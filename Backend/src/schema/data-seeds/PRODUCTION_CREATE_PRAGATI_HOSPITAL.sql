-- ============================================================================
-- MANUAL-RUN ONLY. NOT executed by the node-pg-migrate runner.
-- Apply with: psql -f PRODUCTION_CREATE_PRAGATI_HOSPITAL.sql (review first).
-- Moved from migrations/ to data-seeds/ on 2026-05-14 (BE-review M21).
-- ============================================================================
-- ============================================================================
-- CREATE PRAGATI HOSPITAL RECORD
-- Date: April 27, 2026
-- Purpose: Create the base hospital record before data migration
-- ============================================================================

BEGIN;

-- ============================================================================
-- CREATE PRAGATI HOSPITAL IN HOSPITALS TABLE
-- ============================================================================

INSERT INTO hospital.hospitals (
  id, name, city, drive_folder_id, details, is_cashless_everywhere_active,
  cashless_everywhere_enrollment_date, cashless_everywhere_status,
  created_at, updated_at
) VALUES (
  '9a16278c-5605-4116-b19e-d434716af27a',
  'Pragati Hospital and Stem Cell Centre',
  'Bhopal',
  'https://drive.google.com/drive/folders/1TZ7PBXMVIlMrp2ukyD1Gh6DgZScQmIK0?usp=drive_link',
  NULL,
  true,
  '2026-04-21',
  'active',
  NOW(),
  NOW()
) ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

SELECT 'Hospital Creation Result' as status;
SELECT id, name, city FROM hospital.hospitals
WHERE id = '9a16278c-5605-4116-b19e-d434716af27a';

COMMIT;

-- ============================================================================
-- SUCCESS MESSAGE
-- ============================================================================
-- Pragati Hospital record created successfully!
-- Now you can run: PRODUCTION_PRAGATI_HOSPITAL_MIGRATION.sql
-- ============================================================================
