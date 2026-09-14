-- ============================================================================
-- 076 — run consent, pause/resume, unreadable pages
-- ============================================================================
-- Extends claim_ai_runs (060) with a paused state + cost-consent columns,
-- extends doc_phase_ledger (061) with a 'blocked' status, adds the
-- claim_ai_unreadable_pages table, and adds run attribution to llm_cost_log.
--
-- Every statement is idempotent. The CHECK-constraint replacements discover
-- the existing constraint by DEFINITION rather than by name, because a
-- database restored from a pg_dump may carry a system-generated name we did
-- not choose. Each definition-scoped DO-block is paired with an explicit
-- `DROP CONSTRAINT IF EXISTS <our name>` so that the SECOND run — where the
-- constraint is the one THIS file added, under the name this file chose — is
-- equally clean, and so the lint guard can see the drop that makes the
-- following ADD CONSTRAINT replayable.
--
-- Why this migration exists (2026-09-14):
--   Vision-only OCR means a page vision cannot read is no longer silently
--   degraded to Tesseract — it becomes an UNREADABLE PAGE carrying a reason.
--   That needs somewhere to live (claim_ai_unreadable_pages). Cost consent
--   means a run now carries the budget a human approved, and can PARK itself
--   mid-flight when actual spend would cross it — that needs a seventh run
--   status ('paused') and the columns that let the UI re-ask the question
--   with real numbers. Resume needs to know which phases were CUT SHORT by
--   a bound (redo them) versus which genuinely finished (skip them) — that
--   is the 'blocked' ledger status, and it is the single fact that makes
--   resume-with-more-budget correct rather than a re-run.
-- ============================================================================

BEGIN;

-- ─── A. claim_ai_runs: new columns ──────────────────────────────────────────
ALTER TABLE hospital.claim_ai_runs
  ADD COLUMN IF NOT EXISTS pause_reason            TEXT,
  ADD COLUMN IF NOT EXISTS paused_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_by               UUID,
  ADD COLUMN IF NOT EXISTS approved_budget_inr     NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS budget_approved_by      UUID,
  ADD COLUMN IF NOT EXISTS budget_approved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS spend_at_pause_inr      NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS projected_remaining_inr NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS resume_count            INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimate                JSONB,
  ADD COLUMN IF NOT EXISTS end_reason              TEXT,
  ADD COLUMN IF NOT EXISTS unreadable_acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unreadable_acknowledged_by UUID;

COMMENT ON COLUMN hospital.claim_ai_runs.approved_budget_inr IS
  'Total rupees (OCR page reads + reasoning, combined) the user approved for '
  'this run. NULL only on legacy rows created before migration 076. Raised '
  'in place by a resume-with-more-budget; never lowered.';
COMMENT ON COLUMN hospital.claim_ai_runs.estimate IS
  'Frozen snapshot of the RunCostEstimate the user was shown when they '
  'approved. Audit: it must be possible to answer "what were they told?" '
  'without recomputing against a document set that has since changed.';
COMMENT ON COLUMN hospital.claim_ai_runs.spend_at_pause_inr IS
  'Run spend at the moment of the pause. Denormalised deliberately: the UI '
  'must show the same number the pause decision was made on, even if late '
  'cost-log rows from in-flight calls land afterwards.';

-- ─── B. claim_ai_runs: status CHECK gains 'paused' ──────────────────────────
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class      rel ON rel.oid = con.conrelid
      JOIN pg_namespace  ns  ON ns.oid  = rel.relnamespace
     WHERE ns.nspname = 'hospital'
       AND rel.relname = 'claim_ai_runs'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%status%'
       AND pg_get_constraintdef(con.oid) ILIKE '%superseded%'
  LOOP
    EXECUTE format('ALTER TABLE hospital.claim_ai_runs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

-- Belt and braces for the replay case: on the second run the loop above has
-- already removed whatever the dump called it, and what remains is the
-- constraint this file added under the name below.
ALTER TABLE hospital.claim_ai_runs
  DROP CONSTRAINT IF EXISTS claim_ai_runs_status_check;

-- NOT VALID first, then VALIDATE: the row scan then takes SHARE UPDATE
-- EXCLUSIVE instead of holding ACCESS EXCLUSIVE for its duration.
ALTER TABLE hospital.claim_ai_runs
  ADD CONSTRAINT claim_ai_runs_status_check
  CHECK (status IN ('queued','running','paused','succeeded','partial','failed','superseded'))
  NOT VALID;
ALTER TABLE hospital.claim_ai_runs VALIDATE CONSTRAINT claim_ai_runs_status_check;

-- ─── C. claim_ai_runs: pause_reason + end_reason enums ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname='hospital' AND rel.relname='claim_ai_runs'
       AND con.conname='claim_ai_runs_pause_reason_check'
  ) THEN
    ALTER TABLE hospital.claim_ai_runs
      ADD CONSTRAINT claim_ai_runs_pause_reason_check
      CHECK (pause_reason IS NULL OR pause_reason IN ('user_requested','cost_consent_required'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname='hospital' AND rel.relname='claim_ai_runs'
       AND con.conname='claim_ai_runs_end_reason_check'
  ) THEN
    ALTER TABLE hospital.claim_ai_runs
      ADD CONSTRAINT claim_ai_runs_end_reason_check
      CHECK (end_reason IS NULL OR end_reason IN (
        'completed','budget_declined','user_cancelled','unreadable_pages',
        'orchestrator_error','superseded'));
  END IF;
END $$;

COMMENT ON COLUMN hospital.claim_ai_runs.pause_reason IS
  'Why the run is parked. ''user_requested'' = someone pressed Pause; '
  '''cost_consent_required'' = actual spend reached the approved budget and '
  'the run is waiting on a human to approve more or finish with what exists. '
  'NULL whenever status <> ''paused''.';
COMMENT ON COLUMN hospital.claim_ai_runs.end_reason IS
  'How the run reached its terminal state. Distinguishes a clean finish from '
  'a declined budget, a user cancel, an orchestrator crash, a supersession, '
  'and a finish where pages were left unread.';

-- ─── D. claim_ai_runs: a paused run is ACTIVE for supersession purposes ─────
-- The 060 partial index covered ('queued','running') only. A new Run-Analysis
-- click must also supersede a run someone left paused three days ago.
DROP INDEX IF EXISTS hospital.idx_claim_ai_runs_active;
CREATE INDEX IF NOT EXISTS idx_claim_ai_runs_active
  ON hospital.claim_ai_runs (claim_id)
  WHERE status IN ('queued','running','paused');

-- Pause polling hot path: workers read (id) -> (status, pause_reason). The
-- PK already serves it; this index serves "any paused run for this claim".
CREATE INDEX IF NOT EXISTS idx_claim_ai_runs_paused
  ON hospital.claim_ai_runs (claim_id, paused_at DESC)
  WHERE status = 'paused';

-- ─── E. doc_phase_ledger: status gains 'blocked' ────────────────────────────
-- 'blocked' = the phase RAN but was cut short by a budget or pause bound and
-- MUST be re-run on resume. It is the single fact that makes resume correct:
-- 'done' is skipped, 'blocked' is redone. Without it, resume-with-more-budget
-- would inherit the truncated transcription the extra money was meant to buy.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class      rel ON rel.oid = con.conrelid
      JOIN pg_namespace  ns  ON ns.oid  = rel.relnamespace
     WHERE ns.nspname='hospital' AND rel.relname='doc_phase_ledger'
       AND con.contype='c'
       AND pg_get_constraintdef(con.oid) ILIKE '%status%'
       AND pg_get_constraintdef(con.oid) ILIKE '%skipped%'
  LOOP
    EXECUTE format('ALTER TABLE hospital.doc_phase_ledger DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE hospital.doc_phase_ledger
  DROP CONSTRAINT IF EXISTS doc_phase_ledger_status_check;

ALTER TABLE hospital.doc_phase_ledger
  ADD CONSTRAINT doc_phase_ledger_status_check
  CHECK (status IN ('pending','running','done','skipped','failed','blocked'))
  NOT VALID;
ALTER TABLE hospital.doc_phase_ledger VALIDATE CONSTRAINT doc_phase_ledger_status_check;

CREATE INDEX IF NOT EXISTS idx_doc_phase_ledger_resumable
  ON hospital.doc_phase_ledger (run_id, phase)
  WHERE status IN ('pending','running','blocked');

-- ─── F. claim_ai_unreadable_pages ───────────────────────────────────────────
-- One row per (run, document, page) that vision could not read. Written by
-- the OCR CONSUMERS (which know run_id), never by ocr.service (which does
-- not). Rows are per-run, so a resume that succeeds simply deletes the ones
-- it fixed — the table always describes the CURRENT truth of the run.
CREATE TABLE IF NOT EXISTS hospital.claim_ai_unreadable_pages (
  run_id       UUID NOT NULL REFERENCES hospital.claim_ai_runs(id) ON DELETE CASCADE,
  doc_id       UUID NOT NULL,
  page_number  INT  NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN (
                 'vision_failed','cost_budget','latency_budget',
                 'page_budget','render_failed')),
  detail       TEXT,
  phase        TEXT CHECK (phase IS NULL OR phase IN (
                 'ingest','classify','dedup','extract','harmonise')),
  section_id   UUID,
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, doc_id, page_number)
);

COMMENT ON TABLE hospital.claim_ai_unreadable_pages IS
  'Pages vision could not read, per run. An unreadable page is a HOLE, not an '
  'empty page: it is never silently substituted and never drops the document. '
  'Rows describe the CURRENT truth of the run, not a history of attempts — a '
  'successful re-read deletes its row.';
COMMENT ON COLUMN hospital.claim_ai_unreadable_pages.reason IS
  'Frozen 5-member enum, each mapping to exactly one operator action: '
  'vision_failed -> retry; cost_budget -> approve more budget; '
  'latency_budget -> rerun with more time; page_budget -> split the document; '
  'render_failed -> re-upload the document.';
COMMENT ON COLUMN hospital.claim_ai_unreadable_pages.detail IS
  'Short, PHI-free, operator-safe explanatory string (<= 200 chars).';

CREATE INDEX IF NOT EXISTS idx_unreadable_pages_run
  ON hospital.claim_ai_unreadable_pages (run_id, doc_id, page_number);
CREATE INDEX IF NOT EXISTS idx_unreadable_pages_reason
  ON hospital.claim_ai_unreadable_pages (run_id, reason);

CREATE OR REPLACE FUNCTION hospital.claim_ai_unreadable_pages_touch()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_claim_ai_unreadable_pages_touch
  ON hospital.claim_ai_unreadable_pages;
CREATE TRIGGER trg_claim_ai_unreadable_pages_touch
  BEFORE UPDATE ON hospital.claim_ai_unreadable_pages
  FOR EACH ROW EXECUTE FUNCTION hospital.claim_ai_unreadable_pages_touch();

-- ─── G. llm_cost_log run attribution ────────────────────────────────────────
-- Nullable and unpopulated for now. Run spend is defined as a time-window
-- query today and a run_id query once this column is threaded through the
-- call sites; the canonical query reads BOTH, so no second migration is
-- needed when the threading lands.
ALTER TABLE hospital.llm_cost_log
  ADD COLUMN IF NOT EXISTS run_id UUID;

CREATE INDEX IF NOT EXISTS idx_llm_cost_run
  ON hospital.llm_cost_log (run_id, created_at)
  WHERE run_id IS NOT NULL;

COMMENT ON COLUMN hospital.llm_cost_log.run_id IS
  'claim_ai_runs.id this billed call belongs to. Nullable and not yet '
  'populated at the time this column landed: run spend is read as '
  '(run_id = $run OR (run_id IS NULL AND created_at >= run.triggered_at)), '
  'which over-counts a superseded run''s tail calls. Over-counting fails '
  'SAFE — it asks for consent earlier than strictly necessary, and can never '
  'let a run silently outspend its approval.';

COMMIT;
