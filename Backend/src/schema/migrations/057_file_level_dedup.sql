-- ============================================================================
-- File-level dedup: one ipd_doc per logical document.
-- ============================================================================
-- Builds on migrations 055 (file content_hash) and 056 (section-level
-- content_text_hash). The piece that was missing: when the SAME PDF is
-- uploaded twice (different file_name, different upload date, different
-- s3_key, but identical bytes), we want it to behave as ONE logical
-- document in the AI summary — not as two parallel pipelines producing
-- two parallel harmonised sections.
--
-- Why a new column instead of relying on content_hash dedup at section level:
--   - content_hash on existing rows is NULL (back-catalog uploaded before
--     migration 055; needs S3-byte backfill that's blocked on creds)
--   - file_size is a 100%-cheap proxy for back-catalog: two files with
--     identical byte counts AND same patient are essentially never
--     genuinely different
--   - section-level content_text_hash dedup misses these because Tesseract
--     OCR is non-deterministic across runs — same bytes produce slightly
--     different text → different sha256s
--
-- Hierarchy after this migration:
--   ipd_doc.dedup_of NULL          = canonical file
--   ipd_doc.dedup_of NOT NULL      = duplicate; references the canonical
--   document_sections.dedup_of NULL+ipd_doc.dedup_of NULL  = canonical section
--   document_sections.dedup_of NOT NULL                    = duplicate section
--
-- Harmoniser already filters to canonical sections only (loadSections
-- WHERE dedup_of IS NULL). The FE photos endpoint will additionally
-- filter ipd_doc.dedup_of IS NULL to hide duplicate files from the
-- main DocumentsPanel. Both are reversible: NULLing the dedup_of
-- columns un-merges everything.

BEGIN;

ALTER TABLE hospital.ipd_doc
  ADD COLUMN IF NOT EXISTS dedup_of UUID
    REFERENCES hospital.ipd_doc(id) ON DELETE SET NULL;

ALTER TABLE hospital.ipd_doc
  ADD COLUMN IF NOT EXISTS dedup_method VARCHAR(20);
  -- Values:
  --   'sha256'    — content_hash matched exactly (most reliable)
  --   'file_size' — file_size proxy (used until sha256 backfill lands)
  --   'manual'    — reviewer-marked duplicate

ALTER TABLE hospital.ipd_doc
  ADD COLUMN IF NOT EXISTS dedup_confidence NUMERIC(4,3);
  -- 1.000 for sha256; 0.95 default for file_size (high but not certain).

-- Reverse lookup index: "give me all duplicates pointing at canonical X"
CREATE INDEX IF NOT EXISTS idx_ipd_doc_dedup_of
  ON hospital.ipd_doc (dedup_of)
  WHERE dedup_of IS NOT NULL;

-- Forward lookup: "find file-size duplicate candidates within a claim"
-- Already covered by idx_ipd_doc_claim_hash from migration 055 for the
-- sha256 path; this one supports the file_size proxy path.
CREATE INDEX IF NOT EXISTS idx_ipd_doc_ipd_filesize
  ON hospital.ipd_doc (ipd_id, file_size)
  WHERE file_size IS NOT NULL;

COMMIT;
