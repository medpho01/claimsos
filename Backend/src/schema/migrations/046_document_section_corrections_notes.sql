-- ============================================================================
-- Wave 9 hot-fix — add `notes` column to document_section_corrections.
-- ============================================================================
-- The DocumentSectionCorrectionController persists the human's free-text
-- "reason" alongside the before/after JSON for every category override.
-- Migration 032 defined the table without a notes column, so the INSERT
-- (controllers/documentSectionCorrection.controller.ts:62) fails with
--   "column \"notes\" of relation \"document_section_corrections\" does not exist"
-- the first time anyone clicks "Fix category" in the Documents panel.
--
-- We add the column as nullable TEXT — older rows (none in prod, but defensive
-- for backfilled environments) stay valid, and future inserts capture the
-- reason verbatim.

BEGIN;

ALTER TABLE hospital.document_section_corrections
  ADD COLUMN IF NOT EXISTS notes TEXT;

COMMENT ON COLUMN hospital.document_section_corrections.notes IS
  'Free-text reason supplied by the operator when overriding the AI category. Captured for audit + Wave 10 pattern mining.';

COMMIT;
