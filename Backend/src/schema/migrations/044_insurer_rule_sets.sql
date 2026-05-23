-- Migration 044: Insurer Rule Sets (Wave 8 — Rules Engine v2)
-- Date: 2026-05-18
--
-- The Rules Engine v2 evaluates a configurable, insurer-scoped rule set
-- against a harmonised medical episode (Wave 7's hospital.claim_harmonised_episodes).
-- Unlike Wave 3A's stage_requirements (doc-category gating), v2 rules use
-- JSONPath / calculation / lookup / custom-function logic to validate clinical
-- content against insurer rule books (see canonical-medical-documents-main/insuranceRulesEx.json).
--
-- Design notes:
--
--   * A "rule set" is the unit of versioning + distribution. It targets an
--     (insurer_code x treatment x specialty) tuple. The engine resolves the
--     most-specific applicable rule set per claim at evaluation time.
--   * Each rule belongs to exactly one rule set (FK CASCADE). Cross-set rule
--     reuse is intentionally NOT supported — keeps versioning clean.
--   * `validation_logic` is JSONB carrying { logic_type, json_path?,
--     operator?, expected_value?, calculation_formula?, custom_function?,
--     lookup_table_ref? }. The engine reads this and dispatches.
--   * Companion tables (document_requirements / financial_limits / los_benchmarks)
--     materialise the auxiliary sections of insuranceRulesEx.json. They are
--     queried by custom functions (e.g. validate_room_eligibility,
--     validate_los_against_benchmark) — NOT directly by the engine loop.
--   * claim_rule_evaluations stores one row per (claim_id, rule_set_id,
--     rule_id) — UPSERT keyed there. Re-evaluation overwrites prior result.
--   * rule_overrides is the operator escape hatch: mark_passed / mark_skipped /
--     accept_deduction with reason + actor. The engine honors overrides in
--     read-paths (latest evaluations are LEFT JOINed against overrides).
--   * No FK from insurer_code -> master_options (composite key over there);
--     curated as convention, matching the Wave 3A pattern.
--   * v1 (stage_requirements) runs alongside v2 — do NOT touch it.

BEGIN;

-- ============================================================================
-- A. hospital.insurer_rule_sets
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.insurer_rule_sets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id             VARCHAR(128) UNIQUE NOT NULL,
  rule_set_name           VARCHAR(255) NOT NULL,
  version                 VARCHAR(32)  NOT NULL DEFAULT '1.0',
  effective_from          DATE,
  effective_till          DATE,
  insurer_code            VARCHAR(64),
  applicable_treatments   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  applicable_specialties  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status                  VARCHAR(32)  NOT NULL DEFAULT 'live',
  created_by              UUID,
  created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_irs_status CHECK (status IN ('draft', 'live', 'deprecated'))
);

CREATE INDEX IF NOT EXISTS idx_irs_insurer_code
  ON hospital.insurer_rule_sets (insurer_code);
CREATE INDEX IF NOT EXISTS idx_irs_status
  ON hospital.insurer_rule_sets (status);

COMMENT ON TABLE hospital.insurer_rule_sets IS
  'Wave 8 Rules Engine v2 — top-level rule set (insurer x treatment x specialty). Resolved per-claim by RulesEngineV2.evaluate().';

-- ============================================================================
-- B. hospital.insurance_rules
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.insurance_rules (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id                   UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  rule_id                       VARCHAR(64) NOT NULL,
  rule_name                     VARCHAR(255) NOT NULL,
  rule_description              TEXT,
  category                      VARCHAR(64) NOT NULL,
  severity                      VARCHAR(16) NOT NULL,
  impact                        VARCHAR(32) NOT NULL,
  enabled                       BOOLEAN NOT NULL DEFAULT true,
  mandatory                     BOOLEAN NOT NULL DEFAULT false,
  validation_logic              JSONB NOT NULL,
  failure_message               TEXT,
  remediation_guidance          TEXT,
  required_documents            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  estimated_deduction_amount    NUMERIC(12,2),
  query_template                TEXT,
  order_index                   INT NOT NULL DEFAULT 999,
  created_at                    TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_insurance_rules_set_rule UNIQUE (rule_set_id, rule_id),
  CONSTRAINT chk_ir_category CHECK (category IN (
    'POLICY_ELIGIBILITY', 'DOCUMENT_COMPLETENESS', 'CLINICAL_APPROPRIATENESS',
    'FINANCIAL_LIMITS', 'PROCEDURAL_COMPLIANCE', 'TEMPORAL_VALIDITY'
  )),
  CONSTRAINT chk_ir_severity CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')),
  CONSTRAINT chk_ir_impact   CHECK (impact   IN ('CLAIM_REJECTION', 'DEDUCTION', 'QUERY', 'WARNING', 'INFO'))
);

CREATE INDEX IF NOT EXISTS idx_ir_set ON hospital.insurance_rules (rule_set_id);
CREATE INDEX IF NOT EXISTS idx_ir_enabled ON hospital.insurance_rules (rule_set_id, enabled) WHERE enabled = true;

COMMENT ON TABLE hospital.insurance_rules IS
  'Wave 8 — individual validation rules within a rule set. validation_logic is { logic_type, json_path?, operator?, expected_value?, calculation_formula?, custom_function?, lookup_table_ref? }.';

-- ============================================================================
-- C. hospital.insurer_document_requirements
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.insurer_document_requirements (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id           UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  document_type         VARCHAR(64) NOT NULL,
  required_when         TEXT,
  mandatory             BOOLEAN NOT NULL DEFAULT true,
  stage                 VARCHAR(32),
  quality_requirements  JSONB,

  CONSTRAINT chk_idr_stage CHECK (stage IS NULL OR stage IN ('PRE_AUTH', 'ENHANCEMENT', 'FINAL_CLAIM', 'QUERY_RESPONSE'))
);

CREATE INDEX IF NOT EXISTS idx_idr_set ON hospital.insurer_document_requirements (rule_set_id);

COMMENT ON TABLE hospital.insurer_document_requirements IS
  'Wave 8 — per rule set, the catalogue of document types expected at each submission stage.';

-- ============================================================================
-- D. hospital.insurer_financial_limits
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.insurer_financial_limits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id  UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  limit_kind   VARCHAR(64) NOT NULL,
  config       JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ifl_set ON hospital.insurer_financial_limits (rule_set_id);

COMMENT ON TABLE hospital.insurer_financial_limits IS
  'Wave 8 — per rule set, financial caps (room_rent / icu_charges / implant_caps / etc). Shape varies; config is JSONB.';

-- ============================================================================
-- E. hospital.insurer_los_benchmarks
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.insurer_los_benchmarks (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id                     UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  procedure_code                  VARCHAR(128),
  procedure_name                  VARCHAR(255),
  expected_los_days               NUMERIC,
  expected_icu_days               NUMERIC,
  tolerance_days                  NUMERIC,
  justification_required_beyond   NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_ilb_set ON hospital.insurer_los_benchmarks (rule_set_id);
CREATE INDEX IF NOT EXISTS idx_ilb_proc ON hospital.insurer_los_benchmarks (rule_set_id, procedure_code);

COMMENT ON TABLE hospital.insurer_los_benchmarks IS
  'Wave 8 — per rule set, expected LOS / ICU days per procedure. Looked up by validate_los_against_benchmark.';

-- ============================================================================
-- F. hospital.claim_rule_evaluations  (per-claim, per-rule outcome ledger)
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.claim_rule_evaluations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id            UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  rule_set_id         UUID NOT NULL,
  rule_id             VARCHAR(64) NOT NULL,
  status              VARCHAR(16) NOT NULL,
  severity            VARCHAR(16) NOT NULL,
  impact              VARCHAR(32) NOT NULL,
  evidence            JSONB,
  message             TEXT,
  deduction_estimate  NUMERIC(12,2),
  evaluated_at        TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_cre_claim_set_rule UNIQUE (claim_id, rule_set_id, rule_id),
  CONSTRAINT chk_cre_status CHECK (status IN ('PASS', 'FAIL', 'SKIP', 'ERROR'))
);

CREATE INDEX IF NOT EXISTS idx_cre_claim ON hospital.claim_rule_evaluations (claim_id);
CREATE INDEX IF NOT EXISTS idx_cre_claim_status ON hospital.claim_rule_evaluations (claim_id, status);
CREATE INDEX IF NOT EXISTS idx_cre_rule_set ON hospital.claim_rule_evaluations (rule_set_id);

COMMENT ON TABLE hospital.claim_rule_evaluations IS
  'Wave 8 — most-recent per-rule outcome for a claim. UPSERT keyed on (claim_id, rule_set_id, rule_id).';

-- ============================================================================
-- G. hospital.rule_overrides
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.rule_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  rule_set_id     UUID NOT NULL,
  rule_id         VARCHAR(64) NOT NULL,
  action          VARCHAR(32) NOT NULL,
  reason          TEXT NOT NULL,
  overridden_by   UUID NOT NULL,
  overridden_at   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_ro_action CHECK (action IN ('mark_passed', 'mark_skipped', 'accept_deduction'))
);

CREATE INDEX IF NOT EXISTS idx_ro_claim ON hospital.rule_overrides (claim_id);
CREATE INDEX IF NOT EXISTS idx_ro_claim_rule ON hospital.rule_overrides (claim_id, rule_set_id, rule_id);

COMMENT ON TABLE hospital.rule_overrides IS
  'Wave 8 — operator escape hatch. Latest override per (claim, rule_set, rule) wins.';

-- ============================================================================
-- H. Seed: ICICI_LOMBARD_CARDIAC_V1
-- ============================================================================

INSERT INTO hospital.insurer_rule_sets (
  rule_set_id, rule_set_name, version, effective_from,
  insurer_code, applicable_treatments, applicable_specialties, status
) VALUES (
  'ICICI_LOMBARD_CARDIAC_V1',
  'ICICI Lombard - Cardiac Treatment Rules',
  '1.0', '2026-01-01',
  'ICICI_LOMBARD',
  ARRAY['MEDICAL_MANAGEMENT', 'SURGICAL'],
  ARRAY['CARDIOLOGY', 'CARDIOTHORACIC_SURGERY'],
  'live'
) ON CONFLICT (rule_set_id) DO NOTHING;

-- Rules
INSERT INTO hospital.insurance_rules (
  rule_set_id, rule_id, rule_name, rule_description, category, severity, impact,
  mandatory, validation_logic, failure_message, remediation_guidance,
  required_documents, estimated_deduction_amount, query_template, order_index
)
SELECT s.id, v.rule_id, v.rule_name, v.rule_description, v.category, v.severity, v.impact,
       v.mandatory, v.validation_logic::jsonb, v.failure_message, v.remediation_guidance,
       v.required_documents, v.estimated_deduction_amount, v.query_template, v.order_index
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('CARDIAC_001', 'ECG Required for Cardiac Admission',
   'All cardiac admissions must have ECG report within 24 hours of admission',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.clinical_timeline[?(@.phase_code==\"EMERGENCY_PRESENTATION\" || @.phase_code==\"ADMISSION\")].diagnostics_performed[?(@.diagnostic_meta.category==\"CARDIAC\" && @.diagnostic_meta.test_name_normalized==\"ELECTROCARDIOGRAM_12_LEAD\")]","operator":"EXISTS"}',
   'ECG report not found for cardiac admission',
   'Please upload ECG report taken within 24 hours of admission',
   ARRAY['ECG_REPORT']::TEXT[], NULL::NUMERIC,
   'ECG report is mandatory for cardiac admission. Please provide ECG report taken at the time of admission.', 10),
  ('CARDIAC_002', 'Cardiac Enzymes for ACS Diagnosis',
   'Acute Coronary Syndrome diagnosis must be supported by elevated cardiac enzymes (Troponin/CKMB)',
   'CLINICAL_APPROPRIATENESS', 'HIGH', 'QUERY', true,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_cardiac_enzymes_for_acs"}',
   'ACS diagnosis not supported by cardiac enzyme elevation',
   'Provide cardiac enzyme (Troponin/CKMB) reports showing elevation, or revise diagnosis',
   ARRAY['PATHOLOGY_REPORTS']::TEXT[], NULL::NUMERIC, NULL, 20),
  ('CARDIAC_003', 'ICU Stay Justification for Medical Management',
   'ICU stay >3 days for medical management requires clinical justification',
   'CLINICAL_APPROPRIATENESS', 'MEDIUM', 'QUERY', false,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_icu_stay_cardiac_medical_mgmt"}',
   'ICU stay exceeds 3 days without adequate justification',
   'Provide daily progress notes explaining clinical necessity for prolonged ICU stay',
   ARRAY['ICU_CHARTS','DAILY_PROGRESS_NOTES']::TEXT[], 5000::NUMERIC, NULL, 30),
  ('CARDIAC_004', 'Room Rent Eligibility Check',
   'Verify room category matches policy eligibility',
   'FINANCIAL_LIMITS', 'HIGH', 'DEDUCTION', true,
   '{"logic_type":"CUSTOM","custom_function":"validate_room_eligibility"}',
   'Room category exceeds policy eligibility',
   'Room rent will be capped as per policy limits with proportionate deduction',
   ARRAY[]::TEXT[], NULL::NUMERIC, NULL, 40),
  ('CARDIAC_005', 'Pre-existing Disease Declaration',
   'Check if cardiac condition existed before policy inception',
   'POLICY_ELIGIBILITY', 'CRITICAL', 'CLAIM_REJECTION', true,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_pre_existing_condition"}',
   'Cardiac condition appears to be pre-existing and not declared',
   'Provide evidence that condition was not present at policy inception or wait for waiting period completion',
   ARRAY[]::TEXT[], NULL::NUMERIC, NULL, 50)
) AS v(rule_id, rule_name, rule_description, category, severity, impact, mandatory,
        validation_logic, failure_message, remediation_guidance, required_documents,
        estimated_deduction_amount, query_template, order_index)
WHERE s.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1'
ON CONFLICT (rule_set_id, rule_id) DO NOTHING;

-- Document requirements
INSERT INTO hospital.insurer_document_requirements (rule_set_id, document_type, required_when, mandatory, stage, quality_requirements)
SELECT s.id, v.dt, v.rw, v.mn, v.st, v.qr::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('ADMISSION_FORM',    NULL,                                                       true,  'PRE_AUTH',    '{"must_be_signed":true,"must_be_stamped":true,"must_be_dated":true}'),
  ('ECG_REPORT',        'diagnosis.primary_diagnosis.icd_code LIKE ''I2%''',         true,  'PRE_AUTH',    NULL),
  ('PATHOLOGY_REPORTS', 'diagnosis.primary_diagnosis.diagnosis_name CONTAINS ACS',   true,  'FINAL_CLAIM', NULL),
  ('ECHO_REPORT',       'procedures contain ECHO',                                   false, 'FINAL_CLAIM', NULL),
  ('DISCHARGE_SUMMARY', NULL,                                                       true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_stamped":true,"must_be_dated":true}'),
  ('FINAL_BILL',        NULL,                                                       true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_stamped":true}')
) AS v(dt, rw, mn, st, qr)
WHERE s.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1';

-- Financial limits
INSERT INTO hospital.insurer_financial_limits (rule_set_id, limit_kind, config)
SELECT s.id, v.k, v.c::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('room_rent',         '{"limit_type":"PERCENTAGE_OF_SI","percentage":2,"proportionate_deduction":true}'),
  ('icu_charges',       '{"limit_per_day":10000,"max_days_covered":7}'),
  ('consumables_limit', '{"limit_type":"PERCENTAGE_OF_BILL","percentage":15}')
) AS v(k, c)
WHERE s.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1';

-- LOS benchmarks
INSERT INTO hospital.insurer_los_benchmarks (rule_set_id, procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
SELECT s.id, v.pc, v.pn, v.elos, v.eicu, v.tol, v.jrb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('MEDICAL_MGMT_ACS', 'Medical Management - Acute Coronary Syndrome', 5::NUMERIC, 2::NUMERIC, 2::NUMERIC, 7::NUMERIC),
  ('CABG',             'Coronary Artery Bypass Graft',                 10::NUMERIC, 3::NUMERIC, 3::NUMERIC, 13::NUMERIC)
) AS v(pc, pn, elos, eicu, tol, jrb)
WHERE s.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1';

-- ============================================================================
-- I. Seed: STAR_HEALTH_ORTHOPEDIC_V1
-- ============================================================================

INSERT INTO hospital.insurer_rule_sets (
  rule_set_id, rule_set_name, version, effective_from,
  insurer_code, applicable_treatments, applicable_specialties, status
) VALUES (
  'STAR_HEALTH_ORTHOPEDIC_V1',
  'Star Health - Orthopedic Surgery Rules',
  '1.0', '2026-01-01',
  'STAR_HEALTH',
  ARRAY['SURGICAL'],
  ARRAY['ORTHOPEDICS'],
  'live'
) ON CONFLICT (rule_set_id) DO NOTHING;

INSERT INTO hospital.insurance_rules (
  rule_set_id, rule_id, rule_name, rule_description, category, severity, impact,
  mandatory, validation_logic, failure_message, remediation_guidance,
  required_documents, estimated_deduction_amount, query_template, order_index
)
SELECT s.id, v.rule_id, v.rule_name, v.rule_description, v.category, v.severity, v.impact,
       v.mandatory, v.validation_logic::jsonb, v.failure_message, v.remediation_guidance,
       v.required_documents, v.estimated_deduction_amount, v.query_template, v.order_index
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('ORTHO_001', 'X-Ray Mandatory for Joint Surgery',
   'Pre-operative X-ray is mandatory for all joint surgeries',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.clinical_timeline[?(@.phase_code==\"PRE_OPERATIVE\")].diagnostics_performed[?(@.diagnostic_meta.category==\"RADIOLOGY\")]","operator":"EXISTS"}',
   'Pre-operative X-ray not found for joint surgery', NULL,
   ARRAY['XRAY_IMAGES']::TEXT[], NULL::NUMERIC, NULL, 10),
  ('ORTHO_002', 'Implant Sticker Mandatory',
   'Implant sticker with batch number and serial number is mandatory for all implant surgeries',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'DEDUCTION', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.images[?(@.image_type==\"IMPLANT_STICKER\")]","operator":"EXISTS"}',
   'Implant sticker not uploaded',
   'Please upload clear photo of implant sticker showing batch number, serial number, and manufacturer details',
   ARRAY['IMPLANT_STICKER']::TEXT[], NULL::NUMERIC, NULL, 20),
  ('ORTHO_003', 'Implant Bill Original Required',
   'Original implant bill from manufacturer/authorized dealer required',
   'DOCUMENT_COMPLETENESS', 'HIGH', 'DEDUCTION', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.bills[?(@.bill_type==\"IMPLANT_BILL\")]","operator":"EXISTS"}',
   'Original implant bill not provided', NULL,
   ARRAY['IMPLANT_INVOICE']::TEXT[], 50000::NUMERIC, NULL, 30),
  ('ORTHO_004', 'Post-Operative X-Ray Required',
   'Post-operative X-ray mandatory to confirm implant position',
   'DOCUMENT_COMPLETENESS', 'HIGH', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.clinical_timeline[?(@.phase_code==\"POST_OPERATIVE\")].diagnostics_performed[?(@.diagnostic_meta.category==\"RADIOLOGY\")]","operator":"EXISTS"}',
   'Post-operative X-ray not found', NULL,
   ARRAY[]::TEXT[], NULL::NUMERIC, NULL, 40),
  ('ORTHO_005', 'Implant Cost Cap',
   'Implant cost capped at Rs. 1,50,000 for knee/hip replacement',
   'FINANCIAL_LIMITS', 'MEDIUM', 'DEDUCTION', false,
   '{"logic_type":"SIMPLE_COMPARISON","json_path":"$.financial_summary.breakdown.implant_charges.total_implant_cost","operator":"LESS_THAN_OR_EQUAL","expected_value":150000}',
   'Implant cost exceeds policy cap of Rs. 1,50,000',
   'Implant cost will be capped at Rs. 1,50,000 as per policy terms',
   ARRAY[]::TEXT[], NULL::NUMERIC, NULL, 50),
  ('ORTHO_006', 'Physiotherapy Coverage',
   'Post-operative physiotherapy covered only if medically documented',
   'CLINICAL_APPROPRIATENESS', 'LOW', 'DEDUCTION', false,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_physiotherapy_prescription"}',
   'Physiotherapy charges require doctor''s prescription and progress notes', NULL,
   ARRAY[]::TEXT[], NULL::NUMERIC, NULL, 60)
) AS v(rule_id, rule_name, rule_description, category, severity, impact, mandatory,
        validation_logic, failure_message, remediation_guidance, required_documents,
        estimated_deduction_amount, query_template, order_index)
WHERE s.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1'
ON CONFLICT (rule_set_id, rule_id) DO NOTHING;

INSERT INTO hospital.insurer_document_requirements (rule_set_id, document_type, required_when, mandatory, stage, quality_requirements)
SELECT s.id, v.dt, v.rw, v.mn, v.st, v.qr::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('XRAY_IMAGES',     NULL,                                       true,  'PRE_AUTH',    NULL),
  ('OT_NOTES',        NULL,                                       true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_dated":true}'),
  ('ANESTHESIA_NOTES',NULL,                                       true,  'FINAL_CLAIM', NULL),
  ('IMPLANT_STICKER', 'procedures_performed contains implant',    true,  'FINAL_CLAIM', NULL),
  ('IMPLANT_INVOICE', 'procedures_performed contains implant',    true,  'FINAL_CLAIM', NULL),
  ('CLINICAL_PHOTOS', 'wound complications exist',                false, 'FINAL_CLAIM', NULL)
) AS v(dt, rw, mn, st, qr)
WHERE s.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1';

INSERT INTO hospital.insurer_financial_limits (rule_set_id, limit_kind, config)
SELECT s.id, v.k, v.c::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('room_rent',         '{"limit_type":"FIXED_AMOUNT","limit_amount":5000,"proportionate_deduction":true}'),
  ('implant_caps',      '[{"implant_type":"KNEE_REPLACEMENT","max_amount":150000,"requires_preauth":true},{"implant_type":"HIP_REPLACEMENT","max_amount":150000,"requires_preauth":true},{"implant_type":"SPINAL_IMPLANT","max_amount":100000,"requires_preauth":true}]'),
  ('consumables_limit', '{"limit_type":"PERCENTAGE_OF_BILL","percentage":20}')
) AS v(k, c)
WHERE s.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1';

INSERT INTO hospital.insurer_los_benchmarks (rule_set_id, procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
SELECT s.id, v.pc, v.pn, v.elos, v.eicu, v.tol, v.jrb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('TOTAL_KNEE_REPLACEMENT', 'Total Knee Replacement', 7::NUMERIC, 0::NUMERIC, 2::NUMERIC, 9::NUMERIC),
  ('TOTAL_HIP_REPLACEMENT',  'Total Hip Replacement',  8::NUMERIC, 0::NUMERIC, 2::NUMERIC, 10::NUMERIC)
) AS v(pc, pn, elos, eicu, tol, jrb)
WHERE s.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1';

-- ============================================================================
-- J. Seed: SADBHAWANA_PMJAY_THR_V1 (distilled from KhatoonTHR.json)
-- ============================================================================

INSERT INTO hospital.insurer_rule_sets (
  rule_set_id, rule_set_name, version, effective_from,
  insurer_code, applicable_treatments, applicable_specialties, status
) VALUES (
  'SADBHAWANA_PMJAY_THR_V1',
  'Sadbhawana / PMJAY - Total Hip Replacement Rules',
  '1.0', '2026-01-01',
  'PMJAY',
  ARRAY['SURGICAL'],
  ARRAY['ORTHOPEDICS'],
  'live'
) ON CONFLICT (rule_set_id) DO NOTHING;

INSERT INTO hospital.insurance_rules (
  rule_set_id, rule_id, rule_name, rule_description, category, severity, impact,
  mandatory, validation_logic, failure_message, remediation_guidance,
  required_documents, estimated_deduction_amount, query_template, order_index
)
SELECT s.id, v.rule_id, v.rule_name, v.rule_description, v.category, v.severity, v.impact,
       v.mandatory, v.validation_logic::jsonb, v.failure_message, v.remediation_guidance,
       v.required_documents, v.estimated_deduction_amount, v.query_template, v.order_index
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('PMJAY_THR_001', 'Pre-operative X-ray Required',
   'Hip X-ray taken before THR is mandatory for PMJAY claims',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.clinical_timeline[*].diagnostics_performed[?(@.diagnostic_meta.category==\"RADIOLOGY\")]","operator":"EXISTS"}',
   'Pre-operative hip X-ray not found',
   'Upload pre-op X-ray of the hip joint clearly showing pathology',
   ARRAY['XRAY_IMAGES']::TEXT[], NULL::NUMERIC,
   'Pre-op X-ray is required to validate THR procedure. Please share dated film.', 10),
  ('PMJAY_THR_002', 'Implant Sticker Mandatory',
   'Implant sticker with batch / lot / serial must be present',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'DEDUCTION', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.images[?(@.image_type==\"IMPLANT_STICKER\")]","operator":"EXISTS"}',
   'Implant sticker missing',
   'Upload clear image of implant sticker. Full implant cost otherwise deducted.',
   ARRAY['IMPLANT_STICKER']::TEXT[], NULL::NUMERIC, NULL, 20),
  ('PMJAY_THR_003', 'Implant Invoice Mandatory',
   'Original implant invoice from authorised dealer required',
   'DOCUMENT_COMPLETENESS', 'HIGH', 'DEDUCTION', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.bills[?(@.bill_type==\"IMPLANT_BILL\")]","operator":"EXISTS"}',
   'Original implant invoice not provided', NULL,
   ARRAY['IMPLANT_INVOICE']::TEXT[], 30000::NUMERIC, NULL, 30),
  ('PMJAY_THR_004', 'OT Notes Signed and Dated',
   'Operative notes must be signed by surgeon and dated',
   'DOCUMENT_COMPLETENESS', 'HIGH', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.notes[?(@.note_type==\"OT_NOTES\" && @.signed==true)]","operator":"EXISTS"}',
   'OT notes not signed/dated',
   'Surgeon to sign and date OT notes, then re-upload.',
   ARRAY['OT_NOTES']::TEXT[], NULL::NUMERIC, NULL, 40),
  ('PMJAY_THR_005', 'Anesthesia Notes Required',
   'Anesthesia chart and notes required',
   'DOCUMENT_COMPLETENESS', 'MEDIUM', 'QUERY', false,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.notes[?(@.note_type==\"ANESTHESIA_NOTES\")]","operator":"EXISTS"}',
   'Anesthesia notes not found', NULL,
   ARRAY['ANESTHESIA_NOTES']::TEXT[], NULL::NUMERIC, NULL, 50),
  ('PMJAY_THR_006', 'Discharge Summary Signed',
   'Discharge summary must be signed by the treating doctor',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.notes[?(@.note_type==\"DISCHARGE_SUMMARY\" && @.signed==true)]","operator":"EXISTS"}',
   'Discharge summary missing or unsigned', NULL,
   ARRAY['DISCHARGE_SUMMARY']::TEXT[], NULL::NUMERIC, NULL, 60),
  ('PMJAY_THR_007', 'Final Bill Within Package',
   'Final billed amount must be within PMJAY package cap',
   'FINANCIAL_LIMITS', 'HIGH', 'DEDUCTION', false,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_pmjay_package_match"}',
   'Final bill exceeds PMJAY package amount', NULL,
   ARRAY['FINAL_BILL']::TEXT[], NULL::NUMERIC, NULL, 70),
  ('PMJAY_THR_008', 'LOS Within Tolerance',
   'Length of stay must be within procedure benchmark + tolerance',
   'TEMPORAL_VALIDITY', 'MEDIUM', 'QUERY', false,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_los_against_benchmark"}',
   'LOS exceeds benchmark', NULL,
   ARRAY['DAILY_PROGRESS_NOTES']::TEXT[], NULL::NUMERIC, NULL, 80)
) AS v(rule_id, rule_name, rule_description, category, severity, impact, mandatory,
        validation_logic, failure_message, remediation_guidance, required_documents,
        estimated_deduction_amount, query_template, order_index)
WHERE s.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1'
ON CONFLICT (rule_set_id, rule_id) DO NOTHING;

INSERT INTO hospital.insurer_document_requirements (rule_set_id, document_type, required_when, mandatory, stage, quality_requirements)
SELECT s.id, v.dt, v.rw, v.mn, v.st, v.qr::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('XRAY_IMAGES',       NULL, true,  'PRE_AUTH',    NULL),
  ('OT_NOTES',          NULL, true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_dated":true}'),
  ('ANESTHESIA_NOTES',  NULL, false, 'FINAL_CLAIM', NULL),
  ('IMPLANT_STICKER',   NULL, true,  'FINAL_CLAIM', NULL),
  ('IMPLANT_INVOICE',   NULL, true,  'FINAL_CLAIM', NULL),
  ('DISCHARGE_SUMMARY', NULL, true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_dated":true}'),
  ('FINAL_BILL',        NULL, true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_stamped":true}')
) AS v(dt, rw, mn, st, qr)
WHERE s.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1';

INSERT INTO hospital.insurer_financial_limits (rule_set_id, limit_kind, config)
SELECT s.id, v.k, v.c::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('package_cap',  '{"limit_type":"FIXED_AMOUNT","procedure_code":"THR","limit_amount":90000}'),
  ('implant_caps', '[{"implant_type":"HIP_REPLACEMENT","max_amount":60000,"requires_preauth":true}]')
) AS v(k, c)
WHERE s.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1';

INSERT INTO hospital.insurer_los_benchmarks (rule_set_id, procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
SELECT s.id, v.pc, v.pn, v.elos, v.eicu, v.tol, v.jrb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('THR',                   'Total Hip Replacement (PMJAY package)', 8::NUMERIC, 0::NUMERIC, 2::NUMERIC, 10::NUMERIC),
  ('TOTAL_HIP_REPLACEMENT', 'Total Hip Replacement',                 8::NUMERIC, 0::NUMERIC, 2::NUMERIC, 10::NUMERIC)
) AS v(pc, pn, elos, eicu, tol, jrb)
WHERE s.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1';

COMMIT;
