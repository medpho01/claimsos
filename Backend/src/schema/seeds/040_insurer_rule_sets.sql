-- ==========================================================================
-- 040 — insurer rule sets, rules, and their three child catalogues
-- ==========================================================================
-- Applied by src/schema/run-seeds.cjs, which owns the transaction and records
-- this file's sha256 in hospital.seed_applications. Editing the file changes
-- that checksum, which is exactly what makes the next `npm run seed` re-apply
-- it. See seeds/README.md for the authoring rules the CI guard enforces.
--
-- This is a DECLARATIVE snapshot of the desired catalog, not a replay of
-- history: it was generated from a database that had run every migration in
-- order, so it is the union of the sources below with every later rename,
-- relabel and correction already folded in.
--
-- Historical sources (left untouched in migrations/, which production is
-- already stamped for):
--   044_insurer_rule_sets.sql sections H and I
--
-- DEPENDS ON migration 074_insurer_rule_child_unique_keys.sql for the three child
-- constraints these ON CONFLICT clauses name:
--   uq_insurer_doc_req_set_type_stage / uq_insurer_fin_limit_set_kind /
--   uq_insurer_los_set_procedure
-- Child rows are joined to their parent through the BUSINESS key
-- (insurer_rule_sets.rule_set_id), never a UUID, because the surrogate id differs
-- per environment.
-- 
-- This file is the scaffolding a future rules-authoring UI writes into — keep each
-- rule set in its own delimited section.
-- ==========================================================================

-- ── A. Rule sets ───────────────────────────────────────────────────────────

INSERT INTO hospital.insurer_rule_sets
    (rule_set_id, rule_set_name, version, effective_from, effective_till, insurer_code,
     applicable_treatments, applicable_specialties, status,
     applicable_schemes, applicable_routes, applicable_stages, applicable_case_types) VALUES
    ('ICICI_LOMBARD_CARDIAC_V1', 'ICICI Lombard - Cardiac Treatment Rules', '1.0', '2026-01-01'::date, NULL, 'ICICI_LOMBARD', '{MEDICAL_MANAGEMENT,SURGICAL}'::text[], '{CARDIOLOGY,CARDIOTHORACIC_SURGERY}'::text[], 'live', '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[]),
    ('SADBHAWANA_PMJAY_THR_V1', 'Sadbhawana / PMJAY - Total Hip Replacement Rules', '1.0', '2026-01-01'::date, NULL, 'PMJAY', '{SURGICAL}'::text[], '{ORTHOPEDICS}'::text[], 'live', '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[]),
    ('STAR_HEALTH_ORTHOPEDIC_V1', 'Star Health - Orthopedic Surgery Rules', '1.0', '2026-01-01'::date, NULL, 'STAR_HEALTH', '{SURGICAL}'::text[], '{ORTHOPEDICS}'::text[], 'live', '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[])
ON CONFLICT (rule_set_id) DO UPDATE SET
    rule_set_name          = EXCLUDED.rule_set_name,
    version                = EXCLUDED.version,
    effective_from         = EXCLUDED.effective_from,
    effective_till         = EXCLUDED.effective_till,
    insurer_code           = EXCLUDED.insurer_code,
    applicable_treatments  = EXCLUDED.applicable_treatments,
    applicable_specialties = EXCLUDED.applicable_specialties,
    status                 = EXCLUDED.status,
    applicable_schemes     = EXCLUDED.applicable_schemes,
    applicable_routes      = EXCLUDED.applicable_routes,
    applicable_stages      = EXCLUDED.applicable_stages,
    applicable_case_types  = EXCLUDED.applicable_case_types,
    updated_at             = NOW();


-- ── B. Rules ───────────────────────────────────────────────────────────────

INSERT INTO hospital.insurance_rules
    (rule_set_id, rule_id, rule_name, rule_description, category, severity, impact, enabled, mandatory,
     validation_logic, failure_message, remediation_guidance, required_documents,
     estimated_deduction_amount, query_template, order_index, kind, min_confidence)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('CARDIAC_001', 'ECG Required for Cardiac Admission', 'All cardiac admissions must have ECG report within 24 hours of admission', 'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true, true, E'{"operator": "EXISTS", "json_path": "$.clinical_timeline[?(@.phase_code==\\"EMERGENCY_PRESENTATION\\" || @.phase_code==\\"ADMISSION\\")].diagnostics_performed[?(@.diagnostic_meta.category==\\"CARDIAC\\" && @.diagnostic_meta.test_name_normalized==\\"ELECTROCARDIOGRAM_12_LEAD\\")]", "logic_type": "EXISTENCE_CHECK"}'::jsonb, 'ECG report not found for cardiac admission', 'Please upload ECG report taken within 24 hours of admission', '{ECG_REPORT}'::text[], NULL::numeric, 'ECG report is mandatory for cardiac admission. Please provide ECG report taken at the time of admission.', 10, NULL, NULL::numeric),
    ('CARDIAC_002', 'Cardiac Enzymes for ACS Diagnosis', 'Acute Coronary Syndrome diagnosis must be supported by elevated cardiac enzymes (Troponin/CKMB)', 'CLINICAL_APPROPRIATENESS', 'HIGH', 'QUERY', true, true, '{"logic_type": "COMPLEX_CONDITION", "custom_function": "validate_cardiac_enzymes_for_acs"}'::jsonb, 'ACS diagnosis not supported by cardiac enzyme elevation', 'Provide cardiac enzyme (Troponin/CKMB) reports showing elevation, or revise diagnosis', '{PATHOLOGY_REPORTS}'::text[], NULL::numeric, NULL, 20, NULL, NULL::numeric),
    ('CARDIAC_003', 'ICU Stay Justification for Medical Management', 'ICU stay >3 days for medical management requires clinical justification', 'CLINICAL_APPROPRIATENESS', 'MEDIUM', 'QUERY', true, false, '{"logic_type": "COMPLEX_CONDITION", "custom_function": "validate_icu_stay_cardiac_medical_mgmt"}'::jsonb, 'ICU stay exceeds 3 days without adequate justification', 'Provide daily progress notes explaining clinical necessity for prolonged ICU stay', '{ICU_CHARTS,DAILY_PROGRESS_NOTES}'::text[], 5000.00::numeric, NULL, 30, NULL, NULL::numeric),
    ('CARDIAC_004', 'Room Rent Eligibility Check', 'Verify room category matches policy eligibility', 'FINANCIAL_LIMITS', 'HIGH', 'DEDUCTION', true, true, '{"logic_type": "CUSTOM", "custom_function": "validate_room_eligibility"}'::jsonb, 'Room category exceeds policy eligibility', 'Room rent will be capped as per policy limits with proportionate deduction', '{}'::text[], NULL::numeric, NULL, 40, NULL, NULL::numeric),
    ('CARDIAC_005', 'Pre-existing Disease Declaration', 'Check if cardiac condition existed before policy inception', 'POLICY_ELIGIBILITY', 'CRITICAL', 'CLAIM_REJECTION', true, true, '{"logic_type": "COMPLEX_CONDITION", "custom_function": "validate_pre_existing_condition"}'::jsonb, 'Cardiac condition appears to be pre-existing and not declared', 'Provide evidence that condition was not present at policy inception or wait for waiting period completion', '{}'::text[], NULL::numeric, NULL, 50, NULL, NULL::numeric)
) AS v(rule_id, rule_name, rule_description, category, severity, impact, enabled, mandatory,
        validation_logic, failure_message, remediation_guidance, required_documents,
        estimated_deduction_amount, query_template, order_index, kind, min_confidence)
WHERE rs.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1'
ON CONFLICT (rule_set_id, rule_id) DO UPDATE SET
    rule_name                  = EXCLUDED.rule_name,
    rule_description           = EXCLUDED.rule_description,
    category                   = EXCLUDED.category,
    severity                   = EXCLUDED.severity,
    impact                     = EXCLUDED.impact,
    enabled                    = EXCLUDED.enabled,
    mandatory                  = EXCLUDED.mandatory,
    validation_logic           = EXCLUDED.validation_logic,
    failure_message            = EXCLUDED.failure_message,
    remediation_guidance       = EXCLUDED.remediation_guidance,
    required_documents         = EXCLUDED.required_documents,
    estimated_deduction_amount = EXCLUDED.estimated_deduction_amount,
    query_template             = EXCLUDED.query_template,
    order_index                = EXCLUDED.order_index,
    kind                       = EXCLUDED.kind,
    min_confidence             = EXCLUDED.min_confidence;

INSERT INTO hospital.insurance_rules
    (rule_set_id, rule_id, rule_name, rule_description, category, severity, impact, enabled, mandatory,
     validation_logic, failure_message, remediation_guidance, required_documents,
     estimated_deduction_amount, query_template, order_index, kind, min_confidence)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('PMJAY_THR_001', 'Pre-operative X-ray Required', 'Hip X-ray taken before THR is mandatory for PMJAY claims', 'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true, true, E'{"operator": "EXISTS", "json_path": "$.clinical_timeline[*].diagnostics_performed[?(@.diagnostic_meta.category==\\"RADIOLOGY\\")]", "logic_type": "EXISTENCE_CHECK"}'::jsonb, 'Pre-operative hip X-ray not found', 'Upload pre-op X-ray of the hip joint clearly showing pathology', '{XRAY_IMAGES}'::text[], NULL::numeric, 'Pre-op X-ray is required to validate THR procedure. Please share dated film.', 10, NULL, NULL::numeric),
    ('PMJAY_THR_002', 'Implant Sticker Mandatory', 'Implant sticker with batch / lot / serial must be present', 'DOCUMENT_COMPLETENESS', 'CRITICAL', 'DEDUCTION', true, true, E'{"operator": "EXISTS", "json_path": "$.documents.images[?(@.image_type==\\"IMPLANT_STICKER\\")]", "logic_type": "EXISTENCE_CHECK"}'::jsonb, 'Implant sticker missing', 'Upload clear image of implant sticker. Full implant cost otherwise deducted.', '{IMPLANT_STICKER}'::text[], NULL::numeric, NULL, 20, NULL, NULL::numeric),
    ('PMJAY_THR_003', 'Implant Invoice Mandatory', 'Original implant invoice from authorised dealer required', 'DOCUMENT_COMPLETENESS', 'HIGH', 'DEDUCTION', true, true, E'{"operator": "EXISTS", "json_path": "$.documents.bills[?(@.bill_type==\\"IMPLANT_BILL\\")]", "logic_type": "EXISTENCE_CHECK"}'::jsonb, 'Original implant invoice not provided', NULL, '{IMPLANT_INVOICE}'::text[], 30000.00::numeric, NULL, 30, NULL, NULL::numeric),
    ('PMJAY_THR_004', 'OT Notes Signed and Dated', 'Operative notes must be signed by surgeon and dated', 'DOCUMENT_COMPLETENESS', 'HIGH', 'QUERY', true, true, E'{"operator": "EXISTS", "json_path": "$.documents.notes[?(@.note_type==\\"OT_NOTES\\" && @.signed==true)]", "logic_type": "EXISTENCE_CHECK"}'::jsonb, 'OT notes not signed/dated', 'Surgeon to sign and date OT notes, then re-upload.', '{OT_NOTES}'::text[], NULL::numeric, NULL, 40, NULL, NULL::numeric),
    ('PMJAY_THR_005', 'Anesthesia Notes Required', 'Anesthesia chart and notes required', 'DOCUMENT_COMPLETENESS', 'MEDIUM', 'QUERY', true, false, E'{"operator": "EXISTS", "json_path": "$.documents.notes[?(@.note_type==\\"ANESTHESIA_NOTES\\")]", "logic_type": "EXISTENCE_CHECK"}'::jsonb, 'Anesthesia notes not found', NULL, '{ANESTHESIA_NOTES}'::text[], NULL::numeric, NULL, 50, NULL, NULL::numeric),
    ('PMJAY_THR_006', 'Discharge Summary Signed', 'Discharge summary must be signed by the treating doctor', 'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true, true, E'{"operator": "EXISTS", "json_path": "$.documents.notes[?(@.note_type==\\"DISCHARGE_SUMMARY\\" && @.signed==true)]", "logic_type": "EXISTENCE_CHECK"}'::jsonb, 'Discharge summary missing or unsigned', NULL, '{DISCHARGE_SUMMARY}'::text[], NULL::numeric, NULL, 60, NULL, NULL::numeric),
    ('PMJAY_THR_007', 'Final Bill Within Package', 'Final billed amount must be within PMJAY package cap', 'FINANCIAL_LIMITS', 'HIGH', 'DEDUCTION', true, false, '{"logic_type": "COMPLEX_CONDITION", "custom_function": "validate_pmjay_package_match"}'::jsonb, 'Final bill exceeds PMJAY package amount', NULL, '{FINAL_BILL}'::text[], NULL::numeric, NULL, 70, NULL, NULL::numeric),
    ('PMJAY_THR_008', 'LOS Within Tolerance', 'Length of stay must be within procedure benchmark + tolerance', 'TEMPORAL_VALIDITY', 'MEDIUM', 'QUERY', true, false, '{"logic_type": "COMPLEX_CONDITION", "custom_function": "validate_los_against_benchmark"}'::jsonb, 'LOS exceeds benchmark', NULL, '{DAILY_PROGRESS_NOTES}'::text[], NULL::numeric, NULL, 80, NULL, NULL::numeric)
) AS v(rule_id, rule_name, rule_description, category, severity, impact, enabled, mandatory,
        validation_logic, failure_message, remediation_guidance, required_documents,
        estimated_deduction_amount, query_template, order_index, kind, min_confidence)
WHERE rs.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1'
ON CONFLICT (rule_set_id, rule_id) DO UPDATE SET
    rule_name                  = EXCLUDED.rule_name,
    rule_description           = EXCLUDED.rule_description,
    category                   = EXCLUDED.category,
    severity                   = EXCLUDED.severity,
    impact                     = EXCLUDED.impact,
    enabled                    = EXCLUDED.enabled,
    mandatory                  = EXCLUDED.mandatory,
    validation_logic           = EXCLUDED.validation_logic,
    failure_message            = EXCLUDED.failure_message,
    remediation_guidance       = EXCLUDED.remediation_guidance,
    required_documents         = EXCLUDED.required_documents,
    estimated_deduction_amount = EXCLUDED.estimated_deduction_amount,
    query_template             = EXCLUDED.query_template,
    order_index                = EXCLUDED.order_index,
    kind                       = EXCLUDED.kind,
    min_confidence             = EXCLUDED.min_confidence;

INSERT INTO hospital.insurance_rules
    (rule_set_id, rule_id, rule_name, rule_description, category, severity, impact, enabled, mandatory,
     validation_logic, failure_message, remediation_guidance, required_documents,
     estimated_deduction_amount, query_template, order_index, kind, min_confidence)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('ORTHO_001', 'X-Ray Mandatory for Joint Surgery', 'Pre-operative X-ray is mandatory for all joint surgeries', 'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true, true, E'{"operator": "EXISTS", "json_path": "$.clinical_timeline[?(@.phase_code==\\"PRE_OPERATIVE\\")].diagnostics_performed[?(@.diagnostic_meta.category==\\"RADIOLOGY\\")]", "logic_type": "EXISTENCE_CHECK"}'::jsonb, 'Pre-operative X-ray not found for joint surgery', NULL, '{XRAY_IMAGES}'::text[], NULL::numeric, NULL, 10, NULL, NULL::numeric),
    ('ORTHO_002', 'Implant Sticker Mandatory', 'Implant sticker with batch number and serial number is mandatory for all implant surgeries', 'DOCUMENT_COMPLETENESS', 'CRITICAL', 'DEDUCTION', true, true, E'{"operator": "EXISTS", "json_path": "$.documents.images[?(@.image_type==\\"IMPLANT_STICKER\\")]", "logic_type": "EXISTENCE_CHECK"}'::jsonb, 'Implant sticker not uploaded', 'Please upload clear photo of implant sticker showing batch number, serial number, and manufacturer details', '{IMPLANT_STICKER}'::text[], NULL::numeric, NULL, 20, NULL, NULL::numeric),
    ('ORTHO_003', 'Implant Bill Original Required', 'Original implant bill from manufacturer/authorized dealer required', 'DOCUMENT_COMPLETENESS', 'HIGH', 'DEDUCTION', true, true, E'{"operator": "EXISTS", "json_path": "$.documents.bills[?(@.bill_type==\\"IMPLANT_BILL\\")]", "logic_type": "EXISTENCE_CHECK"}'::jsonb, 'Original implant bill not provided', NULL, '{IMPLANT_INVOICE}'::text[], 50000.00::numeric, NULL, 30, NULL, NULL::numeric),
    ('ORTHO_004', 'Post-Operative X-Ray Required', 'Post-operative X-ray mandatory to confirm implant position', 'DOCUMENT_COMPLETENESS', 'HIGH', 'QUERY', true, true, E'{"operator": "EXISTS", "json_path": "$.clinical_timeline[?(@.phase_code==\\"POST_OPERATIVE\\")].diagnostics_performed[?(@.diagnostic_meta.category==\\"RADIOLOGY\\")]", "logic_type": "EXISTENCE_CHECK"}'::jsonb, 'Post-operative X-ray not found', NULL, '{}'::text[], NULL::numeric, NULL, 40, NULL, NULL::numeric),
    ('ORTHO_005', 'Implant Cost Cap', 'Implant cost capped at Rs. 1,50,000 for knee/hip replacement', 'FINANCIAL_LIMITS', 'MEDIUM', 'DEDUCTION', true, false, '{"operator": "LESS_THAN_OR_EQUAL", "json_path": "$.financial_summary.breakdown.implant_charges.total_implant_cost", "logic_type": "SIMPLE_COMPARISON", "expected_value": 150000}'::jsonb, 'Implant cost exceeds policy cap of Rs. 1,50,000', 'Implant cost will be capped at Rs. 1,50,000 as per policy terms', '{}'::text[], NULL::numeric, NULL, 50, NULL, NULL::numeric),
    ('ORTHO_006', 'Physiotherapy Coverage', 'Post-operative physiotherapy covered only if medically documented', 'CLINICAL_APPROPRIATENESS', 'LOW', 'DEDUCTION', true, false, '{"logic_type": "COMPLEX_CONDITION", "custom_function": "validate_physiotherapy_prescription"}'::jsonb, 'Physiotherapy charges require doctor''s prescription and progress notes', NULL, '{}'::text[], NULL::numeric, NULL, 60, NULL, NULL::numeric)
) AS v(rule_id, rule_name, rule_description, category, severity, impact, enabled, mandatory,
        validation_logic, failure_message, remediation_guidance, required_documents,
        estimated_deduction_amount, query_template, order_index, kind, min_confidence)
WHERE rs.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1'
ON CONFLICT (rule_set_id, rule_id) DO UPDATE SET
    rule_name                  = EXCLUDED.rule_name,
    rule_description           = EXCLUDED.rule_description,
    category                   = EXCLUDED.category,
    severity                   = EXCLUDED.severity,
    impact                     = EXCLUDED.impact,
    enabled                    = EXCLUDED.enabled,
    mandatory                  = EXCLUDED.mandatory,
    validation_logic           = EXCLUDED.validation_logic,
    failure_message            = EXCLUDED.failure_message,
    remediation_guidance       = EXCLUDED.remediation_guidance,
    required_documents         = EXCLUDED.required_documents,
    estimated_deduction_amount = EXCLUDED.estimated_deduction_amount,
    query_template             = EXCLUDED.query_template,
    order_index                = EXCLUDED.order_index,
    kind                       = EXCLUDED.kind,
    min_confidence             = EXCLUDED.min_confidence;


-- ── C. Document requirements ───────────────────────────────────────────────

INSERT INTO hospital.insurer_document_requirements
    (rule_set_id, document_type, required_when, mandatory, stage, quality_requirements)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('DISCHARGE_SUMMARY', NULL, true, 'FINAL_CLAIM', '{"must_be_dated": true, "must_be_signed": true, "must_be_stamped": true}'::jsonb),
    ('ECHO_REPORT', 'procedures contain ECHO', false, 'FINAL_CLAIM', NULL::jsonb),
    ('FINAL_BILL', NULL, true, 'FINAL_CLAIM', '{"must_be_signed": true, "must_be_stamped": true}'::jsonb),
    ('PATHOLOGY_REPORTS', 'diagnosis.primary_diagnosis.diagnosis_name CONTAINS ACS', true, 'FINAL_CLAIM', NULL::jsonb),
    ('ADMISSION_FORM', NULL, true, 'PRE_AUTH', '{"must_be_dated": true, "must_be_signed": true, "must_be_stamped": true}'::jsonb),
    ('ECG_REPORT', 'diagnosis.primary_diagnosis.icd_code LIKE ''I2%''', true, 'PRE_AUTH', NULL::jsonb)
) AS v(document_type, required_when, mandatory, stage, quality_requirements)
WHERE rs.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1'
ON CONFLICT ON CONSTRAINT uq_insurer_doc_req_set_type_stage DO UPDATE SET
    required_when        = EXCLUDED.required_when,
    mandatory            = EXCLUDED.mandatory,
    quality_requirements = EXCLUDED.quality_requirements;

INSERT INTO hospital.insurer_document_requirements
    (rule_set_id, document_type, required_when, mandatory, stage, quality_requirements)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('ANESTHESIA_NOTES', NULL, false, 'FINAL_CLAIM', NULL::jsonb),
    ('DISCHARGE_SUMMARY', NULL, true, 'FINAL_CLAIM', '{"must_be_dated": true, "must_be_signed": true}'::jsonb),
    ('FINAL_BILL', NULL, true, 'FINAL_CLAIM', '{"must_be_signed": true, "must_be_stamped": true}'::jsonb),
    ('IMPLANT_INVOICE', NULL, true, 'FINAL_CLAIM', NULL::jsonb),
    ('IMPLANT_STICKER', NULL, true, 'FINAL_CLAIM', NULL::jsonb),
    ('OT_NOTES', NULL, true, 'FINAL_CLAIM', '{"must_be_dated": true, "must_be_signed": true}'::jsonb),
    ('XRAY_IMAGES', NULL, true, 'PRE_AUTH', NULL::jsonb)
) AS v(document_type, required_when, mandatory, stage, quality_requirements)
WHERE rs.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1'
ON CONFLICT ON CONSTRAINT uq_insurer_doc_req_set_type_stage DO UPDATE SET
    required_when        = EXCLUDED.required_when,
    mandatory            = EXCLUDED.mandatory,
    quality_requirements = EXCLUDED.quality_requirements;

INSERT INTO hospital.insurer_document_requirements
    (rule_set_id, document_type, required_when, mandatory, stage, quality_requirements)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('ANESTHESIA_NOTES', NULL, true, 'FINAL_CLAIM', NULL::jsonb),
    ('CLINICAL_PHOTOS', 'wound complications exist', false, 'FINAL_CLAIM', NULL::jsonb),
    ('IMPLANT_INVOICE', 'procedures_performed contains implant', true, 'FINAL_CLAIM', NULL::jsonb),
    ('IMPLANT_STICKER', 'procedures_performed contains implant', true, 'FINAL_CLAIM', NULL::jsonb),
    ('OT_NOTES', NULL, true, 'FINAL_CLAIM', '{"must_be_dated": true, "must_be_signed": true}'::jsonb),
    ('XRAY_IMAGES', NULL, true, 'PRE_AUTH', NULL::jsonb)
) AS v(document_type, required_when, mandatory, stage, quality_requirements)
WHERE rs.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1'
ON CONFLICT ON CONSTRAINT uq_insurer_doc_req_set_type_stage DO UPDATE SET
    required_when        = EXCLUDED.required_when,
    mandatory            = EXCLUDED.mandatory,
    quality_requirements = EXCLUDED.quality_requirements;


-- ── D. Financial limits ────────────────────────────────────────────────────

INSERT INTO hospital.insurer_financial_limits (rule_set_id, limit_kind, config)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('consumables_limit', '{"limit_type": "PERCENTAGE_OF_BILL", "percentage": 15}'::jsonb),
    ('icu_charges', '{"limit_per_day": 10000, "max_days_covered": 7}'::jsonb),
    ('room_rent', '{"limit_type": "PERCENTAGE_OF_SI", "percentage": 2, "proportionate_deduction": true}'::jsonb)
) AS v(limit_kind, config)
WHERE rs.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1'
ON CONFLICT ON CONSTRAINT uq_insurer_fin_limit_set_kind DO UPDATE SET
    config = EXCLUDED.config;

INSERT INTO hospital.insurer_financial_limits (rule_set_id, limit_kind, config)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('implant_caps', '[{"max_amount": 60000, "implant_type": "HIP_REPLACEMENT", "requires_preauth": true}]'::jsonb),
    ('package_cap', '{"limit_type": "FIXED_AMOUNT", "limit_amount": 90000, "procedure_code": "THR"}'::jsonb)
) AS v(limit_kind, config)
WHERE rs.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1'
ON CONFLICT ON CONSTRAINT uq_insurer_fin_limit_set_kind DO UPDATE SET
    config = EXCLUDED.config;

INSERT INTO hospital.insurer_financial_limits (rule_set_id, limit_kind, config)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('consumables_limit', '{"limit_type": "PERCENTAGE_OF_BILL", "percentage": 20}'::jsonb),
    ('implant_caps', '[{"max_amount": 150000, "implant_type": "KNEE_REPLACEMENT", "requires_preauth": true}, {"max_amount": 150000, "implant_type": "HIP_REPLACEMENT", "requires_preauth": true}, {"max_amount": 100000, "implant_type": "SPINAL_IMPLANT", "requires_preauth": true}]'::jsonb),
    ('room_rent', '{"limit_type": "FIXED_AMOUNT", "limit_amount": 5000, "proportionate_deduction": true}'::jsonb)
) AS v(limit_kind, config)
WHERE rs.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1'
ON CONFLICT ON CONSTRAINT uq_insurer_fin_limit_set_kind DO UPDATE SET
    config = EXCLUDED.config;


-- ── E. LOS benchmarks ──────────────────────────────────────────────────────

INSERT INTO hospital.insurer_los_benchmarks
    (rule_set_id, procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('CABG', 'Coronary Artery Bypass Graft', 10::numeric, 3::numeric, 3::numeric, 13::numeric),
    ('MEDICAL_MGMT_ACS', 'Medical Management - Acute Coronary Syndrome', 5::numeric, 2::numeric, 2::numeric, 7::numeric)
) AS v(procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
WHERE rs.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1'
ON CONFLICT ON CONSTRAINT uq_insurer_los_set_procedure DO UPDATE SET
    procedure_name                = EXCLUDED.procedure_name,
    expected_los_days             = EXCLUDED.expected_los_days,
    expected_icu_days             = EXCLUDED.expected_icu_days,
    tolerance_days                = EXCLUDED.tolerance_days,
    justification_required_beyond = EXCLUDED.justification_required_beyond;

INSERT INTO hospital.insurer_los_benchmarks
    (rule_set_id, procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('THR', 'Total Hip Replacement (PMJAY package)', 8::numeric, 0::numeric, 2::numeric, 10::numeric),
    ('TOTAL_HIP_REPLACEMENT', 'Total Hip Replacement', 8::numeric, 0::numeric, 2::numeric, 10::numeric)
) AS v(procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
WHERE rs.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1'
ON CONFLICT ON CONSTRAINT uq_insurer_los_set_procedure DO UPDATE SET
    procedure_name                = EXCLUDED.procedure_name,
    expected_los_days             = EXCLUDED.expected_los_days,
    expected_icu_days             = EXCLUDED.expected_icu_days,
    tolerance_days                = EXCLUDED.tolerance_days,
    justification_required_beyond = EXCLUDED.justification_required_beyond;

INSERT INTO hospital.insurer_los_benchmarks
    (rule_set_id, procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
SELECT rs.id, v.* FROM hospital.insurer_rule_sets rs
CROSS JOIN (VALUES
    ('TOTAL_HIP_REPLACEMENT', 'Total Hip Replacement', 8::numeric, 0::numeric, 2::numeric, 10::numeric),
    ('TOTAL_KNEE_REPLACEMENT', 'Total Knee Replacement', 7::numeric, 0::numeric, 2::numeric, 9::numeric)
) AS v(procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
WHERE rs.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1'
ON CONFLICT ON CONSTRAINT uq_insurer_los_set_procedure DO UPDATE SET
    procedure_name                = EXCLUDED.procedure_name,
    expected_los_days             = EXCLUDED.expected_los_days,
    expected_icu_days             = EXCLUDED.expected_icu_days,
    tolerance_days                = EXCLUDED.tolerance_days,
    justification_required_beyond = EXCLUDED.justification_required_beyond;

