/**
 * Eval Harness Service — Sprint 4, Wave 5A
 *
 * The harness keeps an honest score on the intelligence layer's predictions.
 * Three responsibilities:
 *
 *   1. snapshotPrediction(reportId)
 *      Triggered when AdjudicationEngine writes a fresh report. We freeze
 *      {readiness, recommended_action, predicted_outcome, KB/episodic
 *      counts, reasoning flag, prompt versions, total claim spend so far}
 *      into hospital.adjudication_eval. From this moment on, that row is
 *      the truth-of-record for "what we predicted at decision time".
 *
 *   2. resolveActuals(claim_id, stage_reached?)
 *      Triggered when the claim moves past target_stage or closes. For
 *      every unresolved eval row whose target_stage is now in the past,
 *      derive the observed actual_outcome from the dossier and compute
 *      prediction_error against the frozen snapshot.
 *
 *   3. getMetrics(opts) / backtest(opts)
 *      Aggregations and offline replay. Read-only beyond the snapshot +
 *      resolve writes above.
 *
 * Read shape, not contract: the engine, dossier, rules engine, and reasoning
 * agent are NOT modified by this lane. We consume their public outputs.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ INTEGRATION TODO (adjudicationEngine.service.ts)                     ║
 * ║                                                                      ║
 * ║ snapshotPrediction expects to be called once, right after a fresh    ║
 * ║ adjudication_report is written. Two integration paths exist:         ║
 * ║                                                                      ║
 * ║   (preferred) Event-driven via Workers/evalHarnessTriggers.ts —      ║
 * ║   the trigger subscribes to the 'adjudication_run' event the engine  ║
 * ║   already dispatches (see                                            ║
 * ║   Services/adjudicationEngine.service.ts run() step (l)). No engine  ║
 * ║   modification needed; this is the path Wave 5A ships.               ║
 * ║                                                                      ║
 * ║   (alternative) Inline call inside AdjudicationEngine.run() right    ║
 * ║   after insertOrFetch returns. Considered and rejected — it couples  ║
 * ║   the engine to the eval table and would require modifying           ║
 * ║   adjudicationEngine.service.ts.                                     ║
 * ║                                                                      ║
 * ║ resolveActuals expects to be called when the claim's stage advances. ║
 * ║ Two integration paths exist:                                         ║
 * ║                                                                      ║
 * ║   (preferred) Event-driven via Workers/evalHarnessTriggers.ts        ║
 * ║   subscribing to 'stage_transitioned' and 'claim_closed' events.     ║
 * ║                                                                      ║
 * ║   (alternative) Run nightly inside Workers/evalHarness.cron.ts for   ║
 * ║   every claim closed today — bridges the gap if the event listener   ║
 * ║   misses a fire.                                                     ║
 * ║                                                                      ║
 * ║ Both paths are present in Wave 5A. The integration sprint mounts     ║
 * ║ them via startEvalHarnessTriggers() + the cron's startup hook.       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import type { Pool } from 'pg';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import claimDossierService from './claimDossier.service.js';
import type { ClaimDossier } from './claimDossier.service.js';
import {
  ENGINE_VERSION,
  RULES_VERSION,
} from './adjudicationEngine.service.js';

// ─── Public types ────────────────────────────────────────────────────────

export interface PredictionSnapshot {
  readiness_score: number;
  recommended_action: string;
  predicted_outcome: unknown | null;
  kb_matches_count: number;
  episodic_refs_count: number;
  reasoning_invoked: boolean;
}

export interface ActualOutcome {
  actual_outcome_category:
    | 'approved'
    | 'queried'
    | 'rejected'
    | 'withdrawn'
    | 'partial'
    | 'pending';
  actual_amount_approved: number | null;
  actual_deductions: number | null;
  actual_queries: Array<{
    query_id?: string;
    raised_at?: string;
    resolved_at?: string | null;
    deficiency_type?: string | null;
  }>;
  time_to_response_hours: number | null;
}

export interface PredictionError {
  amount_error_inr: number | null;
  amount_error_pct: number | null;
  predicted_action_correct: boolean | null;
  predicted_query_correct: boolean | null;
  readiness_calibrated: boolean | null;
  notes: string | null;
}

export interface GetMetricsOpts {
  period: 'today' | 'week' | 'month' | 'all';
  task?: string;
  rules_version?: string;
  engine_version?: string;
  hospital_id?: string;
}

export interface MetricsResult {
  sample_size: number;
  prediction_accuracy_pct: number;
  breakdown_by_task: Record<
    string,
    { precision: number; recall: number; mean_error: number; n: number }
  >;
  confidence_calibration: Array<{
    bucket_low: number;
    bucket_high: number;
    predicted_rate: number;
    actual_rate: number;
    n: number;
  }>;
  weekly_trend: Array<{
    week_start: string;
    accuracy_pct: number;
    n: number;
  }>;
  cost_per_claim: { mean: number; p50: number; p95: number };
}

export interface BacktestOpts {
  sinceDays?: number;
  maxClaims?: number;
  rules_version?: string;
}

export interface BacktestDelta {
  claim_id: string;
  old_report_id: string;
  new_report: unknown;
  readiness_delta: number;
  recommended_action_changed: boolean;
}

export interface BacktestResult {
  claims_replayed: number;
  deltas: BacktestDelta[];
  summary: {
    mean_readiness_delta: number;
    action_change_count: number;
  };
}

// ─── Internal dependency contracts ───────────────────────────────────────
// Kept narrow so the constructor can accept stubs in tests.

export interface DossierServiceLike {
  getDossier(claim_id: string): Promise<ClaimDossier | null>;
}

export interface AdjudicationEngineLike {
  run(input: {
    claim_id: string;
    target_stage?: string;
    force?: boolean;
  }): Promise<{
    id: string;
    readiness_score: number;
    recommended_action: string;
    [k: string]: unknown;
  }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Period → SQL `WHERE recorded_at >= $N` predicate. Returned as a parameter
 * value (caller binds), or null when period='all' (no filter).
 *
 * Time math is anchored on NOW() inside the SQL to avoid clock skew between
 * the app server and the DB — we don't compute a JS Date here.
 */
function periodToIntervalSql(
  period: GetMetricsOpts['period'],
): string | null {
  switch (period) {
    case 'today':
      return "NOW() - INTERVAL '1 day'";
    case 'week':
      return "NOW() - INTERVAL '7 days'";
    case 'month':
      return "NOW() - INTERVAL '30 days'";
    case 'all':
    default:
      return null;
  }
}

/**
 * Map a claim's terminal/in-flight state to an outcome category.
 *
 * Order of checks matters: a closed claim's terminal outcome wins over
 * any open-query state.
 */
function categoriseOutcome(
  dossier: ClaimDossier,
): ActualOutcome['actual_outcome_category'] {
  if (dossier.closed_at && dossier.closure_outcome) {
    if (dossier.closure_outcome === 'settled') {
      // Partial vs full settlement — if any deduction recorded, it's
      // "partial" for prediction purposes; the dashboard treats partial
      // the same as approved for action-correct counting but separately
      // for amount-error.
      const ded = Number(dossier.amounts?.deducted ?? 0);
      return ded > 0 ? 'partial' : 'approved';
    }
    return dossier.closure_outcome === 'rejected' ? 'rejected' : 'withdrawn';
  }
  if ((dossier.active_queries ?? []).length > 0) return 'queried';
  return 'pending';
}

/**
 * Derive observed amount-approved and deductions from the dossier amounts
 * blob. The dossier has a flat shape with stage-specific amounts; we
 * surface the most-mature value available.
 */
function deriveAmounts(dossier: ClaimDossier): {
  approved: number | null;
  deductions: number | null;
} {
  const a = dossier.amounts ?? {};
  const approved =
    (a.final_approved as number | null | undefined) ??
    (a.enhancement_approved as number | null | undefined) ??
    (a.pre_auth_approved as number | null | undefined) ??
    null;
  const deductions = (a.deducted as number | null | undefined) ?? null;
  return {
    approved: typeof approved === 'number' && Number.isFinite(approved) ? approved : null,
    deductions:
      typeof deductions === 'number' && Number.isFinite(deductions) ? deductions : null,
  };
}

/**
 * Compute prediction_error given prediction + actual. Each field is null
 * when not derivable — the caller persists nulls verbatim.
 */
export function computePredictionError(
  prediction: PredictionSnapshot,
  actual: ActualOutcome,
): PredictionError {
  // amount error: predicted_outcome.expected_amount_inr vs
  // actual.actual_amount_approved. Only meaningful when both exist.
  const predAmount =
    prediction.predicted_outcome &&
    typeof (prediction.predicted_outcome as any).expected_amount_inr === 'number'
      ? (prediction.predicted_outcome as any).expected_amount_inr
      : null;
  const actAmount = actual.actual_amount_approved;
  const amount_error_inr =
    predAmount !== null && actAmount !== null ? actAmount - predAmount : null;
  const amount_error_pct =
    amount_error_inr !== null && predAmount && predAmount > 0
      ? amount_error_inr / predAmount
      : null;

  // action correctness — we say the recommended_action was "correct" when:
  //   file_now → outcome was approved or partial (we'd have lost time on a
  //     spurious request_doc)
  //   request_doc → outcome had queries OR rejected (the suggestion to
  //     stop and gather more docs was vindicated)
  //   review → ambiguous; we can't score this. Leave null.
  //   wait → outcome was approved without intervention (we correctly held)
  //   escalate_to_human → not auto-scorable, leave null.
  let predicted_action_correct: boolean | null = null;
  const outcome = actual.actual_outcome_category;
  switch (prediction.recommended_action) {
    case 'file_now':
      predicted_action_correct =
        outcome === 'approved' || outcome === 'partial';
      break;
    case 'request_doc':
      predicted_action_correct =
        outcome === 'queried' || outcome === 'rejected';
      break;
    case 'wait':
      predicted_action_correct = outcome === 'approved';
      break;
    default:
      predicted_action_correct = null;
  }

  // query-prediction correctness — derived from predicted_outcome.p_query
  // when present. Threshold: p_query >= 0.5 → "we expected a query".
  let predicted_query_correct: boolean | null = null;
  const pQuery =
    prediction.predicted_outcome &&
    typeof (prediction.predicted_outcome as any).p_query === 'number'
      ? (prediction.predicted_outcome as any).p_query
      : null;
  if (pQuery !== null) {
    const predictedQuery = pQuery >= 0.5;
    const actualHadQuery =
      outcome === 'queried' || (actual.actual_queries?.length ?? 0) > 0;
    predicted_query_correct = predictedQuery === actualHadQuery;
  }

  // readiness calibration: high score + good outcome OR low score + bad
  // outcome → calibrated. Threshold at 70 — anything else is "not
  // calibrated".
  let readiness_calibrated: boolean | null = null;
  if (outcome !== 'pending') {
    const goodOutcome = outcome === 'approved' || outcome === 'partial';
    readiness_calibrated =
      (prediction.readiness_score >= 70 && goodOutcome) ||
      (prediction.readiness_score < 70 && !goodOutcome);
  }

  const notes =
    outcome === 'pending'
      ? 'outcome still pending — partial resolution; revisit when claim closes'
      : null;

  return {
    amount_error_inr,
    amount_error_pct,
    predicted_action_correct,
    predicted_query_correct,
    readiness_calibrated,
    notes,
  };
}

/**
 * The set of stages we consider "downstream of" a given target_stage. When
 * the claim reaches one of these, the target_stage's prediction can be
 * resolved.
 *
 * Order is intentionally cumulative: each stage's downstream includes all
 * later stages. The check is "is current_stage in (target's downstream
 * set)?".
 */
const STAGE_ORDER: string[] = [
  'pre_auth',
  'pre_auth_pending',
  'query_reply',
  'approved',
  'enhancement',
  'discharge_filing',
  'final_filing',
  'closed',
];

function isPastTargetStage(
  target_stage: string,
  current_stage: string | null,
  closed: boolean,
): boolean {
  if (closed) return true;
  if (!current_stage) return false;
  const tIdx = STAGE_ORDER.indexOf(target_stage);
  const cIdx = STAGE_ORDER.indexOf(current_stage);
  if (tIdx === -1 || cIdx === -1) return false;
  return cIdx > tIdx;
}

// ─── Service ─────────────────────────────────────────────────────────────

interface EvalRow {
  id: string;
  claim_id: string;
  adjudication_report_id: string;
  target_stage: string;
  prediction: PredictionSnapshot;
  actual_outcome: ActualOutcome | null;
  prediction_error: PredictionError | null;
  rules_version: string;
  engine_version: string;
  prompts_versions: Record<string, string>;
  kb_pattern_ids: string[];
  episodic_case_ids: string[];
  reasoning_cost_inr: number | null;
  total_claim_cost_inr: number | null;
  recorded_at: Date;
  resolved_at: Date | null;
}

export class EvalHarness {
  constructor(
    private readonly pool: Pick<Pool, 'query'> = defaultPool,
    private readonly dossiers: DossierServiceLike = claimDossierService,
    /**
     * Constructor-injectable engine for backtest. Defaults to a lazy
     * dynamic-import of the canonical AdjudicationEngine singleton so
     * production code doesn't pay the cost when only snapshot/resolve are
     * exercised. Tests inject a stub directly.
     */
    private readonly engineForBacktest: AdjudicationEngineLike | null = null,
  ) {}

  // ────────────────────────────────────────────────────────────────────
  // snapshotPrediction
  // ────────────────────────────────────────────────────────────────────

  /**
   * Freeze a prediction snapshot for an adjudication_report.
   *
   * Idempotent: the UNIQUE(adjudication_report_id) constraint plus
   * ON CONFLICT DO NOTHING means concurrent triggers collapse to one
   * row. We still log the conflict at debug level.
   */
  async snapshotPrediction(reportId: string): Promise<void> {
    // (a) Load the report + the claim's cost ledger in one round trip.
    const sql = `
      SELECT
        r.id, r.claim_id, r.target_stage,
        r.readiness_score, r.recommended_action,
        r.predicted_outcome, r.kb_matches, r.episodic_refs,
        r.reasoning, r.citations,
        r.rules_version, r.engine_version,
        (
          SELECT COALESCE(SUM(c.cost_inr), 0)
            FROM hospital.llm_cost_log c
           WHERE c.claim_id = r.claim_id
        ) AS total_cost,
        (
          SELECT COALESCE(SUM(c.cost_inr), 0)
            FROM hospital.llm_cost_log c
           WHERE c.claim_id = r.claim_id
             AND c.task = 'reasoning_agent'
             AND c.created_at >= r.generated_at - INTERVAL '1 minute'
             AND c.created_at <= r.generated_at + INTERVAL '5 minutes'
        ) AS reasoning_cost
      FROM hospital.adjudication_reports r
      WHERE r.id = $1
      LIMIT 1
    `;
    const res = await this.pool.query<any>(sql, [reportId]);
    if ((res.rowCount ?? 0) === 0) {
      logger.warn(
        { reportId },
        'evalHarness.snapshotPrediction: no adjudication_report row — skipping',
      );
      return;
    }
    const r = res.rows[0];

    const kb_matches = Array.isArray(r.kb_matches) ? r.kb_matches : [];
    const episodic_refs = Array.isArray(r.episodic_refs) ? r.episodic_refs : [];
    const citations = (r.citations ?? {}) as {
      pattern_ids?: string[];
      case_ids?: string[];
    };

    const prediction: PredictionSnapshot = {
      readiness_score: Number(r.readiness_score ?? 0),
      recommended_action: String(r.recommended_action ?? 'review'),
      predicted_outcome: r.predicted_outcome ?? null,
      kb_matches_count: kb_matches.length,
      episodic_refs_count: episodic_refs.length,
      reasoning_invoked:
        typeof r.reasoning === 'string' && r.reasoning.length > 0,
    };

    // Prompt-version snapshot: we lazy-import the version constants from
    // the relevant services. Best-effort — any module that fails to
    // import contributes a 'unknown' to the snapshot rather than blowing
    // up the entire snapshot.
    const prompts_versions = await collectPromptVersions();

    const kb_pattern_ids = Array.isArray(citations.pattern_ids)
      ? citations.pattern_ids.filter((x) => typeof x === 'string')
      : [];
    const episodic_case_ids = Array.isArray(citations.case_ids)
      ? citations.case_ids.filter((x) => typeof x === 'string')
      : [];

    const reasoning_cost_inr = Number(r.reasoning_cost ?? 0);
    const total_claim_cost_inr = Number(r.total_cost ?? 0);

    const insertSql = `
      INSERT INTO hospital.adjudication_eval (
        claim_id, adjudication_report_id, target_stage,
        prediction, rules_version, engine_version,
        prompts_versions, kb_pattern_ids, episodic_case_ids,
        reasoning_cost_inr, total_claim_cost_inr
      ) VALUES (
        $1, $2, $3,
        $4::jsonb, $5, $6,
        $7::jsonb, $8::uuid[], $9::uuid[],
        $10, $11
      )
      ON CONFLICT ON CONSTRAINT uq_eval_report DO NOTHING
    `;
    try {
      const ins = await this.pool.query(insertSql, [
        r.claim_id,
        r.id,
        r.target_stage,
        JSON.stringify(prediction),
        r.rules_version,
        r.engine_version,
        JSON.stringify(prompts_versions),
        kb_pattern_ids,
        episodic_case_ids,
        reasoning_cost_inr,
        total_claim_cost_inr,
      ]);
      if ((ins.rowCount ?? 0) === 0) {
        logger.debug(
          { reportId },
          'evalHarness.snapshotPrediction: row already existed (conflict swallowed)',
        );
      }
    } catch (err) {
      // Eval is observability-only; never poison the upstream path.
      logger.warn(
        { err, reportId },
        'evalHarness.snapshotPrediction: insert failed',
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // resolveActuals
  // ────────────────────────────────────────────────────────────────────

  /**
   * Walk unresolved eval rows for a claim and back-fill actual_outcome +
   * prediction_error for those whose target_stage is now in the past.
   *
   * Returns the count of rows resolved this call. Idempotent: rows
   * already resolved are skipped via the WHERE clause.
   */
  async resolveActuals(
    claim_id: string,
    _stage_reached?: string,
  ): Promise<{ rowsResolved: number }> {
    const dossier = await this.dossiers.getDossier(claim_id);
    if (!dossier) {
      logger.debug(
        { claim_id },
        'evalHarness.resolveActuals: dossier missing — nothing to resolve',
      );
      return { rowsResolved: 0 };
    }

    const closed = !!dossier.closed_at;
    const current_stage = dossier.current_stage;

    // Fetch every unresolved row for this claim.
    const fetch = await this.pool.query<{
      id: string;
      target_stage: string;
      prediction: PredictionSnapshot;
    }>(
      `SELECT id, target_stage, prediction
         FROM hospital.adjudication_eval
        WHERE claim_id = $1
          AND resolved_at IS NULL`,
      [claim_id],
    );

    let rowsResolved = 0;

    for (const row of fetch.rows) {
      if (!isPastTargetStage(row.target_stage, current_stage, closed)) continue;

      const actual = this.deriveActualOutcome(dossier);
      const error = computePredictionError(row.prediction, actual);

      try {
        const upd = await this.pool.query(
          `UPDATE hospital.adjudication_eval
              SET actual_outcome   = $1::jsonb,
                  prediction_error = $2::jsonb,
                  resolved_at      = NOW()
            WHERE id = $3
              AND resolved_at IS NULL`,
          [JSON.stringify(actual), JSON.stringify(error), row.id],
        );
        if ((upd.rowCount ?? 0) > 0) rowsResolved += 1;
      } catch (err) {
        logger.warn(
          { err, eval_id: row.id, claim_id },
          'evalHarness.resolveActuals: row update failed',
        );
      }
    }

    if (rowsResolved > 0) {
      logger.info(
        { claim_id, rowsResolved },
        'evalHarness.resolveActuals: rows resolved',
      );
    }

    return { rowsResolved };
  }

  /**
   * Pure (testable) derivation of the actual outcome from a dossier
   * snapshot. Exposed as a method so tests can call it directly without
   * touching the DB.
   */
  deriveActualOutcome(dossier: ClaimDossier): ActualOutcome {
    const category = categoriseOutcome(dossier);
    const { approved, deductions } = deriveAmounts(dossier);

    // Build the queries list with raised/resolved timestamps where we
    // have them (Wave 1 only carries raised_at; resolved_at is implied
    // by a query disappearing from active_queries — we can't recover
    // that fact from the current dossier shape, so we leave it null).
    const queries = (dossier.active_queries ?? []).map((q) => ({
      query_id: q.query_id,
      raised_at: q.raised_at,
      resolved_at: null,
      deficiency_type: q.deficiency_type ?? null,
    }));

    // time_to_response: from the most recent inbound query to closure or
    // now. Best-effort: only computable when the dossier carries query
    // raised_at timestamps and a closed_at.
    let time_to_response_hours: number | null = null;
    if (dossier.closed_at && queries.length > 0) {
      const lastRaised = queries
        .map((q) => (q.raised_at ? new Date(q.raised_at).getTime() : 0))
        .reduce((a, b) => Math.max(a, b), 0);
      if (lastRaised > 0) {
        time_to_response_hours =
          (dossier.closed_at.getTime() - lastRaised) / (1000 * 60 * 60);
      }
    }

    return {
      actual_outcome_category: category,
      actual_amount_approved: approved,
      actual_deductions: deductions,
      actual_queries: queries,
      time_to_response_hours,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // getMetrics
  // ────────────────────────────────────────────────────────────────────

  async getMetrics(opts: GetMetricsOpts): Promise<MetricsResult> {
    const interval = periodToIntervalSql(opts.period);
    const where: string[] = ['e.resolved_at IS NOT NULL'];
    const params: unknown[] = [];

    if (interval) {
      where.push(`e.recorded_at >= ${interval}`);
    }
    if (opts.task) {
      params.push(opts.task);
      where.push(`e.target_stage = $${params.length}`);
    }
    if (opts.rules_version) {
      params.push(opts.rules_version);
      where.push(`e.rules_version = $${params.length}`);
    }
    if (opts.engine_version) {
      params.push(opts.engine_version);
      where.push(`e.engine_version = $${params.length}`);
    }
    if (opts.hospital_id) {
      params.push(opts.hospital_id);
      // ipds carries hospital_id — join to filter by hospital.
      where.push(`i.hospital_id = $${params.length}`);
    }
    const whereSql = where.join(' AND ');

    // (a) Headline: prediction_accuracy = mean(predicted_action_correct == true)
    //     over rows where predicted_action_correct IS NOT NULL.
    const headlineSql = `
      SELECT
        COUNT(*)::INT AS n,
        COALESCE(
          AVG(
            CASE WHEN (e.prediction_error->>'predicted_action_correct')::BOOLEAN THEN 1.0
                 WHEN e.prediction_error->>'predicted_action_correct' IS NULL THEN NULL
                 ELSE 0.0 END
          ),
          0
        )::FLOAT AS accuracy
      FROM hospital.adjudication_eval e
      JOIN hospital.ipds i ON i.id = e.claim_id
      WHERE ${whereSql}
    `;
    const headline = await this.pool.query<{ n: number; accuracy: number }>(
      headlineSql,
      params,
    );
    const sample_size = headline.rows[0]?.n ?? 0;
    const prediction_accuracy_pct = Number(
      ((headline.rows[0]?.accuracy ?? 0) * 100).toFixed(2),
    );

    // (b) Per-task breakdown.
    const breakdownSql = `
      SELECT
        e.target_stage AS task,
        COUNT(*)::INT AS n,
        AVG(
          CASE WHEN (e.prediction_error->>'predicted_action_correct')::BOOLEAN THEN 1.0
               WHEN e.prediction_error->>'predicted_action_correct' IS NULL THEN NULL
               ELSE 0.0 END
        )::FLOAT AS precision_score,
        AVG(
          CASE WHEN (e.prediction_error->>'predicted_query_correct')::BOOLEAN THEN 1.0
               WHEN e.prediction_error->>'predicted_query_correct' IS NULL THEN NULL
               ELSE 0.0 END
        )::FLOAT AS recall_score,
        AVG(NULLIF((e.prediction_error->>'amount_error_inr')::FLOAT, 'NaN')) AS mean_error
      FROM hospital.adjudication_eval e
      JOIN hospital.ipds i ON i.id = e.claim_id
      WHERE ${whereSql}
      GROUP BY e.target_stage
    `;
    const breakdown = await this.pool.query<{
      task: string;
      n: number;
      precision_score: number | null;
      recall_score: number | null;
      mean_error: number | null;
    }>(breakdownSql, params);

    const breakdown_by_task: MetricsResult['breakdown_by_task'] = {};
    for (const row of breakdown.rows) {
      breakdown_by_task[row.task] = {
        precision: Number((row.precision_score ?? 0).toFixed(4)),
        recall: Number((row.recall_score ?? 0).toFixed(4)),
        mean_error: Number((row.mean_error ?? 0).toFixed(2)),
        n: row.n,
      };
    }

    // (c) Confidence calibration: 5 buckets over readiness_score 0..100.
    const calibrationSql = `
      WITH bucketed AS (
        SELECT
          width_bucket(
            (e.prediction->>'readiness_score')::INT, 0, 100, 5
          ) AS bucket,
          (e.prediction->>'readiness_score')::INT AS rs,
          (e.prediction_error->>'predicted_action_correct')::BOOLEAN AS correct
        FROM hospital.adjudication_eval e
        JOIN hospital.ipds i ON i.id = e.claim_id
        WHERE ${whereSql}
          AND e.prediction_error->>'predicted_action_correct' IS NOT NULL
      )
      SELECT
        bucket,
        COUNT(*)::INT AS n,
        AVG(rs)::FLOAT AS predicted_rate,
        AVG(CASE WHEN correct THEN 1.0 ELSE 0.0 END)::FLOAT AS actual_rate
      FROM bucketed
      WHERE bucket BETWEEN 1 AND 5
      GROUP BY bucket
      ORDER BY bucket
    `;
    const calib = await this.pool.query<{
      bucket: number;
      n: number;
      predicted_rate: number | null;
      actual_rate: number | null;
    }>(calibrationSql, params);
    const confidence_calibration: MetricsResult['confidence_calibration'] = calib.rows.map(
      (row) => ({
        bucket_low: (row.bucket - 1) * 20,
        bucket_high: row.bucket * 20,
        // predicted_rate stored as 0..100 in readiness — surface as 0..1 fraction.
        predicted_rate: Number(((row.predicted_rate ?? 0) / 100).toFixed(4)),
        actual_rate: Number((row.actual_rate ?? 0).toFixed(4)),
        n: row.n,
      }),
    );

    // (d) Weekly trend.
    const weeklySql = `
      SELECT
        date_trunc('week', e.recorded_at)::DATE AS week_start,
        COUNT(*)::INT AS n,
        AVG(
          CASE WHEN (e.prediction_error->>'predicted_action_correct')::BOOLEAN THEN 1.0
               WHEN e.prediction_error->>'predicted_action_correct' IS NULL THEN NULL
               ELSE 0.0 END
        )::FLOAT AS accuracy
      FROM hospital.adjudication_eval e
      JOIN hospital.ipds i ON i.id = e.claim_id
      WHERE ${whereSql}
      GROUP BY 1
      ORDER BY 1
    `;
    const weekly = await this.pool.query<{
      week_start: Date;
      n: number;
      accuracy: number | null;
    }>(weeklySql, params);
    const weekly_trend: MetricsResult['weekly_trend'] = weekly.rows.map((row) => ({
      week_start:
        row.week_start instanceof Date
          ? row.week_start.toISOString().slice(0, 10)
          : String(row.week_start),
      accuracy_pct: Number(((row.accuracy ?? 0) * 100).toFixed(2)),
      n: row.n,
    }));

    // (e) Cost per claim — use percentile_cont for p50/p95.
    const costSql = `
      SELECT
        COALESCE(AVG(e.total_claim_cost_inr), 0)::FLOAT AS mean_cost,
        COALESCE(percentile_cont(0.5)
          WITHIN GROUP (ORDER BY e.total_claim_cost_inr), 0)::FLOAT AS p50,
        COALESCE(percentile_cont(0.95)
          WITHIN GROUP (ORDER BY e.total_claim_cost_inr), 0)::FLOAT AS p95
      FROM hospital.adjudication_eval e
      JOIN hospital.ipds i ON i.id = e.claim_id
      WHERE ${whereSql}
    `;
    const cost = await this.pool.query<{
      mean_cost: number;
      p50: number;
      p95: number;
    }>(costSql, params);
    const cost_per_claim = {
      mean: Number((cost.rows[0]?.mean_cost ?? 0).toFixed(4)),
      p50: Number((cost.rows[0]?.p50 ?? 0).toFixed(4)),
      p95: Number((cost.rows[0]?.p95 ?? 0).toFixed(4)),
    };

    return {
      sample_size,
      prediction_accuracy_pct,
      breakdown_by_task,
      confidence_calibration,
      weekly_trend,
      cost_per_claim,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // listPredictions (controller helper)
  // ────────────────────────────────────────────────────────────────────

  async listPredictions(opts: {
    claim_id: string;
    target_stage?: string;
  }): Promise<EvalRow[]> {
    const params: unknown[] = [opts.claim_id];
    let where = `claim_id = $1`;
    if (opts.target_stage) {
      params.push(opts.target_stage);
      where += ` AND target_stage = $${params.length}`;
    }
    const res = await this.pool.query<any>(
      `SELECT
         id, claim_id, adjudication_report_id, target_stage,
         prediction, actual_outcome, prediction_error,
         rules_version, engine_version, prompts_versions,
         kb_pattern_ids, episodic_case_ids,
         reasoning_cost_inr, total_claim_cost_inr,
         recorded_at, resolved_at
       FROM hospital.adjudication_eval
       WHERE ${where}
       ORDER BY recorded_at DESC`,
      params,
    );
    return res.rows as EvalRow[];
  }

  // ────────────────────────────────────────────────────────────────────
  // backtest
  // ────────────────────────────────────────────────────────────────────

  /**
   * Replay closed claims through the CURRENT engine code and compare to
   * the eval row's frozen prediction. Read-only: we never write a new
   * adjudication_report and we never INSERT into adjudication_eval. The
   * engine is invoked through a thin wrapper that calls run() in a
   * stateless way — we trust the engine's own dedup-by-hash to make this
   * cheap for unchanged inputs, but we do NOT capture its output to the
   * DB (no force=true write-through).
   *
   * Caveat: the canonical AdjudicationEngine.run() *does* INSERT a new
   * report when the dossier hash hasn't been seen for the current
   * rules/engine version. For a true read-only backtest the integration
   * sprint should add a `dryRun` flag to the engine; until then we accept
   * that backtest may write at most one cached row per claim per
   * (rules/engine) tuple, which is acceptable for the use case ("should
   * we ship the new rules?") since those rows are exactly the artifacts
   * we'd want anyway. The function returns without persisting backtest
   * deltas to a table — deltas live in memory for the caller to consume.
   *
   * Falls back to a no-op (returns empty deltas) when no engine is
   * available.
   */
  async backtest(opts: BacktestOpts = {}): Promise<BacktestResult> {
    const sinceDays = Math.max(1, Math.min(opts.sinceDays ?? 14, 90));
    const maxClaims = Math.max(1, Math.min(opts.maxClaims ?? 50, 500));

    const engine = this.engineForBacktest ?? (await lazyAdjudicationEngine());
    if (!engine) {
      logger.warn(
        'evalHarness.backtest: no engine available — returning empty deltas',
      );
      return {
        claims_replayed: 0,
        deltas: [],
        summary: { mean_readiness_delta: 0, action_change_count: 0 },
      };
    }

    // Collect candidate claims: closed within sinceDays, with at least
    // one eval row matching the requested rules_version filter (if any).
    const params: unknown[] = [sinceDays];
    let rvFilter = '';
    if (opts.rules_version) {
      params.push(opts.rules_version);
      rvFilter = ` AND e.rules_version = $${params.length}`;
    }
    params.push(maxClaims);
    const sql = `
      SELECT DISTINCT e.claim_id, e.adjudication_report_id, e.target_stage,
             (e.prediction->>'readiness_score')::INT AS old_score,
             (e.prediction->>'recommended_action') AS old_action
        FROM hospital.adjudication_eval e
        JOIN hospital.claim_dossiers d ON d.claim_id = e.claim_id
       WHERE d.closed_at IS NOT NULL
         AND d.closed_at >= NOW() - ($1::INT * INTERVAL '1 day')
         ${rvFilter}
       ORDER BY e.adjudication_report_id
       LIMIT $${params.length}
    `;
    const candidates = await this.pool.query<{
      claim_id: string;
      adjudication_report_id: string;
      target_stage: string;
      old_score: number;
      old_action: string;
    }>(sql, params);

    const deltas: BacktestDelta[] = [];

    for (const cand of candidates.rows) {
      try {
        const newReport = await engine.run({
          claim_id: cand.claim_id,
          target_stage: cand.target_stage,
        });
        const readiness_delta =
          Number(newReport.readiness_score ?? 0) - Number(cand.old_score ?? 0);
        const recommended_action_changed =
          newReport.recommended_action !== cand.old_action;
        deltas.push({
          claim_id: cand.claim_id,
          old_report_id: cand.adjudication_report_id,
          new_report: newReport,
          readiness_delta,
          recommended_action_changed,
        });
      } catch (err) {
        logger.warn(
          { err, claim_id: cand.claim_id },
          'evalHarness.backtest: engine.run threw — skipping claim',
        );
      }
    }

    const action_change_count = deltas.filter(
      (d) => d.recommended_action_changed,
    ).length;
    const mean_readiness_delta =
      deltas.length === 0
        ? 0
        : deltas.reduce((sum, d) => sum + d.readiness_delta, 0) / deltas.length;

    return {
      claims_replayed: deltas.length,
      deltas,
      summary: {
        mean_readiness_delta: Number(mean_readiness_delta.toFixed(2)),
        action_change_count,
      },
    };
  }
}

// ─── Lazy engine import — used only by backtest ──────────────────────────
let cachedEngine: AdjudicationEngineLike | null | undefined = undefined;
async function lazyAdjudicationEngine(): Promise<AdjudicationEngineLike | null> {
  if (cachedEngine !== undefined) return cachedEngine;
  try {
    const mod: any = await import('./adjudicationEngine.service.js');
    cachedEngine = (mod.default ?? null) as AdjudicationEngineLike | null;
  } catch (err) {
    logger.warn(
      { err },
      'evalHarness.backtest: adjudicationEngine.service not available',
    );
    cachedEngine = null;
  }
  return cachedEngine;
}

// ─── Prompt version snapshot ─────────────────────────────────────────────
async function collectPromptVersions(): Promise<Record<string, string>> {
  const out: Record<string, string> = {
    rules: RULES_VERSION,
    engine: ENGINE_VERSION,
  };

  // Each service exposes its own PROMPT_VERSION/SERVICE_VERSION constant.
  // We grab them best-effort — any failure is logged at debug and the
  // missing entry surfaces as 'unknown'.
  const sources: Array<{ key: string; loader: () => Promise<any> }> = [
    { key: 'segmenter', loader: () => import('./docSegmenter.service.js') },
    { key: 'classifier', loader: () => import('./docClassifier.service.js') },
    { key: 'extractor', loader: () => import('./docExtractor.service.js') },
    { key: 'emailIntel', loader: () => import('./emailIntelligence.service.js') },
    { key: 'reasoning', loader: () => import('./reasoningAgent.service.js') },
    { key: 'kbMiner', loader: () => import('./kbPatternMiner.service.js') },
  ];
  for (const s of sources) {
    try {
      const mod: any = await s.loader();
      const v =
        mod[`${s.key.toUpperCase()}_VERSION`] ??
        mod.PROMPT_VERSION ??
        mod.SERVICE_VERSION ??
        mod.MINER_VERSION ??
        mod.REASONING_AGENT_VERSION ??
        mod.SEGMENTER_VERSION ??
        mod.EMAIL_INTEL_VERSION ??
        null;
      out[s.key] = typeof v === 'string' && v.length > 0 ? v : 'unknown';
    } catch {
      out[s.key] = 'unknown';
    }
  }
  return out;
}

// ─── Default singleton ───────────────────────────────────────────────────
export default new EvalHarness();
