/**
 * Wave 10 — AiCorrectionsService unit tests.
 *
 * Runner: node:test. Run with:
 *
 *   npx tsx --test src/Services/__tests__/aiCorrections.test.ts
 *
 * Pool is fully mocked. We assert the SQL fragments that pin each query
 * (INSERT / SELECT WHERE applied_to_kb=false / UPDATE ... applied_to_kb=true)
 * and the parameter shape — that is the contract the listener integrations
 * rely on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AiCorrectionsService } from '../aiCorrections.service.js';

// ─── Mock pool ────────────────────────────────────────────────────────────

type QueryResponse = { rows: any[]; rowCount?: number };

interface MockState {
  calls: Array<{ sql: string; params: unknown[] }>;
  patterns: Array<{
    match: (sql: string) => boolean;
    respond: (params: unknown[]) => QueryResponse;
  }>;
}

function makeMockPool(state: MockState) {
  const query = async (sql: string, params: unknown[]): Promise<QueryResponse> => {
    state.calls.push({ sql, params });
    for (const p of state.patterns) {
      if (p.match(sql)) return p.respond(params);
    }
    return { rows: [], rowCount: 0 };
  };
  return { query: query as any };
}

const CORR_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CORR_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLAIM_1 = '11111111-1111-4111-8111-111111111111';
const PATTERN_1 = '99999999-9999-4999-8999-999999999999';
const USER_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// ─── Tests ────────────────────────────────────────────────────────────────

describe('AiCorrectionsService — record()', () => {
  it('inserts a row with the right surface, target, ai/human values and returns id', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql) => sql.includes('INSERT INTO hospital.ai_corrections'),
      respond: () => ({ rows: [{ id: CORR_1 }], rowCount: 1 }),
    });
    const svc = new AiCorrectionsService(makeMockPool(state) as any);
    const out = await svc.record({
      surface: 'document_category',
      claim_id: CLAIM_1,
      target_id: 'section-123',
      target_kind: 'discharge_slip',
      ai_value: { category: 'discharge_slip', confidence: 0.6 },
      human_value: { category: 'discharge_summary' },
      reason: 'wrong category',
      corrected_by: USER_1,
    });
    assert.equal(out.id, CORR_1);
    assert.equal(state.calls.length, 1);
    const call = state.calls[0]!;
    // Positional params: surface, claim_id, target_id, target_kind, ai, human, reason, by
    assert.equal(call.params[0], 'document_category');
    assert.equal(call.params[1], CLAIM_1);
    assert.equal(call.params[2], 'section-123');
    assert.equal(call.params[3], 'discharge_slip');
    assert.equal(
      call.params[4],
      JSON.stringify({ category: 'discharge_slip', confidence: 0.6 }),
    );
    assert.equal(
      call.params[5],
      JSON.stringify({ category: 'discharge_summary' }),
    );
    assert.equal(call.params[6], 'wrong category');
    assert.equal(call.params[7], USER_1);
  });

  it('serialises undefined ai_value as JSON null (not literal undefined)', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql) => sql.includes('INSERT INTO hospital.ai_corrections'),
      respond: () => ({ rows: [{ id: CORR_1 }], rowCount: 1 }),
    });
    const svc = new AiCorrectionsService(makeMockPool(state) as any);
    await svc.record({
      surface: 'harmonised_field',
      target_kind: '$.diagnosis.primary',
      human_value: { icd_code: 'I21.9' },
      corrected_by: USER_1,
    });
    const call = state.calls[0]!;
    assert.equal(call.params[4], null);
    assert.equal(call.params[5], JSON.stringify({ icd_code: 'I21.9' }));
  });

  it('throws if the INSERT returns no row (defensive against DB hiccups)', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql) => sql.includes('INSERT INTO hospital.ai_corrections'),
      respond: () => ({ rows: [], rowCount: 0 }),
    });
    const svc = new AiCorrectionsService(makeMockPool(state) as any);
    await assert.rejects(
      () =>
        svc.record({
          surface: 'rule_override',
          human_value: { action: 'mark_passed' },
          corrected_by: USER_1,
        }),
      /no id returned/,
    );
  });
});

describe('AiCorrectionsService — listUnmined()', () => {
  it('returns only rows where applied_to_kb=false', async () => {
    const state: MockState = { calls: [], patterns: [] };
    const unmined = [
      { id: CORR_1, surface: 'document_category', applied_to_kb: false },
      { id: CORR_2, surface: 'document_category', applied_to_kb: false },
    ];
    state.patterns.push({
      match: (sql) =>
        sql.includes('FROM hospital.ai_corrections') &&
        sql.includes('applied_to_kb = false'),
      respond: () => ({ rows: unmined, rowCount: unmined.length }),
    });
    const svc = new AiCorrectionsService(makeMockPool(state) as any);
    const rows = await svc.listUnmined({ since_days: 90 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.id, CORR_1);
    assert.equal(rows[1]!.id, CORR_2);
    // The since_days param goes first.
    assert.equal(state.calls[0]!.params[0], 90);
  });

  it('passes the surface filter through as a bound param', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql) =>
        sql.includes('FROM hospital.ai_corrections') &&
        sql.includes('surface ='),
      respond: () => ({ rows: [], rowCount: 0 }),
    });
    const svc = new AiCorrectionsService(makeMockPool(state) as any);
    await svc.listUnmined({ surface: 'rule_override', since_days: 30, limit: 50 });
    const call = state.calls[0]!;
    // Params order: since_days, limit, surface (added after).
    assert.equal(call.params[0], 30);
    assert.equal(call.params[1], 50);
    assert.equal(call.params[2], 'rule_override');
  });
});

describe('AiCorrectionsService — markMined()', () => {
  it('sets applied_to_kb=true and links the pattern_id', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql) =>
        sql.includes('UPDATE hospital.ai_corrections') &&
        sql.includes('applied_to_kb = true') &&
        sql.includes('mined_pattern_id'),
      respond: () => ({ rows: [], rowCount: 2 }),
    });
    const svc = new AiCorrectionsService(makeMockPool(state) as any);
    await svc.markMined([CORR_1, CORR_2], PATTERN_1);
    assert.equal(state.calls.length, 1);
    const call = state.calls[0]!;
    // params: [ids[], pattern_id]
    assert.deepEqual(call.params[0], [CORR_1, CORR_2]);
    assert.equal(call.params[1], PATTERN_1);
  });

  it('no-ops when given an empty id list (no UPDATE issued)', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql) => sql.includes('UPDATE hospital.ai_corrections'),
      respond: () => ({ rows: [], rowCount: 0 }),
    });
    const svc = new AiCorrectionsService(makeMockPool(state) as any);
    await svc.markMined([], PATTERN_1);
    assert.equal(state.calls.length, 0);
  });
});

describe('AiCorrectionsService — getRecent()', () => {
  it('queries by claim_id with a bounded limit and DESC ordering', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql) =>
        sql.includes('FROM hospital.ai_corrections') &&
        sql.includes('WHERE claim_id = $1') &&
        sql.includes('ORDER BY corrected_at DESC'),
      respond: () => ({
        rows: [{ id: CORR_1, claim_id: CLAIM_1 }],
        rowCount: 1,
      }),
    });
    const svc = new AiCorrectionsService(makeMockPool(state) as any);
    const rows = await svc.getRecent(CLAIM_1, 10);
    assert.equal(rows.length, 1);
    assert.equal(state.calls[0]!.params[0], CLAIM_1);
    assert.equal(state.calls[0]!.params[1], 10);
  });
});
