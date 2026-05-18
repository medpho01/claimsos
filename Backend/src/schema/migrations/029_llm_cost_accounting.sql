-- Migration 029: LLM cost accounting tables
-- Date: 2026-05-18
--
-- Sprint 4 — LLM Bridge + Cost Meter
--
-- Persists the cost telemetry the LLM bridge emits for every model call,
-- the per-hospital cost caps that gate further spend, and an alert table
-- that ops/the dashboard can read to surface "near cap" / "over cap"
-- warnings.
--
-- Tables:
--   llm_cost_log         — append-only, one row per LLM call. Source of
--                          truth for "what did claim X cost?" and "what
--                          did hospital Y spend today?"
--   hospital_cost_caps   — per-hospital daily/monthly cap overrides.
--                          Effective-dated so caps can change mid-month
--                          without losing the prior threshold.
--   cost_alerts          — audit of every cap-threshold crossing.
--                          Resolved when spend falls back under the
--                          threshold OR the next period rolls over.
--
-- Indexing strategy:
--   - llm_cost_log queries by claim_id (per-claim spend), by hospital_id
--     filtered to a time window (daily/monthly spend), and by task in a
--     time window (which prompts are getting expensive).
--   - cost_alerts queries by (hospital_id, alert_kind) for the dashboard
--     "active alerts" widget.

BEGIN;

-- ─── llm_cost_log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.llm_cost_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- claim_id is the IPD id (one IPD == one claim in the current data
  -- model). NULLable because some calls aren't tied to a claim — e.g.
  -- hospital onboarding helpers, inbound classification for an email
  -- we haven't matched yet.
  claim_id                 UUID REFERENCES hospital.ipds(id) ON DELETE SET NULL,
  hospital_id              UUID REFERENCES hospital.hospitals(id) ON DELETE SET NULL,
  -- Short identifier for the calling task (e.g. 'attr_extract.policy_number',
  -- 'discharge_summary.parse'). Indexed for per-task spend reports.
  task                     VARCHAR(64) NOT NULL,
  provider                 VARCHAR(32) NOT NULL,    -- 'anthropic', 'bedrock', ...
  model                    VARCHAR(64) NOT NULL,    -- resolved model id from response
  prompt_version           VARCHAR(32) NOT NULL,    -- caller-supplied; enables A/B
  -- Token counts split into uncached / cached input so we can audit
  -- cache hit rate and reconstruct cost from rates if needed.
  tokens_input_uncached    INTEGER NOT NULL DEFAULT 0,
  tokens_input_cached      INTEGER NOT NULL DEFAULT 0,
  tokens_output            INTEGER NOT NULL DEFAULT 0,
  latency_ms               INTEGER NOT NULL DEFAULT 0,
  -- INR with 4 decimal places — single calls can be ₹0.0008 and the
  -- rounding error matters when summed across thousands of calls/month.
  cost_inr                 NUMERIC(10, 4) NOT NULL DEFAULT 0,
  succeeded                BOOLEAN NOT NULL DEFAULT TRUE,
  -- For failed rows: the error message / class. Truncated to 1KB at
  -- write time by the service.
  error_message            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-claim spend lookup (checkBudget hot path).
CREATE INDEX IF NOT EXISTS idx_llm_cost_claim
  ON hospital.llm_cost_log (claim_id, created_at)
  WHERE claim_id IS NOT NULL;

-- Per-hospital, time-windowed spend (daily/monthly cap checks).
CREATE INDEX IF NOT EXISTS idx_llm_cost_hospital_time
  ON hospital.llm_cost_log (hospital_id, created_at DESC)
  WHERE hospital_id IS NOT NULL;

-- Per-task spend reports (which prompt versions are expensive).
CREATE INDEX IF NOT EXISTS idx_llm_cost_task_time
  ON hospital.llm_cost_log (task, created_at DESC);

COMMENT ON TABLE hospital.llm_cost_log IS
  'Append-only ledger of every LLM call: tokens, latency, cost in INR. Source of truth for per-claim/per-hospital LLM spend.';

-- ─── hospital_cost_caps ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.hospital_cost_caps (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id         UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  daily_cap_inr       NUMERIC(12, 2) NOT NULL,
  monthly_cap_inr     NUMERIC(12, 2) NOT NULL,
  -- Effective-dated so caps can be raised mid-month without losing the
  -- prior threshold (audit). Lookup picks the row whose window contains
  -- now(); falls back to code defaults (₹3000/day, ₹50000/month) if
  -- nothing matches.
  effective_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hcc_hospital_effective
  ON hospital.hospital_cost_caps (hospital_id, effective_from DESC);

COMMENT ON TABLE hospital.hospital_cost_caps IS
  'Per-hospital daily / monthly LLM spend caps with an effective window. Defaults (₹3000/day, ₹50000/month) apply when no row matches.';

-- ─── cost_alerts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.cost_alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  -- 'claim_soft' | 'claim_hard' | 'hospital_daily_soft' | 'hospital_daily_hard'
  -- | 'hospital_monthly_soft' | 'hospital_monthly_hard'
  alert_kind      VARCHAR(40) NOT NULL,
  threshold_inr   NUMERIC(12, 2) NOT NULL,
  current_inr     NUMERIC(12, 2) NOT NULL,
  fired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL while the alert is active; set when the cost falls back under
  -- the threshold OR the period rolls over.
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cost_alerts_hospital_kind
  ON hospital.cost_alerts (hospital_id, alert_kind, fired_at DESC);

COMMENT ON TABLE hospital.cost_alerts IS
  'Audit of every cost-cap threshold crossing. Active rows (resolved_at IS NULL) feed the "near cap / over cap" dashboard widget.';

COMMIT;
