/**
 * Wave 10 — KbPatternMiner correction-driven strategy tests.
 *
 * Runner: node:test. Run with:
 *
 *   npx tsx --test src/Services/__tests__/kbPatternMiner_corrections.test.ts
 *
 * Each test:
 *   1. Mocks the pool so the legacy v0 strategies all return zero rows
 *      (we only care about the new correction-driven strategies here).
 *   2. Mocks the ai_corrections SELECT (listUnmined) for ONE surface so
 *      the test isolates a single new strategy.
 *   3. Asserts the INSERT INTO hospital.kb_patterns call carries the right
 *      pattern_type, scope, condition/prediction shape, and that markMined
 *      flips applied_to_kb on the contributing rows.
 *
 * For the threshold-not-met tests we provide < 3 distinct claims and
 * expect 0 candidates added.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KbPatternMiner } from '../kbPatternMiner.service.js';

// ─── Mock pool ────────────────────────────────────────────────────────────

type QueryResponse = { rows: any[]; rowCount?: number };

interface MockState {
  calls: Array<{ sql: string; params: unknown[] }>;
  patterns: Array<{
    match: (sql: string, params: unknown[]) => boolean;
    respond: (params: unknown[]) => QueryResponse;
  }>;
}

function makeMockPool(state: MockState) {
  const query = async (sql: string, params: unknown[]): Promise<QueryResponse> => {
    state.calls.push({ sql, params });
    for (const p of state.patterns) {
      if (p.match(sql, params)) return p.respond(params);
    }
    return { rows: [], rowCount: 0 };
  };
  const connect = async () => ({ query, release: () => {} }) as any;
  return { query: query as any, connect: connect as any };
}

// SQL-pinning helpers — these have to NOT match the new SELECT against
// hospital.ai_corrections, which is the way we route the corrections
// listUnmined call through to a specific fixture.
function isAiCorrectionsListSql(sql: string): boolean {
  return (
    sql.includes('FROM hospital.ai_corrections') &&
    sql.includes('applied_to_kb = false')
  );
}
function isAiCorrectionsUpdate(sql: string): boolean {
  return (
    sql.includes('UPDATE hospital.ai_corrections') &&
    sql.includes('applied_to_kb = true')
  );
}
function isKbPatternsInsert(sql: string): boolean {
  return sql.includes('INSERT INTO hospital.kb_patterns');
}

// Stand-in surface filter: when listUnmined is called the third param is
// the surface code (and there is no third param if no surface filter). We
// route by inspecting the params.
function surfaceOf(params: unknown[]): string | null {
  // listUnmined uses params [sinceDays, limit, optional surface].
  return (params[2] as string) ?? null;
}

const CLAIM_A = '11111111-1111-4111-8111-111111111111';
const CLAIM_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_C = '33333333-3333-4333-8333-333333333333';
const CORR_1 = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CORR_2 = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CORR_3 = 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CORR_4 = 'aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CORR_5 = 'aaaaaaa5-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PATTERN_ID = '99999999-9999-4999-8999-999999999999';

function defaultInsertResponse(): QueryResponse {
  return { rows: [{ id: PATTERN_ID, inserted: true }], rowCount: 1 };
}

function findInsertedPatternType(state: MockState): string | null {
  const insert = state.calls.find((c) => isKbPatternsInsert(c.sql));
  return (insert?.params[0] as string) ?? null;
}

// ─── category_confusion ───────────────────────────────────────────────────

describe('mineCategoryConfusion (Wave 10)', () => {
  it('emits a candidate when ≥3 distinct claims agree on the same (prev → corrected) pair', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql, params) =>
        isAiCorrectionsListSql(sql) && surfaceOf(params) === 'document_category',
      respond: () => ({
        rows: [
          {
            id: CORR_1,
            surface: 'document_category',
            claim_id: CLAIM_A,
            target_id: 's1',
            target_kind: 'discharge_slip',
            ai_value: { category: 'discharge_slip', confidence: 0.6 },
            human_value: { category: 'discharge_summary' },
            reason: null,
            corrected_by: 'u',
            corrected_at: '2026-05-01T00:00:00Z',
            applied_to_kb: false,
            mined_pattern_id: null,
          },
          {
            id: CORR_2,
            surface: 'document_category',
            claim_id: CLAIM_B,
            target_id: 's2',
            target_kind: 'discharge_slip',
            ai_value: { category: 'discharge_slip' },
            human_value: { category: 'discharge_summary' },
            reason: null,
            corrected_by: 'u',
            corrected_at: '2026-05-02T00:00:00Z',
            applied_to_kb: false,
            mined_pattern_id: null,
          },
          {
            id: CORR_3,
            surface: 'document_category',
            claim_id: CLAIM_C,
            target_id: 's3',
            target_kind: 'discharge_slip',
            ai_value: { category: 'discharge_slip' },
            human_value: { category: 'discharge_summary' },
            reason: null,
            corrected_by: 'u',
            corrected_at: '2026-05-03T00:00:00Z',
            applied_to_kb: false,
            mined_pattern_id: null,
          },
        ],
        rowCount: 3,
      }),
    });
    state.patterns.push({
      match: (sql) => isKbPatternsInsert(sql),
      respond: defaultInsertResponse,
    });
    state.patterns.push({
      match: (sql) => isAiCorrectionsUpdate(sql),
      respond: () => ({ rows: [], rowCount: 3 }),
    });

    const miner = new KbPatternMiner(makeMockPool(state) as any);
    const result = await miner.mineCandidatesFromClosedClaims({ sinceDays: 30 });
    assert.equal(result.candidatesAdded, 1);
    assert.equal(findInsertedPatternType(state), 'category_confusion');
    // markMined should have linked the 3 contributing correction ids.
    const upd = state.calls.find((c) => isAiCorrectionsUpdate(c.sql));
    assert.ok(upd, 'markMined UPDATE was issued');
    assert.deepEqual(upd!.params[0], [CORR_1, CORR_2, CORR_3]);
    assert.equal(upd!.params[1], PATTERN_ID);
  });

  it('emits zero candidates when fewer than 3 distinct claims contribute', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql, params) =>
        isAiCorrectionsListSql(sql) && surfaceOf(params) === 'document_category',
      respond: () => ({
        rows: [
          {
            id: CORR_1,
            claim_id: CLAIM_A,
            target_id: 's1',
            target_kind: 'x',
            ai_value: { category: 'x' },
            human_value: { category: 'y' },
            applied_to_kb: false,
          },
          {
            id: CORR_2,
            claim_id: CLAIM_A, // same claim → only 1 distinct claim
            target_id: 's2',
            target_kind: 'x',
            ai_value: { category: 'x' },
            human_value: { category: 'y' },
            applied_to_kb: false,
          },
        ],
        rowCount: 2,
      }),
    });
    state.patterns.push({
      match: (sql) => isKbPatternsInsert(sql),
      respond: defaultInsertResponse,
    });
    const miner = new KbPatternMiner(makeMockPool(state) as any);
    const result = await miner.mineCandidatesFromClosedClaims({ sinceDays: 30 });
    assert.equal(result.candidatesAdded, 0);
    // INSERT must not have fired for category_confusion.
    assert.equal(findInsertedPatternType(state), null);
  });
});

// ─── harmonisation_drift ──────────────────────────────────────────────────

describe('mineHarmonisationDrift (Wave 10)', () => {
  it('emits a candidate when ≥3 distinct claims agree on the same JSONPath direction', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql, params) =>
        isAiCorrectionsListSql(sql) && surfaceOf(params) === 'harmonised_field',
      respond: () => ({
        rows: [CLAIM_A, CLAIM_B, CLAIM_C].map((cid, i) => ({
          id: `corr-${i}`,
          surface: 'harmonised_field',
          claim_id: cid,
          target_id: '$.diagnosis.primary_diagnosis.icd_code',
          target_kind: '$.diagnosis.primary_diagnosis.icd_code',
          ai_value: 'I24.9',
          human_value: 'I21.9',
          applied_to_kb: false,
        })),
        rowCount: 3,
      }),
    });
    state.patterns.push({
      match: (sql) => isKbPatternsInsert(sql),
      respond: defaultInsertResponse,
    });
    state.patterns.push({
      match: (sql) => isAiCorrectionsUpdate(sql),
      respond: () => ({ rows: [], rowCount: 3 }),
    });

    const miner = new KbPatternMiner(makeMockPool(state) as any);
    const result = await miner.mineCandidatesFromClosedClaims({ sinceDays: 30 });
    assert.equal(result.candidatesAdded, 1);
    assert.equal(findInsertedPatternType(state), 'harmonisation_drift');
  });

  it('emits zero candidates when AI and human values are equal (no_change)', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql, params) =>
        isAiCorrectionsListSql(sql) && surfaceOf(params) === 'harmonised_field',
      respond: () => ({
        rows: [CLAIM_A, CLAIM_B, CLAIM_C].map((cid, i) => ({
          id: `corr-eq-${i}`,
          claim_id: cid,
          target_kind: '$.diagnosis.primary',
          ai_value: 'I21.9',
          human_value: 'I21.9', // identical → not a drift
          applied_to_kb: false,
        })),
        rowCount: 3,
      }),
    });
    state.patterns.push({
      match: (sql) => isKbPatternsInsert(sql),
      respond: defaultInsertResponse,
    });
    const miner = new KbPatternMiner(makeMockPool(state) as any);
    const result = await miner.mineCandidatesFromClosedClaims({ sinceDays: 30 });
    assert.equal(result.candidatesAdded, 0);
    assert.equal(findInsertedPatternType(state), null);
  });
});

// ─── rule_overreach ───────────────────────────────────────────────────────

describe('mineRuleOverreach (Wave 10)', () => {
  it('emits a candidate when ≥5 overrides on a rule with ≥60% narrowing', async () => {
    const state: MockState = { calls: [], patterns: [] };
    // 5 mark_passed overrides for the same rule across distinct claims.
    const rows = [CORR_1, CORR_2, CORR_3, CORR_4, CORR_5].map((cid, i) => ({
      id: cid,
      surface: 'rule_override',
      claim_id: `${CLAIM_A.slice(0, -1)}${i + 1}`,
      target_id: 'CARDIAC_001',
      target_kind: 'CARDIAC_001',
      ai_value: { rule_set_id: 'set1', expected_status: 'FAIL' },
      human_value: { action: 'mark_passed' },
      reason: 'rule too strict',
      applied_to_kb: false,
    }));
    state.patterns.push({
      match: (sql, params) =>
        isAiCorrectionsListSql(sql) && surfaceOf(params) === 'rule_override',
      respond: () => ({ rows, rowCount: rows.length }),
    });
    state.patterns.push({
      match: (sql) => isKbPatternsInsert(sql),
      respond: defaultInsertResponse,
    });
    state.patterns.push({
      match: (sql) => isAiCorrectionsUpdate(sql),
      respond: () => ({ rows: [], rowCount: rows.length }),
    });

    const miner = new KbPatternMiner(makeMockPool(state) as any);
    const result = await miner.mineCandidatesFromClosedClaims({ sinceDays: 30 });
    assert.equal(result.candidatesAdded, 1);
    assert.equal(findInsertedPatternType(state), 'rule_overreach');
  });

  it('emits zero candidates when only 4 overrides on a rule (under threshold)', async () => {
    const state: MockState = { calls: [], patterns: [] };
    const rows = [CORR_1, CORR_2, CORR_3, CORR_4].map((cid, i) => ({
      id: cid,
      surface: 'rule_override',
      claim_id: `${CLAIM_A.slice(0, -1)}${i + 1}`,
      target_kind: 'CARDIAC_001',
      ai_value: { expected_status: 'FAIL' },
      human_value: { action: 'mark_passed' },
      applied_to_kb: false,
    }));
    state.patterns.push({
      match: (sql, params) =>
        isAiCorrectionsListSql(sql) && surfaceOf(params) === 'rule_override',
      respond: () => ({ rows, rowCount: rows.length }),
    });
    state.patterns.push({
      match: (sql) => isKbPatternsInsert(sql),
      respond: defaultInsertResponse,
    });
    const miner = new KbPatternMiner(makeMockPool(state) as any);
    const result = await miner.mineCandidatesFromClosedClaims({ sinceDays: 30 });
    assert.equal(result.candidatesAdded, 0);
    assert.equal(findInsertedPatternType(state), null);
  });
});

// ─── extraction_field_pattern ─────────────────────────────────────────────

describe('mineExtractionFieldPatterns (Wave 10)', () => {
  it('emits a candidate when ≥3 distinct claims share the same field-path + shape', async () => {
    const state: MockState = { calls: [], patterns: [] };
    // AI returns full string, human truncates → shape='truncation'.
    state.patterns.push({
      match: (sql, params) =>
        isAiCorrectionsListSql(sql) && surfaceOf(params) === 'ai_draft_field',
      respond: () => ({
        rows: [CLAIM_A, CLAIM_B, CLAIM_C].map((cid, i) => ({
          id: `corr-tx-${i}`,
          surface: 'ai_draft_field',
          claim_id: cid,
          target_id: 'draft-1',
          target_kind: 'diagnosis.icd_code',
          ai_value: 'I21.9 - Acute MI',
          human_value: 'I21.9', // strict prefix → 'truncation'
          applied_to_kb: false,
        })),
        rowCount: 3,
      }),
    });
    state.patterns.push({
      match: (sql) => isKbPatternsInsert(sql),
      respond: defaultInsertResponse,
    });
    state.patterns.push({
      match: (sql) => isAiCorrectionsUpdate(sql),
      respond: () => ({ rows: [], rowCount: 3 }),
    });

    const miner = new KbPatternMiner(makeMockPool(state) as any);
    const result = await miner.mineCandidatesFromClosedClaims({ sinceDays: 30 });
    assert.equal(result.candidatesAdded, 1);
    assert.equal(findInsertedPatternType(state), 'extraction_field_pattern');
  });

  it('emits zero candidates when only 2 distinct claims contribute', async () => {
    const state: MockState = { calls: [], patterns: [] };
    state.patterns.push({
      match: (sql, params) =>
        isAiCorrectionsListSql(sql) && surfaceOf(params) === 'ai_draft_field',
      respond: () => ({
        rows: [
          {
            id: CORR_1,
            claim_id: CLAIM_A,
            target_kind: 'diagnosis.icd_code',
            ai_value: 'I21.9 - ACS',
            human_value: 'I21.9',
            applied_to_kb: false,
          },
          {
            id: CORR_2,
            claim_id: CLAIM_B,
            target_kind: 'diagnosis.icd_code',
            ai_value: 'I24.9 - other',
            human_value: 'I24.9',
            applied_to_kb: false,
          },
        ],
        rowCount: 2,
      }),
    });
    state.patterns.push({
      match: (sql) => isKbPatternsInsert(sql),
      respond: defaultInsertResponse,
    });
    const miner = new KbPatternMiner(makeMockPool(state) as any);
    const result = await miner.mineCandidatesFromClosedClaims({ sinceDays: 30 });
    assert.equal(result.candidatesAdded, 0);
    assert.equal(findInsertedPatternType(state), null);
  });
});
