-- Migration 042: Document Taxonomy Expansion (Stage 1A — Intelligence Layer)
-- Date: 2026-05-18
--
-- Purpose
-- -------
-- The original doc_category vocabulary (migration 028, 21 codes) mirrored the
-- FE PatientPhotosModal pills. Real-world hospital claims involve a much
-- wider variety of documents — KYC, authorizations, consents, ICU charts,
-- pharmacy logs, audit metadata, and so on. Stage 1A expands the canonical
-- vocabulary to ~250 codes organised under 15 top-level groups, derived from
-- the hospital_claims_document_taxonomy reference.
--
-- Design notes
-- ------------
-- * A new master_options category 'doc_category_group' seeds the 15 group
--   codes. Every doc_category row carries its parent group via a new
--   group_code column on master_options (added idempotently below).
-- * The 21 codes seeded by migration 028 are preserved as-is. document_sections
--   rows already point at them, so deactivating would break history.
-- * Where the new taxonomy overlaps with the original codes (e.g. the new
--   'discharge_summary' overlaps with the migration-028 'discharge_slip'),
--   both codes coexist. concept_aliases handles the surface-form mapping so
--   inbound text resolves to a single canonical code per call site.
-- * 'bis_screenshot' (group_code='audit_intelligence_metadata') is included
--   explicitly per ops instruction — it isn't on the reference taxonomy but
--   is required for fraud-detection signal capture.
--
-- All steps run in a single transaction. ON CONFLICT (category, code) DO
-- UPDATE makes the migration idempotent and lets later re-runs back-fill
-- group_code on rows that pre-date this migration.

BEGIN;

-- ============================================================================
-- A. Schema change — add group_code to master_options
-- ============================================================================
-- Use a DO block + information_schema check so the migration is safe to run
-- against environments where prior migrations may have already added the
-- column (manual hotfixes etc.).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'hospital'
           AND table_name   = 'master_options'
           AND column_name  = 'group_code'
    ) THEN
        ALTER TABLE hospital.master_options
            ADD COLUMN group_code VARCHAR(64) NULL;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_master_options_group_code
    ON hospital.master_options (category, group_code);

COMMENT ON COLUMN hospital.master_options.group_code IS
    'Optional grouping key. For category=doc_category, references a code in category=doc_category_group. NULL for categories that do not need a hierarchy.';

-- ============================================================================
-- B. Seed doc_category_group — 15 top-level groups
-- ============================================================================

INSERT INTO hospital.master_options (category, code, label, sort_order, group_code)
VALUES
    ('doc_category_group', 'kyc_identity_insurance',       'KYC / Identity / Insurance',          10, NULL),
    ('doc_category_group', 'insurance_authorization',      'Insurance & Authorization',           20, NULL),
    ('doc_category_group', 'clinical_medical',             'Clinical / Medical',                  30, NULL),
    ('doc_category_group', 'diagnostic_investigation',     'Diagnostic & Investigation',          40, NULL),
    ('doc_category_group', 'surgical_procedure',           'Surgical / Procedure',                50, NULL),
    ('doc_category_group', 'billing_financial',            'Billing & Financial',                 60, NULL),
    ('doc_category_group', 'discharge_outcome',            'Discharge & Outcome',                 70, NULL),
    ('doc_category_group', 'consent_legal',                'Consent & Legal',                     80, NULL),
    ('doc_category_group', 'patient_photos_visual',        'Patient Photos & Visual Evidence',    90, NULL),
    ('doc_category_group', 'icu_critical_care',            'ICU / Critical Care',                100, NULL),
    ('doc_category_group', 'pharmacy_medication',          'Pharmacy & Medication',              110, NULL),
    ('doc_category_group', 'rehabilitation_therapy',       'Rehabilitation & Therapy',           120, NULL),
    ('doc_category_group', 'specialized_treatment',        'Specialized Treatment',              130, NULL),
    ('doc_category_group', 'administrative_operational',   'Administrative & Operational',       140, NULL),
    ('doc_category_group', 'audit_intelligence_metadata',  'Audit & Claims Intelligence Metadata', 150, NULL)
ON CONFLICT (category, code) DO UPDATE
    SET label      = EXCLUDED.label,
        sort_order = EXCLUDED.sort_order,
        is_active  = true;

-- ============================================================================
-- C. Backfill group_code on existing migration-028 doc_category rows
-- ============================================================================
-- These rows pre-date the column, so they have group_code = NULL. Set them
-- to the most sensible group based on the existing label.

UPDATE hospital.master_options SET group_code = 'discharge_outcome'        WHERE category = 'doc_category' AND code = 'discharge_slip';
UPDATE hospital.master_options SET group_code = 'diagnostic_investigation' WHERE category = 'doc_category' AND code = 'investigations';
UPDATE hospital.master_options SET group_code = 'clinical_medical'         WHERE category = 'doc_category' AND code = 'treatment';
UPDATE hospital.master_options SET group_code = 'clinical_medical'         WHERE category = 'doc_category' AND code = 'icps';
UPDATE hospital.master_options SET group_code = 'discharge_outcome'        WHERE category = 'doc_category' AND code = 'surgical_discharge_slip';
UPDATE hospital.master_options SET group_code = 'surgical_procedure'       WHERE category = 'doc_category' AND code = 'ot_notes_and_photos';
UPDATE hospital.master_options SET group_code = 'patient_photos_visual'   WHERE category = 'doc_category' AND code = 'post_op_photos';
UPDATE hospital.master_options SET group_code = 'surgical_procedure'       WHERE category = 'doc_category' AND code = 'post_op_reports';
UPDATE hospital.master_options SET group_code = 'surgical_procedure'       WHERE category = 'doc_category' AND code = 'implant_invoice';
UPDATE hospital.master_options SET group_code = 'insurance_authorization' WHERE category = 'doc_category' AND code = 'insurer_response';
UPDATE hospital.master_options SET group_code = 'administrative_operational' WHERE category = 'doc_category' AND code = 'others';
UPDATE hospital.master_options SET group_code = 'clinical_medical'         WHERE category = 'doc_category' AND code = 'admission_notes';
UPDATE hospital.master_options SET group_code = 'clinical_medical'         WHERE category = 'doc_category' AND code = 'diagnosis_summary';
UPDATE hospital.master_options SET group_code = 'billing_financial'        WHERE category = 'doc_category' AND code = 'procedure_estimate';
UPDATE hospital.master_options SET group_code = 'consent_legal'            WHERE category = 'doc_category' AND code = 'consent';
UPDATE hospital.master_options SET group_code = 'billing_financial'        WHERE category = 'doc_category' AND code = 'final_bill';
UPDATE hospital.master_options SET group_code = 'consent_legal'            WHERE category = 'doc_category' AND code = 'oncologist_consent';
UPDATE hospital.master_options SET group_code = 'kyc_identity_insurance'   WHERE category = 'doc_category' AND code = 'identity_proof';
UPDATE hospital.master_options SET group_code = 'insurance_authorization' WHERE category = 'doc_category' AND code = 'claim_form';
UPDATE hospital.master_options SET group_code = 'insurance_authorization' WHERE category = 'doc_category' AND code = 'insurer_query_letter';
UPDATE hospital.master_options SET group_code = 'insurance_authorization' WHERE category = 'doc_category' AND code = 'insurer_approval_letter';

-- ============================================================================
-- D. Insert expanded doc_category vocabulary (~200+ new codes)
-- ============================================================================
-- Sort_order is grouped by hundreds: kyc=1000s, authorization=2000s,
-- clinical=3000s, diagnostic=4000s, surgical=5000s, billing=6000s,
-- discharge=7000s, consent=8000s, photos=9000s, icu=10000s, pharmacy=11000s,
-- rehab=12000s, specialized=13000s, admin=14000s, audit=15000s.

-- ─── Group 1: KYC / Identity / Insurance ─────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'aadhaar_card',                 'Aadhaar Card',                   1010, 'kyc_identity_insurance'),
    ('doc_category', 'pan_card',                     'PAN Card',                       1020, 'kyc_identity_insurance'),
    ('doc_category', 'voter_id',                     'Voter ID',                       1030, 'kyc_identity_insurance'),
    ('doc_category', 'passport',                     'Passport',                       1040, 'kyc_identity_insurance'),
    ('doc_category', 'driving_license',              'Driving License',                1050, 'kyc_identity_insurance'),
    ('doc_category', 'policy_card',                  'Policy Card',                    1060, 'kyc_identity_insurance'),
    ('doc_category', 'insurance_e_card',             'Insurance e-Card',               1070, 'kyc_identity_insurance'),
    ('doc_category', 'employee_id_card',             'Employee ID Card',               1080, 'kyc_identity_insurance'),
    ('doc_category', 'corporate_id_card',            'Corporate ID Card',              1090, 'kyc_identity_insurance'),
    ('doc_category', 'abha_card',                    'Health ID / ABHA Card',          1100, 'kyc_identity_insurance'),
    ('doc_category', 'insurance_enrollment_form',    'Insurance Enrollment Form',      1110, 'kyc_identity_insurance'),
    ('doc_category', 'patient_registration_form',    'Patient Registration Form',      1120, 'kyc_identity_insurance'),
    ('doc_category', 'address_proof',                'Address Proof',                  1130, 'kyc_identity_insurance'),
    ('doc_category', 'age_proof',                    'Age Proof',                      1140, 'kyc_identity_insurance'),
    ('doc_category', 'relationship_proof',           'Relationship Proof',             1150, 'kyc_identity_insurance'),
    ('doc_category', 'referral_letter',              'Referral Letter',                1160, 'kyc_identity_insurance'),
    ('doc_category', 'tpa_id_card',                  'TPA ID Card',                    1170, 'kyc_identity_insurance')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 2: Insurance & Authorization ──────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'pre_authorization_form',       'Pre-Authorization Form',         2010, 'insurance_authorization'),
    ('doc_category', 'enhancement_request_form',     'Enhancement Request Form',       2020, 'insurance_authorization'),
    ('doc_category', 'pre_auth_query_response',      'Pre-Auth Query Response',        2030, 'insurance_authorization'),
    ('doc_category', 'insurance_declaration_form',   'Insurance Declaration Form',     2040, 'insurance_authorization'),
    ('doc_category', 'cashless_approval_letter',     'Cashless Approval Letter',       2050, 'insurance_authorization'),
    ('doc_category', 'initial_authorization_letter', 'Initial Authorization Letter',   2060, 'insurance_authorization'),
    ('doc_category', 'final_authorization_letter',   'Final Authorization Letter',     2070, 'insurance_authorization'),
    ('doc_category', 'discharge_approval_letter',    'Discharge Approval Letter',      2080, 'insurance_authorization'),
    ('doc_category', 'rejection_denial_letter',      'Rejection / Denial Letter',      2090, 'insurance_authorization'),
    ('doc_category', 'reimbursement_claim_form',     'Reimbursement Claim Form',       2100, 'insurance_authorization'),
    ('doc_category', 'insurance_undertaking',        'Insurance Undertaking',          2110, 'insurance_authorization'),
    ('doc_category', 'copayment_undertaking',        'Co-payment Undertaking',         2120, 'insurance_authorization'),
    ('doc_category', 'non_medical_expense_declaration', 'Non-medical Expense Declaration', 2130, 'insurance_authorization'),
    ('doc_category', 'mlc_declaration',              'MLC Declaration',                2140, 'insurance_authorization'),
    ('doc_category', 'accident_intimation_letter',   'Accident Intimation Letter',     2150, 'insurance_authorization'),
    ('doc_category', 'fir_copy',                     'FIR Copy',                       2160, 'insurance_authorization'),
    ('doc_category', 'employer_declaration',         'Employer Declaration',           2170, 'insurance_authorization'),
    ('doc_category', 'treating_doctor_declaration',  'Treating Doctor Declaration',    2180, 'insurance_authorization'),
    ('doc_category', 'package_utilization_sheet',    'Package Utilization Sheet',      2190, 'insurance_authorization')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 3: Clinical / Medical ─────────────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'opd_notes',                    'OPD Notes',                      3010, 'clinical_medical'),
    ('doc_category', 'prescription',                 'Prescription',                   3020, 'clinical_medical'),
    ('doc_category', 'clinician_notes',              'Clinician Notes',                3030, 'clinical_medical'),
    ('doc_category', 'initial_assessment_notes',     'Initial Assessment Notes',       3040, 'clinical_medical'),
    ('doc_category', 'progress_notes',               'Progress Notes',                 3050, 'clinical_medical'),
    ('doc_category', 'daily_clinical_notes',         'Daily Clinical Notes',           3060, 'clinical_medical'),
    ('doc_category', 'consultation_notes',           'Consultation Notes',             3070, 'clinical_medical'),
    ('doc_category', 'specialist_consultation_reports', 'Specialist Consultation Reports', 3080, 'clinical_medical'),
    ('doc_category', 'nursing_notes',                'Nursing Notes',                  3090, 'clinical_medical'),
    ('doc_category', 'icp_charts',                   'ICP Charts',                     3100, 'clinical_medical'),
    ('doc_category', 'nursing_charts',               'Nursing Charts',                 3110, 'clinical_medical'),
    ('doc_category', 'case_sheet',                   'Case Sheet',                     3120, 'clinical_medical'),
    ('doc_category', 'bed_head_ticket',              'Bed Head Ticket (BHT)',          3130, 'clinical_medical'),
    ('doc_category', 'history_physical_exam_notes',  'History & Physical Examination Notes', 3140, 'clinical_medical'),
    ('doc_category', 'vitals_monitoring_sheet',      'Vitals Monitoring Sheet',        3150, 'clinical_medical'),
    ('doc_category', 'medication_administration_record', 'Medication Administration Record (MAR)', 3160, 'clinical_medical'),
    ('doc_category', 'temperature_chart',            'Temperature Chart',              3170, 'clinical_medical'),
    ('doc_category', 'intake_output_chart',          'Intake / Output Chart',          3180, 'clinical_medical'),
    ('doc_category', 'pain_assessment_sheet',        'Pain Assessment Sheet',          3190, 'clinical_medical'),
    ('doc_category', 'fall_risk_assessment',         'Fall Risk Assessment',           3200, 'clinical_medical'),
    ('doc_category', 'sepsis_assessment',            'Sepsis Assessment',              3210, 'clinical_medical'),
    ('doc_category', 'glasgow_coma_scale_chart',     'Glasgow Coma Scale Chart',       3220, 'clinical_medical'),
    ('doc_category', 'nutrition_assessment',         'Nutrition Assessment',           3230, 'clinical_medical'),
    ('doc_category', 'er_notes',                     'ER Notes',                       3300, 'clinical_medical'),
    ('doc_category', 'triage_notes',                 'Triage Notes',                   3310, 'clinical_medical'),
    ('doc_category', 'emergency_assessment',         'Emergency Assessment',           3320, 'clinical_medical'),
    ('doc_category', 'ambulance_records',            'Ambulance Records',              3330, 'clinical_medical')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 4: Diagnostic & Investigation ─────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'blood_test_reports',           'Blood Test Reports',             4010, 'diagnostic_investigation'),
    ('doc_category', 'urine_test_reports',           'Urine Test Reports',             4020, 'diagnostic_investigation'),
    ('doc_category', 'culture_reports',              'Culture Reports',                4030, 'diagnostic_investigation'),
    ('doc_category', 'histopathology_reports',       'Histopathology Reports',         4040, 'diagnostic_investigation'),
    ('doc_category', 'biopsy_reports',               'Biopsy Reports',                 4050, 'diagnostic_investigation'),
    ('doc_category', 'serology_reports',             'Serology Reports',               4060, 'diagnostic_investigation'),
    ('doc_category', 'xray_reports',                 'X-Ray Reports',                  4110, 'diagnostic_investigation'),
    ('doc_category', 'ct_scan_reports',              'CT Scan Reports',                4120, 'diagnostic_investigation'),
    ('doc_category', 'mri_reports',                  'MRI Reports',                    4130, 'diagnostic_investigation'),
    ('doc_category', 'pet_scan_reports',             'PET Scan Reports',               4140, 'diagnostic_investigation'),
    ('doc_category', 'ultrasound_reports',           'Ultrasound Reports',             4150, 'diagnostic_investigation'),
    ('doc_category', 'mammography_reports',          'Mammography Reports',            4160, 'diagnostic_investigation'),
    ('doc_category', 'ecg',                          'ECG',                            4210, 'diagnostic_investigation'),
    ('doc_category', 'echo',                         'ECHO',                           4220, 'diagnostic_investigation'),
    ('doc_category', 'tmt_reports',                  'TMT Reports',                    4230, 'diagnostic_investigation'),
    ('doc_category', 'holter_monitoring_reports',    'Holter Monitoring Reports',      4240, 'diagnostic_investigation'),
    ('doc_category', 'pulmonary_function_test',      'Pulmonary Function Test',        4310, 'diagnostic_investigation'),
    ('doc_category', 'endoscopy_reports',            'Endoscopy Reports',              4320, 'diagnostic_investigation'),
    ('doc_category', 'colonoscopy_reports',          'Colonoscopy Reports',            4330, 'diagnostic_investigation'),
    ('doc_category', 'sleep_study_reports',          'Sleep Study Reports',            4340, 'diagnostic_investigation'),
    ('doc_category', 'neurodiagnostic_reports',      'Neurodiagnostic Reports',        4350, 'diagnostic_investigation'),
    ('doc_category', 'pre_surgery_diagnostics',      'Pre-Surgery Diagnostics',        4410, 'diagnostic_investigation'),
    ('doc_category', 'post_surgery_diagnostics',     'Post-Surgery Diagnostics',       4420, 'diagnostic_investigation'),
    ('doc_category', 'anaesthesia_fitness_reports',  'Anaesthesia Fitness Reports',    4430, 'diagnostic_investigation'),
    ('doc_category', 'surgical_fitness_reports',     'Surgical Fitness Reports',       4440, 'diagnostic_investigation')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 5: Surgical / Procedure ───────────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'ot_notes',                     'OT Notes',                       5010, 'surgical_procedure'),
    ('doc_category', 'procedure_notes',              'Procedure Notes',                5020, 'surgical_procedure'),
    ('doc_category', 'surgery_notes',                'Surgery Notes',                  5030, 'surgical_procedure'),
    ('doc_category', 'surgeon_notes',                'Surgeon Notes',                  5040, 'surgical_procedure'),
    ('doc_category', 'anaesthesia_notes',            'Anaesthesia Notes',              5050, 'surgical_procedure'),
    ('doc_category', 'intraoperative_monitoring_records', 'Intraoperative Monitoring Records', 5060, 'surgical_procedure'),
    ('doc_category', 'implant_barcode',              'Implant Barcode',                5070, 'surgical_procedure'),
    ('doc_category', 'implant_sticker',              'Implant Sticker',                5080, 'surgical_procedure'),
    ('doc_category', 'implant_bill',                 'Implant Bill',                   5090, 'surgical_procedure'),
    ('doc_category', 'consumable_usage_sheet',       'Consumable Usage Sheet',         5100, 'surgical_procedure'),
    ('doc_category', 'cssd_records',                 'CSSD Records',                   5110, 'surgical_procedure'),
    ('doc_category', 'blood_utilization_records',    'Blood Utilization Records',      5120, 'surgical_procedure'),
    ('doc_category', 'surgical_checklist',           'Surgical Checklist',             5130, 'surgical_procedure'),
    ('doc_category', 'who_surgical_safety_checklist', 'WHO Surgical Safety Checklist', 5140, 'surgical_procedure'),
    ('doc_category', 'icu_transfer_notes',           'ICU Transfer Notes',             5150, 'surgical_procedure')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 6: Billing & Financial ────────────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'cost_estimate',                'Cost Estimate',                  6010, 'billing_financial'),
    ('doc_category', 'revised_estimate',             'Revised Estimate',               6020, 'billing_financial'),
    ('doc_category', 'package_estimate',             'Package Estimate',               6030, 'billing_financial'),
    ('doc_category', 'interim_bill',                 'Interim Bill',                   6110, 'billing_financial'),
    ('doc_category', 'final_breakup_of_bill',        'Final Breakup of Bill',          6120, 'billing_financial'),
    ('doc_category', 'consolidated_bill',            'Consolidated Bill',              6130, 'billing_financial'),
    ('doc_category', 'pharmacy_bill',                'Pharmacy Bill',                  6140, 'billing_financial'),
    ('doc_category', 'consumables_bill',             'Consumables Bill',               6150, 'billing_financial'),
    ('doc_category', 'diagnostics_bill',             'Diagnostics Bill',               6160, 'billing_financial'),
    ('doc_category', 'procedure_charges',            'Procedure Charges',              6170, 'billing_financial'),
    ('doc_category', 'room_rent_summary',            'Room Rent Summary',              6180, 'billing_financial'),
    ('doc_category', 'icu_charges_summary',          'ICU Charges Summary',            6190, 'billing_financial'),
    ('doc_category', 'payment_receipts',             'Payment Receipts',               6210, 'billing_financial'),
    ('doc_category', 'advance_receipts',             'Advance Receipts',               6220, 'billing_financial'),
    ('doc_category', 'refund_receipts',              'Refund Receipts',                6230, 'billing_financial'),
    ('doc_category', 'payment_settlement_summary',   'Payment Settlement Summary',     6240, 'billing_financial'),
    ('doc_category', 'upi_card_transaction_slips',   'UPI / Card Transaction Slips',   6250, 'billing_financial'),
    ('doc_category', 'credit_notes',                 'Credit Notes',                   6310, 'billing_financial'),
    ('doc_category', 'debit_notes',                  'Debit Notes',                    6320, 'billing_financial'),
    ('doc_category', 'tpa_settlement_sheet',         'TPA Settlement Sheet',           6330, 'billing_financial'),
    ('doc_category', 'insurance_deduction_sheet',    'Insurance Deduction Sheet',      6340, 'billing_financial'),
    ('doc_category', 'non_payable_item_list',        'Non-payable Item List',          6350, 'billing_financial')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 7: Discharge & Outcome ────────────────────────────────────────
-- NOTE: 'discharge_summary' coexists with the migration-028 'discharge_slip'.
-- Aliases below normalise common surface-forms to 'discharge_summary'.
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'discharge_summary',            'Discharge Summary',              7010, 'discharge_outcome'),
    ('doc_category', 'discharge_medication',         'Discharge Medication',           7020, 'discharge_outcome'),
    ('doc_category', 'follow_up_advice',             'Follow-up Advice',               7030, 'discharge_outcome'),
    ('doc_category', 'follow_up_prescription',       'Follow-up Prescription',         7040, 'discharge_outcome'),
    ('doc_category', 'fitness_certificate',          'Fitness Certificate',            7050, 'discharge_outcome'),
    ('doc_category', 'return_to_work_certificate',   'Return-to-Work Certificate',     7060, 'discharge_outcome'),
    ('doc_category', 'death_summary',                'Death Summary',                  7070, 'discharge_outcome'),
    ('doc_category', 'death_certificate',            'Death Certificate',              7080, 'discharge_outcome'),
    ('doc_category', 'referral_at_discharge',        'Referral at Discharge',          7090, 'discharge_outcome'),
    ('doc_category', 'transfer_summary',             'Transfer Summary',               7100, 'discharge_outcome'),
    ('doc_category', 'lama_dama_forms',              'LAMA / DAMA Forms',              7110, 'discharge_outcome'),
    ('doc_category', 'home_care_instructions',       'Home Care Instructions',         7120, 'discharge_outcome')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 8: Consent & Legal ────────────────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'general_consent_form',         'General Consent Form',           8010, 'consent_legal'),
    ('doc_category', 'procedure_consent_form',       'Procedure Consent Form',         8020, 'consent_legal'),
    ('doc_category', 'surgery_consent_form',         'Surgery Consent Form',           8030, 'consent_legal'),
    ('doc_category', 'high_risk_consent',            'High-Risk Consent',              8040, 'consent_legal'),
    ('doc_category', 'blood_transfusion_consent',    'Blood Transfusion Consent',      8050, 'consent_legal'),
    ('doc_category', 'icu_consent',                  'ICU Consent',                    8060, 'consent_legal'),
    ('doc_category', 'ventilator_consent',           'Ventilator Consent',             8070, 'consent_legal'),
    ('doc_category', 'anaesthesia_consent',          'Anaesthesia Consent',            8080, 'consent_legal'),
    ('doc_category', 'organ_donation_consent',       'Organ Donation Consent',         8090, 'consent_legal'),
    ('doc_category', 'telemedicine_consent',         'Telemedicine Consent',           8100, 'consent_legal'),
    ('doc_category', 'data_privacy_consent',         'Data Privacy Consent',           8110, 'consent_legal'),
    ('doc_category', 'financial_consent',            'Financial Consent',              8120, 'consent_legal'),
    ('doc_category', 'photography_consent',          'Photography Consent',            8130, 'consent_legal'),
    ('doc_category', 'mlc_documents',                'MLC Documents',                  8140, 'consent_legal'),
    ('doc_category', 'police_intimation',            'Police Intimation',              8150, 'consent_legal')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 9: Patient Photos & Visual Evidence ───────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'general_patient_photo',        'General Patient Photo',          9010, 'patient_photos_visual'),
    ('doc_category', 'gps_tagged_patient_photos',    'GPS Tagged Patient Photos',      9020, 'patient_photos_visual'),
    ('doc_category', 'admission_photo',              'Admission Photo',                9030, 'patient_photos_visual'),
    ('doc_category', 'discharge_photo',              'Discharge Photo',                9040, 'patient_photos_visual'),
    ('doc_category', 'ot_photos_doctor_patient',     'OT Photos with Treating Doctor and Patient', 9110, 'patient_photos_visual'),
    ('doc_category', 'scar_photos',                  'Scar Photos',                    9120, 'patient_photos_visual'),
    ('doc_category', 'wound_photos',                 'Wound Photos',                   9130, 'patient_photos_visual'),
    ('doc_category', 'procedure_site_photos',        'Procedure Site Photos',          9140, 'patient_photos_visual'),
    ('doc_category', 'bedside_photos',               'Bedside Photos',                 9150, 'patient_photos_visual'),
    ('doc_category', 'implant_photos',               'Implant Photos',                 9210, 'patient_photos_visual'),
    ('doc_category', 'device_serial_number_photos',  'Device Serial Number Photos',    9220, 'patient_photos_visual')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 10: ICU / Critical Care ───────────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'ventilator_charts',            'Ventilator Charts',             10010, 'icu_critical_care'),
    ('doc_category', 'icu_flow_sheets',              'ICU Flow Sheets',               10020, 'icu_critical_care'),
    ('doc_category', 'abg_reports',                  'ABG Reports',                   10030, 'icu_critical_care'),
    ('doc_category', 'sedation_monitoring',          'Sedation Monitoring',           10040, 'icu_critical_care'),
    ('doc_category', 'vasopressor_monitoring',       'Vasopressor Monitoring',        10050, 'icu_critical_care'),
    ('doc_category', 'critical_care_notes',          'Critical Care Notes',           10060, 'icu_critical_care'),
    ('doc_category', 'central_line_monitoring',      'Central Line Monitoring',       10070, 'icu_critical_care'),
    ('doc_category', 'dialysis_records',             'Dialysis Records',              10080, 'icu_critical_care')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 11: Pharmacy & Medication ─────────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'medication_charts',            'Medication Charts',             11010, 'pharmacy_medication'),
    ('doc_category', 'pharmacy_issue_slips',         'Pharmacy Issue Slips',          11020, 'pharmacy_medication'),
    ('doc_category', 'drug_administration_logs',     'Drug Administration Logs',      11030, 'pharmacy_medication'),
    ('doc_category', 'narcotics_register',           'Narcotics Register',            11040, 'pharmacy_medication'),
    ('doc_category', 'high_risk_medication_monitoring', 'High-risk Medication Monitoring', 11050, 'pharmacy_medication'),
    ('doc_category', 'vaccination_records',          'Vaccination Records',           11060, 'pharmacy_medication')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 12: Rehabilitation & Therapy ──────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'physiotherapy_notes',          'Physiotherapy Notes',           12010, 'rehabilitation_therapy'),
    ('doc_category', 'occupational_therapy_notes',   'Occupational Therapy Notes',    12020, 'rehabilitation_therapy'),
    ('doc_category', 'speech_therapy_notes',         'Speech Therapy Notes',          12030, 'rehabilitation_therapy'),
    ('doc_category', 'rehabilitation_progress_notes', 'Rehabilitation Progress Notes', 12040, 'rehabilitation_therapy'),
    ('doc_category', 'mobility_assessment',          'Mobility Assessment',           12050, 'rehabilitation_therapy')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 13: Specialized Treatment ─────────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'chemotherapy_protocol',        'Chemotherapy Protocol',         13010, 'specialized_treatment'),
    ('doc_category', 'radiation_therapy_summary',    'Radiation Therapy Summary',     13020, 'specialized_treatment'),
    ('doc_category', 'dialysis_flow_sheet',          'Dialysis Flow Sheet',           13110, 'specialized_treatment'),
    ('doc_category', 'nephrology_notes',             'Nephrology Notes',              13120, 'specialized_treatment'),
    ('doc_category', 'delivery_notes',               'Delivery Notes',                13210, 'specialized_treatment'),
    ('doc_category', 'fetal_monitoring_chart',       'Fetal Monitoring Chart',        13220, 'specialized_treatment'),
    ('doc_category', 'neonatal_notes',               'Neonatal Notes',                13230, 'specialized_treatment'),
    ('doc_category', 'immunization_records',         'Immunization Records',          13310, 'specialized_treatment'),
    ('doc_category', 'growth_charts',                'Growth Charts',                 13320, 'specialized_treatment')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 14: Administrative & Operational ──────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'admission_form',               'Admission Form',                14010, 'administrative_operational'),
    ('doc_category', 'bed_allocation_sheet',         'Bed Allocation Sheet',          14020, 'administrative_operational'),
    ('doc_category', 'transfer_notes',               'Transfer Notes',                14030, 'administrative_operational'),
    ('doc_category', 'ward_movement_logs',           'Ward Movement Logs',            14040, 'administrative_operational'),
    ('doc_category', 'duty_doctor_notes',            'Duty Doctor Notes',             14050, 'administrative_operational'),
    ('doc_category', 'duty_nurse_notes',             'Duty Nurse Notes',              14060, 'administrative_operational'),
    ('doc_category', 'visitor_records',              'Visitor Records',               14070, 'administrative_operational'),
    ('doc_category', 'biomedical_waste_logs',        'Biomedical Waste Logs',         14080, 'administrative_operational'),
    ('doc_category', 'infection_control_records',    'Infection Control Records',     14090, 'administrative_operational')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ─── Group 15: Audit & Claims Intelligence Metadata ──────────────────────
-- NOTE: 'bis_screenshot' is added per ops instruction — not on the reference
-- taxonomy but required for biometric / fraud-signal capture.
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'document_classification_metadata', 'Document Classification Metadata', 15010, 'audit_intelligence_metadata'),
    ('doc_category', 'ocr_confidence_scores',        'OCR Confidence Scores',         15020, 'audit_intelligence_metadata'),
    ('doc_category', 'missing_document_alerts',      'Missing Document Alerts',       15030, 'audit_intelligence_metadata'),
    ('doc_category', 'fraud_risk_indicators',        'Fraud Risk Indicators',         15040, 'audit_intelligence_metadata'),
    ('doc_category', 'temporal_consistency_checks',  'Temporal Consistency Checks',   15050, 'audit_intelligence_metadata'),
    ('doc_category', 'medical_necessity_flags',      'Medical Necessity Flags',       15060, 'audit_intelligence_metadata'),
    ('doc_category', 'coding_validation_results',    'Coding Validation Results',     15070, 'audit_intelligence_metadata'),
    ('doc_category', 'duplicate_detection_results',  'Duplicate Detection Results',   15080, 'audit_intelligence_metadata'),
    ('doc_category', 'policy_compliance_checks',     'Policy Compliance Checks',      15090, 'audit_intelligence_metadata'),
    ('doc_category', 'clinical_timeline_reconstruction', 'Clinical Timeline Reconstruction', 15100, 'audit_intelligence_metadata'),
    ('doc_category', 'provider_risk_scores',         'Provider Risk Scores',          15110, 'audit_intelligence_metadata'),
    ('doc_category', 'claim_confidence_scores',      'Claim Confidence Scores',       15120, 'audit_intelligence_metadata'),
    ('doc_category', 'adjudication_recommendation_logs', 'Adjudication Recommendation Logs', 15130, 'audit_intelligence_metadata'),
    ('doc_category', 'human_override_logs',          'Human Override Logs',           15140, 'audit_intelligence_metadata'),
    ('doc_category', 'ai_explanation_trails',        'AI Explanation Trails',         15150, 'audit_intelligence_metadata'),
    ('doc_category', 'audit_trail_events',           'Audit Trail Events',            15160, 'audit_intelligence_metadata'),
    ('doc_category', 'bis_screenshot',               'BIS Screenshot',                15170, 'audit_intelligence_metadata')
ON CONFLICT (category, code) DO UPDATE
    SET group_code = EXCLUDED.group_code, label = EXCLUDED.label, is_active = true;

-- ============================================================================
-- E. concept_aliases — surface-form normalisation
-- ============================================================================
-- These map common variants (abbreviations, plural/singular, spacing,
-- punctuation) onto canonical doc_category codes. Lookup is case-insensitive
-- via the idx_concept_aliases_lower index defined in migration 028.
--
-- Conventions:
--   * One row per (concept_category, alias) — UNIQUE constraint enforces it.
--   * alias_source='manual', confidence=1.0 — these are curated, not mined.

INSERT INTO hospital.concept_aliases (concept_category, concept_code, alias, alias_source, confidence) VALUES
    -- Discharge variants
    ('doc_category', 'discharge_summary',  'discharge summary',         'manual', 1.0),
    ('doc_category', 'discharge_summary',  'discharge note',            'manual', 1.0),
    ('doc_category', 'discharge_summary',  'ds',                        'manual', 1.0),
    ('doc_category', 'discharge_summary',  'final discharge summary',   'manual', 1.0),
    -- Admission variants — canonical is the migration-028 'admission_notes'
    ('doc_category', 'admission_notes',    'admission notes',           'manual', 1.0),
    ('doc_category', 'admission_notes',    'admission note',            'manual', 1.0),
    ('doc_category', 'admission_notes',    'admission record',          'manual', 1.0),
    ('doc_category', 'admission_form',     'admission form',            'manual', 1.0),
    ('doc_category', 'admission_form',     'registration form',         'manual', 1.0),
    -- Cardiology abbreviations
    ('doc_category', 'ecg',                'ecg',                       'manual', 1.0),
    ('doc_category', 'ecg',                'ekg',                       'manual', 1.0),
    ('doc_category', 'ecg',                'electrocardiogram',         'manual', 1.0),
    ('doc_category', 'echo',               'echocardiogram',            'manual', 1.0),
    ('doc_category', 'echo',               '2d echo',                   'manual', 1.0),
    -- Radiology
    ('doc_category', 'xray_reports',       'x-ray',                     'manual', 1.0),
    ('doc_category', 'xray_reports',       'xray',                      'manual', 1.0),
    ('doc_category', 'xray_reports',       'x ray',                     'manual', 1.0),
    ('doc_category', 'xray_reports',       'radiograph',                'manual', 1.0),
    ('doc_category', 'ct_scan_reports',    'ct scan',                   'manual', 1.0),
    ('doc_category', 'ct_scan_reports',    'cat scan',                  'manual', 1.0),
    ('doc_category', 'mri_reports',        'mri',                       'manual', 1.0),
    ('doc_category', 'ultrasound_reports', 'usg',                       'manual', 1.0),
    ('doc_category', 'ultrasound_reports', 'sonography',                'manual', 1.0),
    -- Lab abbreviations
    ('doc_category', 'blood_test_reports', 'cbc',                       'manual', 1.0),
    ('doc_category', 'blood_test_reports', 'lft',                       'manual', 1.0),
    ('doc_category', 'blood_test_reports', 'kft',                       'manual', 1.0),
    ('doc_category', 'blood_test_reports', 'blood report',              'manual', 1.0),
    -- Surgery / OT
    ('doc_category', 'ot_notes',           'ot notes',                  'manual', 1.0),
    ('doc_category', 'ot_notes',           'operation theatre notes',   'manual', 1.0),
    ('doc_category', 'surgery_notes',      'op notes',                  'manual', 1.0),
    -- Bills
    ('doc_category', 'final_breakup_of_bill', 'final bill breakup',     'manual', 1.0),
    ('doc_category', 'final_breakup_of_bill', 'bill breakup',           'manual', 1.0),
    ('doc_category', 'pharmacy_bill',      'medicine bill',             'manual', 1.0),
    -- Consents
    ('doc_category', 'surgery_consent_form', 'surgical consent',        'manual', 1.0),
    ('doc_category', 'high_risk_consent',  'high risk consent',         'manual', 1.0),
    -- Identity
    ('doc_category', 'aadhaar_card',       'aadhar',                    'manual', 1.0),
    ('doc_category', 'aadhaar_card',       'aadhar card',               'manual', 1.0),
    ('doc_category', 'aadhaar_card',       'uid',                       'manual', 1.0),
    -- Authorization
    ('doc_category', 'pre_authorization_form', 'pre auth',              'manual', 1.0),
    ('doc_category', 'pre_authorization_form', 'preauth',               'manual', 1.0),
    ('doc_category', 'pre_authorization_form', 'pre-authorization',     'manual', 1.0),
    ('doc_category', 'cashless_approval_letter', 'cashless approval',   'manual', 1.0),
    ('doc_category', 'cashless_approval_letter', 'approval letter',     'manual', 1.0),
    -- BIS / audit
    ('doc_category', 'bis_screenshot',     'bis screenshot',            'manual', 1.0),
    ('doc_category', 'bis_screenshot',     'biometric screenshot',      'manual', 1.0)
ON CONFLICT (concept_category, alias) DO NOTHING;

-- ============================================================================
-- F. Convenience view — doc_category_groups
-- ============================================================================
-- Joins each doc_category to its group label so downstream code can fetch
-- the full hierarchy in one query without re-joining master_options to itself.

CREATE OR REPLACE VIEW hospital.doc_category_groups AS
SELECT
    g.code           AS group_code,
    g.label          AS group_label,
    g.sort_order     AS group_sort_order,
    c.code           AS doc_category_code,
    c.label          AS doc_category_label,
    c.sort_order     AS doc_category_sort_order,
    c.is_active      AS doc_category_is_active
FROM hospital.master_options c
LEFT JOIN hospital.master_options g
       ON g.category = 'doc_category_group'
      AND g.code     = c.group_code
WHERE c.category = 'doc_category';

COMMENT ON VIEW hospital.doc_category_groups IS
    'Flat join of doc_category rows to their parent doc_category_group. Read this instead of joining master_options to itself.';

-- ============================================================================
-- VERIFICATION (uncomment to inspect)
-- ============================================================================
-- SELECT group_code, COUNT(*) AS n
--   FROM hospital.master_options
--  WHERE category = 'doc_category'
--  GROUP BY group_code
--  ORDER BY n DESC;
--
-- SELECT COUNT(*) AS alias_count FROM hospital.concept_aliases;
--
-- SELECT * FROM hospital.doc_category_groups
--  WHERE group_code = 'audit_intelligence_metadata'
--  ORDER BY doc_category_sort_order;

COMMIT;
