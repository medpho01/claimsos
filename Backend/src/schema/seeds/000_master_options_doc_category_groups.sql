-- ==========================================================================
-- 000 — master_options: doc_category_group (top-level document groups)
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
--   042_doc_taxonomy_expansion.sql section B
--
-- MUST be applied before 010: the hospital.doc_category_groups view (042:496)
-- LEFT JOINs doc_category rows to these rows on group_code, and 010's rows
-- carry group_code values that have to resolve here.
-- ==========================================================================

INSERT INTO hospital.master_options (category, code, label, sort_order, group_code, is_active) VALUES
    ('doc_category_group', 'kyc_identity_insurance', 'KYC / Identity / Insurance', 10, NULL, true),
    ('doc_category_group', 'insurance_authorization', 'Insurance & Authorization', 20, NULL, true),
    ('doc_category_group', 'clinical_medical', 'Clinical / Medical', 30, NULL, true),
    ('doc_category_group', 'diagnostic_investigation', 'Diagnostic & Investigation', 40, NULL, true),
    ('doc_category_group', 'surgical_procedure', 'Surgical / Procedure', 50, NULL, true),
    ('doc_category_group', 'billing_financial', 'Billing & Financial', 60, NULL, true),
    ('doc_category_group', 'discharge_outcome', 'Discharge & Outcome', 70, NULL, true),
    ('doc_category_group', 'consent_legal', 'Consent & Legal', 80, NULL, true),
    ('doc_category_group', 'patient_photos_visual', 'Patient Photos & Visual Evidence', 90, NULL, true),
    ('doc_category_group', 'icu_critical_care', 'ICU / Critical Care', 100, NULL, true),
    ('doc_category_group', 'pharmacy_medication', 'Pharmacy & Medication', 110, NULL, true),
    ('doc_category_group', 'rehabilitation_therapy', 'Rehabilitation & Therapy', 120, NULL, true),
    ('doc_category_group', 'specialized_treatment', 'Specialized Treatment', 130, NULL, true),
    ('doc_category_group', 'administrative_operational', 'Administrative & Operational', 140, NULL, true),
    ('doc_category_group', 'audit_intelligence_metadata', 'Audit & Claims Intelligence Metadata', 150, NULL, true)
ON CONFLICT (category, code) DO UPDATE SET
    label      = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    group_code = EXCLUDED.group_code,
    is_active  = EXCLUDED.is_active,
    updated_at = NOW();

