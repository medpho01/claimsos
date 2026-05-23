-- ============================================================================
-- 065 — Hospital format profiles + Document format library  (Phase 3, May 21, 2026)
-- ============================================================================
-- Two related capabilities for scalable extraction:
--
-- A. hospital_format_profiles  (few-shot learning per hospital)
--    Reviewers correct extractor mistakes via the extraction_corrections
--    ledger (mig 064). When enough corrections converge on a consistent
--    pattern for (hospital, doc_category, field), we precipitate that
--    pattern out as a "format profile" — a short, prompt-ready hint that
--    can be injected into the extractor system prompt for ALL future
--    documents from that hospital. This lets accuracy improve organically
--    as a hospital's claim stream accumulates without re-training the LLM.
--
-- B. document_format_library  (pHash-based layout fingerprinting)
--    Many docs from the same hospital share an EXACT layout (e.g. the
--    Jigyasa coronary-angiography report v2). The pHash of the first
--    canonical section's first page fingerprints that layout. We keep a
--    library of known formats per hospital so we can later fast-path
--    extraction for known formats (deterministic field-position reads,
--    hospital-specific extractor routes). This migration just BUILDS the
--    library — routing on matches comes in a later iteration.
--
-- Both tables are additive — no destructive operations. Idempotent on
-- replay (CREATE TABLE IF NOT EXISTS).

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- A. hospital_format_profiles
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hospital.hospital_format_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  doc_category VARCHAR(100) NOT NULL,
  field_name VARCHAR(100) NOT NULL,
  -- Short natural-language hint about how this hospital formats this field.
  -- Read by the extractor prompt assembly; goes into the user message as a
  -- HOSPITAL_FORMAT_HINTS bullet.
  extraction_hint TEXT NOT NULL,
  -- Verbatim quote from a past document and the reviewer-corrected value.
  -- Used as the "few-shot example" half of the hint. Optional — purely
  -- text-narrative profiles can omit these.
  example_quote TEXT,
  example_value TEXT,
  -- Bookkeeping: how many distinct reviewer corrections this profile was
  -- aggregated from. Higher = more reliable. The aggregator bumps this
  -- on each rebuild; the prompt assembler sorts DESC by confidence so
  -- the most-reliable hints survive the 1500-token cap.
  source_correction_count INT DEFAULT 0,
  confidence NUMERIC(4,3) DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(hospital_id, doc_category, field_name)
);

CREATE INDEX IF NOT EXISTS idx_hfp_hospital_cat
  ON hospital.hospital_format_profiles(hospital_id, doc_category);

-- ──────────────────────────────────────────────────────────────────────
-- B. document_format_library
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hospital.document_format_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  doc_category VARCHAR(100),
  -- Human-readable label, e.g. "Jigyasa Coronary Angiography Report v1".
  -- Initially auto-generated ("<hospital>:<category>:<short_hash>"); admins
  -- can rename via the format-library admin UI.
  format_label TEXT NOT NULL,
  -- Representative pHash of the layout. For now, the first page of the
  -- first canonical section, which is enough to fingerprint most
  -- single-page forms (admission slip, discharge slip, lab report header).
  representative_phash TEXT NOT NULL,
  -- Sample document_section IDs that exemplify this format (kept for
  -- human review of misclassifications and for the later deterministic
  -- extractor to bootstrap field positions). Capped at ~10 entries by
  -- the service to keep the row small.
  sample_section_ids UUID[] DEFAULT '{}',
  -- Hand-curated field bounding boxes per format. Populated later for
  -- hot formats; this migration leaves it NULL.
  field_positions JSONB,
  occurrence_count INT DEFAULT 0,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(hospital_id, representative_phash)
);

CREATE INDEX IF NOT EXISTS idx_dfl_phash
  ON hospital.document_format_library(representative_phash);
CREATE INDEX IF NOT EXISTS idx_dfl_hospital_cat
  ON hospital.document_format_library(hospital_id, doc_category);

COMMIT;
