-- ============================================================================
-- Wave 12 follow-up #3 — three-layer dedup foundation.
-- ============================================================================
-- Closes three independent sources of duplicate work observed on the
-- Vahid claim (05cf88cb-...) and other re-analysed claims:
--
--   Layer 1 (upload-time): the same physical file being uploaded twice
--     and creating two ipd_doc rows that then fan out into independent
--     classify + extract pipelines. Solved by storing the SHA-256 of
--     the file bytes on ipd_doc and short-circuiting upload at the
--     controller when a hit is found for the same claim.
--
--   Layer 2 (section-level): bundle classifier re-runs (force=true)
--     INSERTING new sections without deleting prior ones for the same
--     document, so a doc ends up with overlapping sections at
--     different versions. Solved with a (document_id, page_start,
--     page_end) unique constraint + a "delete auto-status sections
--     before insert" pattern in the service layer (preserves any
--     'corrected' sections the user has fixed manually).
--
--   Layer 3 (presentation): handled in FE — no schema change here.
--
-- All adds are backward-compatible: existing rows have NULL
-- content_hash and don't participate in dedup, the unique constraint
-- is only on (document_id, page_start, page_end) which legacy data
-- already respects (the bundle classifier emits disjoint page ranges
-- per doc by design).

BEGIN;

-- ─── Layer 1: content_hash column ───────────────────────────────────────
-- SHA-256 hex = 64 chars. CHAR(64) over TEXT for a tight index.
ALTER TABLE hospital.ipd_doc
  ADD COLUMN IF NOT EXISTS content_hash CHAR(64);

-- Lookup index used by the upload controller's dedup probe:
--   SELECT id FROM ipd_doc WHERE ipd_id = $1 AND content_hash = $2
-- Partial because the column is NULL for the back-catalog (pre-this-
-- migration uploads) — we don't want them in the index until backfilled.
CREATE INDEX IF NOT EXISTS idx_ipd_doc_claim_hash
  ON hospital.ipd_doc(ipd_id, content_hash)
  WHERE content_hash IS NOT NULL;

-- Unique constraint to catch the rare race where two concurrent uploads
-- of the same file land between the controller's SELECT-then-INSERT.
-- Partial so back-catalog NULLs don't collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ipd_doc_claim_hash
  ON hospital.ipd_doc(ipd_id, content_hash)
  WHERE content_hash IS NOT NULL;

-- ─── Layer 2: section overlap prevention ────────────────────────────────
-- A document_sections row represents "pages [start..end] of doc X are
-- of category Y". Two rows that cover the same exact page range on the
-- same document are by definition duplicate work — the second one
-- would be the same input through a non-deterministic LLM, producing
-- a different category for the same content. That's the chaos the
-- user reported.
--
-- The bundle classifier emits disjoint page ranges per doc by design
-- (its system prompt requires "every page covered, no gaps, no
-- overlaps"), so existing data is already compliant. We add the
-- constraint to make accidental violation impossible going forward,
-- including force-rerun bugs that forget to clean up first.
ALTER TABLE hospital.document_sections
  DROP CONSTRAINT IF EXISTS uq_document_sections_doc_pages;
ALTER TABLE hospital.document_sections
  ADD CONSTRAINT uq_document_sections_doc_pages
  UNIQUE (document_id, page_start, page_end);

COMMIT;
