-- ============================================================================
-- Field schemas for 5 categories the cross-hospital smoke test (May 21, 2026)
-- found in active classifier output but with ZERO extractor schemas
-- ============================================================================
-- Background:
--   Cross-hospital QA across Sadbhawana / Ganga / Akshay / Jigyasa / Jain
--   showed 3 of 5 hospitals (Akshay, Jigyasa, Jain) producing 78-100% empty
--   extracted_fields because their primary clinical docs land in these
--   categories with no field schemas:
--     - blood_test_reports     (CBC, LFT, KFT, lipid)         — Jigyasa, others
--     - progress_notes         (daily clinical notes)         — Jigyasa
--     - medication_administration_record (MAR sheets)         — Jigyasa
--     - serology_reports       (CRP, hep markers, dengue)     — Akshay
--     - fitness_certificate    (medical fit-for-discharge)    — Akshay
--
--   Pipeline correctly classifies these (e.g. blood_test_reports conf=0.98)
--   but the extractor logs "no field_schema for category — extraction_skipped"
--   and writes empty fields. Kishan Dai's CBC has Hb, TLC, Neutrophils %,
--   Platelets, etc. — all 8 critical values invisible to ClaimOS, but Claude
--   vision read them all.
--
--   Schemas below cover the common-case fields each doc type provides. Field
--   priorities mirror the existing xray_reports/discharge_slip style so the
--   extractor LLM gets a consistent prompt structure.

BEGIN;

-- ─── blood_test_reports ─────────────────────────────────────────────────
-- CBC, biochemistry, lipid panel etc. Most labs print a tabular result block
-- with reference ranges; we capture key headline values as text + a
-- catch-all `test_values_json` for the full panel.
INSERT INTO hospital.document_field_schemas
  (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority)
VALUES
  ('blood_test_reports', 'patient_name',         'Patient Name',           'text',   false, NULL, 10),
  ('blood_test_reports', 'patient_age',          'Patient Age (years)',    'number', false, NULL, 15),
  ('blood_test_reports', 'patient_sex',          'Patient Sex',            'enum',   false, '["male","female","other"]'::jsonb, 16),
  ('blood_test_reports', 'study_date',           'Sample Collection Date', 'date',   false, NULL, 20),
  ('blood_test_reports', 'lab_name',             'Lab / Imaging Centre',   'text',   false, NULL, 25),
  ('blood_test_reports', 'reporting_doctor',     'Reporting Pathologist',  'text',   false, NULL, 30),
  ('blood_test_reports', 'panel_type',           'Panel Type (e.g. CBC, LFT, KFT, Lipid)', 'text', false, NULL, 35),
  ('blood_test_reports', 'haemoglobin',          'Haemoglobin (g/dL)',     'text',   false, NULL, 40),
  ('blood_test_reports', 'tlc',                  'Total Leukocyte Count',  'text',   false, NULL, 41),
  ('blood_test_reports', 'platelets',            'Platelets (lakh/mcL)',   'text',   false, NULL, 42),
  ('blood_test_reports', 'creatinine',           'Creatinine (mg/dL)',     'text',   false, NULL, 50),
  ('blood_test_reports', 'urea',                 'Urea (mg/dL)',           'text',   false, NULL, 51),
  ('blood_test_reports', 'bilirubin_total',      'Total Bilirubin',        'text',   false, NULL, 52),
  ('blood_test_reports', 'sgot_ast',             'SGOT / AST',             'text',   false, NULL, 53),
  ('blood_test_reports', 'sgpt_alt',             'SGPT / ALT',             'text',   false, NULL, 54),
  ('blood_test_reports', 'glucose_fasting',      'Glucose (Fasting)',      'text',   false, NULL, 55),
  ('blood_test_reports', 'hba1c',                'HbA1c (%)',              'text',   false, NULL, 56),
  ('blood_test_reports', 'abnormal_flags',       'Abnormal / Flagged Values', 'text', false, NULL, 80),
  ('blood_test_reports', 'reference_lab_no',     'Lab / Reference Number', 'text',   false, NULL, 90)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── progress_notes ─────────────────────────────────────────────────────
-- Daily ward notes — typically one entry per day with vitals + observations +
-- plan. We capture the observation/plan as free text and any structured
-- vitals as separate fields.
INSERT INTO hospital.document_field_schemas
  (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority)
VALUES
  ('progress_notes', 'note_date',           'Note Date',                'date', false, NULL, 10),
  ('progress_notes', 'note_time',           'Note Time',                'text', false, NULL, 11),
  ('progress_notes', 'patient_name',        'Patient Name',             'text', false, NULL, 15),
  ('progress_notes', 'attending_doctor',    'Attending Doctor',         'text', false, NULL, 20),
  ('progress_notes', 'observations',        'Clinical Observations',    'text', false, NULL, 30),
  ('progress_notes', 'vitals_bp',           'Blood Pressure (mmHg)',    'text', false, NULL, 40),
  ('progress_notes', 'vitals_pulse',        'Pulse (bpm)',              'text', false, NULL, 41),
  ('progress_notes', 'vitals_temp',         'Temperature',              'text', false, NULL, 42),
  ('progress_notes', 'vitals_spo2',         'SpO2 (%)',                 'text', false, NULL, 43),
  ('progress_notes', 'assessment',          'Clinical Assessment',      'text', false, NULL, 50),
  ('progress_notes', 'plan',                'Treatment Plan',           'text', false, NULL, 60),
  ('progress_notes', 'investigations_today','Investigations Ordered',   'text', false, NULL, 70)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── medication_administration_record ──────────────────────────────────
-- MAR sheets — usually a tabular list of meds × times × doses signed off
-- by nursing staff. We capture as text + key totals so the harmoniser can
-- inventory antibiotics, opioids, IV fluids etc.
INSERT INTO hospital.document_field_schemas
  (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority)
VALUES
  ('medication_administration_record', 'record_date',          'MAR Date',                       'date',  false, NULL, 10),
  ('medication_administration_record', 'patient_name',         'Patient Name',                   'text',  false, NULL, 15),
  ('medication_administration_record', 'prescribing_doctor',   'Prescribing Doctor',             'text',  false, NULL, 20),
  ('medication_administration_record', 'medications',          'Medications Administered (list)', 'text', false, NULL, 30),
  ('medication_administration_record', 'antibiotics_list',     'Antibiotics',                    'text',  false, NULL, 40),
  ('medication_administration_record', 'analgesics_list',      'Analgesics / Opioids',           'text',  false, NULL, 41),
  ('medication_administration_record', 'iv_fluids_list',       'IV Fluids',                      'text',  false, NULL, 42),
  ('medication_administration_record', 'route_summary',        'Route Summary (PO/IV/IM/SC)',    'text',  false, NULL, 50),
  ('medication_administration_record', 'nurse_signature',      'Nurse Signature / ID',           'text',  false, NULL, 60)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── serology_reports ───────────────────────────────────────────────────
-- Single-test serology reports — CRP, dengue NS1/IgM, hepatitis B/C markers,
-- HIV, RA factor, ASO. Often handwritten or printed on lab-specific
-- letterhead. Test name + value + reference is the typical shape.
INSERT INTO hospital.document_field_schemas
  (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority)
VALUES
  ('serology_reports', 'patient_name',     'Patient Name',          'text', false, NULL, 10),
  ('serology_reports', 'patient_age',      'Patient Age',           'number', false, NULL, 15),
  ('serology_reports', 'study_date',       'Sample Date',           'date', false, NULL, 20),
  ('serology_reports', 'lab_name',         'Lab Name',              'text', false, NULL, 25),
  ('serology_reports', 'reporting_doctor', 'Reporting Pathologist', 'text', false, NULL, 30),
  ('serology_reports', 'test_name',        'Test Name',             'text', true,  NULL, 35),
  ('serology_reports', 'test_value',       'Test Result',           'text', true,  NULL, 40),
  ('serology_reports', 'reference_range',  'Reference Range',       'text', false, NULL, 45),
  ('serology_reports', 'result_flag',      'Flag (Normal/High/Low/Reactive/Non-reactive)', 'text', false, NULL, 50),
  ('serology_reports', 'methodology',      'Methodology',           'text', false, NULL, 55)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── fitness_certificate ───────────────────────────────────────────────
-- Medical fit-for-discharge / fit-for-school / fit-for-work certificates.
-- Short notes, typically a doctor's certification on hospital letterhead.
INSERT INTO hospital.document_field_schemas
  (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority)
VALUES
  ('fitness_certificate', 'certificate_date',     'Certificate Date',         'date', false, NULL, 10),
  ('fitness_certificate', 'patient_name',         'Patient Name',             'text', false, NULL, 15),
  ('fitness_certificate', 'patient_age',          'Patient Age',              'number', false, NULL, 20),
  ('fitness_certificate', 'certifying_doctor',    'Certifying Doctor',        'text', false, NULL, 25),
  ('fitness_certificate', 'doctor_registration',  'Doctor Registration No.',  'text', false, NULL, 30),
  ('fitness_certificate', 'fit_for',              'Fit For (work/school/discharge)', 'text', false, NULL, 35),
  ('fitness_certificate', 'diagnosis_or_reason',  'Diagnosis / Reason',       'text', false, NULL, 40),
  ('fitness_certificate', 'restrictions',         'Restrictions / Conditions','text', false, NULL, 50),
  ('fitness_certificate', 'valid_until',          'Validity Date',            'date', false, NULL, 60)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

COMMIT;
