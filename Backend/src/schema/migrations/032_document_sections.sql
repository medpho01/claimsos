-- Migration 032: Document Sections (Sprint 3, Wave 2A — DocSegmenter)
-- Date: 2026-05-18
--
-- The DocSegmenter takes an uploaded PDF (an `ipd_doc` row) and asks an LLM to
-- propose page-range boundaries that break the document into semantically-
-- distinct sections — e.g. a single 35-page "claim packet" is one upload but
-- contains a discharge slip, two pages of investigations, an ICP block, and a
-- final bill, each of which deserves its own classification and field
-- extraction.
--
-- This migration introduces two tables:
--
--   1. hospital.document_sections — one row per segment proposed (and later
--      reviewed) for a given ipd_doc. Holds the segmenter's output, plus
--      reserved columns for the downstream classifier (Wave 2A) and extractor
--      (Wave 2B). Storing all three stages in one row keeps the per-section
--      audit trail compact and avoids a join on the read path.
--
--   2. hospital.document_section_corrections — append-only log of human edits
--      (split / merge / reclassify / edit_fields). Pairs with the row-level
--      status field on document_sections so the FE can render a clean "this
--      section was auto-detected and edited by Asha on …" trail.
--
-- claim_id semantics:
--   Denormalised from ipd_doc.ipd_id so claim-scoped queries (e.g. "all
--   sections of all docs on this claim") don't have to join through ipd_doc.
--   FK'd ON DELETE CASCADE to hospital.ipds(id) — same convention used by
--   migrations 030/031.
--
-- All steps run in a single transaction; IF NOT EXISTS makes re-applying
-- against partially-seeded environments safe.

BEGIN;

-- ============================================================================
-- A. hospital.document_sections
-- ============================================================================
-- One row per (document_id, page_start..page_end) segment.
--
-- Lifecycle:
--   created by DocSegmenterService — category NULL, classification_confidence
--     holds the segmenter's *boundary* confidence (NOT classification).
--   updated by DocClassifierService (Wave 2A Lane B) — sets category,
--     reuses classification_confidence to hold the classifier's confidence,
--     fills classifier_provider/model/version.
--   updated by DocExtractorService (Wave 2B) — fills extracted_fields,
--     extraction_confidence, extractor_provider/model/version.
--   updated by FE review workflow — status moves auto -> reviewed | corrected,
--     reviewed_by/reviewed_at set, notes optional.
--
-- The segmenter is responsible only for boundaries; it stores its boundary
-- confidence as `classification_confidence` because the classifier overwrites
-- that field with the final category-confidence — same field re-used across
-- stages keeps the read shape simple.

CREATE TABLE IF NOT EXISTS hospital.document_sections (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The parent ipd_doc row. ON DELETE CASCADE because a section is meaningless
  -- without the document it segments.
  document_id                 UUID NOT NULL
                              REFERENCES hospital.ipd_doc(id) ON DELETE CASCADE,

  -- Denormalised from ipd_doc.ipd_id for fast claim-scoped reads. Matches the
  -- canonical claim grain established in migration 030.
  claim_id                    UUID
                              REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  page_start                  INT NOT NULL,
  page_end                    INT NOT NULL,

  -- master_options.code (category='doc_category'). NULL while classification
  -- is pending; populated by DocClassifierService.
  category                    VARCHAR(100),

  -- 0..1. While category is NULL this holds the segmenter's *boundary*
  -- confidence; once the classifier runs, it overwrites with category conf.
  classification_confidence   NUMERIC(4,3),
  classifier_provider         VARCHAR(64),
  classifier_model            VARCHAR(128),
  classifier_version          VARCHAR(32),

  -- Filled by DocExtractorService (Wave 2B). Shape is the per-doc-category
  -- schema from hospital.document_field_schemas keyed by field_key.
  extracted_fields            JSONB,
  -- Per-field confidence map. { field_key: 0..1 }.
  extraction_confidence       JSONB,
  extractor_provider          VARCHAR(64)
  ,
  extractor_model             VARCHAR(128),
  extractor_version           VARCHAR(32),

  -- Which segmenter prompt/code emitted this row. Bumped whenever segmentation
  -- logic changes meaningfully (drives the idempotency cache in
  -- DocSegmenterService — same (document_id, segmenter_version) short-circuits).
  segmenter_version           VARCHAR(32) NOT NULL,

  -- 'auto'    — emitted by the pipeline, no human has touched it
  -- 'reviewed' — human confirmed without edits
  -- 'corrected' — human edited (see document_section_corrections for the diff)
  status                      VARCHAR(32) NOT NULL DEFAULT 'auto',

  reviewed_by                 UUID,
  reviewed_at                 TIMESTAMP,
  notes                       TEXT,

  created_at                  TIMESTAMP DEFAULT NOW(),
  updated_at                  TIMESTAMP DEFAULT NOW(),

  CONSTRAINT chk_document_sections_pages
    CHECK (page_start >= 1 AND page_end >= page_start),
  CONSTRAINT chk_document_sections_status
    CHECK (status IN ('auto', 'reviewed', 'corrected'))
);

CREATE INDEX IF NOT EXISTS idx_document_sections_document
  ON hospital.document_sections (document_id);
CREATE INDEX IF NOT EXISTS idx_document_sections_claim
  ON hospital.document_sections (claim_id)
  WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_sections_claim_category
  ON hospital.document_sections (claim_id, category)
  WHERE claim_id IS NOT NULL AND category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_sections_status
  ON hospital.document_sections (status);

COMMENT ON TABLE hospital.document_sections IS
  'Per-segment row produced by DocSegmenter (boundaries) -> DocClassifier (category) -> DocExtractor (fields). One row per detected sub-document inside an ipd_doc upload.';

-- ============================================================================
-- B. hospital.document_section_corrections
-- ============================================================================
-- Append-only audit trail of human edits to document_sections. Each correction
-- carries the full before/after JSON so the FE can render a diff without
-- joining to other tables, and so we can mine these for training data later.
--
-- We intentionally key by document_id rather than section_id because some
-- actions (split, merge) operate on multiple sections at once — a merge takes
-- two sections and emits one; a split takes one and emits two. The before/
-- after JSON arrays carry whichever rows participated.

CREATE TABLE IF NOT EXISTS hospital.document_section_corrections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL,

  -- Maps onto SectionCorrectedPayload.action in eventTypes.ts. 'edit_fields'
  -- is unique to this table (the section_corrected event payload only covers
  -- split/merge/reclassify); we surface it here because a field-level edit
  -- also deserves the same audit trail.
  action          VARCHAR(32) NOT NULL,
  before          JSONB NOT NULL,
  after           JSONB NOT NULL,
  corrected_by    UUID NOT NULL,
  corrected_at    TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_document_section_corrections_action
    CHECK (action IN ('split', 'merge', 'reclassify', 'edit_fields'))
);

CREATE INDEX IF NOT EXISTS idx_document_section_corrections_document
  ON hospital.document_section_corrections (document_id);
CREATE INDEX IF NOT EXISTS idx_document_section_corrections_corrected_by
  ON hospital.document_section_corrections (corrected_by);

COMMENT ON TABLE hospital.document_section_corrections IS
  'Append-only edit history for document_sections. Captures split/merge/reclassify/edit_fields with full before/after JSON. Pairs with the row-level status flag on document_sections.';

COMMIT;
