-- =============================================================================
-- 067 — claim_context + document_sections.stage  (2026-06-02)
--
-- Milestone 0 of the stage-aware adjudication engine. Adds:
--   1. hospital.claim_context — the per-claim resolved context vector
--      {scheme, route, insurer, stage, case_type} produced by the M1
--      Auto-Context Resolver. Written in SHADOW only (no live path reads it yet).
--   2. document_sections.stage — a nullable stage tag (M2 will populate it).
--
-- Convention: FORWARD-ONLY + idempotent (repo uses node-pg-migrate -j sql with no
-- down markers ⇒ down:false). Additive + inert, so manual rollback is safe:
--   DROP TABLE IF EXISTS hospital.claim_context;
--   DROP INDEX IF EXISTS hospital.idx_document_sections_stage;
--   ALTER TABLE hospital.document_sections DROP COLUMN IF EXISTS stage;
--
-- Stage columns are free-text VARCHAR(40), app-validated against
-- master_options(category='ipd_stage') — mirrors ipds.stage (no FK/CHECK).
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.claim_context (
  claim_id           UUID PRIMARY KEY
                     REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  scheme             VARCHAR(64),
  route              VARCHAR(40),
  insurer_panel_id   UUID,
  stage              VARCHAR(40),
  case_type          VARCHAR(40),
  flags              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  context            JSONB        NOT NULL,            -- full ResolvedContext (ctx.vN)
  resolver_version   VARCHAR(32)  NOT NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_context_stage   ON hospital.claim_context (stage);
CREATE INDEX IF NOT EXISTS idx_claim_context_scheme  ON hospital.claim_context (scheme);
CREATE INDEX IF NOT EXISTS idx_claim_context_insurer ON hospital.claim_context (insurer_panel_id);

-- updated_at touch trigger (same pattern as migs 060/061/066)
CREATE OR REPLACE FUNCTION hospital.touch_claim_context_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_claim_context_updated_at ON hospital.claim_context;
CREATE TRIGGER trg_claim_context_updated_at
  BEFORE UPDATE ON hospital.claim_context
  FOR EACH ROW EXECUTE FUNCTION hospital.touch_claim_context_updated_at();

-- Stage tag on document sections (populated in M2; nullable until then).
ALTER TABLE hospital.document_sections ADD COLUMN IF NOT EXISTS stage VARCHAR(40);
CREATE INDEX IF NOT EXISTS idx_document_sections_stage ON hospital.document_sections (stage);

COMMIT;
