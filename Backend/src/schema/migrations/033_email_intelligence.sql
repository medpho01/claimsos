-- Migration 033: Email Intelligence Drafts (Sprint 4, Wave 2C)
-- Date: 2026-05-18
--
-- Adds two tables that back the Email Intelligence layer — the bit of the
-- Intelligence stack that turns a raw inbound insurer email (approval letter,
-- query letter, rejection, follow-up) into a structured *draft* that a human
-- can review, edit, and apply to the claim. The LLM never writes to a claim
-- directly; every effect goes through the draft.
--
-- The two tables:
--
--   A. hospital.email_intelligence_drafts
--      One row per (inbound_email × prompt_version). Holds the classified
--      category (approved / queried / rejected / …), the extracted typed
--      payload, the LLM provenance (provider, model, tokens, cost, latency),
--      the review state machine, and a human-supplied rejection reason when
--      a reviewer throws the draft out.
--
--      Idempotency: a UNIQUE constraint on (inbound_email_id, prompt_version)
--      means re-running the same prompt against the same email is a no-op —
--      the worker can safely retry without duplicating work. Bumping
--      EMAIL_INTEL_VERSION in code lets us re-process a backlog under a new
--      prompt without dropping prior drafts.
--
--      PHI hygiene: `raw_response` is intentionally NULL on the happy path.
--      We only persist the raw LLM text on rows with status='extraction_failed'
--      — that's the one case where we genuinely need the unparsed model
--      output for forensic debugging. Successful extractions live entirely
--      in the typed `extracted_payload` JSONB.
--
--   B. hospital.email_intelligence_corrections
--      Per-field audit trail of what the AI suggested vs what the human
--      ended up applying. Drives the prompt-tuning feedback loop: a query
--      against this table by (field_path, deficiency_type) tells us which
--      fields the AI gets wrong most often, which then feeds prompt
--      iteration or schema additions.
--
-- Scope notes:
--   - The *effect* of applying a draft (updating claim status, writing
--     approval amount, raising query rows, etc.) lives downstream — Wave 3
--     adjudication/action engines react to the ai_draft_applied event.
--     This migration only stores the draft and its review state.
--   - The inbound email FK targets hospital.emails_inbound (created in
--     migration 013, kept in place by migration 023). ON DELETE CASCADE so
--     a deleted email cleans up its drafts.
--   - claim_id is nullable: the same pipeline runs on unmatched emails
--     (lower priority — drives the ops "needs review" queue), but most
--     traffic will have a matched claim.

BEGIN;

-- ============================================================================
-- A. email_intelligence_drafts
-- ============================================================================
CREATE TABLE IF NOT EXISTS hospital.email_intelligence_drafts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ─── Source linkage ─────────────────────────────────────────────────────
  -- The inbound email that produced this draft. CASCADE on delete so a
  -- purged inbound row doesn't leave orphan drafts.
  inbound_email_id         UUID NOT NULL
                           REFERENCES hospital.emails_inbound(id) ON DELETE CASCADE,
  -- Claim this draft will (eventually) be applied to. Nullable because an
  -- unmatched email may still be processed — the reviewer matches it to a
  -- claim as part of the apply step. SET NULL on claim delete so the draft
  -- is preserved for audit even if the IPD is removed.
  claim_id                 UUID
                           REFERENCES hospital.ipds(id) ON DELETE SET NULL,

  -- ─── Classifier output ──────────────────────────────────────────────────
  -- One of master_options(category='insurer_outcome') codes — approved,
  -- partially_approved, queried, rejected, enhancement_approved,
  -- enhancement_partial, follow_up, withdrawn — plus 'other' and 'unknown'
  -- escape hatches for emails the classifier can't pin down. The reviewer
  -- can override the category at apply time via field_overrides.
  category                 VARCHAR(64) NOT NULL,
  classifier_confidence    NUMERIC(4,3),

  -- ─── Extractor output ───────────────────────────────────────────────────
  -- Typed JSON whose shape depends on `category`:
  --   approved / partially_approved / enhancement_approved /
  --   enhancement_partial → ApprovalExtraction
  --   queried / follow_up                                  → QueryExtraction
  --   rejected / withdrawn                                 → RejectionExtraction
  --   other / unknown                                      → null/empty (reviewer fills in)
  -- The Zod definitions live in Services/llm/schemas/emailIntelligence.ts.
  extracted_payload        JSONB,

  -- ─── LLM provenance ─────────────────────────────────────────────────────
  llm_provider             VARCHAR(64),
  llm_model                VARCHAR(128),
  prompt_version           VARCHAR(32) NOT NULL,
  tokens_used              INT,
  latency_ms               INT,
  cost_inr                 NUMERIC(10,4),

  -- ─── Review state machine ──────────────────────────────────────────────
  --   pending_review     — created, waiting for a human
  --   applied            — reviewer accepted; downstream Wave 3 consumers
  --                        react to ai_draft_applied
  --   rejected           — reviewer threw it out; rejection_reason set
  --   expired            — superseded by a fresher draft on the same email
  --                        without explicit human action (future automation)
  --   superseded         — explicitly replaced by a later prompt_version
  --   extraction_failed  — LLM call or schema validation failed; raw_response
  --                        is populated so a human can debug
  status                   VARCHAR(32) NOT NULL DEFAULT 'pending_review',

  -- PHI hygiene: only populated when status='extraction_failed'. The happy
  -- path persists the typed extracted_payload and nothing else from the LLM.
  raw_response             TEXT,

  reviewed_by              UUID,
  reviewed_at              TIMESTAMPTZ,
  applied_at               TIMESTAMPTZ,
  rejection_reason         TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency: re-running the same prompt version against the same email
-- collapses to the existing draft. Bump EMAIL_INTEL_VERSION in code to
-- force a re-process under a new prompt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eid_email_prompt_unique
  ON hospital.email_intelligence_drafts (inbound_email_id, prompt_version);

CREATE INDEX IF NOT EXISTS idx_eid_inbound_email
  ON hospital.email_intelligence_drafts (inbound_email_id);

CREATE INDEX IF NOT EXISTS idx_eid_claim
  ON hospital.email_intelligence_drafts (claim_id)
  WHERE claim_id IS NOT NULL;

-- Cockpit query: "pending drafts for this claim, newest first".
CREATE INDEX IF NOT EXISTS idx_eid_claim_status
  ON hospital.email_intelligence_drafts (claim_id, status, created_at DESC)
  WHERE claim_id IS NOT NULL;

-- Ops queue: all pending drafts across the platform.
CREATE INDEX IF NOT EXISTS idx_eid_status
  ON hospital.email_intelligence_drafts (status, created_at DESC);

COMMENT ON TABLE  hospital.email_intelligence_drafts IS
  'AI-suggested interpretation of an inbound insurer email. One row per (inbound_email × prompt_version). Status transitions: pending_review → applied|rejected|expired|superseded. extraction_failed is a terminal failure state with raw_response captured for debugging.';

COMMENT ON COLUMN hospital.email_intelligence_drafts.category IS
  'master_options(category=''insurer_outcome'') code, plus ''other'' / ''unknown'' escape hatches. Reviewer can override at apply time.';

COMMENT ON COLUMN hospital.email_intelligence_drafts.extracted_payload IS
  'Typed payload — ApprovalExtraction | QueryExtraction | RejectionExtraction | null. Shape per category lives in Services/llm/schemas/emailIntelligence.ts.';

COMMENT ON COLUMN hospital.email_intelligence_drafts.raw_response IS
  'Raw LLM text. PHI hygiene: only persisted when status=''extraction_failed''. Successful drafts live entirely in the typed extracted_payload.';

COMMENT ON COLUMN hospital.email_intelligence_drafts.prompt_version IS
  'EMAIL_INTEL_VERSION at creation time. The UNIQUE on (inbound_email_id, prompt_version) makes re-runs idempotent; bumping the version lets us re-process a backlog under a fresh prompt.';

COMMENT ON COLUMN hospital.email_intelligence_drafts.status IS
  'pending_review | applied | rejected | expired | superseded | extraction_failed.';


-- ============================================================================
-- B. email_intelligence_corrections
-- ============================================================================
-- Per-field audit log of AI suggestion vs human override. Recorded on
-- applyDraft when fieldOverrides differs from extracted_payload.
CREATE TABLE IF NOT EXISTS hospital.email_intelligence_corrections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        UUID NOT NULL
                  REFERENCES hospital.email_intelligence_drafts(id) ON DELETE CASCADE,
  -- JSON-pointer-like path into the extracted_payload. Examples:
  --   'amount_inr', 'validity_to', 'queries.0.description',
  --   'deduction_breakdown.2.reason'
  field_path      VARCHAR(255) NOT NULL,
  ai_value        JSONB,
  human_value     JSONB,
  corrected_by    UUID NOT NULL,
  corrected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eic_draft
  ON hospital.email_intelligence_corrections (draft_id);

COMMENT ON TABLE  hospital.email_intelligence_corrections IS
  'Per-field audit of AI suggestion vs human override on email_intelligence_drafts apply. Drives the prompt-tuning feedback loop — aggregate by field_path to find what the AI consistently gets wrong.';

COMMENT ON COLUMN hospital.email_intelligence_corrections.field_path IS
  'JSON-pointer-like dotted path into extracted_payload, e.g. ''queries.0.description'', ''deduction_breakdown.2.reason''.';

COMMIT;
