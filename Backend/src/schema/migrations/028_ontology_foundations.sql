-- Migration 028: Ontology Foundations (Sprint 1)
-- Date: 2026-05-18
--
-- The Intelligence Layer needs a shared vocabulary before any pattern-mining,
-- KB authoring, or LLM extraction code can land. This migration seeds that
-- vocabulary into the existing master_options table and introduces two
-- ontology-support structures:
--
--   1. concept_aliases — maps the messy strings we see in inbound emails,
--      tariff PDFs, and operator-typed notes back to a canonical concept
--      code. e.g. "Room Rent Capping", "RR cap", "room‑rent (capped)" all
--      collapse to deduction_reason:room_rent_cap. Sourced from data over
--      time; bootstrapped manually.
--
--   2. document_field_schemas — declarative spec of what fields we expect to
--      extract from each doc_category (discharge_slip, OT notes, …). Drives
--      both the LLM extraction prompts and the FE review-and-correct UI. The
--      schema is versioned per (doc_category, field_key) so we can roll out
--      new fields without rewriting history.
--
-- Existing doc_category vocabulary mirrors webapp FIELD_NAMES
-- (PatientPhotosModal/hooks/usePhotosData.ts) so the FE pills line up 1:1.
-- New categories (admission_notes, diagnosis_summary, procedure_estimate,
-- consent, final_bill, oncologist_consent, identity_proof, claim_form,
-- insurer_query_letter, insurer_approval_letter) are introduced here for
-- coverage of pre-auth, claim, and query stages.
--
-- All steps run in a single transaction; ON CONFLICT clauses make the
-- migration idempotent so re-applying against partially-seeded environments
-- is safe.

BEGIN;

-- ============================================================================
-- A. master_options seed data — controlled vocabularies
-- ============================================================================

-- ─── doc_category ────────────────────────────────────────────────────────
-- Canonical document buckets. The first 11 codes mirror webapp FIELD_NAMES
-- exactly (PatientPhotosModal). The remaining 10 cover documents that exist
-- in the flow today but weren't surfaced as their own pill yet.
INSERT INTO hospital.master_options (category, code, label, sort_order)
VALUES
    ('doc_category', 'discharge_slip',              'Discharge Slip',                10),
    ('doc_category', 'investigations',              'Investigations',                20),
    ('doc_category', 'treatment',                   'Treatment',                     30),
    ('doc_category', 'icps',                        'ICPs',                          40),
    ('doc_category', 'surgical_discharge_slip',     'Surgical Discharge Slip',       50),
    ('doc_category', 'ot_notes_and_photos',         'OT Notes and Photos',           60),
    ('doc_category', 'post_op_photos',              'Post Op Photos',                70),
    ('doc_category', 'post_op_reports',             'Post Op Reports',               80),
    ('doc_category', 'implant_invoice',             'Implant Invoice',               90),
    ('doc_category', 'insurer_response',            'Insurer Responses',            100),
    ('doc_category', 'others',                      'Others',                       110),
    ('doc_category', 'admission_notes',             'Admission Notes',              120),
    ('doc_category', 'diagnosis_summary',           'Diagnosis Summary',            130),
    ('doc_category', 'procedure_estimate',          'Procedure Estimate',           140),
    ('doc_category', 'consent',                     'Consent',                      150),
    ('doc_category', 'final_bill',                  'Final Bill',                   160),
    ('doc_category', 'oncologist_consent',          'Oncologist Consent',           170),
    ('doc_category', 'identity_proof',              'Identity Proof',               180),
    ('doc_category', 'claim_form',                  'Claim Form',                   190),
    ('doc_category', 'insurer_query_letter',        'Insurer Query Letter',         200),
    ('doc_category', 'insurer_approval_letter',     'Insurer Approval Letter',      210)
ON CONFLICT (category, code) DO NOTHING;

-- ─── deficiency_type ─────────────────────────────────────────────────────
-- What the insurer (or our own QA pass) flagged as missing or wrong on a
-- submission. Drives the deficiency queue UI and powers the
-- "query-likelihood" predictor.
INSERT INTO hospital.master_options (category, code, label, sort_order)
VALUES
    ('deficiency_type', 'missing_consent',                'Missing Consent',                  10),
    ('deficiency_type', 'missing_diagnosis_summary',      'Missing Diagnosis Summary',        20),
    ('deficiency_type', 'missing_procedure_estimate',     'Missing Procedure Estimate',       30),
    ('deficiency_type', 'missing_icp',                    'Missing ICP',                      40),
    ('deficiency_type', 'missing_implant_invoice',        'Missing Implant Invoice',          50),
    ('deficiency_type', 'missing_final_bill',             'Missing Final Bill',               60),
    ('deficiency_type', 'diagnosis_mismatch',             'Diagnosis Mismatch',               70),
    ('deficiency_type', 'icd_unspecified',                'ICD Code Unspecified',             80),
    ('deficiency_type', 'document_illegible',             'Document Illegible',               90),
    ('deficiency_type', 'signature_missing',              'Signature Missing',               100),
    ('deficiency_type', 'date_inconsistency',             'Date Inconsistency',              110)
ON CONFLICT (category, code) DO NOTHING;

-- ─── deduction_reason ────────────────────────────────────────────────────
-- Why the insurer cut money off an approval. Powers the deductions analytics
-- and the "expected vs approved" variance breakdown.
INSERT INTO hospital.master_options (category, code, label, sort_order)
VALUES
    ('deduction_reason', 'non_payable_item',         'Non-Payable Item',           10),
    ('deduction_reason', 'room_rent_cap',            'Room Rent Cap',              20),
    ('deduction_reason', 'sublimit_breached',        'Sublimit Breached',          30),
    ('deduction_reason', 'copay_applied',            'Copay Applied',              40),
    ('deduction_reason', 'outside_package',          'Outside Package',            50),
    ('deduction_reason', 'pre_existing_condition',   'Pre-Existing Condition',     60),
    ('deduction_reason', 'waiting_period',           'Waiting Period',             70),
    ('deduction_reason', 'capping_applied',          'Capping Applied',            80)
ON CONFLICT (category, code) DO NOTHING;

-- ─── insurer_outcome ─────────────────────────────────────────────────────
-- Terminal or near-terminal states of an insurer interaction. Distinct from
-- ipd.stage — outcome describes what the insurer said, stage describes where
-- the claim is in our internal workflow.
INSERT INTO hospital.master_options (category, code, label, sort_order)
VALUES
    ('insurer_outcome', 'approved',                'Approved',                  10),
    ('insurer_outcome', 'partially_approved',      'Partially Approved',        20),
    ('insurer_outcome', 'queried',                 'Queried',                   30),
    ('insurer_outcome', 'rejected',                'Rejected',                  40),
    ('insurer_outcome', 'enhancement_approved',    'Enhancement Approved',      50),
    ('insurer_outcome', 'enhancement_partial',     'Enhancement Partially Approved', 60),
    ('insurer_outcome', 'follow_up',               'Follow Up',                 70),
    ('insurer_outcome', 'withdrawn',               'Withdrawn',                 80)
ON CONFLICT (category, code) DO NOTHING;

-- ─── kb_pattern_type ─────────────────────────────────────────────────────
-- High-level taxonomy for entries in the Knowledge Base. Every kb_patterns
-- row will declare one of these so the consumer (LLM, dashboard, ops) knows
-- how to interpret its body.
INSERT INTO hospital.master_options (category, code, label, sort_order)
VALUES
    ('kb_pattern_type', 'insurer_query_pattern',    'Insurer Query Pattern',     10),
    ('kb_pattern_type', 'deduction_pattern',        'Deduction Pattern',         20),
    ('kb_pattern_type', 'doc_correlation',          'Document Correlation',      30),
    ('kb_pattern_type', 'stage_transition_pattern', 'Stage Transition Pattern',  40),
    ('kb_pattern_type', 'amount_variance_pattern',  'Amount Variance Pattern',   50)
ON CONFLICT (category, code) DO NOTHING;

-- ============================================================================
-- B. concept_aliases — many-to-one normalisation map
-- ============================================================================
-- A concept lives in master_options (concept_category + concept_code). The
-- alias is whatever surface-form string we encountered in the wild. Lookup is
-- always case-insensitive, hence the lower(alias) index.
--
-- alias_source examples: 'manual', 'llm_extracted', 'insurer_template',
--   'tariff_pdf', 'historic_data'.
-- confidence is on [0,1] — manual entries default to 1.0; mined aliases
-- get the model's confidence so we can filter out low-trust mappings.

CREATE TABLE IF NOT EXISTS hospital.concept_aliases (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_category    VARCHAR(50) NOT NULL,
    concept_code        VARCHAR(100) NOT NULL,
    alias               TEXT NOT NULL,
    alias_source        VARCHAR(50),
    confidence          NUMERIC(3,2) DEFAULT 1.0,
    created_at          TIMESTAMP DEFAULT NOW(),
    UNIQUE(concept_category, alias)
);

CREATE INDEX IF NOT EXISTS idx_concept_aliases_lower
    ON hospital.concept_aliases (lower(alias));
CREATE INDEX IF NOT EXISTS idx_concept_aliases_concept
    ON hospital.concept_aliases (concept_category, concept_code);

COMMENT ON TABLE hospital.concept_aliases IS 'Surface-form strings (from emails, PDFs, operator notes) mapped to a canonical (category, code) in master_options. Drives entity-resolution at extraction time.';

-- ============================================================================
-- C. document_field_schemas — declarative extraction spec
-- ============================================================================
-- One row per (doc_category, field_key, schema_version). field_type is an
-- open enum maintained in app code: 'text' | 'date' | 'number' | 'money' |
-- 'boolean' | 'enum' | 'reference'.
--   - enum_values    : JSON array of allowed values when field_type='enum'
--   - reference_category: master_options category to resolve against when
--                         field_type='reference' (e.g. icd code, panel id)
-- extraction_priority lets the LLM-orchestration layer fetch the most
-- important fields first when token budget is tight (lower number = earlier).

CREATE TABLE IF NOT EXISTS hospital.document_field_schemas (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_category          VARCHAR(100) NOT NULL,
    field_key             VARCHAR(100) NOT NULL,
    field_label           VARCHAR(255) NOT NULL,
    field_type            VARCHAR(50)  NOT NULL,
    is_required           BOOLEAN DEFAULT false,
    enum_values           JSONB,
    reference_category    VARCHAR(50),
    extraction_priority   INT DEFAULT 999,
    schema_version        INT DEFAULT 1,
    created_at            TIMESTAMP DEFAULT NOW(),
    UNIQUE(doc_category, field_key, schema_version)
);

CREATE INDEX IF NOT EXISTS idx_dfs_doc_category
    ON hospital.document_field_schemas (doc_category, schema_version);

COMMENT ON TABLE hospital.document_field_schemas IS 'Per-doc-category extraction schema. The LLM prompt builder reads this to know which fields to pull from each document, in what order, and how strict the typing should be.';

-- ============================================================================
-- D. document_field_schemas — seed data (v1) for 5 priority categories
-- ============================================================================
-- The room_category enum mirrors how hospitals classify wards on the
-- discharge slip and procedure estimate. Keep these in sync if you ever add
-- a new ward class (e.g. 'deluxe').
--
-- Field choices below were validated against the FIELD_NAMES vocabulary and
-- typical ICP / OT note templates we see across panels.

-- discharge_slip ------------------------------------------------------------
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority)
VALUES
    ('discharge_slip', 'admission_date',     'Admission Date',     'date',  true,  NULL, 10),
    ('discharge_slip', 'discharge_date',     'Discharge Date',     'date',  true,  NULL, 20),
    ('discharge_slip', 'primary_diagnosis',  'Primary Diagnosis',  'text',  true,  NULL, 30),
    ('discharge_slip', 'treating_doctor',    'Treating Doctor',    'text',  false, NULL, 40),
    ('discharge_slip', 'room_category',      'Room Category',      'enum',  false,
        '["general","semi_private","private","icu","iccu","nicu"]'::jsonb, 50),
    ('discharge_slip', 'total_amount',       'Total Amount',       'money', false, NULL, 60)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- investigations -----------------------------------------------------------
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority)
VALUES
    ('investigations', 'investigation_date', 'Investigation Date', 'date',    false, NULL, 10),
    ('investigations', 'test_name',          'Test Name',          'text',    false, NULL, 20),
    ('investigations', 'test_result',        'Test Result',        'text',    false, NULL, 30),
    ('investigations', 'reference_range',    'Reference Range',    'text',    false, NULL, 40),
    ('investigations', 'abnormal_flag',      'Abnormal Flag',      'boolean', false, NULL, 50)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ot_notes_and_photos ------------------------------------------------------
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority)
VALUES
    ('ot_notes_and_photos', 'surgery_date',         'Surgery Date',         'date',   true,  NULL, 10),
    ('ot_notes_and_photos', 'procedure_performed',  'Procedure Performed',  'text',   true,  NULL, 20),
    ('ot_notes_and_photos', 'surgeon',              'Surgeon',              'text',   true,  NULL, 30),
    ('ot_notes_and_photos', 'anaesthetist',         'Anaesthetist',         'text',   false, NULL, 40),
    ('ot_notes_and_photos', 'duration_minutes',     'Duration (minutes)',   'number', false, NULL, 50),
    ('ot_notes_and_photos', 'findings',             'Findings',             'text',   false, NULL, 60)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- procedure_estimate -------------------------------------------------------
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority)
VALUES
    ('procedure_estimate', 'estimated_amount',         'Estimated Amount',         'money',  true,  NULL, 10),
    ('procedure_estimate', 'proposed_procedure',       'Proposed Procedure',       'text',   true,  NULL, 20),
    ('procedure_estimate', 'proposed_admission_date',  'Proposed Admission Date',  'date',   false, NULL, 30),
    ('procedure_estimate', 'room_category',            'Room Category',            'enum',   false,
        '["general","semi_private","private","icu","iccu","nicu"]'::jsonb, 40),
    ('procedure_estimate', 'estimated_los_days',       'Estimated Length of Stay (days)', 'number', false, NULL, 50)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- diagnosis_summary --------------------------------------------------------
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority)
VALUES
    ('diagnosis_summary', 'primary_diagnosis',    'Primary Diagnosis',    'text', true,  NULL, 10),
    ('diagnosis_summary', 'icd_code_candidate',   'ICD Code Candidate',   'text', false, NULL, 20),
    ('diagnosis_summary', 'comorbidities',        'Comorbidities',        'text', false, NULL, 30),
    ('diagnosis_summary', 'proposed_treatment',   'Proposed Treatment',   'text', false, NULL, 40),
    ('diagnosis_summary', 'justification',        'Justification',        'text', false, NULL, 50)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ============================================================================
-- VERIFICATION QUERIES (uncomment to inspect after migration)
-- ============================================================================
-- SELECT category, COUNT(*) FROM hospital.master_options
--  WHERE category IN ('doc_category','deficiency_type','deduction_reason','insurer_outcome','kb_pattern_type')
--  GROUP BY category ORDER BY category;
-- SELECT doc_category, COUNT(*) FROM hospital.document_field_schemas GROUP BY doc_category;
-- SELECT * FROM hospital.concept_aliases LIMIT 1; -- structural check only

COMMIT;
