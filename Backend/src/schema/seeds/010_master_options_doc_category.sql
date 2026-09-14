-- ==========================================================================
-- 010 — master_options: doc_category (the document taxonomy)
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
--   042_doc_taxonomy_expansion.sql            (base vocabulary + group backfill)
--   047_doc_category_additions.sql            (additions, relabels)
--   059_aadhaar_taxonomy_and_pmjay_categories.sql (aadhaar front/back split, PMJAY)
--   049_doc_category_extraction_hints.sql     (per-category prompt hints -> description)
--   050_doc_category_extraction_mode.sql      (ocr | vision | auto routing)
--   052_vision_routing_for_handwritten_categories.sql
--
-- DO UPDATE, not DO NOTHING: this layer's job is to converge a live catalog on
-- the committed one, so a corrected label, sort order or group actually
-- propagates.
--
-- `extraction_mode` is the ONE column this file does not own once a row exists.
-- It is a cost dial (Tesseract vs a per-page Claude Vision call) and a non-NULL
-- value in the database is treated as OPERATOR INTENT: the seed supplies it on
-- a new row or fills a NULL, and never overwrites it thereafter. Migration 052
-- obeys the same rule. The reasoning, and the escape hatches in both
-- directions, are on the ON CONFLICT clause at the bottom of this file and in
-- seeds/README.md § "extraction_mode is operator-owned".
--
-- `description` (the per-category prompt hint) keeps the normal precedence —
-- the file wins — and is COALESCEd only so a NULL here never wipes a
-- hand-tuned hint.
-- ==========================================================================

INSERT INTO hospital.master_options
    (category, code, label, sort_order, group_code, is_active, extraction_mode, description) VALUES
    ('doc_category', 'discharge_slip', 'Discharge Slip', 10, 'discharge_outcome', true, 'auto', NULL),
    ('doc_category', 'investigations', 'Investigations', 20, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'treatment', 'Treatment', 30, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'icps', 'ICPs', 40, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'surgical_discharge_slip', 'Surgical Discharge Slip', 50, 'discharge_outcome', true, 'vision', '
Surgical discharge slips are a hybrid of pre-printed form fields and handwritten clinical content. Standard sections (in roughly this order):

  - Patient block: name, age, IPD number, ward.
  - Admission date / Discharge date / LOS (length of stay).
  - Diagnosis: surgical indication. Map to `primary_diagnosis`.
  - Procedure done / Surgery: name + side (e.g. "Hybrid THR Rt hip", "TKR Lt knee"). Map to `procedure_performed`.
  - Date of surgery (DD/MM/YYYY) → `surgery_date`.
  - Surgeon''s name (often with reg number) → `primary_surgeon`.
  - Anaesthesia: type (SA / GA / Epidural / Regional Block / Sedation) + anaesthetist''s name.
  - Implants: brand + model + serial number lines, when applicable (joint replacements, spinal, cardiac stents).
  - Operative findings: 1-3 lines describing what was found at surgery.
  - Post-op course: 1-5 lines describing recovery.
  - Condition at discharge: typically "stable", "improved", "ambulating with support".
  - Medications (often a structured list with dose + duration).
  - Follow-up: review date + instructions.
  - Doctor signature + stamp at the bottom.

For PMJAY/government claims, the form often has the package code printed. If you see "PMJAY THR" or "PMJAY_TKR" treat that as both confirmation of the package and a strong signal for procedure type.

Indian-context note: dates are DD/MM/YYYY by default; surgery dates often appear with month name ("26 Dec 2025"). Always emit ISO YYYY-MM-DD.
'),
    ('doc_category', 'ot_notes_and_photos', 'OT Notes and Photos', 60, 'surgical_procedure', true, 'vision', NULL),
    ('doc_category', 'post_op_photos', 'Post Op Photos', 70, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'post_op_reports', 'Post Op Reports', 80, 'surgical_procedure', true, 'vision', NULL),
    ('doc_category', 'implant_invoice', 'Implant Invoice', 90, 'surgical_procedure', true, NULL, NULL),
    ('doc_category', 'insurer_response', 'Insurer Responses', 100, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'others', 'Others', 110, 'administrative_operational', true, NULL, NULL),
    ('doc_category', 'admission_notes', 'Admission Notes', 120, 'clinical_medical', true, 'auto', NULL),
    ('doc_category', 'diagnosis_summary', 'Diagnosis Summary', 130, 'clinical_medical', true, NULL, NULL),
    ('doc_category', 'procedure_estimate', 'Procedure Estimate', 140, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'consent', 'Consent', 150, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'final_bill', 'Final Bill', 160, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'oncologist_consent', 'Oncologist Consent', 170, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'identity_proof', 'Identity Proof', 180, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'claim_form', 'Claim Form', 190, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'insurer_query_letter', 'Insurer Query Letter', 200, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'insurer_approval_letter', 'Insurer Approval Letter', 210, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'aadhaar_card', 'Aadhaar Card', 999, NULL, true, NULL, NULL),
    ('doc_category', 'pmjay_card', 'PMJAY / Ayushman Card', 999, NULL, true, NULL, NULL),
    ('doc_category', 'pmjay_letter', 'PMJAY Welcome Letter', 999, NULL, true, NULL, NULL),
    ('doc_category', 'aadhaar_back', 'Aadhaar Back', 1010, 'kyc_identity_insurance', true, NULL, '
The Aadhaar back (issued by UIDAI) carries the holder''s address. Layout:

  - The 12-digit Aadhaar number is repeated at the bottom (same 4-4-4 grouped format).
  - The address block is preceded by either "S/O:" (son of), "D/O:" (daughter of), "W/O:" (wife of), or "C/O:" (care of) followed by the parent/spouse name and the address. Map the name following S/O / D/O / W/O / C/O to `parent_or_spouse_name`.
  - Address lines follow comma-separated: house/door number, street/locality, village/post, sub-district, district, state, then a 6-digit PIN code.
  - State name is one of the 28 Indian states / 8 UTs — use canonical English spelling for `state`.
  - The PIN code is exactly 6 digits, often appearing at the end of the address. Populate `pin_code`.
  - QR code is present but not extracted.
'),
    ('doc_category', 'aadhaar_front', 'Aadhaar Front', 1011, 'kyc_identity_insurance', true, NULL, E'
The Aadhaar front (issued by UIDAI, Government of India) has a fixed layout:

  - HEADER: "भारत सरकार / Government of India" with the Indian tricolour and Ashoka emblem.
  - NAME: appears immediately after the header as TWO lines with NO "Name:" label prefix:
      Line 1 — name in Devanagari (Hindi) script (e.g. "भूरी")
      Line 2 — same name transliterated in English (e.g. "Bhuri")
    Use the English line for `full_name`. If only Devanagari is OCR''d cleanly, transliterate using common Indian-name patterns.
  - DOB: labelled bilingually "जन्म तिथि / DOB : DD/MM/YYYY". Map to `date_of_birth` in ISO YYYY-MM-DD.
    Some older cards print only year — populate `year_of_birth` (number) in that case and leave `date_of_birth` null.
  - GENDER: labelled "पुरुष / Male" or "महिला / Female" (or "Other"). Map to enum: M / F / O.
  - AADHAAR NUMBER: 12-digit UID rendered as THREE GROUPS OF FOUR digits separated by spaces (e.g. "6978 2591 6544"). Strip the spaces when populating `aadhaar_number`.
  - QR code and photo are also present but not extracted.

Scans frequently arrive rotated 90/180/270°. If the OCR text reads as broken vertical fragments, the source is rotated — try harder to reconstruct fields from disjoint OCR tokens; do NOT return {} just because no field label is detectable. The 12-digit UID pattern (\\d{4}\\s\\d{4}\\s\\d{4}) is the strongest anchor for orientation.
'),
    ('doc_category', 'pan_card', 'PAN Card', 1020, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'voter_id', 'Voter ID', 1030, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'passport', 'Passport', 1040, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'driving_license', 'Driving License', 1050, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'policy_card', 'Policy Card', 1060, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'insurance_e_card', 'Insurance e-Card', 1070, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'employee_id_card', 'Employee ID Card', 1080, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'corporate_id_card', 'Corporate ID Card', 1090, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'abha_card', 'Health ID / ABHA Card', 1100, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'insurance_enrollment_form', 'Insurance Enrollment Form', 1110, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'patient_registration_form', 'Patient Registration Form', 1120, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'address_proof', 'Address Proof', 1130, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'age_proof', 'Age Proof', 1140, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'relationship_proof', 'Relationship Proof', 1150, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'referral_letter', 'Referral Letter', 1160, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'tpa_id_card', 'TPA ID Card', 1170, 'kyc_identity_insurance', true, NULL, NULL),
    ('doc_category', 'ration_card', 'Ration Card', 1180, 'kyc_identity_insurance', true, NULL, '
Indian ration cards (issued by State Civil Supplies departments under PDS) vary widely by state, but share core elements:

  - Card number: alphanumeric, format varies by state (UP, MP, Bihar etc.) — extract verbatim into `ration_card_number`. Some legacy paper cards have no printed number; populate null in that case.
  - Card type (CRITICAL — drives eligibility): one of:
      APL (Above Poverty Line)
      BPL (Below Poverty Line)
      Antyodaya / AAY (Antyodaya Anna Yojana — poorest of the poor)
      Annapurna (for senior citizens)
    The card type is usually printed prominently as a colour band or text label. Pick the closest enum value.
  - Head of family: name printed at the top of the family-members table or labelled "Head" / "मुखिया" / "कर्ता".
  - Family members: tabular list with name, age, gender, relation. Concatenate into a comma-separated string for `family_members` (e.g. "Bhuri (72/F, SELF), Vahid (67/M, HUSBAND)").
  - FPS shop number: the Fair Price Shop assigned to the family — labelled "FPS No." / "उचित मूल्य दुकान संख्या".
  - State + district: usually printed in the header or as a stamp.
'),
    ('doc_category', 'pre_authorization_form', 'Pre-Authorization Form', 2010, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'enhancement_request_form', 'Enhancement Request Form', 2020, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'pre_auth_query_response', 'Pre-Auth Query Response', 2030, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'insurance_declaration_form', 'Insurance Declaration Form', 2040, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'cashless_approval_letter', 'Cashless Approval Letter', 2050, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'initial_authorization_letter', 'Initial Authorization Letter', 2060, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'final_authorization_letter', 'Final Authorization Letter', 2070, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'discharge_approval_letter', 'Discharge Approval Letter', 2080, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'rejection_denial_letter', 'Rejection / Denial Letter', 2090, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'reimbursement_claim_form', 'Reimbursement Claim Form', 2100, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'insurance_undertaking', 'Insurance Undertaking', 2110, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'copayment_undertaking', 'Co-payment Undertaking', 2120, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'non_medical_expense_declaration', 'Non-medical Expense Declaration', 2130, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'mlc_declaration', 'MLC Declaration', 2140, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'accident_intimation_letter', 'Accident Intimation Letter', 2150, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'fir_copy', 'FIR Copy', 2160, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'employer_declaration', 'Employer Declaration', 2170, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'treating_doctor_declaration', 'Treating Doctor Declaration', 2180, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'package_utilization_sheet', 'Package Utilization Sheet', 2190, 'insurance_authorization', true, NULL, NULL),
    ('doc_category', 'opd_notes', 'OPD Notes', 3010, 'clinical_medical', true, 'vision', '
OPD (out-patient) consultation notes in India are almost always HANDWRITTEN. Typical layout (variable, but these elements are consistent):

  - Top of the page: patient name (or sticker), age, date of visit.
  - "C/O" (Complaint of): the chief complaints. Often abbreviated — "Pain Lt knee", "Difficulty in walking", "SOB", "Chest pain x 2 days". Treat each line under C/O as a separate complaint. Map to `chief_complaints` (multi-line string).
  - "H/O" (History of): past medical/surgical history. "H/O TKR 1 yr ago Rt knee" → put in `history`.
  - "O/E" (On examination): examination findings.
  - X-ray / CT / investigation summary, often handwritten line-by-line: capture verbatim in `examination_findings` if findings, or `investigations_ordered` if just listing what was sent.
  - "Adv" (Advice): treatment plan. Often a bulleted list. Map to `advice_or_plan`.
  - Diagnosis usually appears with a clinical staging marker like "OA III Lt knee" (osteoarthritis grade III, left knee) or "AVN Rt hip". Map to `provisional_diagnosis`.
  - Signature + date + Reg No. + doctor''s name printed at the bottom (rubber stamp).

Indian medical-handwriting shortcuts to expect:
  - Lt = Left, Rt = Right, B/L = Bilateral
  - C̄ (c with bar) = "with"; S̄ (s with bar) = "without"
  - Dates often DD/MM/YY or with month names
  - Doses inline with medications ("Tab Pantoprazole 40 1-0-1")

Do NOT invent values. If a section of the slip isn''t legible, leave the field empty (the system will mark per_field_confidence=0 for missing required fields).
'),
    ('doc_category', 'prescription', 'Prescription', 3020, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'clinician_notes', 'Clinician Notes', 3030, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'initial_assessment_notes', 'Initial Assessment Notes', 3040, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'progress_notes', 'Progress Notes', 3050, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'daily_clinical_notes', 'Daily Clinical Notes', 3060, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'consultation_notes', 'Consultation Notes', 3070, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'specialist_consultation_reports', 'Specialist Consultation Reports', 3080, 'clinical_medical', true, 'auto', NULL),
    ('doc_category', 'nursing_notes', 'Nursing Notes', 3090, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'icp_charts', 'ICP Charts', 3100, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'nursing_charts', 'Nursing Charts', 3110, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'case_sheet', 'Case Sheet', 3120, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'bed_head_ticket', 'Bed Head Ticket (BHT)', 3130, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'history_physical_exam_notes', 'History & Physical Examination Notes', 3140, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'vitals_monitoring_sheet', 'Vitals Monitoring Sheet', 3150, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'medication_administration_record', 'Medication Administration Record (MAR)', 3160, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'temperature_chart', 'Temperature Chart', 3170, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'intake_output_chart', 'Intake / Output Chart', 3180, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'pain_assessment_sheet', 'Pain Assessment Sheet', 3190, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'fall_risk_assessment', 'Fall Risk Assessment', 3200, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'sepsis_assessment', 'Sepsis Assessment', 3210, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'glasgow_coma_scale_chart', 'Glasgow Coma Scale Chart', 3220, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'nutrition_assessment', 'Nutrition Assessment', 3230, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'er_notes', 'ER Notes', 3300, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'triage_notes', 'Triage Notes', 3310, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'emergency_assessment', 'Emergency Assessment', 3320, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'ambulance_records', 'Ambulance Records', 3330, 'clinical_medical', true, 'vision', NULL),
    ('doc_category', 'blood_test_reports', 'Blood Test Reports', 4010, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'urine_test_reports', 'Urine Test Reports', 4020, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'culture_reports', 'Culture Reports', 4030, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'histopathology_reports', 'Histopathology Reports', 4040, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'biopsy_reports', 'Biopsy Reports', 4050, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'serology_reports', 'Serology Reports', 4060, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'xray_reports', 'X-Ray Reports', 4110, 'diagnostic_investigation', true, 'vision', '
X-Ray reports in Indian hospital uploads fall into two layouts:

  1. TYPED report from a radiology PACS system (most diagnostic centres):
     header with centre name, patient block (Name, Age, Sex, ID), study
     date, "FINDINGS:" paragraph, "IMPRESSION:" / "OPINION:" paragraph,
     radiologist''s signature + reg number.

  2. PLATE ONLY — the X-ray film itself, photographed. The text overlay
     on the plate carries patient name, age, sex, hospital, date, view.
     There''s NO findings/impression — those have to be inferred from the
     image. For this case:
       - Extract patient_name, patient_age, patient_sex, study_date,
         body_part, views, laterality from the overlay text.
       - For `findings`, describe what''s visible on the X-ray clinically
         (e.g. "Reduced medial joint space, osteophytes at femoral
         condyles, sclerosis of tibial plateau — consistent with OA grade 3").
       - For `impression`, provide a brief clinical conclusion if you can
         see clear pathology, otherwise leave empty.

Common abbreviations:
  - "AP" = anteroposterior view; "LAT" / "Lat" = lateral view; "OBL" = oblique
  - "B/L" = bilateral; views labelled "L" / "R" indicate side
  - "JNT" = joint
  - Body part terms: "KNEE JNT", "HIP JNT", "C-SPINE", "L-SPINE", "PELVIS", "CXR" (chest)

Always extract the overlay''s date (format DD/MM/YYYY or D/M/YYYY) as study_date in ISO.
'),
    ('doc_category', 'ct_scan_reports', 'CT Scan Reports', 4120, 'diagnostic_investigation', true, 'vision', '
CT scan reports follow a fairly standard radiology format:

  - Study date: printed near the top, often labelled "Date of Study" / "Date:" / "Examination Date". Map to ISO YYYY-MM-DD in `study_date`.
  - Body part / anatomy: the title of the report (e.g. "CT BRAIN", "HRCT CHEST", "CT KNEE — BOTH SIDES"). Use the most specific phrasing for `body_part`.
  - Clinical indication / referral diagnosis: short note describing why the scan was ordered (e.g. "C/O knee pain x 3 months").
  - Contrast: explicitly stated as "Non-contrast" / "Plain" / "IV contrast" / "Oral contrast". Map to enum: none / iv_contrast / oral_contrast / both.
  - Findings: longest free-text section describing what was seen on the scan, organ-by-organ. Copy verbatim (up to ~1000 chars).
  - Impression / Conclusion: the radiologist''s interpretive summary at the end. Usually 1-5 sentences. Copy verbatim.
  - Ordering physician: doctor who requested the scan (often a surgeon or specialist).
  - Reporting radiologist: doctor who interpreted the scan and signed the report (usually printed at the bottom with a registration number).
'),
    ('doc_category', 'mri_reports', 'MRI Reports', 4130, 'diagnostic_investigation', true, 'vision', NULL),
    ('doc_category', 'pet_scan_reports', 'PET Scan Reports', 4140, 'diagnostic_investigation', true, 'vision', NULL),
    ('doc_category', 'ultrasound_reports', 'Ultrasound Reports', 4150, 'diagnostic_investigation', true, 'auto', NULL),
    ('doc_category', 'mammography_reports', 'Mammography Reports', 4160, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'ecg', 'ECG', 4210, 'diagnostic_investigation', true, 'vision', NULL),
    ('doc_category', 'echo', 'ECHO', 4220, 'diagnostic_investigation', true, 'auto', NULL),
    ('doc_category', 'tmt_reports', 'TMT Reports', 4230, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'holter_monitoring_reports', 'Holter Monitoring Reports', 4240, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'pulmonary_function_test', 'Pulmonary Function Test', 4310, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'endoscopy_reports', 'Endoscopy Reports', 4320, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'colonoscopy_reports', 'Colonoscopy Reports', 4330, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'sleep_study_reports', 'Sleep Study Reports', 4340, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'neurodiagnostic_reports', 'Neurodiagnostic Reports', 4350, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'pre_surgery_diagnostics', 'Pre-Surgery Diagnostics', 4410, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'post_surgery_diagnostics', 'Post-Surgery Diagnostics', 4420, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'anaesthesia_fitness_reports', 'Anaesthesia Fitness Reports', 4430, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'surgical_fitness_reports', 'Surgical Fitness Reports', 4440, 'diagnostic_investigation', true, NULL, NULL),
    ('doc_category', 'ot_notes', 'OT Notes', 5010, 'surgical_procedure', true, 'vision', NULL),
    ('doc_category', 'procedure_notes', 'Procedure Notes', 5020, 'surgical_procedure', true, 'vision', NULL),
    ('doc_category', 'surgery_notes', 'Surgery Notes', 5030, 'surgical_procedure', true, 'vision', NULL),
    ('doc_category', 'surgeon_notes', 'Surgeon Notes', 5040, 'surgical_procedure', true, 'vision', NULL),
    ('doc_category', 'anaesthesia_notes', 'Anaesthesia Notes', 5050, 'surgical_procedure', true, 'vision', NULL),
    ('doc_category', 'intraoperative_monitoring_records', 'Intraoperative Monitoring Records', 5060, 'surgical_procedure', true, 'vision', NULL),
    ('doc_category', 'implant_barcode', 'Implant Barcode', 5070, 'surgical_procedure', true, NULL, NULL),
    ('doc_category', 'implant_sticker', 'Implant Sticker', 5080, 'surgical_procedure', true, NULL, NULL),
    ('doc_category', 'implant_bill', 'Implant Bill', 5090, 'surgical_procedure', true, NULL, NULL),
    ('doc_category', 'consumable_usage_sheet', 'Consumable Usage Sheet', 5100, 'surgical_procedure', true, NULL, NULL),
    ('doc_category', 'cssd_records', 'CSSD Records', 5110, 'surgical_procedure', true, NULL, NULL),
    ('doc_category', 'blood_utilization_records', 'Blood Utilization Records', 5120, 'surgical_procedure', true, NULL, NULL),
    ('doc_category', 'surgical_checklist', 'Surgical Checklist', 5130, 'surgical_procedure', true, NULL, NULL),
    ('doc_category', 'who_surgical_safety_checklist', 'WHO Surgical Safety Checklist', 5140, 'surgical_procedure', true, NULL, NULL),
    ('doc_category', 'icu_transfer_notes', 'ICU Transfer Notes', 5150, 'surgical_procedure', true, 'vision', NULL),
    ('doc_category', 'cost_estimate', 'Cost Estimate', 6010, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'revised_estimate', 'Revised Estimate', 6020, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'package_estimate', 'Package Estimate', 6030, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'interim_bill', 'Interim Bill', 6110, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'final_breakup_of_bill', 'Final Breakup of Bill', 6120, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'consolidated_bill', 'Consolidated Bill', 6130, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'pharmacy_bill', 'Pharmacy Bill', 6140, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'consumables_bill', 'Consumables Bill', 6150, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'diagnostics_bill', 'Diagnostics Bill', 6160, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'procedure_charges', 'Procedure Charges', 6170, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'room_rent_summary', 'Room Rent Summary', 6180, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'icu_charges_summary', 'ICU Charges Summary', 6190, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'payment_receipts', 'Payment Receipts', 6210, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'advance_receipts', 'Advance Receipts', 6220, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'refund_receipts', 'Refund Receipts', 6230, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'payment_settlement_summary', 'Payment Settlement Summary', 6240, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'upi_card_transaction_slips', 'UPI / Card Transaction Slips', 6250, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'credit_notes', 'Credit Notes', 6310, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'debit_notes', 'Debit Notes', 6320, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'tpa_settlement_sheet', 'TPA Settlement Sheet', 6330, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'insurance_deduction_sheet', 'Insurance Deduction Sheet', 6340, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'non_payable_item_list', 'Non-payable Item List', 6350, 'billing_financial', true, NULL, NULL),
    ('doc_category', 'discharge_summary', 'Discharge Summary', 7010, 'discharge_outcome', true, 'auto', NULL),
    ('doc_category', 'discharge_medication', 'Discharge Medication', 7020, 'discharge_outcome', true, 'vision', NULL),
    ('doc_category', 'follow_up_advice', 'Follow-up Advice', 7030, 'discharge_outcome', true, 'auto', NULL),
    ('doc_category', 'follow_up_prescription', 'Follow-up Prescription', 7040, 'discharge_outcome', true, 'auto', NULL),
    ('doc_category', 'fitness_certificate', 'Fitness Certificate', 7050, 'discharge_outcome', true, NULL, NULL),
    ('doc_category', 'return_to_work_certificate', 'Return-to-Work Certificate', 7060, 'discharge_outcome', true, NULL, NULL),
    ('doc_category', 'death_summary', 'Death Summary', 7070, 'discharge_outcome', true, 'vision', NULL),
    ('doc_category', 'death_certificate', 'Death Certificate', 7080, 'discharge_outcome', true, NULL, NULL),
    ('doc_category', 'referral_at_discharge', 'Referral at Discharge', 7090, 'discharge_outcome', true, 'vision', NULL),
    ('doc_category', 'transfer_summary', 'Transfer Summary', 7100, 'discharge_outcome', true, 'vision', NULL),
    ('doc_category', 'lama_dama_forms', 'LAMA / DAMA Forms', 7110, 'discharge_outcome', true, 'vision', NULL),
    ('doc_category', 'home_care_instructions', 'Home Care Instructions', 7120, 'discharge_outcome', true, 'vision', NULL),
    ('doc_category', 'general_consent_form', 'General Consent Form', 8010, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'procedure_consent_form', 'Procedure Consent Form', 8020, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'surgery_consent_form', 'Surgery Consent Form', 8030, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'high_risk_consent', 'High-Risk Consent', 8040, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'blood_transfusion_consent', 'Blood Transfusion Consent', 8050, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'icu_consent', 'ICU Consent', 8060, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'ventilator_consent', 'Ventilator Consent', 8070, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'anaesthesia_consent', 'Anaesthesia Consent', 8080, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'organ_donation_consent', 'Organ Donation Consent', 8090, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'telemedicine_consent', 'Telemedicine Consent', 8100, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'data_privacy_consent', 'Data Privacy Consent', 8110, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'financial_consent', 'Financial Consent', 8120, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'photography_consent', 'Photography Consent', 8130, 'consent_legal', true, 'vision', NULL),
    ('doc_category', 'mlc_documents', 'MLC Documents', 8140, 'consent_legal', true, NULL, NULL),
    ('doc_category', 'police_intimation', 'Police Intimation', 8150, 'consent_legal', true, NULL, NULL),
    ('doc_category', 'general_patient_photo', 'General Patient Photo', 9010, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'patient_photo_without_gps', 'Patient Photo without GPS', 9015, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'gps_tagged_patient_photos', 'Patient Photo with GPS', 9020, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'admission_photo', 'Admission Photo', 9030, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'discharge_photo', 'Discharge Photo', 9040, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'ot_photos_doctor_patient', 'OT Photos with Treating Doctor and Patient', 9110, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'scar_photos', 'Scar Photos', 9120, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'wound_photos', 'Wound Photos', 9130, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'procedure_site_photos', 'Procedure Site Photos', 9140, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'bedside_photos', 'Bedside Photos', 9150, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'implant_photos', 'Implant Photos', 9210, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'device_serial_number_photos', 'Device Serial Number Photos', 9220, 'patient_photos_visual', true, 'vision', NULL),
    ('doc_category', 'ventilator_charts', 'Ventilator Charts', 10010, 'icu_critical_care', true, 'vision', NULL),
    ('doc_category', 'icu_flow_sheets', 'ICU Flow Sheets', 10020, 'icu_critical_care', true, 'vision', NULL),
    ('doc_category', 'abg_reports', 'ABG Reports', 10030, 'icu_critical_care', true, NULL, NULL),
    ('doc_category', 'sedation_monitoring', 'Sedation Monitoring', 10040, 'icu_critical_care', true, 'vision', NULL),
    ('doc_category', 'vasopressor_monitoring', 'Vasopressor Monitoring', 10050, 'icu_critical_care', true, 'vision', NULL),
    ('doc_category', 'critical_care_notes', 'Critical Care Notes', 10060, 'icu_critical_care', true, 'vision', NULL),
    ('doc_category', 'central_line_monitoring', 'Central Line Monitoring', 10070, 'icu_critical_care', true, 'vision', NULL),
    ('doc_category', 'dialysis_records', 'Dialysis Records', 10080, 'icu_critical_care', true, 'vision', NULL),
    ('doc_category', 'medication_charts', 'Medication Charts', 11010, 'pharmacy_medication', true, 'vision', NULL),
    ('doc_category', 'pharmacy_issue_slips', 'Pharmacy Issue Slips', 11020, 'pharmacy_medication', true, NULL, NULL),
    ('doc_category', 'drug_administration_logs', 'Drug Administration Logs', 11030, 'pharmacy_medication', true, 'vision', NULL),
    ('doc_category', 'narcotics_register', 'Narcotics Register', 11040, 'pharmacy_medication', true, 'vision', NULL),
    ('doc_category', 'high_risk_medication_monitoring', 'High-risk Medication Monitoring', 11050, 'pharmacy_medication', true, 'vision', NULL),
    ('doc_category', 'vaccination_records', 'Vaccination Records', 11060, 'pharmacy_medication', true, NULL, NULL),
    ('doc_category', 'physiotherapy_notes', 'Physiotherapy Notes', 12010, 'rehabilitation_therapy', true, 'vision', NULL),
    ('doc_category', 'occupational_therapy_notes', 'Occupational Therapy Notes', 12020, 'rehabilitation_therapy', true, 'vision', NULL),
    ('doc_category', 'speech_therapy_notes', 'Speech Therapy Notes', 12030, 'rehabilitation_therapy', true, 'vision', NULL),
    ('doc_category', 'rehabilitation_progress_notes', 'Rehabilitation Progress Notes', 12040, 'rehabilitation_therapy', true, 'vision', NULL),
    ('doc_category', 'mobility_assessment', 'Mobility Assessment', 12050, 'rehabilitation_therapy', true, 'vision', NULL),
    ('doc_category', 'chemotherapy_protocol', 'Chemotherapy Protocol', 13010, 'specialized_treatment', true, NULL, NULL),
    ('doc_category', 'radiation_therapy_summary', 'Radiation Therapy Summary', 13020, 'specialized_treatment', true, NULL, NULL),
    ('doc_category', 'dialysis_flow_sheet', 'Dialysis Flow Sheet', 13110, 'specialized_treatment', true, 'vision', NULL),
    ('doc_category', 'nephrology_notes', 'Nephrology Notes', 13120, 'specialized_treatment', true, 'vision', NULL),
    ('doc_category', 'delivery_notes', 'Delivery Notes', 13210, 'specialized_treatment', true, 'vision', NULL),
    ('doc_category', 'fetal_monitoring_chart', 'Fetal Monitoring Chart', 13220, 'specialized_treatment', true, 'vision', NULL),
    ('doc_category', 'neonatal_notes', 'Neonatal Notes', 13230, 'specialized_treatment', true, 'vision', NULL),
    ('doc_category', 'immunization_records', 'Immunization Records', 13310, 'specialized_treatment', true, NULL, NULL),
    ('doc_category', 'growth_charts', 'Growth Charts', 13320, 'specialized_treatment', true, NULL, NULL),
    ('doc_category', 'admission_form', 'Admission Form', 14010, 'administrative_operational', true, NULL, NULL),
    ('doc_category', 'bed_allocation_sheet', 'Bed Allocation Sheet', 14020, 'administrative_operational', true, NULL, NULL),
    ('doc_category', 'transfer_notes', 'Transfer Notes', 14030, 'administrative_operational', true, NULL, NULL),
    ('doc_category', 'ward_movement_logs', 'Ward Movement Logs', 14040, 'administrative_operational', true, NULL, NULL),
    ('doc_category', 'duty_doctor_notes', 'Duty Doctor Notes', 14050, 'administrative_operational', true, NULL, NULL),
    ('doc_category', 'duty_nurse_notes', 'Duty Nurse Notes', 14060, 'administrative_operational', true, NULL, NULL),
    ('doc_category', 'visitor_records', 'Visitor Records', 14070, 'administrative_operational', true, NULL, NULL),
    ('doc_category', 'biomedical_waste_logs', 'Biomedical Waste Logs', 14080, 'administrative_operational', true, NULL, NULL),
    ('doc_category', 'infection_control_records', 'Infection Control Records', 14090, 'administrative_operational', true, NULL, NULL),
    ('doc_category', 'document_classification_metadata', 'Document Classification Metadata', 15010, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'ocr_confidence_scores', 'OCR Confidence Scores', 15020, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'missing_document_alerts', 'Missing Document Alerts', 15030, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'fraud_risk_indicators', 'Fraud Risk Indicators', 15040, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'temporal_consistency_checks', 'Temporal Consistency Checks', 15050, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'medical_necessity_flags', 'Medical Necessity Flags', 15060, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'coding_validation_results', 'Coding Validation Results', 15070, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'duplicate_detection_results', 'Duplicate Detection Results', 15080, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'policy_compliance_checks', 'Policy Compliance Checks', 15090, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'clinical_timeline_reconstruction', 'Clinical Timeline Reconstruction', 15100, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'provider_risk_scores', 'Provider Risk Scores', 15110, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'claim_confidence_scores', 'Claim Confidence Scores', 15120, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'adjudication_recommendation_logs', 'Adjudication Recommendation Logs', 15130, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'human_override_logs', 'Human Override Logs', 15140, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'ai_explanation_trails', 'AI Explanation Trails', 15150, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'audit_trail_events', 'Audit Trail Events', 15160, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'bis_screenshot', 'BIS Screenshot', 15170, 'audit_intelligence_metadata', true, NULL, NULL),
    ('doc_category', 'pmjay_bis_family_tree', 'PMJAY BIS Family Tree', 15180, 'audit_intelligence_metadata', true, NULL, '
PMJAY BIS (Beneficiary Identification System) Family Tree screenshots are taken from the PM-JAY portal during beneficiary verification. Layout:

  - PMJAY Beneficiary ID: long alphanumeric (often 24+ chars) labelled "PMJAY ID" or "बेनिफिशियरी आईडी". Map to `pmjay_beneficiary_id`. The same value may appear as "Household ID" — if present, populate `household_id` too (often identical to beneficiary ID for single-card households).
  - Head of family: the FIRST row of the family-tree table, marked as "HOF" / "Head".
  - Family members: every row in the family table; concatenate names comma-separated for `family_members`.
  - Total family size: the row count (or printed total). Populate `total_family_size` (number).
  - Eligibility status: printed as "Eligible" / "Not Eligible" / "Under Review" — map to enum.
  - State + district: often shown in the portal header or as filter chips.
  - The screenshot may include the PM-JAY logo and government colours; ignore those decorations.
'),
    ('doc_category', '__failed__', 'Classification Failed', 15999, 'audit_intelligence_metadata', false, NULL, NULL)
ON CONFLICT (category, code) DO UPDATE SET
    label           = EXCLUDED.label,
    sort_order      = EXCLUDED.sort_order,
    group_code      = EXCLUDED.group_code,
    is_active       = EXCLUDED.is_active,
    -- ── extraction_mode: THE DATABASE WINS. ───────────────────────────────
    -- The argument order here is deliberate and is the opposite of
    -- `description` below. Read it as: this file supplies the INITIAL routing
    -- for a category; once a row HAS a mode, only an operator (or a new,
    -- reviewed migration) changes it.
    --
    -- The previous rule was COALESCE(EXCLUDED, existing), i.e. "the seed wins
    -- unless the seed is NULL". That protected only the 140 rows whose seed
    -- value is NULL. It did NOT protect the 106 rows this file pins explicitly
    -- (98 'vision', 8 'auto') — so an operator who pinned, say, `treatment`
    -- (seed value 'vision') to 'ocr' during a cost incident had it silently
    -- reverted by the next `npm run seed`, while `investigations` (seed value
    -- NULL) survived. Two categories, same operator action, opposite outcome,
    -- decided by an implementation detail of this file. Reproduced on a live
    -- database, not theorised.
    --
    -- extraction_mode is not a label: it decides whether a document category
    -- goes to Tesseract or to a per-page Claude Vision call, so re-asserting it
    -- is re-asserting SPEND. A cost dial an operator cannot durably hold is not
    -- a dial. Migration 052 was fixed the same way (every UPDATE is now guarded
    -- `AND extraction_mode IS NULL`), so BOTH re-run paths — re-seed and
    -- migration replay — now obey one rule.
    --
    -- Consequences, accepted knowingly:
    --   * Editing the mode column of a row in this file changes NOTHING on any
    --     environment that already has a value for it. It only affects rows
    --     that are new, or whose mode is still NULL. To re-route a category
    --     fleet-wide, ship a numbered migration that names the categories
    --     (that is what 050 and 052 are); do not expect an edit here to travel.
    --   * To hand a category back to this file's default, an operator NULLs it
    --     and re-applies the seed:
    --         UPDATE hospital.master_options SET extraction_mode = NULL
    --          WHERE category = 'doc_category' AND code = 'treatment';
    --         node src/schema/run-seeds.cjs --force --only 010_master_options_doc_category
    extraction_mode = COALESCE(hospital.master_options.extraction_mode, EXCLUDED.extraction_mode),
    -- `description` keeps the opposite precedence ON PURPOSE. It is a prompt
    -- hint: retuning it is the routine, reviewed way this catalog improves
    -- extraction quality, and it costs nothing to re-assert. The COALESCE is
    -- only so a NULL here never WIPES a hand-tuned hint.
    description     = COALESCE(EXCLUDED.description, hospital.master_options.description),
    updated_at      = NOW();

