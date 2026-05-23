-- Migration 040: adjudication_eval table (Sprint 4, Wave 5A — Eval Harness)
-- Date: 2026-05-18
--
-- The eval harness's per-prediction record. Every adjudication_report that
-- we want to score gets ONE row here, snapshotted at the moment the report
-- is written. Later — when the claim moves past the target_stage, or
-- closes — we back-fill `actual_outcome` and compute `prediction_error`
-- against the snapshotted `prediction`.
--
-- Why a dedicated table (vs computing on-the-fly from adjudication_reports +
-- claim_dossiers):
--   - We need *frozen* predictions. If we replay the engine later (rules
--     bump, prompt tweak, ReasoningAgent v2) we cannot let "what we
--     predicted yesterday" silently mutate. The snapshot here is the
--     truth-of-record.
--   - We need a stable join key for cost telemetry: a claim's
--     total_claim_cost_inr at *the moment* the report was written is
--     materially different from its lifetime total a week later.
--   - The metrics dashboard's hot-path aggregations want a denormalised
--     row (one INSERT, many SELECTs). Computing prediction_error in SQL
--     across three tables for every dashboard request would be wasteful.
--
-- claim_id semantics: matches migrations 030/031/036 — FK to hospital.ipds(id),
-- ON DELETE CASCADE so removing an IPD cleans up its eval rows.
--
-- Resolution lifecycle:
--   recorded_at        ← always populated at snapshot time
--   actual_outcome     ← populated by resolveActuals when the claim
--                        progresses past target_stage (or closes)
--   prediction_error   ← computed at the same time as actual_outcome
--   resolved_at        ← timestamp of the resolution step. NULL means
--                        "still waiting on the world to tell us what
--                        actually happened".
--
-- Partial outcomes (e.g. claim is past pre_auth but still has an open
-- enhancement query): we resolve what we can — predicted_action_correct
-- and amount_error_inr are derivable as soon as the immediate stage's
-- outcome is observable. Downstream fields (e.g. final_amount when
-- target_stage='pre_auth') are left NULL inside prediction_error and
-- the dashboard treats them as "not yet measurable".

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.adjudication_eval (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  claim_id               UUID NOT NULL
                         REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- The AdjudicationReport this row scores. ON DELETE CASCADE because if
  -- the source report is deleted (e.g. claim re-rebuild) the eval row is
  -- meaningless anyway. UNIQUE — at most one eval row per report.
  adjudication_report_id UUID NOT NULL
                         REFERENCES hospital.adjudication_reports(id)
                         ON DELETE CASCADE,

  target_stage           VARCHAR(100) NOT NULL,

  -- ─── Snapshot of the prediction ─────────────────────────────────────
  -- Shape: {
  --   readiness_score: number,             // 0..100
  --   recommended_action: string,          // 'file_now' | 'request_doc' | ...
  --   predicted_outcome: object | null,    // ReasoningAgent output (or null in v0)
  --   kb_matches_count: integer,
  --   episodic_refs_count: integer,
  --   reasoning_invoked: boolean
  -- }
  prediction             JSONB NOT NULL,

  -- ─── Observed reality, back-filled by resolveActuals ────────────────
  -- Shape: {
  --   actual_outcome_category: string,     // 'approved' | 'queried' | 'rejected' | 'withdrawn' | 'partial'
  --   actual_amount_approved: number | null,
  --   actual_deductions: number | null,
  --   actual_queries: Array<{ raised_at, resolved_at?, deficiency_type? }>,
  --   time_to_response_hours: number | null
  -- }
  actual_outcome         JSONB,

  -- ─── Computed delta ─────────────────────────────────────────────────
  -- Shape (any field may be null when not applicable):
  -- {
  --   amount_error_inr: number | null,
  --   amount_error_pct: number | null,
  --   predicted_action_correct: boolean | null,
  --   predicted_query_correct: boolean | null,
  --   readiness_calibrated: boolean | null,    // did readiness match outcome?
  --   notes: string | null
  -- }
  prediction_error       JSONB,

  -- ─── Lineage / replay context ───────────────────────────────────────
  rules_version          VARCHAR(32) NOT NULL,
  engine_version         VARCHAR(32) NOT NULL,
  -- Snapshot of every prompt version used to produce this report — used
  -- by the per-prompt regression dashboards. Shape e.g.
  --   { segmenter: 'v3', classifier: 'v2', extractor: 'v4',
  --     emailIntel: 'v1', reasoning: 'v2', ... }
  prompts_versions       JSONB NOT NULL,

  -- Cross-reference pointers — we keep the ids directly here (in addition
  -- to citations on adjudication_reports) so the metrics dashboard can
  -- filter "show me eval rows that matched KB pattern X" without joining
  -- through the report row.
  kb_pattern_ids         UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  episodic_case_ids      UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],

  -- Cost ledger. reasoning_cost_inr is the marginal cost of the
  -- ReasoningAgent call (zero when the heuristic skipped it).
  -- total_claim_cost_inr is the running sum of llm_cost_log entries for
  -- this claim up to recorded_at — the "what did we spend to reach this
  -- prediction" number the cost-per-claim KPI consumes.
  reasoning_cost_inr     NUMERIC(10,4),
  total_claim_cost_inr   NUMERIC(10,4),

  recorded_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at            TIMESTAMP,

  CONSTRAINT uq_eval_report UNIQUE (adjudication_report_id)
);

-- ─── Indexes ────────────────────────────────────────────────────────────
-- Per-claim history (the "show me all evals for this claim" lookup).
CREATE INDEX IF NOT EXISTS idx_eval_claim
  ON hospital.adjudication_eval (claim_id);

-- Per-stage rollups for the dashboard task breakdown.
CREATE INDEX IF NOT EXISTS idx_eval_target_stage
  ON hospital.adjudication_eval (target_stage);

-- Time-range filters on the dashboard ("this week", "this month").
CREATE INDEX IF NOT EXISTS idx_eval_recorded_at
  ON hospital.adjudication_eval (recorded_at);

-- The resolver's hot path: "find me unresolved eval rows for this claim".
-- Partial index keeps the working set tiny — historically resolved rows
-- are by far the majority.
CREATE INDEX IF NOT EXISTS idx_eval_unresolved
  ON hospital.adjudication_eval (claim_id, target_stage)
  WHERE resolved_at IS NULL;

-- ─── Comments ───────────────────────────────────────────────────────────
COMMENT ON TABLE hospital.adjudication_eval IS
  'Wave 5A eval harness: one row per adjudication_report we want to score. Frozen prediction at snapshot time + back-filled actual_outcome when reality settles. Joined with llm_cost_log for cost-per-claim telemetry.';

COMMENT ON COLUMN hospital.adjudication_eval.prediction IS
  'Frozen snapshot of {readiness_score, recommended_action, predicted_outcome, kb_matches_count, episodic_refs_count, reasoning_invoked} at the moment the report was written.';

COMMENT ON COLUMN hospital.adjudication_eval.actual_outcome IS
  'Populated by resolveActuals when the claim moves past target_stage. NULL means "outcome not yet observable".';

COMMENT ON COLUMN hospital.adjudication_eval.prediction_error IS
  'Computed delta between prediction and actual_outcome. Each field may be null when not applicable to the target_stage. Computed once when actual_outcome is filled.';

COMMENT ON COLUMN hospital.adjudication_eval.prompts_versions IS
  'Snapshot of every prompt version used to produce this report. Drives per-prompt regression dashboards.';

COMMENT ON COLUMN hospital.adjudication_eval.total_claim_cost_inr IS
  'Running sum of llm_cost_log entries for this claim up to recorded_at. Feeds the cost-per-claim KPI.';

COMMIT;
