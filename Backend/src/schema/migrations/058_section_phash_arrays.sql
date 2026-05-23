-- ============================================================================
-- Perceptual-hash dedup — per-page pHash + dHash arrays on sections.
-- ============================================================================
-- The fifth dedup layer on top of:
--   055 — file-level sha256 (ipd_doc.content_hash)
--   056 — section-level OCR text hash (document_sections.content_text_hash)
--   057 — file-level dedup_of (catches re-uploaded files)
-- pHash catches the case all previous layers miss: the SAME visual content
-- embedded inside DIFFERENT PDF containers (different bytes, different OCR
-- text after Tesseract jitter). Validated on Vahid against the local
-- Python imagehash reference: 11 sections + 2 files deduped that text-
-- hash + sha256 could not catch.
--
-- Per-page arrays (not section-level scalars):
--   A section can span 1-many pages. Storing the pHash list per page
--   lets us match sections of identical content even when the page-range
--   coverage differs across runs (e.g. one bundle classify run grouped
--   four OT photos into a single 4-page section; another emitted them
--   as four 1-page sections — still the same content, should still dedup).
--
-- 256-bit precision (16 hex chars per hash):
--   matches the Python imagehash hash_size=16 that proved out on Vahid.
--   64-bit (the default for most JS libs) is too coarse — false positive
--   rate on different X-rays gets noticeable.

BEGIN;

ALTER TABLE hospital.document_sections
  ADD COLUMN IF NOT EXISTS content_phash_array TEXT[],     -- one 16-char hex pHash per page in section's [page_start..page_end] range
  ADD COLUMN IF NOT EXISTS content_dhash_array TEXT[],     -- dHash for confirmation (different false-positive pattern from pHash)
  ADD COLUMN IF NOT EXISTS phash_computed_at TIMESTAMP;    -- backfill progress marker

-- GIN index supports "find sections containing pHash X" queries used by
-- the cross-section page-level dedup (Phase 4 work). Partial so back-
-- catalog NULLs don't bloat the index.
CREATE INDEX IF NOT EXISTS idx_doc_sections_phash_gin
  ON hospital.document_sections USING GIN (content_phash_array)
  WHERE content_phash_array IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_doc_sections_phash_pending
  ON hospital.document_sections (claim_id)
  WHERE content_phash_array IS NULL;
-- Drives the backfill cursor: "give me sections needing pHash, by claim".

COMMIT;
