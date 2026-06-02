-- ============================================================================
-- 066 — Pipeline v2 Stage 0: the Layer-B `derived_page` table  (May 29, 2026)
-- ============================================================================
-- The two-layer artifact model the v2 pipeline rebuild is built on.
--
--   Layer A = `ipd_doc`     — the immutable patient UPLOAD. It is the coverage
--                             denominator and the ONLY thing that is ever "a
--                             document" or an ipd_doc dedup peer (mig 057).
--   Layer B = `derived_page`— a render PRODUCED from a Layer-A upload: one PDF
--                             page rasterised to JPEG, a HEIC/webp transcoded,
--                             an already-image upload passed through. This is
--                             the unit Stage 1's vision reader actually reads.
--
-- HARD invariants this table encodes (why it is its own table, not a column on
-- ipd_doc or a reuse of document_sections):
--   • A derived page is NEVER counted as a document. Coverage (Stage 0) is
--     ALWAYS measured against Layer-A `ipd_doc`, never against this table — so
--     rendering one 14-page PDF into 14 rows can never inflate the document
--     count or the coverage denominator.
--   • A derived page is NEVER an `ipd_doc` dedup peer. File-level dedup
--     (ipd_doc.dedup_of, mig 057) and visual dedup over renders (Stage 3, which
--     consumes derived_page.phash) are SEPARATE layers and must not be conflated
--     — a render collapsing into a visual cluster must never mark a source
--     upload as a duplicate file.
--   • Renders live under a SEPARATE S3 prefix from ipd_doc.s3_key, so a Layer-B
--     object can never be mistaken for an original upload in storage.
--   • Lineage is the triple (source_doc_id, page_index, transform): every render
--     points back to exactly the upload + page + transform that produced it. The
--     UNIQUE constraint on that triple makes re-rendering idempotent (a replay or
--     a re-run overwrites, never duplicates).
--
-- Additive + idempotent on replay (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF
-- NOT EXISTS). No destructive operations.
--
-- NOTE: authored for review; NOT yet applied to any environment.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- derived_page  (Layer B)
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hospital.derived_page (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lineage → the Layer-A upload this page was rendered from. CASCADE so a
  -- deleted upload takes its renders with it (renders have no independent life).
  source_doc_id UUID NOT NULL
    REFERENCES hospital.ipd_doc(id) ON DELETE CASCADE,

  -- 1-based page index WITHIN the source document (always 1 for a single image).
  page_index INT NOT NULL CHECK (page_index >= 1),

  -- How this render was produced — part of the lineage key. Known values:
  --   'pdf_render'  — a PDF page rasterised to an image
  --   'webp_to_jpg' — a webp upload re-encoded
  --   'heic_to_jpg' — an iPhone HEIC transcoded
  --   'identity'    — the upload was already a readable image; passed through
  transform VARCHAR(40) NOT NULL,

  -- Layer-B object key — a SEPARATE S3 prefix from ipd_doc.s3_key. Required:
  -- a derived_page row without bytes is meaningless.
  s3_key VARCHAR(500) NOT NULL,
  mime VARCHAR(100) NOT NULL,

  -- sha256 of the RENDER bytes — the exact-duplicate key for renders. Distinct
  -- from ipd_doc.content_hash (which hashes the ORIGINAL upload bytes). NULL
  -- until computed at render time.
  sha256 CHAR(64),

  -- Perceptual hashes of the render (hex). phash is the near-duplicate key
  -- Stage 3 clusters on; dhash corroborates it. NULL when hashing was skipped
  -- (e.g. a render that failed legibility before hashing).
  phash TEXT,
  dhash TEXT,

  -- Render bookkeeping — cheap to capture at render time, useful for audit and
  -- for spotting a degenerate (0-byte / 1×1) render. All optional.
  byte_size INTEGER,
  width_px INT,
  height_px INT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- The lineage key. One render per (source upload, page, transform); a re-run
  -- or replay UPSERTs onto the existing row rather than fanning out duplicates.
  UNIQUE (source_doc_id, page_index, transform)
);

-- Reverse lineage: "give me every render of upload X" (Stage 0 coverage,
-- Stage 1 read fan-out, lineage display in the review UI).
CREATE INDEX IF NOT EXISTS idx_derived_page_source
  ON hospital.derived_page (source_doc_id);

-- Stage 3 near-duplicate probe over renders. Partial: a render with no phash
-- is un-deduplicable and should not sit in the index.
CREATE INDEX IF NOT EXISTS idx_derived_page_phash
  ON hospital.derived_page (phash)
  WHERE phash IS NOT NULL;

-- Exact-duplicate render probe. Partial for the same reason.
CREATE INDEX IF NOT EXISTS idx_derived_page_sha256
  ON hospital.derived_page (sha256)
  WHERE sha256 IS NOT NULL;

-- updated_at touch trigger — same pattern as claim_ai_runs (mig 060) and
-- doc_phase_ledger (mig 061).
CREATE OR REPLACE FUNCTION hospital.derived_page_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_derived_page_touch_updated_at ON hospital.derived_page;
CREATE TRIGGER trg_derived_page_touch_updated_at
  BEFORE UPDATE ON hospital.derived_page
  FOR EACH ROW
  EXECUTE FUNCTION hospital.derived_page_touch_updated_at();

COMMIT;
