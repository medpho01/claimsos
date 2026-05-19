-- Migration 043: claim_harmonised_episodes + harmonisation_corrections
-- Date: 2026-05-18
-- Wave 7 — Harmonisation Layer
--
-- Stores a per-claim, derived "canonical medical episode" — a JSONB instance
-- of the claimsos.canonical.medical_episode.v2 schema (see
-- canonical-medical-documents/ReferenceStructure.json). The harmoniser fuses
-- the dossier projection (Wave 1), the per-document segmented sections
-- (Wave 2A), and the per-section extracted fields (Wave 2B) into ONE
-- normalised episode shape that:
--
--   - Adjudication, KB pattern matching, prediction, and downstream
--     insurer-facing exports all read from a single canonical artifact
--     instead of re-stitching the dossier + sections + extractions on
--     every call.
--   - Carries per-field provenance (which section_id sourced which
--     JSONPath) so the cockpit can surface "this diagnosis came from
--     section ABC, with 0.92 LLM confidence" — and so corrections close
--     a tight loop back to the source extraction row.
--
-- Cache discipline:
--   - dossier_state_hash is the harmonisation cache key. Same hash +
--     same prompt_version + status='fresh' = no LLM call required.
--   - Re-running .harmonise() on an unchanged dossier is a ~₹0 no-op.
--   - When a human applies a correction we DO NOT re-run the LLM;
--     we patch the episode JSONB at the json_path in place and log
--     the human override on harmonisation_corrections (the learning
--     loop in a later wave can fold these back into prompts /
--     extraction tuning).
--
-- claim grain: hospital.ipds(id). One harmonised episode per IPD.
-- ON DELETE CASCADE wipes the artifact when the IPD is removed.

BEGIN;

-- ─── claim_harmonised_episodes ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.claim_harmonised_episodes (
  claim_id            UUID PRIMARY KEY
                      REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- Validated instance of medical_episode.v2. Nullable in 'failed' /
  -- 'pending' states; required for 'fresh' / 'stale' / 'partial' /
  -- 'corrected'. We don't enforce NOT NULL at the DB level because
  -- the pending row is written BEFORE the LLM call and the failure
  -- update writes the row without an episode.
  episode             JSONB NOT NULL,

  -- Schema + prompt version stamps. A bump on either invalidates the
  -- cache and forces re-harmonisation on the next call.
  schema_version      VARCHAR(64)  NOT NULL DEFAULT 'claimsos.canonical.medical_episode.v2',
  prompt_version      VARCHAR(32)  NOT NULL DEFAULT 'harmoniser.v1',

  -- Overall confidence 0..1. The LLM self-reports per-field; we
  -- aggregate (average of per-field confidence) into this single
  -- headline number for cockpit chips.
  confidence          NUMERIC(4,3),

  -- Provenance map: { "$.diagnosis.primary_diagnosis.icd_code":
  --                    { "source_section_id": "...", "confidence":
  --                      0.92, "llm_inferred": false } }
  -- For v1 the map is sparse — fields directly extracted from a known
  -- section carry the section_id; LLM-inferred / synthesised fields
  -- carry source_section_id=null + llm_inferred=true.
  provenance          JSONB,

  -- Cache key — hash of (current_stage, doc_sections_by_category,
  -- amounts, active_queries, section_ids set). See
  -- harmonisation.service.ts::computeDossierStateHash for the exact
  -- input vector. When the dossier moves materially the hash flips
  -- and the next harmonise() call re-runs the LLM.
  dossier_state_hash  VARCHAR(64) NOT NULL,

  -- Cost / token accounting. cost_inr is the per-call INR the LLM
  -- bridge billed for this run; cumulative spend lives in
  -- llm_cost_log keyed on claim_id. We carry the per-run numbers on
  -- the row for quick "what did this one cost" lookups in the UI.
  cost_inr            NUMERIC(10,4),
  tokens_used         INT,
  llm_provider        VARCHAR(64),
  llm_model           VARCHAR(128),

  generated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  -- last_corrected_at is touched by applyCorrection() — it is NOT
  -- touched by .harmonise() since a fresh run starts from the LLM
  -- output (which has no human corrections).
  last_corrected_at   TIMESTAMP,

  -- Lifecycle:
  --   fresh     — generated against current dossier_state_hash, no
  --               human corrections layered on.
  --   stale     — dossier moved past the hash this row was generated
  --               for; the cockpit knows to render a "needs refresh"
  --               chip. (We don't auto-mark stale today; harmonise()
  --               just regenerates on hash miss.)
  --   pending   — the LLM call is in flight (write happens before
  --               provider.extract()).
  --   failed    — the LLM returned, but Zod validation failed, or
  --               the budget guard blocked us. error_message has
  --               details.
  --   partial   — Zod validated only against HarmonisedEpisodePartial
  --               (the lenient subset). Adjudication can still
  --               consume this — diagnosis + patient + timeline are
  --               present — but optional sub-structures are missing.
  --   corrected — human applyCorrection() touched the episode JSONB
  --               at least once since the LLM produced it.
  status              VARCHAR(32) NOT NULL DEFAULT 'fresh',
  error_message       TEXT,

  CONSTRAINT chk_claim_harmonised_status
    CHECK (status IN ('fresh', 'stale', 'pending', 'failed', 'partial', 'corrected'))
);

CREATE INDEX IF NOT EXISTS idx_claim_harmonised_episodes_status
  ON hospital.claim_harmonised_episodes (status);

CREATE INDEX IF NOT EXISTS idx_claim_harmonised_episodes_generated_at
  ON hospital.claim_harmonised_episodes (generated_at DESC);

COMMENT ON TABLE hospital.claim_harmonised_episodes IS
  'Wave 7 — derived canonical medical_episode.v2 JSON per IPD. One row per claim. dossier_state_hash gates re-harmonisation; corrections do not invalidate the cache.';

-- ─── harmonisation_corrections ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.harmonisation_corrections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id            UUID NOT NULL
                      REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- JSONPath expression targeting the field the human overrode.
  -- e.g. '$.diagnosis.primary_diagnosis.icd_code'. v1 only supports
  -- the simple dotted-form JSONPath ($.a.b.c with array indices
  -- via $.a[0].b); complex predicates ($..[?(@.foo==1)]) are NOT
  -- supported by the patcher and applyCorrection() will reject
  -- them.
  json_path           TEXT NOT NULL,

  -- What the AI had emitted at that path. Captured for the audit
  -- trail (so a future learning loop can pattern-mine "AI emits X
  -- but human always corrects to Y"). NULL when the AI had no
  -- value at that path (i.e. the human is adding a new field).
  ai_value            JSONB,

  -- The human-supplied value. NOT NULL: if a human wants to delete
  -- a field, they pass JSON null and we set it to null — distinct
  -- from omitting the column.
  human_value         JSONB NOT NULL,

  -- User id of the corrector. Nullable for system-applied
  -- corrections (e.g. a future reconciliation pass against a
  -- ground-truth source).
  corrected_by        UUID,
  reason              TEXT,

  corrected_at        TIMESTAMP NOT NULL DEFAULT NOW(),

  -- True once the patch has actually been merged into
  -- claim_harmonised_episodes.episode. applyCorrection() flips
  -- this to true within the same transaction it writes the
  -- correction row. False rows indicate either a patcher failure
  -- (logged, manual recovery required) or a queued correction
  -- awaiting an in-flight harmonisation.
  applied_to_episode  BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_harmonisation_corrections_claim
  ON hospital.harmonisation_corrections (claim_id, corrected_at DESC);

COMMENT ON TABLE hospital.harmonisation_corrections IS
  'Wave 7 — audit trail of human edits to claim_harmonised_episodes.episode. Corrections are applied to the canonical JSON in place and logged here; cache hash is NOT invalidated.';

COMMIT;
