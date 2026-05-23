-- ============================================================================
-- extraction_corrections — reviewer overrides of AI-emitted extraction values
-- ============================================================================
-- Background (May 21, 2026):
--   ai_corrections (mig 045) is the GLOBAL correction firehose used by the
--   KB miner: surface-tagged, hashed-into-patterns, and frequently re-
--   classified. Useful for prompt iteration but lossy for accuracy math —
--   you can't cleanly compute "% of patient_context.first_name values
--   reviewers changed for hospital X in the last 30 days" because the
--   `target_kind` field is overloaded across surfaces and the field-path
--   isn't queryable.
--
--   This table is the per-claim, field-grained ledger that the FE reviewer
--   UI writes into on every override. Three downstream consumers:
--     1. Hospital accuracy dashboards (per-hospital, per-field rollups)
--     2. Few-shot training data for the next extractor iteration
--     3. Systemic-error detection — (hospital_id, field_path) pairs that
--        get corrected > N times signal a prompt bug worth fixing
--
--   Out of scope for THIS migration: the FE writes (separate downstream
--   task) and any back-propagation into ai_corrections. Both tables co-
--   exist — ai_corrections stays the KB miner's input, extraction_
--   corrections stays the accuracy ledger.

BEGIN;

CREATE TABLE hospital.extraction_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  -- the target of the correction
  target_kind TEXT NOT NULL CHECK (target_kind IN (
    'section_extracted_field',
    'harmonised_episode_field',
    'canonical_patient',
    'foreign_document_flag',
    'id_conflict'
  )),
  section_id UUID REFERENCES hospital.document_sections(id) ON DELETE SET NULL,
  -- json-pointer-ish path into either extracted_fields or episode, e.g.
  -- "patient_context.first_name" or "diagnosis.primary_diagnosis.diagnosis_name"
  field_path TEXT NOT NULL,
  -- what the AI emitted (JSONB so we capture object/string/number/null faithfully)
  ai_value JSONB,
  -- what the reviewer corrected it to
  corrected_value JSONB,
  -- free-form reviewer note explaining WHY
  reason TEXT,
  -- audit
  reviewer_id UUID,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- did this correction get rolled back later? (e.g. another reviewer disagreed)
  superseded_at TIMESTAMPTZ,
  superseded_by UUID
);

CREATE INDEX idx_extr_corrections_claim ON hospital.extraction_corrections(claim_id);
CREATE INDEX idx_extr_corrections_hospital_field ON hospital.extraction_corrections(hospital_id, field_path);
CREATE INDEX idx_extr_corrections_recent ON hospital.extraction_corrections(reviewed_at DESC) WHERE superseded_at IS NULL;

COMMIT;
