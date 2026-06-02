-- =============================================================================
-- 069 — per-stage rule evaluations + claim_hypothesis  (2026-06-02, M3)
--
-- (OD3) Widen the per-rule evaluation ledger's unique key to include `stage`
-- so one claim can hold distinct outcomes per submission stage. Existing rows
-- have stage NULL; COALESCE(stage,'') keeps their semantics identical to the
-- old (claim_id, rule_set_id, rule_id) key, so this is data-safe.
--
-- Also adds claim_hypothesis — the 4-layer hypothesis per (claim, stage),
-- shadow until M4/M5 populate/read it.
--
-- Forward-only + idempotent. Manual rollback:
--   DROP TABLE IF EXISTS hospital.claim_hypothesis;
--   DROP INDEX IF EXISTS hospital.uq_cre_claim_stage_set_rule;
--   ALTER TABLE hospital.claim_rule_evaluations DROP COLUMN IF EXISTS stage;
--   (then re-add CONSTRAINT uq_cre_claim_set_rule UNIQUE (claim_id, rule_set_id, rule_id))
-- =============================================================================

BEGIN;

ALTER TABLE hospital.claim_rule_evaluations
  ADD COLUMN IF NOT EXISTS stage VARCHAR(40);

-- Replace the old unique key with a stage-aware one (expression index, so it
-- must be a UNIQUE INDEX rather than a table CONSTRAINT).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_cre_claim_set_rule') THEN
    ALTER TABLE hospital.claim_rule_evaluations DROP CONSTRAINT uq_cre_claim_set_rule;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cre_claim_stage_set_rule
  ON hospital.claim_rule_evaluations (claim_id, COALESCE(stage, ''), rule_set_id, rule_id);

CREATE TABLE IF NOT EXISTS hospital.claim_hypothesis (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id          UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  stage             VARCHAR(40),
  layer1_documents  JSONB,   -- documents + stage
  layer2_content    JSONB,   -- extracted fields
  layer3_rules      JSONB,   -- rules applied + pass/fail + cited evidence
  layer4_readiness  JSONB,   -- readiness score + recommended action
  resolver_version  VARCHAR(32),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_hypothesis_claim_stage
  ON hospital.claim_hypothesis (claim_id, COALESCE(stage, ''));

COMMIT;
