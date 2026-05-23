-- Migration 030: Event Schema Extensions (Sprint 2 — Intelligence Layer)
-- Date: 2026-05-18
--
-- Wave 0 introduced the LLM bridge, OCR, ontology, and FE primitives. This
-- migration prepares the *event substrate* the Intelligence Layer will write
-- against:
--
--   A. Two new columns on hospital.submission_events:
--      - kind            — typed event kind (claim_created, doc_uploaded,
--                          stage_transitioned, etc.). Coexists with the
--                          legacy `event_type` column from migration 027,
--                          which keeps writing the small open-enum the
--                          original submission/inbound pipeline used.
--                          The new dispatcher writes `kind`; legacy writers
--                          keep writing `event_type`. A future sprint
--                          backfills and drops the old column.
--      - correlation_id  — links related events (e.g. a stage_transitioned
--                          row correlates with the submission_sent that
--                          triggered it). Lets the FE timeline group
--                          causally-related rows.
--      Both columns are added inside a DO block that checks information_schema
--      first, so the migration is safe to re-run.
--
--   B. hospital.stage_transitions — enriched, queryable per-claim stage
--      history. Stage changes still write to submission_events (the firehose),
--      but stage_transitions captures the richer context (document sections
--      present, unresolved queries, reasoning, reversal flag) that the
--      Intelligence Layer needs for pattern-mining and timeline rendering.
--
--   C. Idempotency strengthening — submission_events gets its own
--      idempotency_key + claim_id columns and a UNIQUE constraint on the
--      pair, so the new eventDispatcher can safely retry without inserting
--      duplicate rows. Note: this is *separate from* migration 025's
--      idempotency_key on insurance_submissions — the dispatcher writes
--      events, not submissions.
--
-- All steps run in one transaction; everything is IF NOT EXISTS-guarded so
-- the migration is idempotent against partially-applied environments.

BEGIN;

-- ============================================================================
-- A. submission_events: kind + correlation_id
-- ============================================================================
-- Use a DO block so we can probe information_schema and skip cleanly if the
-- column was added in a hotfix or a previous run. Plain ADD COLUMN IF NOT
-- EXISTS would also work, but the DO block lets us emit a NOTICE and keep the
-- intent explicit (the columns carry new semantics, not just shape).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'hospital'
       AND table_name   = 'submission_events'
       AND column_name  = 'kind'
  ) THEN
    ALTER TABLE hospital.submission_events
      ADD COLUMN kind VARCHAR(64) NOT NULL DEFAULT 'unknown';
    COMMENT ON COLUMN hospital.submission_events.kind IS
      'Typed event kind from Backend/src/Services/events/eventTypes.ts (EVENT_KINDS). Coexists with the legacy event_type column (migration 027) which the original submission/inbound writers still populate. New dispatcher writes here; back-fill + drop of event_type happens in a later sprint. Default ''unknown'' preserves existing rows.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'hospital'
       AND table_name   = 'submission_events'
       AND column_name  = 'correlation_id'
  ) THEN
    ALTER TABLE hospital.submission_events
      ADD COLUMN correlation_id UUID NULL;
    COMMENT ON COLUMN hospital.submission_events.correlation_id IS
      'Optional UUID linking causally-related events. Example: a stage_transitioned row carries the correlation_id of the submission_sent that triggered the transition. NULL for events that don''t belong to a chain.';
  END IF;
END $$;

-- Index for correlation lookups — small, sparse, only used by the timeline
-- and the dispatcher's "find the head of this chain" query.
CREATE INDEX IF NOT EXISTS idx_se_correlation
  ON hospital.submission_events (correlation_id)
  WHERE correlation_id IS NOT NULL;

-- Index for kind-filtered queries (the dashboard's "show me all
-- ai_draft_created in the last 24h" panel).
CREATE INDEX IF NOT EXISTS idx_se_kind_created
  ON hospital.submission_events (kind, created_at DESC);

-- ============================================================================
-- C. submission_events: claim_id + idempotency_key + UNIQUE constraint
-- ============================================================================
-- The new eventDispatcher writes against claim_id (IPD id). The legacy 027
-- schema only has insurance_submission_id (NOT NULL) and ipd_id (nullable),
-- so we add a dedicated claim_id column that the dispatcher always populates.
-- For now claim_id is nullable so legacy rows (which only have ipd_id) stay
-- valid; a later sprint backfills claim_id := ipd_id and tightens to NOT NULL.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'hospital'
       AND table_name   = 'submission_events'
       AND column_name  = 'claim_id'
  ) THEN
    ALTER TABLE hospital.submission_events
      ADD COLUMN claim_id UUID NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE;
    COMMENT ON COLUMN hospital.submission_events.claim_id IS
      'Claim (IPD) the event belongs to. Nullable for backward compat with rows written by the legacy submissionEvents.service.ts before migration 030. The new eventDispatcher always populates it.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'hospital'
       AND table_name   = 'submission_events'
       AND column_name  = 'idempotency_key'
  ) THEN
    ALTER TABLE hospital.submission_events
      ADD COLUMN idempotency_key VARCHAR(128) NULL;
    COMMENT ON COLUMN hospital.submission_events.idempotency_key IS
      'Caller-supplied dedup key (e.g. ''ai_draft_created:<draft_id>''). The dispatcher uses it to make event writes safe to retry: a second insert with the same (claim_id, idempotency_key) is collapsed to the existing row. Separate from insurance_submissions.idempotency_key (migration 025), which dedups submission *sends*.';
  END IF;
END $$;

-- Partial UNIQUE constraint over (claim_id, idempotency_key). Partial so legacy
-- rows (claim_id IS NULL OR idempotency_key IS NULL) aren't constrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_se_claim_idem_unique
  ON hospital.submission_events (claim_id, idempotency_key)
  WHERE claim_id IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_se_claim_created
  ON hospital.submission_events (claim_id, created_at DESC)
  WHERE claim_id IS NOT NULL;

-- ============================================================================
-- B. stage_transitions — enriched per-claim stage history
-- ============================================================================
-- submission_events keeps logging stage_transitioned as a firehose row; this
-- table is the *queryable* per-claim history with the rich context the
-- Intelligence Layer (and the FE patient-timeline) need.
CREATE TABLE IF NOT EXISTS hospital.stage_transitions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- IPD id (one IPD == one claim in the current data model). NOT NULL: every
  -- stage transition belongs to exactly one claim.
  claim_id                 UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  -- NULL on the very first transition (no prior stage).
  before_stage             VARCHAR(100),
  after_stage              VARCHAR(100) NOT NULL,
  -- 'human' | 'ai_suggestion' | 'inbound_email' | 'submission_sent' | 'timeout'
  -- Open enum, controlled by app code (see eventTypes.ts triggered_by union).
  triggered_by             VARCHAR(64) NOT NULL,
  -- When the transition was caused by another event (e.g. a submission_sent
  -- flipped the stage to 'submitted'), we point back to that event so the
  -- timeline can render the causal link.
  triggering_event_id      UUID REFERENCES hospital.submission_events(id) ON DELETE SET NULL,
  -- Snapshot of document_sections present on the claim at the moment of
  -- transition. The sections table doesn't exist yet (Wave 1) — this column
  -- stores an array of UUIDs that will reference document_sections(id) once
  -- that table lands. NULL until then.
  context_doc_section_ids  UUID[],
  -- Snapshot of insurer queries that were still unresolved at transition
  -- time. Same forward-compat shape as context_doc_section_ids.
  unresolved_query_ids     UUID[],
  -- True when the transition moves the claim *backward* in the lifecycle
  -- (e.g. submitted -> queried, approved -> rejected). Drives the "reversal"
  -- chip in the timeline and the Intelligence Layer's reversal-rate metrics.
  was_reversal             BOOLEAN NOT NULL DEFAULT FALSE,
  -- Human or AI-supplied explanation. Free-form; used in the timeline and
  -- in the audit export. May be NULL for purely mechanical transitions
  -- (timeouts, submission_sent auto-advance).
  reasoning                TEXT,
  -- Operator who triggered the transition. NULL when triggered_by != 'human'.
  actor_user_id            UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-claim history (the most common access pattern: "show me the stage
-- timeline for claim X").
CREATE INDEX IF NOT EXISTS idx_st_claim_created
  ON hospital.stage_transitions (claim_id, created_at DESC);

-- "How often does the AI suggest a transition?" / "How often does a timeout
-- fire?" — dashboard aggregations.
CREATE INDEX IF NOT EXISTS idx_st_triggered_by
  ON hospital.stage_transitions (triggered_by, created_at DESC);

-- Plain claim_id index for FK joins (cheap; small table relative to events).
CREATE INDEX IF NOT EXISTS idx_st_claim_id
  ON hospital.stage_transitions (claim_id);

COMMENT ON TABLE hospital.stage_transitions IS
  'Enriched per-claim stage history. Stage changes also write a stage_transitioned row to submission_events (the firehose), but this table is the source of truth for "what was the context at the moment of transition?" — document sections present, queries unresolved, reversal flag, reasoning. Powers the patient timeline and the Intelligence Layer''s reversal-rate / stuck-stage analytics.';

COMMIT;
