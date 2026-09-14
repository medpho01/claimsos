-- ==========================================================================
-- 083 — stage provenance: where a section's stage came from
-- ==========================================================================
-- 079 created document_stage_affinity and documentStageAffinity.service.ts
-- gained `resolveSectionStage`, whose whole contract is a PRECEDENCE:
--
--     reviewer > declared (upload dropdown) > affinity > claim stage
--
-- Two of those four tiers had nowhere to live, so the function had no
-- production callers and document_sections.stage was 916/916 NULL.
--
-- WHAT WAS ACTUALLY HAPPENING
-- ------------------------------------------------------------------------
-- docBundleClassifier and docSegmenter each stamped `stage` with
-- fetchClaimStage(claimId) — a blanket per-document UPDATE using the claim's
-- current stage, the WEAKEST tier in the precedence. It also produced nothing:
-- ipds.stage was NULL on 471 of 475 rows, so the stamp was a no-op that looked
-- like a feature. Both call sites move to resolveSectionStage in this commit.
--
-- WHY stage_source IS NOT COSMETIC
-- ------------------------------------------------------------------------
-- 'declared' and 'claim_stage' can hold the same string and mean completely
-- different things: one is a person stating what a document is for, the other
-- is the pipeline guessing from arrival time. Without the source recorded, a
-- reviewer cannot tell a human's answer from a default, and the rule engine
-- cannot weight them differently. Storing the tier is what makes the
-- precedence auditable after the fact.
--
-- ipd_doc.declared_stage is the upload dropdown's answer. It sits on the
-- DOCUMENT, not the section, because the uploader picks it once for the file
-- they are attaching, before anything is segmented or classified.
-- ==========================================================================

ALTER TABLE hospital.document_sections
  ADD COLUMN IF NOT EXISTS stage_source VARCHAR(20);

COMMENT ON COLUMN hospital.document_sections.stage_source IS
  'Which precedence tier set `stage`: reviewer | declared | affinity | claim_stage | none. '
  'NULL means the row predates 083 or was never stamped.';

ALTER TABLE hospital.ipd_doc
  ADD COLUMN IF NOT EXISTS declared_stage VARCHAR(40);

COMMENT ON COLUMN hospital.ipd_doc.declared_stage IS
  'Stage the uploader chose at upload time (claim_stages.code). The `declared` '
  'tier of resolveSectionStage. NULL for inbound documents (email/portal) and '
  'for anything uploaded before the dropdown shipped.';

-- Deliberately NOT an FK: claim_stages.code is a configurable registry whose
-- rows are retired rather than deleted (see 077), and a hard FK would make
-- retiring a stage fail against historical documents that legitimately still
-- reference it. Same convention as the other four stage-bearing columns.
CREATE INDEX IF NOT EXISTS idx_document_sections_stage
  ON hospital.document_sections (claim_id, stage)
  WHERE stage IS NOT NULL;

-- ── Guard ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'hospital' AND table_name = 'document_sections'
       AND column_name = 'stage_source'
  ) THEN
    RAISE EXCEPTION '083: document_sections.stage_source was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'hospital' AND table_name = 'ipd_doc'
       AND column_name = 'declared_stage'
  ) THEN
    RAISE EXCEPTION '083: ipd_doc.declared_stage was not created';
  END IF;

  RAISE NOTICE '083 stage provenance: stage_source + declared_stage ready';
END $$;
