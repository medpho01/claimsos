-- ============================================================================
-- claim_ai_runs — the AI pipeline's claim-level run cursor
-- ============================================================================
-- Background (May 20, 2026):
--   The intelligence pipeline is a chain of Bull workers (bundle classifier
--   → section dedup → extractor → harmoniser → adjudication). Each worker
--   writes its outputs to the DB asynchronously as it finishes. The
--   frontend has historically polled `document_sections` directly to
--   render the Claim AI Summary > Documents tab — which means it sees
--   partial state every time it polls, and that partial state KEEPS
--   CHANGING for the 2-5 minutes it takes the pipeline to finish all
--   docs. Result: documents appear, sections shift, the "extracted" count
--   ticks upward on every refresh. Users reasonably interpret this as
--   "the analysis is unstable / unreliable".
--
--   The fix is a claim-level run cursor: one row inserted at the start of
--   each `Run AI Analysis` click, updated as the pipeline progresses,
--   marked `succeeded` only when ALL docs are done. The FE polls this
--   row and gates the Documents tab on its terminal state. Mid-run, it
--   shows a single progress card instead of a flickering half-built
--   table.
--
--   This migration is the first step of the 7-step pipeline re-arch
--   tracked in ADR-2026-05-20. Subsequent steps add a per-doc phase
--   ledger, split orientation/quality into their own phases, and move
--   file-level dedup ahead of classify. Step 1 alone is enough to stop
--   the flicker.

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.claim_ai_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id         UUID NOT NULL,
  triggered_by     UUID,                              -- user_id, NULL for system-triggered runs
  triggered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Run lifecycle:
  --   queued      → orchestrator accepted the request, workers not yet active
  --   running     → at least one phase is in flight
  --   succeeded   → all phases finished with no per-doc failures
  --   partial     → all phases finished, but ≥1 doc failed (docs_failed > 0)
  --   failed      → the run itself crashed (orchestrator-level error)
  --   superseded  → a newer Run AI click for the same claim_id took over
  status           TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','running','succeeded','partial','failed','superseded')),

  -- Coarse phase indicator for the FE progress banner. Granular per-doc
  -- detail will land in doc_phase_ledger (Step 3 of the rearch). Today
  -- this is good enough for "Processing… Classify phase 2/5".
  phase            TEXT
                       CHECK (phase IS NULL OR phase IN (
                         'quality','orient','dedup','classify','extract','harmonise','done'
                       )),

  -- Progress counters. `total_docs` is set once at start; `docs_completed`
  -- and `docs_failed` advance as workers finish. The FE renders
  -- "{docs_completed}/{total_docs} documents" until status flips terminal.
  total_docs       INT NOT NULL DEFAULT 0,
  docs_completed   INT NOT NULL DEFAULT 0,
  docs_failed      INT NOT NULL DEFAULT 0,

  -- Cumulative LLM cost for this run. Useful for the audit log + future
  -- per-run cost telemetry. NULL until at least one billed call lands.
  cost_inr         NUMERIC(10,4),

  -- Terminal timestamps. `finished_at` is set when status flips terminal
  -- (succeeded/partial/failed/superseded). Audit trail: every run row
  -- is retained per the ADR decision — no auto-cleanup.
  finished_at      TIMESTAMPTZ,
  error            TEXT,                              -- orchestrator-level error if status='failed'

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The FE's "current run" lookup: latest row for a given claim_id. We sort
-- by triggered_at DESC, so this composite index serves both that query
-- and historical audit lookups for a claim.
CREATE INDEX IF NOT EXISTS idx_claim_ai_runs_claim_triggered
  ON hospital.claim_ai_runs (claim_id, triggered_at DESC);

-- For supersession: when a new run starts, we need to find any
-- still-running runs for this claim. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS idx_claim_ai_runs_active
  ON hospital.claim_ai_runs (claim_id)
  WHERE status IN ('queued','running');

-- updated_at touch trigger so the orchestrator + worker writes don't need
-- to remember to bump it explicitly.
CREATE OR REPLACE FUNCTION hospital.claim_ai_runs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_claim_ai_runs_touch_updated_at ON hospital.claim_ai_runs;
CREATE TRIGGER trg_claim_ai_runs_touch_updated_at
  BEFORE UPDATE ON hospital.claim_ai_runs
  FOR EACH ROW
  EXECUTE FUNCTION hospital.claim_ai_runs_touch_updated_at();

COMMIT;
