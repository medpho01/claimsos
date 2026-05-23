-- ============================================================================
-- Wave 9 follow-up — comprehensive vision routing for handwritten categories.
-- ============================================================================
-- Migration 050 routed the obvious handwritten cases (OT notes, OPD slips,
-- nursing notes, etc.) to extraction_mode='vision'. But the doc_category
-- taxonomy has ~150 codes and many of the clinical sub-categories are
-- also commonly handwritten — Tesseract returns garbage on those today.
--
-- This migration audits the full taxonomy and flips every category that
-- is HANDWRITTEN OR IMAGE-PRIMARY in Indian hospital practice to vision.
-- Decision rules:
--
--   - Clinical bedside charts / monitoring sheets → vision
--     (handwritten by nursing staff, almost never typed)
--   - Surgeon / anaesthetist / physician progress notes → vision
--     (handwritten in real-time during rounds)
--   - Consent forms → vision
--     (printed form + handwritten patient name, signature, date — the
--     handwritten fields are what we actually want to extract)
--   - Image-primary diagnostic outputs (ECG strips, fetal monitor traces) → vision
--   - Pre-printed pharmacy / medication logs with handwritten entries → vision
--   - Specialist clinical notes (delivery, dialysis, neonatal) → vision
--
--   - LEAVE on OCR: typed lab/PACS reports (blood tests, ultrasound,
--     histopathology, echo, TMT — these come out of automated systems)
--   - LEAVE on OCR: invoices, bills, insurance forms, IDs (all printed)
--
-- Cost note: vision is ~10× the per-call cost of text-only LLM. For a
-- typical claim that contains, say, 3 nursing chart pages and 2 doctor's
-- progress notes plus an ECG, the incremental cost is ~₹2.50 over OCR-
-- only. We're well within the ₹15/claim hard cap. Tesseract on these
-- would otherwise return 5-15% confidence garbage that the LLM either
-- rejects or hallucinates around — vision is the only correct path.

BEGIN;

-- ─── Clinical / bedside charts and notes (all handwritten) ──────────────
UPDATE hospital.master_options
   SET extraction_mode = 'vision'
 WHERE category = 'doc_category'
   AND code IN (
     'treatment',                       -- handwritten treatment chart
     'icps',                            -- Inpatient Clinical Pathway, handwritten
     'clinician_notes',                 -- handwritten doctor's notes
     'initial_assessment_notes',        -- handwritten on admission
     'progress_notes',                  -- handwritten round notes
     'daily_clinical_notes',            -- handwritten daily notes
     'consultation_notes',              -- handwritten OPD/IPD notes
     'icp_charts',                      -- handwritten clinical pathway charts
     'nursing_charts',                  -- handwritten nursing flow charts
     'case_sheet',                      -- handwritten case-sheet
     'bed_head_ticket',                 -- handwritten BHT
     'history_physical_exam_notes',     -- handwritten H&P
     'vitals_monitoring_sheet',         -- handwritten vitals chart
     'medication_administration_record',-- handwritten MAR
     'temperature_chart',               -- handwritten temp chart
     'intake_output_chart',             -- handwritten I/O chart
     'pain_assessment_sheet',           -- handwritten pain scores
     'fall_risk_assessment',            -- handwritten checkbox + signature
     'sepsis_assessment',               -- handwritten scoring
     'glasgow_coma_scale_chart',        -- handwritten GCS chart
     'nutrition_assessment',            -- handwritten
     'er_notes',                        -- handwritten emergency notes
     'triage_notes',                    -- handwritten triage
     'emergency_assessment',            -- handwritten
     'ambulance_records'                -- handwritten ambulance log
   );

-- ─── ICU / Critical care charts (all handwritten by ICU nurses) ─────────
UPDATE hospital.master_options
   SET extraction_mode = 'vision'
 WHERE category = 'doc_category'
   AND code IN (
     'ventilator_charts',
     'icu_flow_sheets',
     'sedation_monitoring',
     'vasopressor_monitoring',
     'critical_care_notes',
     'central_line_monitoring',
     'dialysis_records'
   );

-- ─── Surgical / OT notes (handwritten by surgeon/anaesthetist) ──────────
UPDATE hospital.master_options
   SET extraction_mode = 'vision'
 WHERE category = 'doc_category'
   AND code IN (
     'ot_notes',                        -- handwritten OT notes
     'procedure_notes',                 -- handwritten
     'surgery_notes',                   -- handwritten
     'surgeon_notes',                   -- handwritten
     'anaesthesia_notes',               -- handwritten anaesthesia chart
     'intraoperative_monitoring_records', -- handwritten OT monitoring chart
     'icu_transfer_notes',              -- handwritten transfer note
     'post_op_reports'                  -- often handwritten
   );

-- ─── Consent forms (printed form + handwritten patient details/sig) ─────
UPDATE hospital.master_options
   SET extraction_mode = 'vision'
 WHERE category = 'doc_category'
   AND code IN (
     'consent',
     'general_consent_form',
     'procedure_consent_form',
     'surgery_consent_form',
     'high_risk_consent',
     'blood_transfusion_consent',
     'icu_consent',
     'ventilator_consent',
     'organ_donation_consent',
     'telemedicine_consent',
     'data_privacy_consent',
     'financial_consent',
     'photography_consent',
     'oncologist_consent'
   );

-- ─── Pharmacy / medication administration (handwritten logs) ────────────
UPDATE hospital.master_options
   SET extraction_mode = 'vision'
 WHERE category = 'doc_category'
   AND code IN (
     'medication_charts',
     'drug_administration_logs',
     'narcotics_register',
     'high_risk_medication_monitoring'
   );

-- ─── Rehab / therapy notes (handwritten by therapists) ──────────────────
UPDATE hospital.master_options
   SET extraction_mode = 'vision'
 WHERE category = 'doc_category'
   AND code IN (
     'physiotherapy_notes',
     'occupational_therapy_notes',
     'speech_therapy_notes',
     'rehabilitation_progress_notes',
     'mobility_assessment'
   );

-- ─── Specialist clinical notes ──────────────────────────────────────────
UPDATE hospital.master_options
   SET extraction_mode = 'vision'
 WHERE category = 'doc_category'
   AND code IN (
     'delivery_notes',                  -- handwritten OB notes
     'fetal_monitoring_chart',          -- printed strip + handwritten annotations
     'neonatal_notes',                  -- handwritten
     'nephrology_notes',                -- handwritten
     'dialysis_flow_sheet'              -- handwritten flow sheet
   );

-- ─── Image-primary diagnostic outputs ───────────────────────────────────
-- ECG strips are printed but interpretation is added handwritten, and the
-- strip pattern itself is the diagnostic signal — vision can read both.
UPDATE hospital.master_options
   SET extraction_mode = 'vision'
 WHERE category = 'doc_category'
   AND code IN (
     'ecg',                             -- ECG strip + handwritten interpretation
     'pet_scan_reports'                 -- often image plates
   );

-- ─── Discharge notes that are typically handwritten in small hospitals ──
UPDATE hospital.master_options
   SET extraction_mode = 'vision'
 WHERE category = 'doc_category'
   AND code IN (
     'death_summary',                   -- handwritten in smaller hospitals
     'referral_at_discharge',           -- handwritten referral notes
     'transfer_summary',                -- handwritten
     'lama_dama_forms',                 -- printed form + handwritten signature/reason
     'home_care_instructions',          -- handwritten advice slip
     'discharge_medication'             -- often handwritten med list
   );

-- ─── 'auto' for categories that go EITHER way in practice ───────────────
-- These come out typed at large corporate hospitals (Apollo, Fortis, AIIMS)
-- but handwritten at smaller nursing homes. Auto = try OCR first; fall
-- through to vision when Tesseract returns sparse low-confidence text.
UPDATE hospital.master_options
   SET extraction_mode = 'auto'
 WHERE category = 'doc_category'
   AND code IN (
     'specialist_consultation_reports', -- mixed
     'discharge_summary',               -- formal ones are typed; nursing-home ones handwritten
     'ultrasound_reports',              -- typed at large centres; sometimes handwritten
     'echo',                            -- mostly typed
     'follow_up_advice',                -- mixed
     'follow_up_prescription',          -- mixed (handwritten at clinics)
     'discharge_slip'                   -- mixed
   );

-- ─── Patient photo categories: image-primary, route to vision so we can
-- ─── read overlay text (date/time/location stamps, captions). ──────────
-- The category 'gps_tagged_patient_photos' specifically needs vision to
-- read the GPS coordinate overlay.
UPDATE hospital.master_options
   SET extraction_mode = 'vision'
 WHERE category = 'doc_category'
   AND group_code = 'patient_photos_visual'
   AND COALESCE(extraction_mode, '') != 'vision';

COMMIT;
