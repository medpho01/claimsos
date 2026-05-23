-- Migration 045: AI Corrections — Unified Audit + Mining Input (Wave 10)
-- Date: 2026-05-18
--
-- Wave 10 — Correction-to-KB Pipeline.
--
-- The system already records "human edited what the AI did" across four
-- domain-specific surfaces:
--
--   * hospital.document_section_corrections   (Wave 2 — section split / merge / reclassify)
--   * hospital.email_intelligence_corrections (Wave 2 — AI draft field overrides)
--   * hospital.harmonisation_corrections      (Wave 7 — JSONPath-keyed episode edits)
--   * hospital.rule_overrides                 (Wave 8 — rule_overreach overrides)
--
-- Each lives at the grain of its own writer because the writers care about
-- shape-specific columns (section_id, draft_id, json_path, rule_id, ...).
-- That's fine for the original write path, but the *mining* path wants a
-- single denormalised stream it can group by and threshold against.
--
-- hospital.ai_corrections is that stream: every domain-specific correction
-- ALSO inserts a row here, with:
--
--   * surface       — discriminates the source table
--   * target_id     — varies (section_id / draft_id / rule_id / json_path)
--   * target_kind   — secondary discriminator (e.g. 'discharge_slip')
--   * ai_value      — what the AI said
--   * human_value   — what the human corrected to
--   * reason        — free-text human note (often NULL for non-rule overrides)
--   * applied_to_kb — flipped to true once the row is consumed by the miner,
--                     so a re-mining run doesn't re-mine the same evidence
--   * mined_pattern_id — back-link to kb_patterns.id when the row contributed
--
-- We deliberately don't UNION ALL the four source tables in a view because
-- the original writers may need to evolve their schemas without breaking the
-- mining pipeline. A persisted denormalised table also gives us cheap
-- partial indexes on applied_to_kb=false.
--
-- The kb_patterns table also gets an evidence_correction_ids UUID[] so a
-- promoted pattern can be drilled back to the raw human edits.

BEGIN;

-- ============================================================================
-- A. hospital.ai_corrections
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.ai_corrections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which source surface emitted the correction. Open enum — adding a new
  -- surface in a future wave just needs an ALTER on the CHECK.
  surface               VARCHAR(64) NOT NULL
                        CHECK (surface IN (
                          'document_category',
                          'extraction_field',
                          'harmonised_field',
                          'rule_override',
                          'ai_draft_field',
                          'audit_call_wrong'
                        )),

  -- Optional: claim grain. Not all surfaces have a claim_id (e.g. a
  -- standalone audit-call-wrong row before a claim is matched). When set,
  -- delete-claim cascades wipe the correction trail.
  claim_id              UUID REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- The natural id of the target whose correction we're recording. Type
  -- varies by surface — VARCHAR is the lowest common denominator. The
  -- miner reads this opaquely (group-by) and doesn't try to FK-validate.
  target_id             VARCHAR(128),

  -- Additional discriminator within a surface (e.g. 'discharge_slip' for
  -- document_category, the field_path for ai_draft_field, the rule_id for
  -- rule_override, etc). The miner uses (surface, target_kind) as its
  -- primary grouping key for most strategies.
  target_kind           VARCHAR(64),

  ai_value              JSONB,
  human_value           JSONB NOT NULL,
  reason                TEXT,

  corrected_by          UUID NOT NULL,
  corrected_at          TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Mining lineage. applied_to_kb flips to true once the miner has consumed
  -- the row (either contributed to a candidate or rolled into the count of
  -- an existing candidate). mined_pattern_id points at the resulting
  -- kb_patterns row when one was generated.
  applied_to_kb         BOOLEAN NOT NULL DEFAULT false,
  mined_pattern_id      UUID
);

-- ---- Indexes --------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_ai_corrections_surface
  ON hospital.ai_corrections (surface);

CREATE INDEX IF NOT EXISTS idx_ai_corrections_claim
  ON hospital.ai_corrections (claim_id);

-- Hot path for the miner: "give me every unmined row by surface". Partial
-- index keeps it small — most rows are eventually mined.
CREATE INDEX IF NOT EXISTS idx_ai_corrections_unmined
  ON hospital.ai_corrections (corrected_at DESC)
  WHERE applied_to_kb = false;

CREATE INDEX IF NOT EXISTS idx_ai_corrections_surface_kind
  ON hospital.ai_corrections (surface, target_kind);

COMMENT ON TABLE hospital.ai_corrections IS
  'Wave 10 — unified, denormalised stream of every human correction over an AI output. Source surfaces still own their domain tables; this is the mining input.';

COMMENT ON COLUMN hospital.ai_corrections.surface IS
  'document_category | extraction_field | harmonised_field | rule_override | ai_draft_field | audit_call_wrong';

COMMENT ON COLUMN hospital.ai_corrections.target_id IS
  'Natural id of the corrected target (section_id, draft_id, rule_id, json_path, ...). Opaque to the miner — used only for group-by.';

COMMENT ON COLUMN hospital.ai_corrections.applied_to_kb IS
  'true once a miner run has consumed this row. Re-mining skips applied rows so evidence is not double-counted.';

-- ============================================================================
-- B. hospital.kb_patterns — back-link to source corrections
-- ============================================================================
-- When a candidate is mined from corrections we want to be able to render
-- the raw human edits that justified it on the review screen. We store a
-- bounded list (same cap as evidence_claim_ids) of ai_corrections.id rows.

ALTER TABLE hospital.kb_patterns
  ADD COLUMN IF NOT EXISTS evidence_correction_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN hospital.kb_patterns.evidence_correction_ids IS
  'Wave 10 — for correction-driven patterns (category_confusion / harmonisation_drift / rule_overreach / extraction_field_pattern), the ai_corrections.id rows that justified this pattern.';

COMMIT;
