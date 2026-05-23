-- ============================================================================
-- MANUAL-RUN ONLY. NOT executed by the node-pg-migrate runner.
-- Apply with: psql -f PRODUCTION_GANGA_HOSPITAL_MIGRATION.sql (review first).
-- Moved from migrations/ to data-seeds/ on 2026-05-14 (BE-review M21).
-- ============================================================================
-- ============================================================================
-- CLAIMSOS GANGA HOSPITAL DATA MIGRATION
-- Date: April 27, 2026
-- Hospital ID: df2c60d6-d634-4697-a997-e9fd0f3b9960
-- Data: 24 attributes + 77 documents + 2 panels + 1 doctor with attributes
-- Prerequisites: PRODUCTION_NEW_TABLES_SCRIPT.sql & PRODUCTION_SEED_DATA_MIGRATION.sql
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. VERIFY GANGA HOSPITAL EXISTS (in existing hospitals table)
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hospital.hospitals WHERE id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960') THEN
    RAISE EXCEPTION 'Ganga Hospital not found in hospitals table. Hospital must exist before data migration.';
  END IF;
END $$;

-- ============================================================================
-- 2. HOSPITAL PROFILE FOR GANGA
-- ============================================================================

INSERT INTO hospital.hospital_profile (
  id, hospital_id, legal_name, city, state, pincode, website, phone,
  verification_level, is_public_profile_enabled,
  created_at, updated_at
) VALUES (
  'df2c60d6-d634-4697-a997-e9fd0f3b9960-profile'::uuid,
  'df2c60d6-d634-4697-a997-e9fd0f3b9960',
  'Ganga Super Speciality Hospital',
  'Bangalore',
  'Karnataka',
  '560063',
  'https://www.gangahospital.com',
  '9522584944',
  'none',
  true,
  NOW(),
  NOW()
) ON CONFLICT (hospital_id) DO NOTHING;

-- ============================================================================
-- 3. DOCTOR REGISTRATION (1 doctor)
-- ============================================================================

INSERT INTO hospital.doctors (
  id, first_name, last_name, email, primary_specialization,
  registration_status, is_public_profile_enabled,
  created_at, updated_at
) VALUES (
  '0e853029-d5fc-4d2b-8dc5-af51902aed3e',
  'Sreekanth',
  'Reddy',
  'sreekanthreddy@gmail.com',
  'Oncology',
  'active',
  true,
  NOW(),
  NOW()
) ON CONFLICT (email) DO NOTHING;

-- ============================================================================
-- 4. LINK DOCTOR TO GANGA HOSPITAL
-- ============================================================================

INSERT INTO hospital.hospital_doctors (
  hospital_id, doctor_id, employment_type, department, specialization,
  start_date, status,
  created_at, updated_at
) VALUES (
  'df2c60d6-d634-4697-a997-e9fd0f3b9960',
  '0e853029-d5fc-4d2b-8dc5-af51902aed3e',
  'consultant',
  'Oncology',
  'Oncology',
  '2024-01-01',
  'active',
  NOW(),
  NOW()
) ON CONFLICT (hospital_id, doctor_id) DO NOTHING;

-- ============================================================================
-- 5. HOSPITAL ATTRIBUTES FOR GANGA (24 attributes)
-- ============================================================================
-- NOTE: Actual attribute data can be imported via psql direct insert
-- For now, placeholder structure to demonstrate migration pattern
-- To get actual Ganga data, run:
-- psql -h prod-host -d claimsos -c "SELECT * FROM hospital.hospital_attributes
--   WHERE hospital_id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960'"

-- INSERT statements for Ganga hospital attributes would go here (24 rows)
-- Similar pattern to Pragati above - omitted for brevity but should include:
-- - Accreditation attributes
-- - Bed configuration
-- - Compliance certificates
-- - Equipment details
-- - Services offered
-- - Tariff information

-- To complete this section, export from local DB:
-- PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod \
--   -c "COPY (SELECT id, hospital_id, attribute_key, value_text, value_date,
--            value_boolean, value_integer, certificate_number, issuing_authority,
--            issued_at, expires_at, verification_status FROM hospital.hospital_attributes
--            WHERE hospital_id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960')
--       TO STDOUT;" > ganga_attributes.csv

-- ============================================================================
-- 6. HOSPITAL DOCUMENTS FOR GANGA (77 documents)
-- ============================================================================
-- NOTE: Ganga has 77 documents which is too large to include inline
-- Export from local DB and import via CSV or COPY statement:

-- PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod \
--   -c "COPY (SELECT id, hospital_id, document_category, document_name, s3_key,
--            file_name, mime_type FROM hospital.hospital_documents
--            WHERE hospital_id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960')
--       TO STDOUT;" > ganga_documents.csv

-- Then import on production:
-- psql -h prod-host -d claimsos -c "COPY hospital.hospital_documents
--   FROM STDIN WITH (FORMAT csv)" < ganga_documents.csv

-- ============================================================================
-- 7. HOSPITAL PANELS FOR GANGA (2 panels)
-- ============================================================================
-- Note: Panels structure differs - check actual schema
-- Placeholder for panel configuration

-- ============================================================================
-- 8. VERIFICATION
-- ============================================================================

SELECT 'GANGA HOSPITAL MIGRATION STATUS' as status;

SELECT 'Hospital Profile' as item, COUNT(*) as count
FROM hospital.hospital_profile
WHERE hospital_id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960';

SELECT 'Doctors Registered' as item, COUNT(*) as count
FROM hospital.hospital_doctors
WHERE hospital_id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960';

SELECT 'Hospital Attributes' as item, COUNT(*) as count
FROM hospital.hospital_attributes
WHERE hospital_id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960';

SELECT 'Hospital Documents' as item, COUNT(*) as count
FROM hospital.hospital_documents
WHERE hospital_id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960';

COMMIT;

-- ============================================================================
-- NEXT STEPS FOR COMPLETE GANGA MIGRATION
-- ============================================================================
-- 1. Export attributes data from local database:
--    PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod \
--      -c "SELECT id, hospital_id, attribute_key, value_text, value_date, value_boolean,
--             value_integer, certificate_number, issuing_authority, issued_at, expires_at,
--             verification_status FROM hospital.hospital_attributes
--             WHERE hospital_id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960'" > /tmp/ganga_attrs.sql
--
-- 2. Export documents from local database:
--    PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod \
--      -c "SELECT id, hospital_id, document_category, document_name, s3_key, file_name, mime_type
--             FROM hospital.hospital_documents
--             WHERE hospital_id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960'" > /tmp/ganga_docs.sql
--
-- 3. Review hospital_panels schema and export panel configuration
--
-- 4. Execute generated INSERT statements on production
--
-- ============================================================================
