-- ============================================================================
-- Taxonomy cleanup + PMJAY card/letter categories
-- ============================================================================
-- Three changes diagnosed from Qamruddin's misclassifications (May 20, 2026):
--
-- 1. The existing code `aadhaar_card` has a misleading label "Aadhaar Back"
--    in master_options. The label was applied to a code whose intent was
--    "any Aadhaar card (front+back)" — causing the FE to render Aadhaar
--    FRONT pages with the label "Aadhaar Back". Fix: rename the code to
--    `aadhaar_back` (matches the actual semantics) and add a NEW code
--    `aadhaar_card` for the generic case where front+back are on the
--    same page or unclear. End state:
--      aadhaar_front  — code unchanged, label "Aadhaar Front"  (existing)
--      aadhaar_back   — RENAMED from aadhaar_card             (existing data preserved)
--      aadhaar_card   — NEW generic catch-all
--
-- 2. Ayushman Card / PM-JAY beneficiary card had no slot. The classifier
--    was forced to pick `abha_card` (digital health ID) for them, which
--    is a related but distinct document. Add `pmjay_card`.
--
-- 3. The PMJAY scheme also issues a *letter* (the one with the PM image
--    and welcome text). It was being mis-classified as `aadhaar_card`.
--    Add `pmjay_letter`.
--
-- Companion field schemas seeded for pmjay_card + pmjay_letter so the
-- extractor has something to pull.

BEGIN;

-- ─── Step 1: rename existing aadhaar_card → aadhaar_back ────────────────
--   The master_options row gets its CODE updated. The label is also
--   corrected to match the new code's semantics.
UPDATE hospital.master_options
   SET code = 'aadhaar_back',
       label = 'Aadhaar Back',
       updated_at = NOW()
 WHERE category = 'doc_category'
   AND code = 'aadhaar_card';

-- Cascade the rename to existing data — every section currently
-- classified as `aadhaar_card` represented the Aadhaar back (per the
-- pre-existing label), so it correctly becomes `aadhaar_back`.
UPDATE hospital.document_sections
   SET category = 'aadhaar_back',
       updated_at = NOW()
 WHERE category = 'aadhaar_card';

-- Same for field schemas if any were seeded under aadhaar_card.
UPDATE hospital.document_field_schemas
   SET doc_category = 'aadhaar_back'
 WHERE doc_category = 'aadhaar_card';

-- ─── Step 2: add NEW generic aadhaar_card category ──────────────────────
--   Use case: scanned ID with BOTH sides on one page, or when the
--   classifier can't tell which side it's looking at. Default
--   behaviour is to encourage the classifier to pick front/back
--   specifically; aadhaar_card is the fallback.
INSERT INTO hospital.master_options (category, code, label, sort_order, is_active, created_at, updated_at)
VALUES ('doc_category', 'aadhaar_card', 'Aadhaar Card', 999, true, NOW(), NOW())
ON CONFLICT (category, code) DO UPDATE SET label = EXCLUDED.label, is_active = true, updated_at = NOW();

-- ─── Step 3: add PMJAY Card (Ayushman Bharat beneficiary card) ──────────
--   The physical card with the holder's photo, ABHA-style ID, village,
--   district — distinct from abha_card which is the digital health ID
--   alone. Both can coexist; PMJAY is the scheme membership, ABHA is
--   the digital identity.
INSERT INTO hospital.master_options (category, code, label, sort_order, is_active, created_at, updated_at)
VALUES ('doc_category', 'pmjay_card', 'PMJAY / Ayushman Card', 999, true, NOW(), NOW())
ON CONFLICT (category, code) DO UPDATE SET label = EXCLUDED.label, is_active = true, updated_at = NOW();

-- ─── Step 4: add PMJAY Welcome Letter ───────────────────────────────────
--   Government letter with PM image + welcome text + scheme rules.
--   Often co-uploaded with the PMJAY card. Mis-classified as Aadhaar
--   Back in Qamruddin's case because the PM portrait + Hindi text
--   pattern looks visually similar to Aadhaar.
INSERT INTO hospital.master_options (category, code, label, sort_order, is_active, created_at, updated_at)
VALUES ('doc_category', 'pmjay_letter', 'PMJAY Welcome Letter', 999, true, NOW(), NOW())
ON CONFLICT (category, code) DO UPDATE SET label = EXCLUDED.label, is_active = true, updated_at = NOW();

-- ─── Step 5: field schemas for the new categories ───────────────────────
-- PMJAY Card — name, photo, scheme membership IDs.
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority) VALUES
    ('pmjay_card', 'holder_name',        'Holder Name',           'text',  true,  NULL, 10),
    ('pmjay_card', 'date_of_birth',      'Date of Birth / YOB',   'date',  false, NULL, 20),
    ('pmjay_card', 'gender',             'Gender',                'enum',  false, '["male","female","other"]'::jsonb, 30),
    ('pmjay_card', 'pmjay_id',           'PM-JAY ID',             'text',  false, NULL, 40),
    ('pmjay_card', 'abha_number',        'ABHA Number',           'text',  false, NULL, 50),
    ('pmjay_card', 'village',            'Village / Town',        'text',  false, NULL, 60),
    ('pmjay_card', 'district',           'District',              'text',  false, NULL, 70),
    ('pmjay_card', 'state',              'State',                 'text',  false, NULL, 80)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- PMJAY Letter — letter-specific fields.
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority) VALUES
    ('pmjay_letter', 'household_head',        'Head of Household',     'text',   false, NULL, 10),
    ('pmjay_letter', 'family_members_count',  'Family Members Listed', 'number', false, NULL, 20),
    ('pmjay_letter', 'activation_code',       'Activation Code',       'text',   false, NULL, 30),
    ('pmjay_letter', 'ayushman_bharat_id',    'Ayushman Bharat ID',    'text',   false, NULL, 40),
    ('pmjay_letter', 'state',                 'State',                 'text',   false, NULL, 50),
    ('pmjay_letter', 'district',              'District',              'text',   false, NULL, 60),
    ('pmjay_letter', 'helpline_number',       'Helpline Number',       'text',   false, NULL, 70)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- aadhaar_card (the new generic) — same shape as aadhaar_front (name + UID).
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key, field_label, field_type, is_required, enum_values, extraction_priority) VALUES
    ('aadhaar_card', 'holder_name',     'Holder Name',     'text', true,  NULL, 10),
    ('aadhaar_card', 'aadhaar_number',  'Aadhaar Number',  'text', true,  NULL, 20),
    ('aadhaar_card', 'date_of_birth',   'Date of Birth',   'date', false, NULL, 30),
    ('aadhaar_card', 'gender',          'Gender',          'enum', false, '["male","female","other"]'::jsonb, 40),
    ('aadhaar_card', 'address',         'Address',         'text', false, NULL, 50)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

COMMIT;
