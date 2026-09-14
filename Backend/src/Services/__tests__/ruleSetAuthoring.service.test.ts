/**
 * ruleSetAuthoring — the guard rails that make handing the rule engine to a
 * superadmin safe.
 *
 * Three behaviours carry the weight, and all three are pinned here:
 *
 *   1. A live pack cannot be edited in place.
 *   2. Promotion requires a shadow run that POSTDATES the last edit — so
 *      "shadow, then edit, then promote" cannot slip through.
 *   3. Every promotion demands a change note, because "why does this claim
 *      have a hold?" must be answerable in six months.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RuleSetAuthoringService } from '../ruleSetAuthoring.service.js';

function poolFor(set: Record<string, any>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool: any = {
    calls,
    set,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM hospital\.insurer_rule_sets WHERE rule_set_id/.test(sql)) {
        return { rows: set ? [set] : [], rowCount: set ? 1 : 0 };
      }
      if (/FROM hospital\.(insurance_rules|insurer_document_requirements|insurer_financial_limits|insurer_los_benchmarks)/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*UPDATE hospital\.insurer_rule_sets/.test(sql)) {
        return { rows: [{ ...set, status: 'live' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => pool.query(sql, params ?? []),
      release: () => {},
    }),
  };
  return pool;
}

const DRAFT = {
  id: 'uuid-1', rule_set_id: 'STAR_CATARACT_V2', rule_set_name: 'Star cataract',
  version: '1.0', status: 'draft', insurer_code: 'STAR',
  last_shadow_run_id: null, cloned_from: 'STAR_CATARACT_V1',
};
const LIVE = { ...DRAFT, status: 'live' };
const SHADOWED = { ...DRAFT, last_shadow_run_id: 'run-1' };

describe('ruleSetAuthoring — a live pack is immutable', () => {
  it('refuses to edit the set', async () => {
    const svc = new RuleSetAuthoringService(poolFor(LIVE));
    await assert.rejects(
      () => svc.updateSet('STAR_CATARACT_V2', { rule_set_name: 'x' }),
      /clone it, edit the draft/,
    );
  });

  it('refuses to add a rule', async () => {
    const svc = new RuleSetAuthoringService(poolFor(LIVE));
    await assert.rejects(
      () => svc.upsertRule('STAR_CATARACT_V2', { rule_id: 'R1', rule_name: 'x' }),
      /cannot be edited in place/,
    );
  });

  it('refuses to delete a rule', async () => {
    const svc = new RuleSetAuthoringService(poolFor(LIVE));
    await assert.rejects(() => svc.deleteRule('STAR_CATARACT_V2', 'R1'), /cannot be edited in place/);
  });
});

describe('ruleSetAuthoring — the promotion gate', () => {
  it('refuses to promote a draft that was never shadow-run', async () => {
    const svc = new RuleSetAuthoringService(poolFor(DRAFT));
    await assert.rejects(
      () => svc.promote('STAR_CATARACT_V2', 'tightening the implant rule'),
      /has not been shadow-run/,
    );
  });

  it('refuses to promote without a change note', async () => {
    const svc = new RuleSetAuthoringService(poolFor(SHADOWED));
    await assert.rejects(() => svc.promote('STAR_CATARACT_V2', '   '), /change note is required/);
  });

  it('promotes when shadow-run and annotated', async () => {
    const svc = new RuleSetAuthoringService(poolFor(SHADOWED));
    const res = await svc.promote('STAR_CATARACT_V2', 'tightening the implant rule');
    assert.equal(res.status, 'live');
  });

  it('snapshots the pack on promotion', async () => {
    const pool = poolFor(SHADOWED);
    const svc = new RuleSetAuthoringService(pool);
    await svc.promote('STAR_CATARACT_V2', 'note');
    const snap = pool.calls.find((c: any) =>
      /INSERT INTO hospital\.insurer_rule_set_versions/.test(c.sql));
    assert.ok(snap, 'expected a version snapshot to be written');
    assert.equal(snap.params[3], 'note', 'change note must be stored with the snapshot');
  });

  it('refuses a set that is already live', async () => {
    const svc = new RuleSetAuthoringService(poolFor(LIVE));
    await assert.rejects(() => svc.promote('STAR_CATARACT_V2', 'note'), /already live/);
  });
});

describe('ruleSetAuthoring — editing invalidates a prior shadow run', () => {
  it('clears last_shadow_run_id when the set changes', async () => {
    // Without this, "shadow it, then edit it, then promote" would pass the
    // gate while promoting something that was never tested.
    const pool = poolFor(DRAFT);
    const svc = new RuleSetAuthoringService(pool);
    await svc.updateSet('STAR_CATARACT_V2', { rule_set_name: 'renamed' });
    const upd = pool.calls.find((c: any) => /UPDATE hospital\.insurer_rule_sets SET/.test(c.sql));
    assert.match(upd.sql, /last_shadow_run_id = NULL/);
  });

  it('clears it when a rule changes too', async () => {
    const pool = poolFor(DRAFT);
    const svc = new RuleSetAuthoringService(pool);
    await svc.upsertRule('STAR_CATARACT_V2', {
      rule_id: 'R1', rule_name: 'Implant sticker present', kind: 'DOCUMENT_PRESENCE',
    });
    const cleared = pool.calls.some((c: any) => /last_shadow_run_id = NULL/.test(c.sql));
    assert.ok(cleared, 'a rule edit must invalidate the prior shadow run');
  });
});

describe('ruleSetAuthoring — rule validation', () => {
  const svc = () => new RuleSetAuthoringService(poolFor(DRAFT));

  it('rejects an unknown evaluator kind', async () => {
    // The kind registry is frozen (FROZEN_CONTRACTS OD4); an unknown kind
    // would be stored and then silently never dispatched.
    await assert.rejects(
      () => svc().upsertRule('STAR_CATARACT_V2', {
        rule_id: 'R1', rule_name: 'x', kind: 'VIBES_CHECK',
      }),
      /unknown rule kind/,
    );
  });

  it('rejects an out-of-range min_confidence', async () => {
    await assert.rejects(
      () => svc().upsertRule('STAR_CATARACT_V2', {
        rule_id: 'R1', rule_name: 'x', min_confidence: 1.5,
      }),
      /between 0 and 1/,
    );
  });

  it('rejects an unknown severity', async () => {
    await assert.rejects(
      () => svc().upsertRule('STAR_CATARACT_V2', {
        rule_id: 'R1', rule_name: 'x', severity: 'CATASTROPHIC',
      }),
      /unknown severity/,
    );
  });

  it('requires rule_id and rule_name', async () => {
    await assert.rejects(
      () => svc().upsertRule('STAR_CATARACT_V2', { rule_name: 'no id' }),
      /rule_id and rule_name are required/,
    );
  });

  it('accepts a well-formed rule', async () => {
    await assert.doesNotReject(() =>
      svc().upsertRule('STAR_CATARACT_V2', {
        rule_id: 'IMPLANT_STICKER', rule_name: 'Implant sticker present',
        kind: 'DOCUMENT_PRESENCE', severity: 'HIGH',
        category: 'DOCUMENT_COMPLETENESS', impact: 'DEDUCTION',
        min_confidence: 0.8,
      }));
  });
});
