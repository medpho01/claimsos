-- ============================================================================
-- Wave 9 follow-up — operator-requested doc_category vocabulary additions.
-- ============================================================================
-- Ops needs the classifier to distinguish Aadhaar front vs back, with-GPS vs
-- without-GPS patient photos, and to recognise PMJAY BIS family-tree
-- screenshots. Migration 042 only had a single combined `aadhaar_card` row
-- (which matched whichever side the OCR happened to land on) and a single
-- `gps_tagged_patient_photos` row (so an ungeoreferenced patient photo had
-- to be bucketed under `general_patient_photo`, which auditors confused
-- with the GPS-tagged one).
--
-- Changes:
--   1. Rename label of existing `aadhaar_card` → "Aadhaar Back".
--      Existing rows on document_sections keep their `category='aadhaar_card'`
--      code; this is a label-only change so the FE display flips immediately
--      without a data migration.
--   2. Add `aadhaar_front` as a sibling code in kyc_identity_insurance.
--   3. Rename label of `gps_tagged_patient_photos` → "Patient Photo with GPS".
--   4. Add `patient_photo_without_gps` in the patient_photos_visual group.
--   5. Add `pmjay_bis_family_tree` in audit_intelligence_metadata (alongside
--      `bis_screenshot` — same PMJAY auth-artefact lineage).
--   6. Seed aliases on doc_category_aliases so the OCR-based hint layer in
--      docClassifier matches incoming text variants.

BEGIN;

-- ─── 1 + 3: relabel existing codes ───────────────────────────────────────
UPDATE hospital.master_options
   SET label = 'Aadhaar Back'
 WHERE category = 'doc_category' AND code = 'aadhaar_card';

UPDATE hospital.master_options
   SET label = 'Patient Photo with GPS'
 WHERE category = 'doc_category' AND code = 'gps_tagged_patient_photos';

-- ─── 2 + 4 + 5: new codes ────────────────────────────────────────────────
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code) VALUES
    ('doc_category', 'aadhaar_front',              'Aadhaar Front',             1011, 'kyc_identity_insurance'),
    ('doc_category', 'ration_card',                'Ration Card',               1180, 'kyc_identity_insurance'),
    ('doc_category', 'patient_photo_without_gps',  'Patient Photo without GPS', 9015, 'patient_photos_visual'),
    ('doc_category', 'pmjay_bis_family_tree',      'PMJAY BIS Family Tree',    15180, 'audit_intelligence_metadata')
ON CONFLICT (category, code) DO UPDATE
    SET label = EXCLUDED.label,
        group_code = EXCLUDED.group_code,
        sort_order = EXCLUDED.sort_order,
        is_active = true;

-- ─── 6: seed aliases for the classifier's hint layer ─────────────────────
-- Aadhaar back — backfill an explicit alias so OCR text "aadhar back" maps
-- here, plus existing aliases stay valid.
INSERT INTO hospital.concept_aliases (concept_category, concept_code, alias, alias_source, confidence) VALUES
    ('doc_category', 'aadhaar_card',              'aadhar back',           'manual', 1.0),
    ('doc_category', 'aadhaar_card',              'aadhaar back',          'manual', 1.0),
    ('doc_category', 'aadhaar_card',              'back side aadhar',      'manual', 1.0),

    ('doc_category', 'aadhaar_front',             'aadhar front',          'manual', 1.0),
    ('doc_category', 'aadhaar_front',             'aadhaar front',         'manual', 1.0),
    ('doc_category', 'aadhaar_front',             'front side aadhar',     'manual', 1.0),
    ('doc_category', 'aadhaar_front',             'uid front',             'manual', 1.0),

    ('doc_category', 'patient_photo_without_gps', 'patient photo',         'manual', 0.7),
    ('doc_category', 'patient_photo_without_gps', 'patient photo no gps',  'manual', 1.0),
    ('doc_category', 'patient_photo_without_gps', 'patient photo without gps', 'manual', 1.0),

    ('doc_category', 'gps_tagged_patient_photos', 'patient photo with gps','manual', 1.0),
    ('doc_category', 'gps_tagged_patient_photos', 'gps patient photo',     'manual', 1.0),
    ('doc_category', 'gps_tagged_patient_photos', 'geotagged patient photo','manual', 1.0),

    ('doc_category', 'pmjay_bis_family_tree',     'pmjay family tree',     'manual', 1.0),
    ('doc_category', 'pmjay_bis_family_tree',     'bis family tree',       'manual', 1.0),
    ('doc_category', 'pmjay_bis_family_tree',     'family tree screenshot','manual', 1.0),
    ('doc_category', 'pmjay_bis_family_tree',     'pmjay bis family',      'manual', 1.0),

    ('doc_category', 'ration_card',               'ration card',           'manual', 1.0),
    ('doc_category', 'ration_card',               'rashan card',           'manual', 1.0),
    ('doc_category', 'ration_card',               'pds card',              'manual', 1.0),
    ('doc_category', 'ration_card',               'public distribution card', 'manual', 1.0),
    ('doc_category', 'ration_card',               'apl card',              'manual', 0.9),
    ('doc_category', 'ration_card',               'bpl card',              'manual', 0.9),
    ('doc_category', 'ration_card',               'antyodaya card',        'manual', 1.0)
ON CONFLICT (concept_category, alias) DO NOTHING;

COMMIT;
