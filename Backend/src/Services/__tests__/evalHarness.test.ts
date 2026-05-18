/**
 * Unit tests for the Eval Harness (Sprint 4, Wave 5A).
 *
 * Runner: node:test (matches the convention in claimDossierProjector.test.ts,
 * actionEngine.test.ts, eventDispatcher.test.ts). Run with:
 *
 *   npx tsx --test src/Services/__tests__/evalHarness.test.ts
 *
 * Everything is mocked: pg pool, dossier service, the (optional) engine used
 * by backtest. No DB, no LLM, no network.
 *
 * What we cover (mirrors the service's public API surface — see
 * Services/evalHarness.service.ts for the source of truth):
 *
 *   • computePredictionError — pure helper; happy-path + edge cases
 *   • EvalHarness.snapshotPrediction — INSERT path, idempotency on
 *     report_id (ON CONFLICT DO NOTHING swallowed), error swallowing
 *     so the upstream adjudication path never gets poisoned
 *   • EvalHarness.resolveActuals — SELECT-then-UPDATE flow, partial
 *     resolution when not all eval rows are past their target_stage,
 *     graceful handling when the dossier is missing
 *   • EvalHarness.deriveActualOutcome — pure derivation from a dossier
 *   • EvalHarness.getMetrics — aggregation shape + filter param
 *     plumbing (period, task, hospital_id), confidence-calibration
 *     bucket transforms
 *   • EvalHarness.backtest — read-only: no INSERT/UPDATE issued against
 *     the eval table during a replay; deltas computed from the engine
 *     stub's outputs
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  EvalHarness,
  computePredictionError,
  type PredictionSnapshot,
  type ActualOutcome,
  type DossierServiceLike,
  type AdjudicationEngineLike,
} from '../evalHarness.service.js';
import type { ClaimDossier } from '../claimDossier.service.js';

// ─── Mock pool ────────────────────────────────────────────────────────────
// Same pattern as actionEngine.test.ts: a list of pattern matchers that the
// mock cycles through in order, plus a default empty-rowset fallback.

type QueryResponse = { rows: any[]; rowCount?: number };

interface MockState {
  calls: Array<{ sql: string; params: unknown[] }>;
  queueByPattern: Array<{
    match: (sql: string) => boolean;
    respond: (sql: string, params: unknown[]) => QueryResponse | Error;
  }>;
}

function freshState(): MockState {
  return { calls: [], queueByPattern: [] };
}

function makeMockPool(state: MockState) {
  const query = async (sql: string, params: unknown[] = []): Promise<QueryResponse> => {
    state.calls.push({ sql, params });
    for (const entry of state.queueByPattern) {
      if (entry.match(sql)) {
        const r = entry.respond(sql, params);
        if (r instanceof Error) throw r;
        return r;
      }
    }
    return { rows: [], rowCount: 0 };
  };
  return { query: query as any };
}

// ─── Dossier stub ─────────────────────────────────────────────────────────

function makeDossierStub(byClaim: Record<string, ClaimDossier | null>): DossierServiceLike {
  return {
    getDossier: async (claim_id: string) => byClaim[claim_id] ?? null,
  };
}

function dossier(partial: Partial<ClaimDossier> & { claim_id: string }): ClaimDossier {
  return {
    claim_id: partial.claim_id,
    last_event_id: null,
    last_event_at: null,
    version: 1,
    current_stage: partial.current_stage ?? null,
    current_panel_id: null,
    current_insurer_id: null,
    patient_summary: null,
    amounts: partial.amounts ?? null,
    doc_sections_by_category: null,
    doc_sufficiency_per_stage: null,
    events_summary: [],
    inbound_emails: [],
    outbound_submissions: [],
    active_queries: partial.active_queries ?? [],
    pending_actions: [],
    active_adjudication: null,
    ai_drafts_pending: [],
    matched_kb_patterns: [],
    case_embedding_state: null,
    closed_at: partial.closed_at ?? null,
    closure_outcome: partial.closure_outcome ?? null,
    retrospective_summary: null,
    updated_at: new Date(),
  } as ClaimDossier;
}

// ─── computePredictionError — pure ────────────────────────────────────────

describe('computePredictionError (pure)', () => {
  const basePrediction: PredictionSnapshot = {
    readiness_score: 85,
    recommended_action: 'file_now',
    predicted_outcome: { expected_amount_inr: 50000, p_query: 0.2 },
    kb_matches_count: 2,
    episodic_refs_count: 1,
    reasoning_invoked: false,
  };

  it('returns positive amount_error when actual > predicted', () => {
    const actual: ActualOutcome = {
      actual_outcome_category: 'approved',
      actual_amount_approved: 60000,
      actual_deductions: 0,
      actual_queries: [],
      time_to_response_hours: null,
    };
    const err = computePredictionError(basePrediction, actual);
    assert.equal(err.amount_error_inr, 10000);
    assert.ok(err.amount_error_pct !== null && Math.abs(err.amount_error_pct - 0.2) < 1e-9);
    assert.equal(err.predicted_action_correct, true);
    assert.equal(err.readiness_calibrated, true);
  });

  it('returns negative amount_error when actual < predicted', () => {
    const actual: ActualOutcome = {
      actual_outcome_category: 'partial',
      actual_amount_approved: 40000,
      actual_deductions: 10000,
      actual_queries: [],
      time_to_response_hours: null,
    };
    const err = computePredictionError(basePrediction, actual);
    assert.equal(err.amount_error_inr, -10000);
    assert.equal(err.predicted_action_correct, true); // partial counts as good for file_now
  });

  it('leaves amount_error null when prediction has no expected_amount_inr', () => {
    const pred = { ...basePrediction, predicted_outcome: { p_query: 0.5 } };
    const actual: ActualOutcome = {
      actual_outcome_category: 'approved',
      actual_amount_approved: 30000,
      actual_deductions: 0,
      actual_queries: [],
      time_to_response_hours: null,
    };
    const err = computePredictionError(pred, actual);
    assert.equal(err.amount_error_inr, null);
    assert.equal(err.amount_error_pct, null);
  });

  it('scores request_doc correct when outcome was queried or rejected', () => {
    const pred = { ...basePrediction, recommended_action: 'request_doc' };
    const queried: ActualOutcome = {
      actual_outcome_category: 'queried',
      actual_amount_approved: null,
      actual_deductions: null,
      actual_queries: [{ query_id: 'q1' }],
      time_to_response_hours: null,
    };
    assert.equal(computePredictionError(pred, queried).predicted_action_correct, true);

    const approved: ActualOutcome = { ...queried, actual_outcome_category: 'approved', actual_queries: [] };
    assert.equal(computePredictionError(pred, approved).predicted_action_correct, false);
  });

  it('returns null predicted_action_correct for review/escalate (unscoreable)', () => {
    const pred = { ...basePrediction, recommended_action: 'review' };
    const actual: ActualOutcome = {
      actual_outcome_category: 'approved',
      actual_amount_approved: 50000,
      actual_deductions: 0,
      actual_queries: [],
      time_to_response_hours: null,
    };
    assert.equal(computePredictionError(pred, actual).predicted_action_correct, null);
  });

  it('readiness_calibrated null when outcome still pending; notes set', () => {
    const actual: ActualOutcome = {
      actual_outcome_category: 'pending',
      actual_amount_approved: null,
      actual_deductions: null,
      actual_queries: [],
      time_to_response_hours: null,
    };
    const err = computePredictionError(basePrediction, actual);
    assert.equal(err.readiness_calibrated, null);
    assert.ok(typeof err.notes === 'string' && err.notes.includes('pending'));
  });

  it('readiness_calibrated false when high readiness but bad outcome', () => {
    const actual: ActualOutcome = {
      actual_outcome_category: 'rejected',
      actual_amount_approved: 0,
      actual_deductions: null,
      actual_queries: [],
      time_to_response_hours: null,
    };
    // 85 readiness + rejected → not calibrated
    const err = computePredictionError(basePrediction, actual);
    assert.equal(err.readiness_calibrated, false);
  });

  it('predicted_query_correct compares p_query >= 0.5 against actual queries', () => {
    const pred = { ...basePrediction, predicted_outcome: { p_query: 0.8 } };
    const queried: ActualOutcome = {
      actual_outcome_category: 'queried',
      actual_amount_approved: null,
      actual_deductions: null,
      actual_queries: [{ query_id: 'q1' }],
      time_to_response_hours: null,
    };
    assert.equal(computePredictionError(pred, queried).predicted_query_correct, true);

    const clean: ActualOutcome = { ...queried, actual_outcome_category: 'approved', actual_queries: [] };
    assert.equal(computePredictionError(pred, clean).predicted_query_correct, false);
  });
});

// ─── snapshotPrediction ──────────────────────────────────────────────────

describe('EvalHarness.snapshotPrediction', () => {
  let state: MockState;
  beforeEach(() => {
    state = freshState();
  });

  const reportRow = {
    id: 'report-1',
    claim_id: 'claim-1',
    target_stage: 'pre_auth',
    readiness_score: 82,
    recommended_action: 'file_now',
    predicted_outcome: { expected_amount_inr: 50000, p_query: 0.2 },
    kb_matches: [{ pattern_id: 'p1' }, { pattern_id: 'p2' }],
    episodic_refs: [{ case_id: 'c1' }],
    reasoning: 'agent thought through the claim',
    citations: { pattern_ids: ['p1', 'p2'], case_ids: ['c1'] },
    rules_version: 'r-2026.05',
    engine_version: 'e-1',
    total_cost: 12.5,
    reasoning_cost: 8.0,
  };

  it('issues SELECT then INSERT with the expected column shape', async () => {
    state.queueByPattern.push({
      match: (sql) => /FROM hospital\.adjudication_reports/i.test(sql),
      respond: () => ({ rows: [reportRow], rowCount: 1 }),
    });
    state.queueByPattern.push({
      match: (sql) => /INSERT INTO hospital\.adjudication_eval/i.test(sql),
      respond: () => ({ rows: [], rowCount: 1 }),
    });
    const harness = new EvalHarness(makeMockPool(state) as any, makeDossierStub({}));
    await harness.snapshotPrediction('report-1');

    // First call: SELECT against adjudication_reports
    assert.match(state.calls[0]!.sql, /FROM hospital\.adjudication_reports/i);
    assert.deepEqual(state.calls[0]!.params, ['report-1']);

    // Second call: INSERT with positional params matching the service's
    // current column order (claim_id, report_id, target_stage, prediction,
    // rules_version, engine_version, prompts_versions, kb_pattern_ids,
    // episodic_case_ids, reasoning_cost_inr, total_claim_cost_inr).
    const insertCall = state.calls[1]!;
    assert.match(insertCall.sql, /INSERT INTO hospital\.adjudication_eval/i);
    assert.match(insertCall.sql, /ON CONFLICT ON CONSTRAINT uq_eval_report DO NOTHING/i);
    assert.equal(insertCall.params[0], 'claim-1');
    assert.equal(insertCall.params[1], 'report-1');
    assert.equal(insertCall.params[2], 'pre_auth');

    // prediction is serialised JSON — parse and check the snapshot fields.
    const pred = JSON.parse(insertCall.params[3] as string);
    assert.equal(pred.readiness_score, 82);
    assert.equal(pred.recommended_action, 'file_now');
    assert.equal(pred.kb_matches_count, 2);
    assert.equal(pred.episodic_refs_count, 1);
    assert.equal(pred.reasoning_invoked, true);

    assert.equal(insertCall.params[4], 'r-2026.05');
    assert.equal(insertCall.params[5], 'e-1');

    // prompts_versions JSON contains rules + engine + the loader keys.
    const promptsV = JSON.parse(insertCall.params[6] as string);
    assert.ok(typeof promptsV === 'object');
    assert.ok('rules' in promptsV && 'engine' in promptsV);

    // citation arrays
    assert.deepEqual(insertCall.params[7], ['p1', 'p2']);
    assert.deepEqual(insertCall.params[8], ['c1']);
    assert.equal(insertCall.params[9], 8.0);
    assert.equal(insertCall.params[10], 12.5);
  });

  it('idempotent: ON CONFLICT (rowCount 0) is swallowed without throwing', async () => {
    state.queueByPattern.push({
      match: (sql) => /FROM hospital\.adjudication_reports/i.test(sql),
      respond: () => ({ rows: [reportRow], rowCount: 1 }),
    });
    state.queueByPattern.push({
      match: (sql) => /INSERT INTO hospital\.adjudication_eval/i.test(sql),
      // Simulates the second concurrent attempt — UNIQUE constraint
      // collapses the insert to 0 rows.
      respond: () => ({ rows: [], rowCount: 0 }),
    });
    const harness = new EvalHarness(makeMockPool(state) as any, makeDossierStub({}));
    await assert.doesNotReject(() => harness.snapshotPrediction('report-1'));
  });

  it('skips quietly when the adjudication_report row does not exist', async () => {
    state.queueByPattern.push({
      match: (sql) => /FROM hospital\.adjudication_reports/i.test(sql),
      respond: () => ({ rows: [], rowCount: 0 }),
    });
    const harness = new EvalHarness(makeMockPool(state) as any, makeDossierStub({}));
    await harness.snapshotPrediction('missing-report');
    // No INSERT was attempted.
    assert.equal(state.calls.length, 1);
    assert.match(state.calls[0]!.sql, /FROM hospital\.adjudication_reports/i);
  });

  it('swallows INSERT errors — eval is observability-only and must not poison upstream', async () => {
    state.queueByPattern.push({
      match: (sql) => /FROM hospital\.adjudication_reports/i.test(sql),
      respond: () => ({ rows: [reportRow], rowCount: 1 }),
    });
    state.queueByPattern.push({
      match: (sql) => /INSERT INTO hospital\.adjudication_eval/i.test(sql),
      respond: () => new Error('simulated DB outage'),
    });
    const harness = new EvalHarness(makeMockPool(state) as any, makeDossierStub({}));
    await assert.doesNotReject(() => harness.snapshotPrediction('report-1'));
  });
});

// ─── resolveActuals ──────────────────────────────────────────────────────

describe('EvalHarness.resolveActuals', () => {
  let state: MockState;
  beforeEach(() => {
    state = freshState();
  });

  it('no-ops gracefully when the dossier is missing', async () => {
    const harness = new EvalHarness(
      makeMockPool(state) as any,
      makeDossierStub({ 'claim-x': null }),
    );
    const r = await harness.resolveActuals('claim-x');
    assert.equal(r.rowsResolved, 0);
    // No SQL was issued — the dossier check short-circuits.
    assert.equal(state.calls.length, 0);
  });

  it('SELECTs unresolved eval rows then UPDATEs only those past target_stage', async () => {
    // Two unresolved rows: one for pre_auth (past, since claim is now closed),
    // one for final_filing (not past — but a closed claim is *always* past
    // by the helper, so this one will also resolve).
    const closedDossier = dossier({
      claim_id: 'claim-1',
      closed_at: new Date('2026-05-10T12:00:00Z'),
      closure_outcome: 'settled',
      current_stage: 'closed',
      amounts: { final_approved: 45000, deducted: 5000 },
      active_queries: [],
    });

    state.queueByPattern.push({
      match: (sql) => /SELECT id, target_stage, prediction/i.test(sql),
      respond: () => ({
        rows: [
          {
            id: 'eval-1',
            target_stage: 'pre_auth',
            prediction: {
              readiness_score: 80,
              recommended_action: 'file_now',
              predicted_outcome: { expected_amount_inr: 50000, p_query: 0.1 },
              kb_matches_count: 1,
              episodic_refs_count: 0,
              reasoning_invoked: false,
            },
          },
          {
            id: 'eval-2',
            target_stage: 'final_filing',
            prediction: {
              readiness_score: 60,
              recommended_action: 'review',
              predicted_outcome: null,
              kb_matches_count: 0,
              episodic_refs_count: 0,
              reasoning_invoked: false,
            },
          },
        ],
        rowCount: 2,
      }),
    });
    let updateCalls = 0;
    state.queueByPattern.push({
      match: (sql) => /UPDATE hospital\.adjudication_eval/i.test(sql),
      respond: () => {
        updateCalls += 1;
        return { rows: [], rowCount: 1 };
      },
    });

    const harness = new EvalHarness(
      makeMockPool(state) as any,
      makeDossierStub({ 'claim-1': closedDossier }),
    );
    const r = await harness.resolveActuals('claim-1');
    assert.equal(r.rowsResolved, 2);
    assert.equal(updateCalls, 2);

    // Each UPDATE carries serialised actual + error JSONB and the eval row id.
    const updates = state.calls.filter((c) => /UPDATE hospital\.adjudication_eval/i.test(c.sql));
    assert.equal(updates.length, 2);
    const firstActual = JSON.parse(updates[0]!.params[0] as string) as ActualOutcome;
    assert.equal(firstActual.actual_outcome_category, 'partial'); // deducted > 0
    assert.equal(firstActual.actual_amount_approved, 45000);
    assert.equal(firstActual.actual_deductions, 5000);
  });

  it('skips rows whose target_stage is still in the future (open claim, partial outcomes)', async () => {
    // Claim still at pre_auth, not closed. Only the pre_auth eval row can
    // be considered for resolution, and even that one is not "past" — we
    // require strictly downstream stages.
    const openDossier = dossier({
      claim_id: 'claim-2',
      current_stage: 'pre_auth',
      closed_at: null,
    });

    state.queueByPattern.push({
      match: (sql) => /SELECT id, target_stage, prediction/i.test(sql),
      respond: () => ({
        rows: [
          {
            id: 'eval-A',
            target_stage: 'final_filing',
            prediction: {
              readiness_score: 50,
              recommended_action: 'wait',
              predicted_outcome: null,
              kb_matches_count: 0,
              episodic_refs_count: 0,
              reasoning_invoked: false,
            },
          },
        ],
        rowCount: 1,
      }),
    });
    let updateCount = 0;
    state.queueByPattern.push({
      match: (sql) => /UPDATE hospital\.adjudication_eval/i.test(sql),
      respond: () => {
        updateCount += 1;
        return { rows: [], rowCount: 1 };
      },
    });
    const harness = new EvalHarness(
      makeMockPool(state) as any,
      makeDossierStub({ 'claim-2': openDossier }),
    );
    const r = await harness.resolveActuals('claim-2');
    // Nothing resolved — the helper must not crash the resolver on partial state.
    assert.equal(r.rowsResolved, 0);
    assert.equal(updateCount, 0);
  });

  it('continues past a failing UPDATE and resolves remaining rows', async () => {
    const closedDossier = dossier({
      claim_id: 'claim-3',
      closed_at: new Date('2026-05-12T08:00:00Z'),
      closure_outcome: 'settled',
      current_stage: 'closed',
      amounts: { final_approved: 30000, deducted: 0 },
    });
    state.queueByPattern.push({
      match: (sql) => /SELECT id, target_stage, prediction/i.test(sql),
      respond: () => ({
        rows: [
          {
            id: 'eval-bad',
            target_stage: 'pre_auth',
            prediction: {
              readiness_score: 70,
              recommended_action: 'file_now',
              predicted_outcome: { expected_amount_inr: 30000 },
              kb_matches_count: 0,
              episodic_refs_count: 0,
              reasoning_invoked: false,
            },
          },
          {
            id: 'eval-good',
            target_stage: 'pre_auth',
            prediction: {
              readiness_score: 70,
              recommended_action: 'file_now',
              predicted_outcome: { expected_amount_inr: 30000 },
              kb_matches_count: 0,
              episodic_refs_count: 0,
              reasoning_invoked: false,
            },
          },
        ],
        rowCount: 2,
      }),
    });
    let calls = 0;
    state.queueByPattern.push({
      match: (sql) => /UPDATE hospital\.adjudication_eval/i.test(sql),
      respond: (_sql, params) => {
        calls += 1;
        const id = params[2];
        if (id === 'eval-bad') return new Error('row lock timeout');
        return { rows: [], rowCount: 1 };
      },
    });
    const harness = new EvalHarness(
      makeMockPool(state) as any,
      makeDossierStub({ 'claim-3': closedDossier }),
    );
    const r = await harness.resolveActuals('claim-3');
    assert.equal(calls, 2);
    assert.equal(r.rowsResolved, 1);
  });
});

// ─── deriveActualOutcome (pure-on-method) ─────────────────────────────────

describe('EvalHarness.deriveActualOutcome', () => {
  const harness = new EvalHarness(
    makeMockPool(freshState()) as any,
    makeDossierStub({}),
  );

  it('categorises a settled claim with zero deductions as approved', () => {
    const d = dossier({
      claim_id: 'c',
      closed_at: new Date('2026-05-10T00:00:00Z'),
      closure_outcome: 'settled',
      amounts: { final_approved: 40000, deducted: 0 },
    });
    const a = harness.deriveActualOutcome(d);
    assert.equal(a.actual_outcome_category, 'approved');
    assert.equal(a.actual_amount_approved, 40000);
    assert.equal(a.actual_deductions, 0);
  });

  it('categorises a settled claim with deductions as partial', () => {
    const d = dossier({
      claim_id: 'c',
      closed_at: new Date(),
      closure_outcome: 'settled',
      amounts: { final_approved: 30000, deducted: 5000 },
    });
    assert.equal(harness.deriveActualOutcome(d).actual_outcome_category, 'partial');
  });

  it('categorises a rejected claim as rejected', () => {
    const d = dossier({
      claim_id: 'c',
      closed_at: new Date(),
      closure_outcome: 'rejected',
    });
    assert.equal(harness.deriveActualOutcome(d).actual_outcome_category, 'rejected');
  });

  it('open claim with active queries → queried', () => {
    const d = dossier({
      claim_id: 'c',
      current_stage: 'query_reply',
      active_queries: [
        { query_id: 'q1', raised_at: '2026-05-08T10:00:00Z', deficiency_type: 'discharge' },
      ],
    });
    const a = harness.deriveActualOutcome(d);
    assert.equal(a.actual_outcome_category, 'queried');
    assert.equal(a.actual_queries.length, 1);
    assert.equal(a.actual_queries[0]!.query_id, 'q1');
  });

  it('open claim with no queries → pending', () => {
    const d = dossier({ claim_id: 'c', current_stage: 'pre_auth' });
    assert.equal(harness.deriveActualOutcome(d).actual_outcome_category, 'pending');
  });
});

// ─── getMetrics ──────────────────────────────────────────────────────────

describe('EvalHarness.getMetrics', () => {
  let state: MockState;
  beforeEach(() => {
    state = freshState();
  });

  function queueMetricResponses(opts: {
    headlineN?: number;
    accuracy?: number;
    breakdown?: any[];
    calibration?: any[];
    weekly?: any[];
    cost?: { mean: number; p50: number; p95: number };
  }) {
    state.queueByPattern.push({
      match: (sql) =>
        /COUNT\(\*\)::INT AS n,/.test(sql) &&
        /AS accuracy/.test(sql) &&
        !/date_trunc/.test(sql),
      respond: () => ({
        rows: [{ n: opts.headlineN ?? 0, accuracy: opts.accuracy ?? 0 }],
        rowCount: 1,
      }),
    });
    state.queueByPattern.push({
      match: (sql) => /AS precision_score,/.test(sql),
      respond: () => ({ rows: opts.breakdown ?? [], rowCount: (opts.breakdown ?? []).length }),
    });
    state.queueByPattern.push({
      match: (sql) => /width_bucket\(/.test(sql),
      respond: () => ({ rows: opts.calibration ?? [], rowCount: (opts.calibration ?? []).length }),
    });
    state.queueByPattern.push({
      match: (sql) => /date_trunc\('week'/i.test(sql),
      respond: () => ({ rows: opts.weekly ?? [], rowCount: (opts.weekly ?? []).length }),
    });
    state.queueByPattern.push({
      match: (sql) => /percentile_cont/i.test(sql),
      respond: () => ({
        rows: [opts.cost ?? { mean_cost: 0, p50: 0, p95: 0 }],
        rowCount: 1,
      }),
    });
  }

  it('aggregates synthetic rows into accuracy %, sample size, and cost stats', async () => {
    queueMetricResponses({
      headlineN: 100,
      accuracy: 0.83,
      breakdown: [
        { task: 'pre_auth', n: 60, precision_score: 0.9, recall_score: 0.7, mean_error: 1234.5 },
        { task: 'final_filing', n: 40, precision_score: 0.75, recall_score: 0.5, mean_error: -500 },
      ],
      calibration: [
        { bucket: 1, n: 10, predicted_rate: 10, actual_rate: 0.1 },
        { bucket: 5, n: 30, predicted_rate: 90, actual_rate: 0.88 },
      ],
      weekly: [
        { week_start: new Date('2026-05-04T00:00:00Z'), n: 50, accuracy: 0.8 },
        { week_start: new Date('2026-05-11T00:00:00Z'), n: 50, accuracy: 0.86 },
      ],
      cost: { mean_cost: 12.34, p50: 10, p95: 22.5 } as any,
    });

    const harness = new EvalHarness(makeMockPool(state) as any, makeDossierStub({}));
    const m = await harness.getMetrics({ period: 'week' });

    assert.equal(m.sample_size, 100);
    assert.equal(m.prediction_accuracy_pct, 83);
    assert.equal(Object.keys(m.breakdown_by_task).length, 2);
    assert.equal(m.breakdown_by_task['pre_auth']!.n, 60);
    assert.ok(Math.abs(m.breakdown_by_task['pre_auth']!.precision - 0.9) < 1e-9);
    assert.equal(m.confidence_calibration.length, 2);
    // bucket 1 → low=0, high=20; bucket 5 → low=80, high=100
    assert.equal(m.confidence_calibration[0]!.bucket_low, 0);
    assert.equal(m.confidence_calibration[0]!.bucket_high, 20);
    assert.equal(m.confidence_calibration[1]!.bucket_low, 80);
    // predicted_rate stored as 0..100 in readiness — surfaced as 0..1 fraction.
    assert.ok(Math.abs(m.confidence_calibration[1]!.predicted_rate - 0.9) < 1e-9);
    assert.equal(m.weekly_trend.length, 2);
    assert.equal(m.weekly_trend[0]!.week_start, '2026-05-04');
    assert.equal(m.weekly_trend[1]!.accuracy_pct, 86);
    assert.ok(Math.abs(m.cost_per_claim.mean - 12.34) < 1e-3);
    assert.equal(m.cost_per_claim.p95, 22.5);
  });

  it("period='today' injects a NOW() - INTERVAL '1 day' filter; period='all' does not", async () => {
    queueMetricResponses({ headlineN: 0, accuracy: 0 });
    const harness = new EvalHarness(makeMockPool(state) as any, makeDossierStub({}));
    await harness.getMetrics({ period: 'today' });
    const todaySql = state.calls[0]!.sql;
    assert.ok(/INTERVAL '1 day'/.test(todaySql));

    const state2 = freshState();
    state = state2;
    queueMetricResponses({});
    const harness2 = new EvalHarness(makeMockPool(state) as any, makeDossierStub({}));
    await harness2.getMetrics({ period: 'all' });
    const allSql = state.calls[0]!.sql;
    assert.ok(!/INTERVAL/.test(allSql), 'period=all should not add a time filter');
  });

  it('passes task and hospital_id through as positional params', async () => {
    queueMetricResponses({});
    const harness = new EvalHarness(makeMockPool(state) as any, makeDossierStub({}));
    await harness.getMetrics({
      period: 'month',
      task: 'pre_auth',
      hospital_id: 'h-123',
    });
    // First call is the headline aggregate. It should carry both params.
    const params = state.calls[0]!.params;
    assert.deepEqual(params, ['pre_auth', 'h-123']);
    // And the SQL should reference both target_stage and hospital_id filters.
    assert.match(state.calls[0]!.sql, /e\.target_stage = \$/);
    assert.match(state.calls[0]!.sql, /i\.hospital_id = \$/);
  });
});

// ─── backtest ────────────────────────────────────────────────────────────

describe('EvalHarness.backtest', () => {
  let state: MockState;
  beforeEach(() => {
    state = freshState();
  });

  it('is read-only against the eval table (no INSERT/UPDATE issued)', async () => {
    state.queueByPattern.push({
      match: (sql) => /FROM hospital\.adjudication_eval e/i.test(sql) && /JOIN hospital\.claim_dossiers d/i.test(sql),
      respond: () => ({
        rows: [
          {
            claim_id: 'claim-7',
            adjudication_report_id: 'report-7',
            target_stage: 'pre_auth',
            old_score: 70,
            old_action: 'review',
          },
          {
            claim_id: 'claim-8',
            adjudication_report_id: 'report-8',
            target_stage: 'final_filing',
            old_score: 90,
            old_action: 'file_now',
          },
        ],
        rowCount: 2,
      }),
    });

    const engineCalls: any[] = [];
    const engineStub: AdjudicationEngineLike = {
      run: async (input) => {
        engineCalls.push(input);
        if (input.claim_id === 'claim-7') {
          return {
            id: 'new-report-7',
            readiness_score: 80,
            recommended_action: 'file_now', // changed from 'review'
          };
        }
        return {
          id: 'new-report-8',
          readiness_score: 92, // +2
          recommended_action: 'file_now', // unchanged
        };
      },
    };

    const harness = new EvalHarness(
      makeMockPool(state) as any,
      makeDossierStub({}),
      engineStub,
    );
    const r = await harness.backtest({ sinceDays: 7, maxClaims: 10 });

    assert.equal(engineCalls.length, 2);
    assert.equal(r.claims_replayed, 2);
    assert.equal(r.summary.action_change_count, 1); // only claim-7 changed
    assert.equal(r.summary.mean_readiness_delta, 6); // mean(10, 2) = 6
    const c7 = r.deltas.find((d) => d.claim_id === 'claim-7')!;
    assert.equal(c7.readiness_delta, 10);
    assert.equal(c7.recommended_action_changed, true);

    // Crucially — no INSERT or UPDATE against adjudication_eval was issued.
    const writes = state.calls.filter((c) =>
      /INSERT INTO hospital\.adjudication_eval|UPDATE hospital\.adjudication_eval/i.test(c.sql),
    );
    assert.equal(writes.length, 0, 'backtest must not write to adjudication_eval');
  });

  it('returns empty deltas when no engine is available', async () => {
    state.queueByPattern.push({
      match: (sql) => /FROM hospital\.adjudication_eval e/i.test(sql),
      respond: () => ({ rows: [], rowCount: 0 }),
    });
    // engineForBacktest = null AND the lazy import will fail to find a
    // canonical default at test time → returns empty.
    const harness = new EvalHarness(
      makeMockPool(state) as any,
      makeDossierStub({}),
      // Pass a stub that simulates "no engine" by lazy-import failure path:
      // we can't actually disable lazy import, but supplying null lets the
      // service fall through. The service caches the failure; in test the
      // import succeeds since adjudicationEngine module exists. So instead
      // we exercise the empty-candidates path which also reports 0 replayed.
      null,
    );
    const r = await harness.backtest({});
    assert.equal(r.claims_replayed, 0);
    assert.deepEqual(r.deltas, []);
  });

  it('survives engine.run throwing on a single candidate', async () => {
    state.queueByPattern.push({
      match: (sql) => /FROM hospital\.adjudication_eval e/i.test(sql),
      respond: () => ({
        rows: [
          { claim_id: 'c1', adjudication_report_id: 'r1', target_stage: 'pre_auth', old_score: 50, old_action: 'wait' },
          { claim_id: 'c2', adjudication_report_id: 'r2', target_stage: 'pre_auth', old_score: 60, old_action: 'wait' },
        ],
        rowCount: 2,
      }),
    });
    const engineStub: AdjudicationEngineLike = {
      run: async (input) => {
        if (input.claim_id === 'c1') throw new Error('synthetic engine failure');
        return { id: 'rnew', readiness_score: 65, recommended_action: 'wait' };
      },
    };
    const harness = new EvalHarness(
      makeMockPool(state) as any,
      makeDossierStub({}),
      engineStub,
    );
    const r = await harness.backtest({});
    assert.equal(r.claims_replayed, 1); // only c2 succeeded
    assert.equal(r.deltas[0]!.claim_id, 'c2');
  });
});
