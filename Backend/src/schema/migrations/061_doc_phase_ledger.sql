-- ============================================================================
-- doc_phase_ledger — per-doc, per-phase audit trail for the AI pipeline
-- ============================================================================
-- Step P6 of the May 20, 2026 pipeline re-architecture (companion to
-- migration 060 which added claim_ai_runs).
--
-- Background:
--   claim_ai_runs gives us a CLAIM-level cursor: "Run R is at phase=classify,
--   docs_completed=5/12". That's enough for the FE to render a coarse
--   progress banner, but not enough to answer:
--     - WHICH 5 docs are done? Which 7 are still in flight?
--     - When the run finished, did any doc fail quality gate or get
--       skipped via file-dedup?
--     - What was the OCR rotation chosen for each doc? Was vision used?
--   The status endpoint's aggregator-only design (claimAiRun.recomputeFromState)
--   reads document_sections to count progress — that's a roll-up, not a
--   per-doc audit trail.
--
--   doc_phase_ledger is the audit trail. ONE row per (doc_id, run_id,
--   phase) tuple. Workers write a row at the start of each phase (status=
--   running) and finish it (status=done | skipped | failed) when they
--   exit. The evidence JSONB carries phase-specific outcomes — rotation
--   angle, OCR confidence, dedup pointer, extractor model used, etc.
--
--   Phases enumerated:
--     ingest    → quality gate + OCR + orientation + pHash compute (Phase 1)
--     classify  → bundle classifier (Phase 2)
--     dedup     → section dedup pass (Phase 3) — claim-level not per-doc,
--                  but we record one row per doc with the outcome
--     extract   → docExtractor (Phase 4)
--     harmonise → claim harmoniser (Phase 5) — also claim-level
--
-- Why per (doc, run, phase) tuple:
--   - Re-runs are first-class. Run #1 might have failed a doc at extract;
--     Run #2 (force) succeeds. We want both rows preserved for audit.
--   - The (doc, run, phase) composite key naturally idempotent — workers
--     can UPSERT and the row is unique.
--
-- What the FE gets out of this:
--   /claims/:id/status returns the LATEST run row from claim_ai_runs
--   plus a roll-up of doc_phase_ledger for that run. FE renders:
--     "Doc 5/12 · OCR ✓ (rotated 90°) · Classifying…"

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.doc_phase_ledger (
  doc_id            UUID NOT NULL,
  run_id            UUID NOT NULL REFERENCES hospital.claim_ai_runs(id) ON DELETE CASCADE,
  phase             TEXT NOT NULL CHECK (phase IN (
                      'ingest','classify','dedup','extract','harmonise'
                    )),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                      'pending','running','done','skipped','failed'
                    )),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,

  -- Free-form per-phase outcomes. Shape conventions (documented here,
  -- not enforced by schema):
  --   ingest:    { quality_score?: number, mime?: string, page_count?: number,
  --                rotation_pages?: [{page: 5, angle: 90}, ...],
  --                ocr_avg_confidence?: number, needs_human_review?: boolean }
  --   classify:  { sections_created: number, fell_back_to_segmenter?: boolean,
  --                llm_cost_inr?: number, classifier_version?: string }
  --   dedup:     { groups_found: number, sections_deduped: number,
  --                methods: ['text_exact', 'phash_v1'] }
  --   extract:   { section_count: number, sections_extracted: number,
  --                sections_no_schema?: number, llm_cost_inr?: number }
  --   harmonise: { episode_status: string, cost_inr?: number,
  --                source_documents_count?: number }
  evidence          JSONB,

  -- Surfaces in the FE when status='failed' so reviewers know why a
  -- doc was kicked from a phase without diving into worker logs.
  error             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (doc_id, run_id, phase)
);

-- Run roll-up: "all phases for run R" — used by status endpoint.
CREATE INDEX IF NOT EXISTS idx_doc_phase_ledger_run
  ON hospital.doc_phase_ledger (run_id, phase);

-- Per-doc lookup across runs (audit trail for a single doc over time).
CREATE INDEX IF NOT EXISTS idx_doc_phase_ledger_doc
  ON hospital.doc_phase_ledger (doc_id, run_id);

-- Stall detection: "any phase in 'running' state for >5 minutes" needs
-- to be queryable cheaply. Partial index on running rows only.
CREATE INDEX IF NOT EXISTS idx_doc_phase_ledger_running
  ON hospital.doc_phase_ledger (started_at)
  WHERE status = 'running';

-- updated_at touch trigger — same pattern as claim_ai_runs.
CREATE OR REPLACE FUNCTION hospital.doc_phase_ledger_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_doc_phase_ledger_touch_updated_at ON hospital.doc_phase_ledger;
CREATE TRIGGER trg_doc_phase_ledger_touch_updated_at
  BEFORE UPDATE ON hospital.doc_phase_ledger
  FOR EACH ROW
  EXECUTE FUNCTION hospital.doc_phase_ledger_touch_updated_at();

COMMIT;
