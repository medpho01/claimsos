-- Migration 031: claim_dossiers projection table (Sprint 3, Wave 1)
-- Date: 2026-05-18
--
-- The ClaimDossier is the denormalised "right-now" view of a single insurance
-- claim. It is a read-side projection — every column is derivable from a fold
-- of hospital.submission_events (and, at bootstrap, the parent
-- insurance_submissions/ipds rows). The projection is rebuilt asynchronously by
-- Backend/src/Workers/claimDossierProjector.queue.ts whenever a new event is
-- written for the claim.
--
-- Why a projection at all?
--   - The UI's "claim cockpit" needs sectioned documents, open obligations,
--     latest adjudication, KB linkage, and full timeline in one read. A live
--     SELECT-and-join across 8+ tables on every page load is wasteful and
--     awkward — projecting once on write, reading flat on the hot path, is the
--     standard CQRS shape.
--   - The projection is *recomputable*. last_event_id + last_event_at + version
--     let us detect skew vs the event log and trigger a rebuild without losing
--     ground.
--
-- claim_id semantics:
--   For Wave 1 we identify a "claim" with hospital.insurance_submissions.id.
--   A single IPD can have multiple insurance_submissions (pre-auth, enhancement,
--   final bill — each a fresh row keyed by resubmission_of_id chain). For the
--   moment we project at the *IPD* grain — one dossier per patient admission,
--   accumulating state across all submissions/filings within that IPD. This
--   matches Lane A (030)'s decision to FK submission_events.claim_id and
--   stage_transitions.claim_id to hospital.ipds(id) as well.
--   ON DELETE CASCADE so an IPD delete cleans up its projection.

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.claim_dossiers (
  claim_id                   UUID PRIMARY KEY
                             REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- ─── Replay markers ───────────────────────────────────────────────────
  -- The most recent submission_events row folded into this projection.
  -- Used by the projector to (a) skip re-applying events older than what's
  -- already baked in, and (b) detect drift between projection and event log.
  last_event_id              UUID,
  last_event_at              TIMESTAMPTZ,
  version                    INT NOT NULL DEFAULT 0,

  -- ─── Denormalised "now" ───────────────────────────────────────────────
  current_stage              VARCHAR(100),
  current_panel_id           UUID,
  current_insurer_id         UUID,
  -- {name, uhid, room, primary_diagnosis, procedure}
  patient_summary            JSONB,
  -- {claimed, pre_auth_approved, enhancement_approved, final_approved, deducted}
  amounts                    JSONB,

  -- ─── Document bundle, sectioned by canonical doc_category code ────────
  -- Shape: { discharge_summary: [section_id, ...], investigations: [...] }
  doc_sections_by_category   JSONB,
  -- Stage-keyed map of {required, present, missing} per upcoming step.
  doc_sufficiency_per_stage  JSONB,

  -- ─── Interaction history ──────────────────────────────────────────────
  -- Ordered array of {kind, at, actor, salient}. Truncated client-side; this
  -- column holds the full ribbon for the audit-trail panel.
  events_summary             JSONB,
  inbound_emails             JSONB,
  outbound_submissions       JSONB,

  -- ─── Open obligations ─────────────────────────────────────────────────
  active_queries             JSONB,
  pending_actions            JSONB,

  -- ─── AI's view of the case ────────────────────────────────────────────
  -- Latest AdjudicationReport — full shape lives in code (Sprint 5 lane).
  active_adjudication        JSONB,
  ai_drafts_pending          JSONB,

  -- ─── KB linkage ───────────────────────────────────────────────────────
  -- Pattern UUIDs the case currently matches (insurer × diagnosis × tariff).
  matched_kb_patterns        UUID[],
  -- 'fresh' | 'stale' | 'pending' — embedding for similarity search lives in
  -- a separate pgvector table introduced later; this column tracks freshness.
  case_embedding_state       VARCHAR(32),

  -- ─── Closure ──────────────────────────────────────────────────────────
  closed_at                  TIMESTAMPTZ,
  closure_outcome            VARCHAR(64),  -- 'settled' | 'rejected' | 'withdrawn'
  retrospective_summary      JSONB,

  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cd_current_stage
  ON hospital.claim_dossiers (current_stage);

CREATE INDEX IF NOT EXISTS idx_cd_closed_at
  ON hospital.claim_dossiers (closed_at);

CREATE INDEX IF NOT EXISTS idx_cd_current_panel
  ON hospital.claim_dossiers (current_panel_id);

CREATE INDEX IF NOT EXISTS idx_cd_matched_kb_patterns
  ON hospital.claim_dossiers USING GIN (matched_kb_patterns);

-- ─── Comments ────────────────────────────────────────────────────────────
COMMENT ON TABLE  hospital.claim_dossiers IS
  'Denormalised projection of a single insurance claim built by folding hospital.submission_events. CQRS read model — recomputable end-to-end via claimDossierProjector. Source of truth remains the event log; this table optimises the cockpit read path.';

COMMENT ON COLUMN hospital.claim_dossiers.claim_id IS
  'FK to hospital.insurance_submissions(id). Projects at the submission grain for Wave 1; a future hospital.claims aggregate may re-key.';

COMMENT ON COLUMN hospital.claim_dossiers.last_event_id IS
  'Most recent submission_events.id folded into this projection. Combined with last_event_at it gates idempotent re-application of the same event.';

COMMENT ON COLUMN hospital.claim_dossiers.version IS
  'Monotonic counter bumped on every successful projection write. Used for optimistic-concurrency hints to readers and to spot regressions.';

COMMENT ON COLUMN hospital.claim_dossiers.doc_sections_by_category IS
  'JSONB map { <doc_category_code>: <section_id[]> } — derived from section_classified events. Drives the sectioned-documents view.';

COMMENT ON COLUMN hospital.claim_dossiers.events_summary IS
  'Ordered ribbon of { kind, at, actor, salient } objects — one per event, oldest first. The full audit trail UI renders from this.';

COMMENT ON COLUMN hospital.claim_dossiers.active_adjudication IS
  'Latest AdjudicationReport blob (Sprint 5 vocabulary). Overwritten by every adjudication_run event.';

COMMENT ON COLUMN hospital.claim_dossiers.case_embedding_state IS
  '''fresh'' | ''stale'' | ''pending''. Embedding vectors live in a separate pgvector table once that lane lands; this flag tells the similarity worker whether to recompute.';

COMMIT;
