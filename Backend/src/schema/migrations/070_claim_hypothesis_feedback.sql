-- =============================================================================
-- 070 — claim_hypothesis_feedback  (2026-06-02, M7 human-in-the-loop)
--
-- Append-only reviewer feedback on an adjudication hypothesis, with PER-LAYER
-- root-cause attribution. This is the learning-loop signal: it lets us tell a
-- deterministic fix (wrong/missing/over-strict rule, wrong context) apart from
-- a model fix (bad extraction) — so corrections route to the right place and
-- over-strict rules surface for calibration (the request_doc-rate question).
--
-- Forward-only + idempotent. Manual rollback:
--   DROP TABLE IF EXISTS hospital.claim_hypothesis_feedback;
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.claim_hypothesis_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  stage           VARCHAR(40) NOT NULL DEFAULT '',
  -- which hypothesis layer the feedback is about
  layer           VARCHAR(16) NOT NULL,   -- documents | content | rules | readiness
  -- what within the layer: a rule_id, a doc category, or a field path
  target_ref      VARCHAR(160),
  verdict         VARCHAR(16) NOT NULL,   -- agree | disagree | correct
  -- when disagree/correct: where the error actually originated
  root_cause      VARCHAR(32),            -- documents | content | rules | context | none
  corrected_value JSONB,
  reviewer_id     UUID,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_chf_layer   CHECK (layer   IN ('documents','content','rules','readiness')),
  CONSTRAINT chk_chf_verdict CHECK (verdict IN ('agree','disagree','correct'))
);

CREATE INDEX IF NOT EXISTS idx_chf_claim_stage ON hospital.claim_hypothesis_feedback (claim_id, stage);
CREATE INDEX IF NOT EXISTS idx_chf_rule ON hospital.claim_hypothesis_feedback (target_ref) WHERE layer = 'rules';

COMMIT;
