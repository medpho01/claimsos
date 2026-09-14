-- ==========================================================================
-- 030 — concept_aliases (free-text -> canonical concept code)
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
--   042_doc_taxonomy_expansion.sql
--   047_doc_category_additions.sql
--
-- DO NOTHING is deliberate here: aliases are additive, and a human-curated row
-- must never be clobbered by a re-seed.
-- ==========================================================================

INSERT INTO hospital.concept_aliases (concept_category, concept_code, alias, alias_source, confidence) VALUES
    ('doc_category', 'aadhaar_card', 'aadhaar back', 'manual', 1.00),
    ('doc_category', 'aadhaar_card', 'aadhar', 'manual', 1.00),
    ('doc_category', 'aadhaar_card', 'aadhar back', 'manual', 1.00),
    ('doc_category', 'aadhaar_card', 'aadhar card', 'manual', 1.00),
    ('doc_category', 'aadhaar_card', 'back side aadhar', 'manual', 1.00),
    ('doc_category', 'aadhaar_card', 'uid', 'manual', 1.00),
    ('doc_category', 'aadhaar_front', 'aadhaar front', 'manual', 1.00),
    ('doc_category', 'aadhaar_front', 'aadhar front', 'manual', 1.00),
    ('doc_category', 'aadhaar_front', 'front side aadhar', 'manual', 1.00),
    ('doc_category', 'aadhaar_front', 'uid front', 'manual', 1.00),
    ('doc_category', 'admission_form', 'admission form', 'manual', 1.00),
    ('doc_category', 'admission_form', 'registration form', 'manual', 1.00),
    ('doc_category', 'admission_notes', 'admission note', 'manual', 1.00),
    ('doc_category', 'admission_notes', 'admission notes', 'manual', 1.00),
    ('doc_category', 'admission_notes', 'admission record', 'manual', 1.00),
    ('doc_category', 'bis_screenshot', 'biometric screenshot', 'manual', 1.00),
    ('doc_category', 'bis_screenshot', 'bis screenshot', 'manual', 1.00),
    ('doc_category', 'blood_test_reports', 'blood report', 'manual', 1.00),
    ('doc_category', 'blood_test_reports', 'cbc', 'manual', 1.00),
    ('doc_category', 'blood_test_reports', 'kft', 'manual', 1.00),
    ('doc_category', 'blood_test_reports', 'lft', 'manual', 1.00),
    ('doc_category', 'cashless_approval_letter', 'approval letter', 'manual', 1.00),
    ('doc_category', 'cashless_approval_letter', 'cashless approval', 'manual', 1.00),
    ('doc_category', 'ct_scan_reports', 'cat scan', 'manual', 1.00),
    ('doc_category', 'ct_scan_reports', 'ct scan', 'manual', 1.00),
    ('doc_category', 'discharge_summary', 'discharge note', 'manual', 1.00),
    ('doc_category', 'discharge_summary', 'discharge summary', 'manual', 1.00),
    ('doc_category', 'discharge_summary', 'ds', 'manual', 1.00),
    ('doc_category', 'discharge_summary', 'final discharge summary', 'manual', 1.00),
    ('doc_category', 'ecg', 'ecg', 'manual', 1.00),
    ('doc_category', 'ecg', 'ekg', 'manual', 1.00),
    ('doc_category', 'ecg', 'electrocardiogram', 'manual', 1.00),
    ('doc_category', 'echo', '2d echo', 'manual', 1.00),
    ('doc_category', 'echo', 'echocardiogram', 'manual', 1.00),
    ('doc_category', 'final_breakup_of_bill', 'bill breakup', 'manual', 1.00),
    ('doc_category', 'final_breakup_of_bill', 'final bill breakup', 'manual', 1.00),
    ('doc_category', 'gps_tagged_patient_photos', 'geotagged patient photo', 'manual', 1.00),
    ('doc_category', 'gps_tagged_patient_photos', 'gps patient photo', 'manual', 1.00),
    ('doc_category', 'gps_tagged_patient_photos', 'patient photo with gps', 'manual', 1.00),
    ('doc_category', 'high_risk_consent', 'high risk consent', 'manual', 1.00),
    ('doc_category', 'mri_reports', 'mri', 'manual', 1.00),
    ('doc_category', 'ot_notes', 'operation theatre notes', 'manual', 1.00),
    ('doc_category', 'ot_notes', 'ot notes', 'manual', 1.00),
    ('doc_category', 'patient_photo_without_gps', 'patient photo', 'manual', 0.70),
    ('doc_category', 'patient_photo_without_gps', 'patient photo no gps', 'manual', 1.00),
    ('doc_category', 'patient_photo_without_gps', 'patient photo without gps', 'manual', 1.00),
    ('doc_category', 'pharmacy_bill', 'medicine bill', 'manual', 1.00),
    ('doc_category', 'pmjay_bis_family_tree', 'bis family tree', 'manual', 1.00),
    ('doc_category', 'pmjay_bis_family_tree', 'family tree screenshot', 'manual', 1.00),
    ('doc_category', 'pmjay_bis_family_tree', 'pmjay bis family', 'manual', 1.00),
    ('doc_category', 'pmjay_bis_family_tree', 'pmjay family tree', 'manual', 1.00),
    ('doc_category', 'pre_authorization_form', 'pre auth', 'manual', 1.00),
    ('doc_category', 'pre_authorization_form', 'preauth', 'manual', 1.00),
    ('doc_category', 'pre_authorization_form', 'pre-authorization', 'manual', 1.00),
    ('doc_category', 'ration_card', 'antyodaya card', 'manual', 1.00),
    ('doc_category', 'ration_card', 'apl card', 'manual', 0.90),
    ('doc_category', 'ration_card', 'bpl card', 'manual', 0.90),
    ('doc_category', 'ration_card', 'pds card', 'manual', 1.00),
    ('doc_category', 'ration_card', 'public distribution card', 'manual', 1.00),
    ('doc_category', 'ration_card', 'rashan card', 'manual', 1.00),
    ('doc_category', 'ration_card', 'ration card', 'manual', 1.00),
    ('doc_category', 'surgery_consent_form', 'surgical consent', 'manual', 1.00),
    ('doc_category', 'surgery_notes', 'op notes', 'manual', 1.00),
    ('doc_category', 'ultrasound_reports', 'sonography', 'manual', 1.00),
    ('doc_category', 'ultrasound_reports', 'usg', 'manual', 1.00),
    ('doc_category', 'xray_reports', 'radiograph', 'manual', 1.00),
    ('doc_category', 'xray_reports', 'x ray', 'manual', 1.00),
    ('doc_category', 'xray_reports', 'x-ray', 'manual', 1.00),
    ('doc_category', 'xray_reports', 'xray', 'manual', 1.00)
ON CONFLICT (concept_category, alias) DO NOTHING;

