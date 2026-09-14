/**
 * claimStages.service — the taxonomy a superadmin owns.
 *
 * Two behaviours here can cause silent damage and are pinned accordingly:
 *
 *   - `uploadOptions` decides what a ward clerk can pick at 7pm during a
 *     7-10 day document burst. Offer too much and documents get mis-tagged
 *     into the wrong rule pack with no error; offer too little and staff
 *     cannot back-fill a forgotten pre-auth document.
 *
 *   - `reorder` writes against a UNIQUE index on sort_order, so a naive
 *     implementation collides mid-update and leaves the lifecycle scrambled.
 *
 * Uses a fake pool: the logic under test is ordering and validation, not SQL.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ClaimStagesService } from '../claimStages.service.js';

interface Row {
  code: string;
  label: string;
  definition: string;
  entry_trigger: string | null;
  exit_trigger: string | null;
  expected_tat: string | null;
  sort_order: number;
  cycle_types: string[];
  legacy_codes: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function row(code: string, sort_order: number, extra: Partial<Row> = {}): Row {
  return {
    code,
    label: code,
    definition: `${code} definition`,
    entry_trigger: null,
    exit_trigger: null,
    expected_tat: null,
    sort_order,
    cycle_types: ['initial'],
    legacy_codes: [],
    is_active: true,
    created_at: '',
    updated_at: '',
    ...extra,
  };
}

const SEED: Row[] = [
  row('ELIGIBILITY_CHECK', 10, { legacy_codes: ['draft'] }),
  row('PREAUTH', 20, {
    cycle_types: ['initial', 'query_response'],
    legacy_codes: ['preauth_submitted', 'preauth_query_responded'],
  }),
  row('ENHANCEMENT', 30, { cycle_types: ['initial', 'query_response'] }),
  row('FINAL_AUTH', 40, { cycle_types: ['initial', 'query_response'] }),
  row('CLAIM_FILE', 50, { cycle_types: ['initial', 'query_response'] }),
  row('SETTLEMENT', 60),
];

/** Minimal pool that answers the SELECTs this service issues. */
function fakePool(rows: Row[]) {
  const state = rows.map((r) => ({ ...r }));
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool: any = {
    state,
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM hospital\.claim_stages/.test(sql) && /^\s*SELECT/.test(sql)) {
        if (/WHERE code = \$1/.test(sql)) {
          return { rows: state.filter((r) => r.code === params[0]) };
        }
        const list = /WHERE is_active/.test(sql) ? state.filter((r) => r.is_active) : state;
        return { rows: [...list].sort((a, b) => a.sort_order - b.sort_order) };
      }
      if (/count\(\*\)::int n/.test(sql)) return { rows: [{ n: 0 }] };
      if (/^\s*UPDATE hospital\.claim_stages SET sort_order/.test(sql)) {
        const target = state.find((r) => r.code === params[1]);
        if (target) target.sort_order = params[0] as number;
        return { rows: target ? [target] : [] };
      }
      if (/^\s*UPDATE hospital\.claim_stages SET is_active/.test(sql)) {
        const target = state.find((r) => r.code === params[0]);
        if (target) target.is_active = params[1] as boolean;
        return { rows: target ? [target] : [] };
      }
      if (/^\s*UPDATE hospital\.claim_stages SET/.test(sql)) {
        const target = state.find((r) => r.code === params[0]);
        return { rows: target ? [target] : [] };
      }
      return { rows: [] };
    },
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => pool.query(sql, params ?? []),
      release: () => {},
    }),
  };
  return pool;
}

describe('claimStages — upload dropdown curation', () => {
  let svc: ClaimStagesService;
  let pool: any;
  beforeEach(() => {
    pool = fakePool(SEED);
    svc = new ClaimStagesService(pool);
  });

  it('offers every PAST stage so staff can back-fill a forgotten document', async () => {
    const opts = await svc.uploadOptions('FINAL_AUTH');
    const past = opts.filter((o) => o.relation === 'past').map((o) => o.code);
    assert.deepEqual(past, ['ELIGIBILITY_CHECK', 'PREAUTH', 'ENHANCEMENT']);
    assert.ok(past.every((_, i) => opts[i].confirm === false), 'past stages need no confirm');
  });

  it('offers the NEXT stage but marks it confirm — hospitals do prepare ahead', async () => {
    const opts = await svc.uploadOptions('PREAUTH');
    const next = opts.find((o) => o.relation === 'next');
    assert.equal(next?.code, 'ENHANCEMENT');
    assert.equal(next?.confirm, true);
  });

  it('withholds anything beyond the next stage', async () => {
    const opts = await svc.uploadOptions('PREAUTH');
    const codes = opts.map((o) => o.code);
    assert.ok(!codes.includes('FINAL_AUTH'), 'must not offer two stages ahead');
    assert.ok(!codes.includes('SETTLEMENT'));
  });

  it('resolves a LEGACY code to its absorbing stage', async () => {
    // Until the cutover migration runs, live claims still carry migration-024
    // spellings. If this did not resolve, every such claim would fall through
    // to the unknown-stage branch and be offered only the first stage.
    const opts = await svc.uploadOptions('preauth_query_responded');
    const current = opts.find((o) => o.relation === 'current');
    assert.equal(current?.code, 'PREAUTH');
  });

  it('falls back NARROWLY on an unknown or absent current stage', async () => {
    // Guessing wide is how everything ends up tagged with whatever sits at the
    // top of the list.
    for (const input of [null, 'not_a_stage']) {
      const opts = await svc.uploadOptions(input as any);
      assert.equal(opts[0].relation, 'current');
      assert.equal(opts[0].code, 'ELIGIBILITY_CHECK');
      assert.ok(opts.length <= 2, `expected a narrow list, got ${opts.length}`);
    }
  });

  it('never offers a retired stage', async () => {
    pool.state.find((r: Row) => r.code === 'ENHANCEMENT')!.is_active = false;
    const opts = await svc.uploadOptions('PREAUTH');
    assert.ok(!opts.some((o) => o.code === 'ENHANCEMENT'));
  });
});

describe('claimStages — reorder', () => {
  it('parks rows out of the way before renumbering, so the UNIQUE index cannot collide', async () => {
    const pool = fakePool(SEED);
    const svc = new ClaimStagesService(pool);
    const reversed = [...SEED].map((r) => r.code).reverse();
    await svc.reorder(reversed);

    const updates = pool.calls
      .filter((c: any) => /SET sort_order/.test(c.sql))
      .map((c: any) => c.params[0] as number);
    const firstPass = updates.slice(0, reversed.length);
    assert.ok(firstPass.every((n) => n < 0), 'first pass must park every row in a negative band');
    assert.ok(
      updates.slice(reversed.length).every((n) => n > 0),
      'second pass must assign final positive positions',
    );

    const order = [...pool.state].sort((a: Row, b: Row) => a.sort_order - b.sort_order).map((r: Row) => r.code);
    assert.deepEqual(order, reversed);
  });

  it('refuses a PARTIAL list rather than stranding the omitted stages', async () => {
    const svc = new ClaimStagesService(fakePool(SEED));
    await assert.rejects(
      () => svc.reorder(['PREAUTH', 'ELIGIBILITY_CHECK']),
      /missing: /,
    );
  });

  it('refuses an unknown code', async () => {
    const svc = new ClaimStagesService(fakePool(SEED));
    await assert.rejects(
      () => svc.reorder([...SEED.map((r) => r.code), 'MADE_UP']),
      /unknown stage code/,
    );
  });
});

describe('claimStages — validation', () => {
  it('rejects a code that is not SCREAMING_SNAKE_CASE', async () => {
    const svc = new ClaimStagesService(fakePool(SEED));
    for (const bad of ['lowercase', '9LEADING', 'AB', 'has space']) {
      await assert.rejects(
        () => svc.create({ code: bad, label: 'x', definition: 'y', sort_order: 1 }),
        /SCREAMING_SNAKE_CASE/,
        `expected "${bad}" to be rejected`,
      );
    }
  });

  it("rejects cycle_types without 'initial' — the stage could never be entered", async () => {
    const svc = new ClaimStagesService(fakePool(SEED));
    await assert.rejects(
      () => svc.create({
        code: 'SOME_STAGE', label: 'x', definition: 'y', sort_order: 1,
        cycle_types: ['query_response'],
      }),
      /must include 'initial'/,
    );
  });

  it('rejects an unknown cycle type', async () => {
    const svc = new ClaimStagesService(fakePool(SEED));
    await assert.rejects(
      () => svc.update('PREAUTH', { cycle_types: ['initial', 'appeal_round'] }),
      /invalid cycle_types/,
    );
  });
});

describe('claimStages — retirement', () => {
  it('reports usage alongside the flag rather than asking for blind confirmation', async () => {
    const svc = new ClaimStagesService(fakePool(SEED));
    const res = await svc.setActive('ENHANCEMENT', false);
    assert.equal(res.stage?.is_active, false);
    assert.ok(res.usage && typeof res.usage.claims === 'number');
  });

  it('counts LEGACY codes too, or an in-use stage looks retirable', async () => {
    const pool = fakePool(SEED);
    const svc = new ClaimStagesService(pool);
    await svc.usage('PREAUTH');
    const claimsCall = pool.calls.find((c: any) => /FROM hospital\.ipds WHERE stage/.test(c.sql));
    assert.deepEqual(claimsCall.params[0], [
      'PREAUTH',
      'preauth_submitted',
      'preauth_query_responded',
    ]);
  });
});
