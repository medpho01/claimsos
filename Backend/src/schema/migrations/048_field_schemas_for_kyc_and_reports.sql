-- ============================================================================
-- Wave 9 follow-up — field schemas for KYC + PMJAY + diagnostic-report categories.
-- ============================================================================
-- The doc extractor (`Services/docExtractor.service.ts`) gates extraction on
-- `hospital.document_field_schemas`: if a doc_category has zero schema rows,
-- the extractor short-circuits and stamps extractor_model='no_schema' with
-- extracted_fields={}. The 5 categories seeded in earlier waves
-- (diagnosis_summary, discharge_slip, investigations, ot_notes_and_photos,
-- procedure_estimate) work fine — every other category renders as "No field
-- schema" in the UI even though the docs themselves carry rich structured
-- data we need for adjudication and audit.
--
-- This migration seeds field schemas for the categories ops most commonly
-- uploads from PMJAY claim bundles:
--   * aadhaar_front, aadhaar_card (the "back")  — KYC identity
--   * ration_card                                — KYC + scheme eligibility
--   * pmjay_bis_family_tree                      — PMJAY beneficiary lineage
--   * ct_scan_reports                            — diagnostic imaging
--
-- Field choice principles:
--   - Only fields the LLM can pull reliably from a typical OCR'd scan.
--   - Required only when its absence should block adjudication.
--   - Enums where the value space is closed (gender, card_type) to keep
--     downstream normalisation cheap.
--   - extraction_priority lower = more important = extracted first when
--     the LLM is asked to prioritise.

BEGIN;

-- ─── Aadhaar Front ───────────────────────────────────────────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category,   field_key,        field_label,        field_type, is_required, enum_values, extraction_priority) VALUES
    ('aadhaar_front', 'full_name',     'Full Name',        'text',     true,  NULL, 10),
    ('aadhaar_front', 'aadhaar_number','Aadhaar Number',   'text',     true,  NULL, 20),
    ('aadhaar_front', 'date_of_birth', 'Date of Birth',    'date',     false, NULL, 30),
    ('aadhaar_front', 'gender',        'Gender',           'enum',     false, '["M","F","O"]'::jsonb, 40),
    ('aadhaar_front', 'year_of_birth', 'Year of Birth',    'number',   false, NULL, 50)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Aadhaar Back (existing aadhaar_card code, relabelled to "Aadhaar Back") ─
INSERT INTO hospital.document_field_schemas
    (doc_category,  field_key,         field_label,            field_type, is_required, enum_values, extraction_priority) VALUES
    ('aadhaar_card', 'aadhaar_number', 'Aadhaar Number',       'text',     true,  NULL, 10),
    ('aadhaar_card', 'address',        'Full Address',         'text',     true,  NULL, 20),
    ('aadhaar_card', 'parent_or_spouse_name', 'Parent / Spouse Name', 'text', false, NULL, 30),
    ('aadhaar_card', 'pin_code',       'PIN Code',             'text',     false, NULL, 40),
    ('aadhaar_card', 'state',          'State',                'text',     false, NULL, 50)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Ration Card ─────────────────────────────────────────────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key,            field_label,           field_type, is_required, enum_values, extraction_priority) VALUES
    ('ration_card', 'ration_card_number','Ration Card Number',  'text',     true,  NULL, 10),
    -- APL / BPL / Antyodaya / Annapurna are the canonical PDS categories in India.
    -- Keep as enum so downstream eligibility checks can branch cleanly.
    ('ration_card', 'card_type',         'Card Type',           'enum',     true,
        '["APL","BPL","Antyodaya","Annapurna","Other"]'::jsonb, 20),
    ('ration_card', 'head_of_family',    'Head of Family',      'text',     true,  NULL, 30),
    ('ration_card', 'family_members',    'Family Members',      'text',     false, NULL, 40),
    ('ration_card', 'state',             'State',               'text',     false, NULL, 50),
    ('ration_card', 'district',          'District',            'text',     false, NULL, 60),
    ('ration_card', 'fps_shop_number',   'FPS Shop Number',     'text',     false, NULL, 70),
    ('ration_card', 'issue_date',        'Issue Date',          'date',     false, NULL, 80)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── PMJAY BIS Family Tree ───────────────────────────────────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category,           field_key,            field_label,                field_type, is_required, enum_values, extraction_priority) VALUES
    ('pmjay_bis_family_tree','pmjay_beneficiary_id','PMJAY Beneficiary ID',    'text',     true,  NULL, 10),
    ('pmjay_bis_family_tree','household_id',       'Household ID',             'text',     false, NULL, 20),
    ('pmjay_bis_family_tree','head_of_family',     'Head of Family',           'text',     true,  NULL, 30),
    ('pmjay_bis_family_tree','family_members',     'Family Members (Names)',   'text',     true,  NULL, 40),
    ('pmjay_bis_family_tree','total_family_size',  'Total Family Members',     'number',   false, NULL, 50),
    ('pmjay_bis_family_tree','state',              'State',                    'text',     false, NULL, 60),
    ('pmjay_bis_family_tree','district',           'District',                 'text',     false, NULL, 70),
    ('pmjay_bis_family_tree','eligibility_status', 'Eligibility Status',       'enum',     false,
        '["eligible","not_eligible","under_review"]'::jsonb, 80)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── CT Scan Reports ─────────────────────────────────────────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category,     field_key,                field_label,                  field_type, is_required, enum_values, extraction_priority) VALUES
    ('ct_scan_reports','study_date',             'Study Date',                 'date',     true,  NULL, 10),
    ('ct_scan_reports','body_part',              'Body Part / Anatomy',        'text',     true,  NULL, 20),
    ('ct_scan_reports','clinical_indication',    'Clinical Indication',        'text',     false, NULL, 30),
    ('ct_scan_reports','contrast_used',          'Contrast Used',              'enum',     false,
        '["none","iv_contrast","oral_contrast","both"]'::jsonb, 40),
    ('ct_scan_reports','findings',               'Findings',                   'text',     true,  NULL, 50),
    ('ct_scan_reports','impression',             'Impression / Conclusion',    'text',     true,  NULL, 60),
    ('ct_scan_reports','ordering_physician',     'Ordering Physician',         'text',     false, NULL, 70),
    ('ct_scan_reports','reporting_radiologist',  'Reporting Radiologist',      'text',     false, NULL, 80)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

COMMIT;
