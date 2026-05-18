/**
 * Unit tests for KbPatternMiner.
 *
 * Runner: node:test. Run with:
 *
 *   npx tsx --test src/Services/__tests__/kbPatternMiner.test.ts
 *
 * Pool is fully mocked; each test seeds a canned response per matching SQL
 * pattern (the strategies issue distinguishable SELECTs). Strategies that
 * would need more data than we feel like building return [].
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KbPatternMiner, MINER_VERSION } from '../kbPatternMiner.service.js';

// ─── Mock pool ────────────────────────────────────────────────────────────

type QueryResponse = { rows: any[]; rowCount?: number };

interface MockState {
  calls: Array<{ sql: string; params: unknown[] }>;
  patterns: Array<{
    match: (sql: string) => boolean;
    respond: () => QueryResponse;
  }>;
}

function makeMockPool(state: MockState) {
  const query = async (sql: string, params: unknown[]): Promise<QueryResponse> => {
    state.calls.push({ sql, params });
    for (const p of state.patterns) {
      if (p.match(sql)) return p.respond();
    }
    return { rows: [], rowCount: 0 };
  };
  // PoolClient is referenced by the miner type but unused at runtime.
  const connect = async () => ({ query, release: () => {} }) as any;
  return { query: query as any, connect: connect as any };
}

function freshState(): MockState {
  return { calls: [], patterns: [] };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const PANEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_1 = '11111111-1111-4111-8111-111111111111';
const CLAIM_2 = '22222222-2222-4222-8222-222222222222';
const CLAIM_3 = '33333333-3333-4333-8333-333333333333';

// Patterns to identify which SQL is the one for each strategy.
function isInsurerQuerySql(sql: string): boolean {
  return sql.includes('flagged') && sql.includes('had_query');
}
function isDeductionSql(sql: string): boolean {
  return sql.includes('mean_cut_pct');
}
function isDocCorrelationSql(sql: string): boolean {
  return sql.includes('rate_with') && sql.includes('rate_without');
}
function isStageTransitionSql(sql: string): boolean {
  // The stage strategy is a plain SELECT of events_summary; matches when none
  // of the aggregate strategies match. We pin on the SELECT structure.
  return (
    sql.includes('events_summary') &&
    sql.includes('current_panel_id') &&
    !sql.includes('GROUP BY')
  );
}
function isAmountVarianceSql(sql: string): boolean {
  return sql.includes('STDDEV_SAMP');
}
function isInsertSql(sql: string): boolean {
  return sql.includes('INSERT INTO hospital.kb_patterns');
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('KbPatternMiner — signature dedup (ON CONFLICT)', () => {
  it('returns existingReinforced when insert RETURNING inserted=false', async () => {
    const state = freshState();
    // Insurer-query strategy yields one candidate; INSERT marks it as not
    // newly inserted.
    state.patterns.push({
      match: isInsurerQuerySql,
      respond: () => ({
        rows: [
          {
            panel_id: PANEL_A,
            admission_type: 'planned',
            n: 10,
            query_rate: 0.8,
            evidence_ids: [CLAIM_1, CLAIM_2],
          },
        ],
        rowCount: 1,
      }),
    });
    // All other strategies return empty.
    state.patterns.push({ match: isDeductionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isDocCorrelationSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isStageTransitionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isAmountVarianceSql, respond: () => ({ rows: [] }) });

    // INSERT returns inserted=false ⇒ existing row reinforced.
    state.patterns.push({
      match: isInsertSql,
      respond: () => ({ rows: [{ inserted: false }] }),
    });

    const miner = new KbPatternMiner(makeMockPool(state) as any);
    const result = await miner.mineCandidatesFromClosedClaims({ sinceDays: 30 });
    assert.equal(result.candidatesAdded, 0);
    assert.equal(result.existingReinforced, 1);
  });

  it('returns candidatesAdded when insert RETURNING inserted=true', async () => {
    const state = freshState();
    state.patterns.push({
      match: isInsurerQuerySql,
      respond: () => ({
        rows: [
          {
            panel_id: PANEL_A,
            admission_type: null,
            n: 8,
            query_rate: 0.75,
            evidence_ids: [CLAIM_1],
          },
        ],
        rowCount: 1,
      }),
    });
    state.patterns.push({ match: isDeductionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isDocCorrelationSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isStageTransitionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isAmountVarianceSql, respond: () => ({ rows: [] }) });
    state.patterns.push({
      match: isInsertSql,
      respond: () => ({ rows: [{ inserted: true }] }),
    });

    const miner = new KbPatternMiner(makeMockPool(state) as any);
    const result = await miner.mineCandidatesFromClosedClaims();
    assert.equal(result.candidatesAdded, 1);
    assert.equal(result.existingReinforced, 0);
  });
});

describe('KbPatternMiner — strategies emit expected candidates', () => {
  it('insurer_query_pattern: row with rate=0.8 emits candidate with type+condition', async () => {
    const state = freshState();
    state.patterns.push({
      match: isInsurerQuerySql,
      respond: () => ({
        rows: [
          {
            panel_id: PANEL_A,
            admission_type: 'planned',
            n: 12,
            query_rate: 0.78,
            evidence_ids: [CLAIM_1, CLAIM_2, CLAIM_3],
          },
        ],
      }),
    });
    state.patterns.push({ match: isDeductionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isDocCorrelationSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isStageTransitionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isAmountVarianceSql, respond: () => ({ rows: [] }) });
    state.patterns.push({
      match: isInsertSql,
      respond: () => ({ rows: [{ inserted: true }] }),
    });

    const miner = new KbPatternMiner(makeMockPool(state) as any);
    await miner.mineCandidatesFromClosedClaims();
    const insertCall = state.calls.find((c) => isInsertSql(c.sql));
    assert.ok(insertCall, 'should have issued an INSERT for the candidate');
    // params order in upsertCandidate:
    //   1 pattern_type, 2 title, 3 description, 4 scope, 5 condition,
    //   6 prediction, 7 confidence, 8 evidence_count, 9 evidence_claim_ids,
    //   10 miner_version
    const params = insertCall!.params as any[];
    assert.equal(params[0], 'insurer_query_pattern');
    const scope = JSON.parse(params[3]);
    assert.equal(scope.panel_id, PANEL_A);
    const condition = JSON.parse(params[4]);
    assert.equal(condition.kind, 'doc_missing');
    assert.equal(params[9], MINER_VERSION);
  });

  it('deduction_pattern: mean cut ⇒ amount_cut_pct prediction', async () => {
    const state = freshState();
    state.patterns.push({ match: isInsurerQuerySql, respond: () => ({ rows: [] }) });
    state.patterns.push({
      match: isDeductionSql,
      respond: () => ({
        rows: [
          {
            panel_id: PANEL_A,
            admission_type: 'emergency',
            n: 7,
            mean_cut_pct: 0.22,
            cut_rate: 0.65,
            evidence_ids: [CLAIM_1, CLAIM_2],
          },
        ],
      }),
    });
    state.patterns.push({ match: isDocCorrelationSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isStageTransitionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isAmountVarianceSql, respond: () => ({ rows: [] }) });
    state.patterns.push({
      match: isInsertSql,
      respond: () => ({ rows: [{ inserted: true }] }),
    });

    const miner = new KbPatternMiner(makeMockPool(state) as any);
    await miner.mineCandidatesFromClosedClaims();
    const insertCall = state.calls.find((c) => isInsertSql(c.sql));
    assert.ok(insertCall);
    const params = insertCall!.params as any[];
    assert.equal(params[0], 'deduction_pattern');
    const prediction = JSON.parse(params[5]);
    assert.equal(prediction.kind, 'amount_cut_pct');
    assert.ok(Math.abs(prediction.point_estimate - 0.22) < 1e-9);
  });

  it('doc_correlation: delta > 0.2 ⇒ doc_present condition', async () => {
    const state = freshState();
    state.patterns.push({ match: isInsurerQuerySql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isDeductionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({
      match: isDocCorrelationSql,
      respond: () => ({
        rows: [
          {
            panel_id: PANEL_A,
            cat: 'ot_notes_and_photos',
            n: 25,
            rate_with: 0.10,
            rate_without: 0.55,
            n_with: 10,
            n_without: 15,
            evidence_ids: [CLAIM_1, CLAIM_2, CLAIM_3],
          },
        ],
      }),
    });
    state.patterns.push({ match: isStageTransitionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isAmountVarianceSql, respond: () => ({ rows: [] }) });
    state.patterns.push({
      match: isInsertSql,
      respond: () => ({ rows: [{ inserted: true }] }),
    });

    const miner = new KbPatternMiner(makeMockPool(state) as any);
    await miner.mineCandidatesFromClosedClaims();
    const insertCall = state.calls.find((c) => isInsertSql(c.sql));
    assert.ok(insertCall);
    const params = insertCall!.params as any[];
    assert.equal(params[0], 'doc_correlation');
    const condition = JSON.parse(params[4]);
    assert.equal(condition.kind, 'doc_present');
    assert.equal(condition.params.required_doc_category, 'ot_notes_and_photos');
  });

  it('amount_variance_pattern: emits approval_ratio prediction', async () => {
    const state = freshState();
    state.patterns.push({ match: isInsurerQuerySql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isDeductionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isDocCorrelationSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isStageTransitionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({
      match: isAmountVarianceSql,
      respond: () => ({
        rows: [
          {
            panel_id: PANEL_A,
            admission_type: 'planned',
            n: 18,
            mean_ratio: 0.82,
            std_ratio: 0.12,
            evidence_ids: [CLAIM_1, CLAIM_2],
          },
        ],
      }),
    });
    state.patterns.push({
      match: isInsertSql,
      respond: () => ({ rows: [{ inserted: true }] }),
    });

    const miner = new KbPatternMiner(makeMockPool(state) as any);
    await miner.mineCandidatesFromClosedClaims();
    const insertCall = state.calls.find((c) => isInsertSql(c.sql));
    assert.ok(insertCall);
    const params = insertCall!.params as any[];
    assert.equal(params[0], 'amount_variance_pattern');
    const prediction = JSON.parse(params[5]);
    assert.equal(prediction.kind, 'approval_ratio');
    assert.ok(prediction.distribution);
  });

  // The stage_transition strategy walks events in code; with no synthetic
  // events the bucket never hits n >= 10. Asserting zero output keeps the
  // test stable until a future iteration builds a dedicated fixture.
  it('stage_transition_pattern: returns no candidates when no events', async () => {
    const state = freshState();
    state.patterns.push({ match: isInsurerQuerySql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isDeductionSql, respond: () => ({ rows: [] }) });
    state.patterns.push({ match: isDocCorrelationSql, respond: () => ({ rows: [] }) });
    state.patterns.push({
      match: isStageTransitionSql,
      respond: () => ({
        rows: [
          { claim_id: CLAIM_1, panel_id: PANEL_A, events: [] },
          { claim_id: CLAIM_2, panel_id: PANEL_A, events: [] },
        ],
      }),
    });
    state.patterns.push({ match: isAmountVarianceSql, respond: () => ({ rows: [] }) });

    const miner = new KbPatternMiner(makeMockPool(state) as any);
    const result = await miner.mineCandidatesFromClosedClaims();
    // No inserts attempted (no candidate produced).
    const insertCalls = state.calls.filter((c) => isInsertSql(c.sql));
    assert.equal(insertCalls.length, 0);
    assert.equal(result.candidatesAdded, 0);
    assert.equal(result.existingReinforced, 0);
  });
});

describe('KbPatternMiner.promoteCandidate / demotePattern', () => {
  it('promoteCandidate issues UPDATE … status=live', async () => {
    const state = freshState();
    state.patterns.push({
      match: (sql) => sql.includes("status = 'live'"),
      respond: () => ({ rows: [], rowCount: 1 }),
    });
    const miner = new KbPatternMiner(makeMockPool(state) as any);
    await miner.promoteCandidate('p-1', 'reviewer-1', 'looks good');
    const call = state.calls.find((c) =>
      c.sql.includes("status = 'live'") && c.sql.includes('promotion_reason'),
    );
    assert.ok(call);
    assert.deepEqual(call!.params, ['p-1', 'reviewer-1', 'looks good']);
  });

  it('demotePattern issues UPDATE … status=demoted', async () => {
    const state = freshState();
    state.patterns.push({
      match: (sql) => sql.includes("status = 'demoted'"),
      respond: () => ({ rows: [], rowCount: 1 }),
    });
    const miner = new KbPatternMiner(makeMockPool(state) as any);
    await miner.demotePattern('p-2', 'reviewer-2', 'noise');
    const call = state.calls.find((c) =>
      c.sql.includes("status = 'demoted'") && c.sql.includes('demotion_reason'),
    );
    assert.ok(call);
    assert.deepEqual(call!.params, ['p-2', 'reviewer-2', 'noise']);
  });
});
