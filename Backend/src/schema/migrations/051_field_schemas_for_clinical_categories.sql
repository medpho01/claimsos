-- ============================================================================
-- Wave 9 follow-up — field schemas for clinical / handwritten categories.
-- ============================================================================
-- Several categories were marked extraction_mode='vision' in migration 050
-- because Tesseract OCR fails on them (handwritten OPD slips, X-ray plates
-- with annotations, surgical discharge notes, etc.) — but the extractor
-- short-circuits at the "no field_schema" check BEFORE the vision routing
-- decision, leaving these sections forever empty.
--
-- This migration:
--   1. Seeds field schemas for the clinical categories that still have none
--      (opd_notes, xray_reports, surgical_discharge_slip, anaesthesia_consent,
--      nursing_notes, prescription, admission_notes, pathology_reports).
--   2. Flips opd_notes to extraction_mode='vision' (was unset).
--   3. Adds master_options.description hints so the LLM knows what to look
--      for in each layout — same pattern as migration 049.
--
-- Why required=false on most fields: handwritten documents vary wildly in
-- how complete they are. Marking a field required would force the LLM to
-- emit a sentinel placeholder (the system prompt's '1970-01-01' / 0 /
-- empty-string convention) for every missing value, and the user would
-- see those sentinels as garbage in the UI. Optional + low-confidence
-- markers handle the "field absent" case more honestly.

BEGIN;

-- ─── OPD Notes (handwritten doctor's consultation) ──────────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category,  field_key,                 field_label,                 field_type, is_required, enum_values, extraction_priority) VALUES
    ('opd_notes',   'consultation_date',       'Consultation Date',         'date',     false, NULL, 10),
    ('opd_notes',   'consulting_doctor',       'Consulting Doctor',         'text',     false, NULL, 20),
    ('opd_notes',   'chief_complaints',        'Chief Complaints',          'text',     true,  NULL, 30),
    ('opd_notes',   'history',                 'Relevant History',          'text',     false, NULL, 40),
    ('opd_notes',   'examination_findings',    'Examination Findings',      'text',     false, NULL, 50),
    ('opd_notes',   'provisional_diagnosis',   'Provisional Diagnosis',     'text',     false, NULL, 60),
    ('opd_notes',   'investigations_ordered',  'Investigations Ordered',    'text',     false, NULL, 70),
    ('opd_notes',   'advice_or_plan',          'Advice / Plan',             'text',     false, NULL, 80),
    ('opd_notes',   'prescribed_medications',  'Prescribed Medications',    'text',     false, NULL, 90)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

UPDATE hospital.master_options
   SET extraction_mode = 'vision',
       description = $$
OPD (out-patient) consultation notes in India are almost always HANDWRITTEN. Typical layout (variable, but these elements are consistent):

  - Top of the page: patient name (or sticker), age, date of visit.
  - "C/O" (Complaint of): the chief complaints. Often abbreviated — "Pain Lt knee", "Difficulty in walking", "SOB", "Chest pain x 2 days". Treat each line under C/O as a separate complaint. Map to `chief_complaints` (multi-line string).
  - "H/O" (History of): past medical/surgical history. "H/O TKR 1 yr ago Rt knee" → put in `history`.
  - "O/E" (On examination): examination findings.
  - X-ray / CT / investigation summary, often handwritten line-by-line: capture verbatim in `examination_findings` if findings, or `investigations_ordered` if just listing what was sent.
  - "Adv" (Advice): treatment plan. Often a bulleted list. Map to `advice_or_plan`.
  - Diagnosis usually appears with a clinical staging marker like "OA III Lt knee" (osteoarthritis grade III, left knee) or "AVN Rt hip". Map to `provisional_diagnosis`.
  - Signature + date + Reg No. + doctor's name printed at the bottom (rubber stamp).

Indian medical-handwriting shortcuts to expect:
  - Lt = Left, Rt = Right, B/L = Bilateral
  - C̄ (c with bar) = "with"; S̄ (s with bar) = "without"
  - Dates often DD/MM/YY or with month names
  - Doses inline with medications ("Tab Pantoprazole 40 1-0-1")

Do NOT invent values. If a section of the slip isn't legible, leave the field empty (the system will mark per_field_confidence=0 for missing required fields).
$$
 WHERE category = 'doc_category' AND code = 'opd_notes';

-- ─── X-Ray Reports (radiograph plate with annotations) ──────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category,    field_key,                field_label,               field_type, is_required, enum_values, extraction_priority) VALUES
    ('xray_reports',  'patient_name',           'Patient Name',            'text',     false, NULL, 10),
    ('xray_reports',  'patient_age',            'Patient Age',             'number',   false, NULL, 15),
    ('xray_reports',  'patient_sex',            'Patient Sex',             'enum',     false, '["M","F","O"]'::jsonb, 16),
    ('xray_reports',  'study_date',             'Study Date',              'date',     false, NULL, 20),
    ('xray_reports',  'body_part',              'Body Part / Anatomy',     'text',     true,  NULL, 30),
    ('xray_reports',  'views',                  'Views (AP / Lateral / Oblique)',  'text', false, NULL, 40),
    ('xray_reports',  'laterality',             'Laterality',              'enum',     false, '["LEFT","RIGHT","BILATERAL","NA"]'::jsonb, 45),
    ('xray_reports',  'imaging_centre',         'Imaging Centre / Hospital','text',    false, NULL, 50),
    ('xray_reports',  'findings',               'Findings',                'text',     false, NULL, 60),
    ('xray_reports',  'impression',             'Impression',              'text',     false, NULL, 70),
    ('xray_reports',  'ordering_physician',     'Ordering Physician',      'text',     false, NULL, 80),
    ('xray_reports',  'reporting_radiologist',  'Reporting Radiologist',   'text',     false, NULL, 90)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

UPDATE hospital.master_options SET description = $$
X-Ray reports in Indian hospital uploads fall into two layouts:

  1. TYPED report from a radiology PACS system (most diagnostic centres):
     header with centre name, patient block (Name, Age, Sex, ID), study
     date, "FINDINGS:" paragraph, "IMPRESSION:" / "OPINION:" paragraph,
     radiologist's signature + reg number.

  2. PLATE ONLY — the X-ray film itself, photographed. The text overlay
     on the plate carries patient name, age, sex, hospital, date, view.
     There's NO findings/impression — those have to be inferred from the
     image. For this case:
       - Extract patient_name, patient_age, patient_sex, study_date,
         body_part, views, laterality from the overlay text.
       - For `findings`, describe what's visible on the X-ray clinically
         (e.g. "Reduced medial joint space, osteophytes at femoral
         condyles, sclerosis of tibial plateau — consistent with OA grade 3").
       - For `impression`, provide a brief clinical conclusion if you can
         see clear pathology, otherwise leave empty.

Common abbreviations:
  - "AP" = anteroposterior view; "LAT" / "Lat" = lateral view; "OBL" = oblique
  - "B/L" = bilateral; views labelled "L" / "R" indicate side
  - "JNT" = joint
  - Body part terms: "KNEE JNT", "HIP JNT", "C-SPINE", "L-SPINE", "PELVIS", "CXR" (chest)

Always extract the overlay's date (format DD/MM/YYYY or D/M/YYYY) as study_date in ISO.
$$
 WHERE category = 'doc_category' AND code = 'xray_reports';

-- ─── Surgical Discharge Slip ────────────────────────────────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category,                field_key,                  field_label,                  field_type, is_required, enum_values, extraction_priority) VALUES
    ('surgical_discharge_slip',   'admission_date',           'Admission Date',             'date',     true,  NULL, 10),
    ('surgical_discharge_slip',   'discharge_date',           'Discharge Date',             'date',     true,  NULL, 20),
    ('surgical_discharge_slip',   'primary_diagnosis',        'Primary Diagnosis',          'text',     true,  NULL, 30),
    ('surgical_discharge_slip',   'procedure_performed',      'Procedure Performed',        'text',     true,  NULL, 40),
    ('surgical_discharge_slip',   'surgery_date',             'Surgery Date',               'date',     false, NULL, 45),
    ('surgical_discharge_slip',   'primary_surgeon',          'Primary Surgeon',            'text',     false, NULL, 50),
    ('surgical_discharge_slip',   'anaesthetist',             'Anaesthetist',               'text',     false, NULL, 60),
    ('surgical_discharge_slip',   'anaesthesia_type',         'Anaesthesia Type',           'enum',     false,
        '["GENERAL","SPINAL","EPIDURAL","REGIONAL","LOCAL","SEDATION"]'::jsonb, 70),
    ('surgical_discharge_slip',   'implants_used',            'Implants Used',              'text',     false, NULL, 80),
    ('surgical_discharge_slip',   'operative_findings',       'Operative Findings',         'text',     false, NULL, 90),
    ('surgical_discharge_slip',   'post_op_course',           'Post-op Course',             'text',     false, NULL, 100),
    ('surgical_discharge_slip',   'discharge_condition',      'Condition at Discharge',     'text',     false, NULL, 110),
    ('surgical_discharge_slip',   'discharge_medications',    'Discharge Medications',      'text',     false, NULL, 120),
    ('surgical_discharge_slip',   'follow_up_advice',         'Follow-up Advice',           'text',     false, NULL, 130),
    ('surgical_discharge_slip',   'treating_doctor',          'Treating Doctor',            'text',     false, NULL, 140),
    ('surgical_discharge_slip',   'room_category',            'Room Category',              'enum',     false,
        '["general","semi_private","private","icu","iccu","nicu"]'::jsonb, 150)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

UPDATE hospital.master_options SET description = $$
Surgical discharge slips are a hybrid of pre-printed form fields and handwritten clinical content. Standard sections (in roughly this order):

  - Patient block: name, age, IPD number, ward.
  - Admission date / Discharge date / LOS (length of stay).
  - Diagnosis: surgical indication. Map to `primary_diagnosis`.
  - Procedure done / Surgery: name + side (e.g. "Hybrid THR Rt hip", "TKR Lt knee"). Map to `procedure_performed`.
  - Date of surgery (DD/MM/YYYY) → `surgery_date`.
  - Surgeon's name (often with reg number) → `primary_surgeon`.
  - Anaesthesia: type (SA / GA / Epidural / Regional Block / Sedation) + anaesthetist's name.
  - Implants: brand + model + serial number lines, when applicable (joint replacements, spinal, cardiac stents).
  - Operative findings: 1-3 lines describing what was found at surgery.
  - Post-op course: 1-5 lines describing recovery.
  - Condition at discharge: typically "stable", "improved", "ambulating with support".
  - Medications (often a structured list with dose + duration).
  - Follow-up: review date + instructions.
  - Doctor signature + stamp at the bottom.

For PMJAY/government claims, the form often has the package code printed. If you see "PMJAY THR" or "PMJAY_TKR" treat that as both confirmation of the package and a strong signal for procedure type.

Indian-context note: dates are DD/MM/YYYY by default; surgery dates often appear with month name ("26 Dec 2025"). Always emit ISO YYYY-MM-DD.
$$
 WHERE category = 'doc_category' AND code = 'surgical_discharge_slip';

-- ─── Anaesthesia Consent / Anaesthesia Notes ────────────────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category,            field_key,               field_label,                field_type, is_required, enum_values, extraction_priority) VALUES
    ('anaesthesia_consent',   'surgery_date',          'Surgery Date',             'date',     false, NULL, 10),
    ('anaesthesia_consent',   'duration_minutes',      'Anaesthesia Duration (mins)','number', false, NULL, 20),
    ('anaesthesia_consent',   'anaesthesia_type',      'Anaesthesia Type',         'enum',     false,
        '["GENERAL","SPINAL","EPIDURAL","REGIONAL","LOCAL","SEDATION","COMBINED"]'::jsonb, 30),
    ('anaesthesia_consent',   'anaesthetist',          'Anaesthetist',             'text',     false, NULL, 40),
    ('anaesthesia_consent',   'asa_grade',             'ASA Physical Status',      'enum',     false,
        '["ASA_I","ASA_II","ASA_III","ASA_IV","ASA_V","ASA_VI"]'::jsonb, 50),
    ('anaesthesia_consent',   'pre_anaesthetic_findings', 'Pre-anaesthetic Findings', 'text',  false, NULL, 60),
    ('anaesthesia_consent',   'consent_signed_by',     'Consent Signed By',        'text',     false, NULL, 70),
    ('anaesthesia_consent',   'consent_date',          'Consent Date',             'date',     false, NULL, 80)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Admission Notes ────────────────────────────────────────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category,       field_key,                field_label,                  field_type, is_required, enum_values, extraction_priority) VALUES
    ('admission_notes',  'admission_date',         'Admission Date',             'date',     true,  NULL, 10),
    ('admission_notes',  'admission_time',         'Admission Time',             'text',     false, NULL, 15),
    ('admission_notes',  'admission_type',         'Admission Type',             'enum',     false,
        '["EMERGENCY","ELECTIVE","PLANNED","TRANSFER"]'::jsonb, 20),
    ('admission_notes',  'admitting_doctor',       'Admitting Doctor',           'text',     false, NULL, 30),
    ('admission_notes',  'admission_diagnosis',    'Admission Diagnosis',        'text',     true,  NULL, 40),
    ('admission_notes',  'chief_complaints',       'Chief Complaints',           'text',     false, NULL, 50),
    ('admission_notes',  'history_of_present_illness', 'History of Present Illness', 'text', false, NULL, 60),
    ('admission_notes',  'past_history',           'Past History',               'text',     false, NULL, 70),
    ('admission_notes',  'examination_findings',   'Examination Findings',       'text',     false, NULL, 80),
    ('admission_notes',  'vitals_on_admission',    'Vitals on Admission',        'text',     false, NULL, 90),
    ('admission_notes',  'plan',                   'Initial Plan',               'text',     false, NULL, 100)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Prescription ───────────────────────────────────────────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category,   field_key,             field_label,             field_type, is_required, enum_values, extraction_priority) VALUES
    ('prescription', 'prescription_date',   'Prescription Date',     'date',     false, NULL, 10),
    ('prescription', 'prescribing_doctor',  'Prescribing Doctor',    'text',     false, NULL, 20),
    ('prescription', 'diagnosis',           'Diagnosis',             'text',     false, NULL, 30),
    ('prescription', 'medications',         'Medications',           'text',     true,  NULL, 40),
    ('prescription', 'duration',            'Duration',              'text',     false, NULL, 50),
    ('prescription', 'follow_up_date',      'Follow-up Date',        'date',     false, NULL, 60)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Nursing Notes ──────────────────────────────────────────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category,    field_key,                field_label,                  field_type, is_required, enum_values, extraction_priority) VALUES
    ('nursing_notes', 'note_date',              'Note Date',                  'date',     true,  NULL, 10),
    ('nursing_notes', 'shift',                  'Shift',                      'enum',     false,
        '["MORNING","AFTERNOON","EVENING","NIGHT"]'::jsonb, 20),
    ('nursing_notes', 'vitals',                 'Vitals',                     'text',     false, NULL, 30),
    ('nursing_notes', 'intake_output',          'Intake / Output',            'text',     false, NULL, 40),
    ('nursing_notes', 'medications_administered','Medications Administered',  'text',     false, NULL, 50),
    ('nursing_notes', 'observations',           'Clinical Observations',      'text',     false, NULL, 60),
    ('nursing_notes', 'recorded_by',            'Recorded By',                'text',     false, NULL, 70)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Pathology Reports ──────────────────────────────────────────────────
INSERT INTO hospital.document_field_schemas
    (doc_category,        field_key,             field_label,            field_type, is_required, enum_values, extraction_priority) VALUES
    ('pathology_reports', 'report_date',         'Report Date',          'date',     false, NULL, 10),
    ('pathology_reports', 'specimen_type',       'Specimen Type',        'text',     false, NULL, 20),
    ('pathology_reports', 'tests_performed',     'Tests Performed',      'text',     true,  NULL, 30),
    ('pathology_reports', 'key_findings',        'Key Findings',         'text',     false, NULL, 40),
    ('pathology_reports', 'abnormal_values',     'Abnormal Values',      'text',     false, NULL, 50),
    ('pathology_reports', 'impression',          'Impression',           'text',     false, NULL, 60),
    ('pathology_reports', 'lab_name',            'Lab Name',             'text',     false, NULL, 70),
    ('pathology_reports', 'pathologist',         'Reporting Pathologist','text',     false, NULL, 80)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

COMMIT;
