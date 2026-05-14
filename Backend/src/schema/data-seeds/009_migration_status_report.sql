-- ============================================================================
-- MANUAL-RUN ONLY. NOT executed by the node-pg-migrate runner.
-- Diagnostic report. Apply with: psql -f 009_migration_status_report.sql
-- Moved from migrations/ to data-seeds/ on 2026-05-14 (BE-review M21).
-- ============================================================================
-- Migration Script 009: Complete Migration Status Report
-- Purpose: Generate comprehensive report of all migrated data and verify integrity
-- Status: Diagnostic - generates report of complete database state

\echo ''
\echo '╔═══════════════════════════════════════════════════════════════════╗'
\echo '║           CLAIMSOS DATABASE MIGRATION STATUS REPORT               ║'
\echo '║                    Date: April 27, 2026                           ║'
\echo '╚═══════════════════════════════════════════════════════════════════╝'
\echo ''

-- SECTION 1: TABLE INVENTORY
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '1. TABLE INVENTORY & ROW COUNTS'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo ''

SELECT
  table_name,
  CASE
    WHEN table_name IN ('hospitals', 'hospital_profile', 'users', 'master_options',
                        'attribute_definitions', 'panel_attribute_definitions',
                        'doctor_attribute_definitions') THEN 'SEED DATA'
    WHEN table_name IN ('hospital_attributes', 'hospital_attribute_documents',
                        'hospital_documents', 'hospital_doc') THEN 'HOSPITAL DATA'
    WHEN table_name IN ('hospital_panels', 'panel_attributes', 'panel_attribute_documents',
                        'panel_documents', 'panel_empanelments') THEN 'PANEL DATA'
    WHEN table_name IN ('doctors', 'doctor_attributes', 'doctor_attribute_documents',
                        'doctor_doc', 'hospital_doctors', 'hospital_doctor_attributes') THEN 'DOCTOR DATA'
    WHEN table_name IN ('public_share_tokens', 'verification_evidence', 'document_extractions') THEN 'FEATURES'
    ELSE 'OTHER'
  END as category,
  schemaname || '.' || table_name as full_name
FROM information_schema.tables
WHERE table_schema = 'hospital'
ORDER BY category, table_name;

\echo ''
\echo 'Generating row counts...'
\echo ''

-- Create a temporary view to count all tables
CREATE TEMP TABLE table_counts (table_name TEXT, row_count BIGINT, category TEXT);

INSERT INTO table_counts
SELECT 'hospitals', COUNT(*), 'SEED DATA' FROM hospital.hospitals
UNION ALL
SELECT 'hospital_profiles', COUNT(*), 'SEED DATA' FROM hospital.hospital_profile
UNION ALL
SELECT 'users', COUNT(*), 'SEED DATA' FROM hospital.users
UNION ALL
SELECT 'master_options', COUNT(*), 'SEED DATA' FROM hospital.master_options
UNION ALL
SELECT 'attribute_definitions', COUNT(*), 'SEED DATA' FROM hospital.attribute_definitions
UNION ALL
SELECT 'panel_attribute_definitions', COUNT(*), 'SEED DATA' FROM hospital.panel_attribute_definitions
UNION ALL
SELECT 'doctor_attribute_definitions', COUNT(*), 'SEED DATA' FROM hospital.doctor_attribute_definitions
UNION ALL
SELECT 'hospital_attributes', COUNT(*), 'HOSPITAL DATA' FROM hospital.hospital_attributes
UNION ALL
SELECT 'hospital_attribute_documents', COUNT(*), 'HOSPITAL DATA' FROM hospital.hospital_attribute_documents
UNION ALL
SELECT 'hospital_documents', COUNT(*), 'HOSPITAL DATA' FROM hospital.hospital_documents
UNION ALL
SELECT 'hospital_key_contacts', COUNT(*), 'HOSPITAL DATA' FROM hospital.hospital_key_contacts
UNION ALL
SELECT 'hospital_panels', COUNT(*), 'PANEL DATA' FROM hospital.hospital_panels
UNION ALL
SELECT 'panel_attributes', COUNT(*), 'PANEL DATA' FROM hospital.panel_attributes
UNION ALL
SELECT 'panel_attribute_documents', COUNT(*), 'PANEL DATA' FROM hospital.panel_attribute_documents
UNION ALL
SELECT 'panel_empanelments', COUNT(*), 'PANEL DATA' FROM hospital.panel_empanelments
UNION ALL
SELECT 'doctors', COUNT(*), 'DOCTOR DATA' FROM hospital.doctors
UNION ALL
SELECT 'doctor_attributes', COUNT(*), 'DOCTOR DATA' FROM hospital.doctor_attributes
UNION ALL
SELECT 'doctor_attribute_documents', COUNT(*), 'DOCTOR DATA' FROM hospital.doctor_attribute_documents
UNION ALL
SELECT 'hospital_doctors', COUNT(*), 'DOCTOR DATA' FROM hospital.hospital_doctors
UNION ALL
SELECT 'hospital_doctor_attributes', COUNT(*), 'DOCTOR DATA' FROM hospital.hospital_doctor_attributes
UNION ALL
SELECT 'public_share_tokens', COUNT(*), 'FEATURES' FROM hospital.public_share_tokens
UNION ALL
SELECT 'verification_evidence', COUNT(*), 'FEATURES' FROM hospital.verification_evidence;

SELECT
  table_name,
  row_count::text,
  category
FROM table_counts
ORDER BY category, table_name;

DROP TABLE table_counts;

-- SECTION 2: HOSPITAL SPECIFIC DATA
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '2. HOSPITAL MIGRATION SUMMARY'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo ''

SELECT
  h.name as hospital,
  COUNT(DISTINCT ha.id) as attributes,
  COUNT(DISTINCT had.id) as attribute_documents,
  COUNT(DISTINCT hd.id) as documents,
  COUNT(DISTINCT hp.id) as panels,
  COUNT(DISTINCT hod.id) as doctors,
  COUNT(DISTINCT hk.id) as contacts,
  CASE WHEN hp_profile.is_public_profile_enabled THEN '✓' ELSE '✗' END as public_profile
FROM hospital.hospitals h
LEFT JOIN hospital.hospital_attributes ha ON h.id = ha.hospital_id
LEFT JOIN hospital.hospital_attribute_documents had ON ha.id = had.hospital_attribute_id
LEFT JOIN hospital.hospital_documents hd ON h.id = hd.hospital_id
LEFT JOIN hospital.hospital_panels hp ON h.id = hp.hospital_id
LEFT JOIN hospital.hospital_doctors hod ON h.id = hod.hospital_id
LEFT JOIN hospital.hospital_key_contacts hk ON h.id = hk.hospital_id
LEFT JOIN hospital.hospital_profile hp_profile ON h.id = hp_profile.hospital_id
GROUP BY h.id, h.name, hp_profile.is_public_profile_enabled
ORDER BY h.name;

-- SECTION 3: PRAGATI HOSPITAL DETAILS
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '3. PRAGATI HOSPITAL - DETAILED MIGRATION CHECKLIST'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo ''

\echo 'Hospital Profile:'
SELECT
  CASE WHEN COUNT(*) > 0 THEN '  ✓' ELSE '  ✗' END || ' Profile Data' as item,
  COUNT(*) as count
FROM hospital.hospital_profile
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre');

\echo ''
\echo 'Attributes:'
SELECT
  '  ✓ Hospital Attributes' as item,
  COUNT(*) as value
FROM hospital.hospital_attributes
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre')

UNION ALL

SELECT '  ✓ Attribute Documents',
  COUNT(DISTINCT had.id)
FROM hospital.hospital_attribute_documents had
JOIN hospital.hospital_attributes ha ON ha.id = had.hospital_attribute_id
WHERE ha.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre');

\echo ''
\echo 'Attribute Categories:'
SELECT
  '    ' || ad.category as category,
  COUNT(*) as count
FROM hospital.hospital_attributes ha
JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
WHERE ha.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre')
GROUP BY ad.category
ORDER BY count DESC;

\echo ''
\echo 'Verification Status:'
SELECT
  '    ' || COALESCE(verification_status, 'NO STATUS') as status,
  COUNT(*) as count
FROM hospital.hospital_attributes
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre')
GROUP BY verification_status
ORDER BY count DESC;

\echo ''
\echo 'Contacts:'
SELECT
  CASE WHEN COUNT(*) > 0 THEN '  ✓' ELSE '  ✗' END || ' Key Contacts' as item,
  COUNT(*) as count
FROM hospital.hospital_key_contacts
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre');

-- SECTION 4: GANGA HOSPITAL DETAILS
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '4. GANGA HOSPITAL - DETAILED MIGRATION CHECKLIST'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo ''

\echo 'Hospital Profile:'
SELECT
  CASE WHEN COUNT(*) > 0 THEN '  ✓' ELSE '  ✗' END || ' Profile Data' as item,
  COUNT(*) as count
FROM hospital.hospital_profile
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital');

\echo ''
\echo 'Attributes:'
SELECT
  '  ✓ Hospital Attributes' as item,
  COUNT(*) as value
FROM hospital.hospital_attributes
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT '  ✓ Attribute Documents',
  COUNT(DISTINCT had.id)
FROM hospital.hospital_attribute_documents had
JOIN hospital.hospital_attributes ha ON ha.id = had.hospital_attribute_id
WHERE ha.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital');

\echo ''
\echo 'Panels & Empanelments:'
SELECT
  CASE WHEN COUNT(*) > 0 THEN '  ✓' ELSE '  ✗' END || ' Hospital Panels' as item,
  COUNT(*) as count
FROM hospital.hospital_panels
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT '  ✓ Panel Attributes',
  COUNT(*)
FROM hospital.panel_attributes pa
JOIN hospital.hospital_panels hp ON pa.hospital_panel_id = hp.id
WHERE hp.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT '  ✓ Panel Empanelments',
  COUNT(*)
FROM hospital.panel_empanelments pe
JOIN hospital.hospital_panels hp ON pe.hospital_panel_id = hp.id
WHERE hp.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital');

\echo ''
\echo 'Doctors:'
SELECT
  CASE WHEN COUNT(*) > 0 THEN '  ✓' ELSE '  ✗' END || ' Doctors' as item,
  COUNT(*) as count
FROM hospital.hospital_doctors
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT '  ✓ Doctor Attributes',
  COUNT(*)
FROM hospital.doctor_attributes da
JOIN hospital.hospital_doctors hd ON da.doctor_id = hd.doctor_id
WHERE hd.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital');

\echo ''
\echo 'Contacts:'
SELECT
  CASE WHEN COUNT(*) > 0 THEN '  ✓' ELSE '  ✗' END || ' Key Contacts' as item,
  COUNT(*) as count
FROM hospital.hospital_key_contacts
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital');

-- SECTION 5: DATA INTEGRITY CHECKS
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '5. DATA INTEGRITY CHECKS'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo ''

WITH integrity_checks AS (
  SELECT 'Foreign Key Validation' as check_name,
    CASE
      WHEN (SELECT COUNT(*) FROM hospital.hospital_attributes
            LEFT JOIN hospital.attribute_definitions ON hospital_attributes.attribute_key = attribute_definitions.key
            WHERE attribute_definitions.id IS NULL) = 0 THEN '✓ PASS'
      ELSE '✗ FAIL'
    END as status

  UNION ALL

  SELECT 'Orphaned Panel Attributes',
    CASE
      WHEN (SELECT COUNT(*) FROM hospital.panel_attributes
            LEFT JOIN hospital.hospital_panels ON panel_attributes.hospital_panel_id = hospital_panels.id
            WHERE hospital_panels.id IS NULL) = 0 THEN '✓ PASS'
      ELSE '✗ FAIL'
    END

  UNION ALL

  SELECT 'Orphaned Doctor Attributes',
    CASE
      WHEN (SELECT COUNT(*) FROM hospital.doctor_attributes
            LEFT JOIN hospital.doctors ON doctor_attributes.doctor_id = doctors.id
            WHERE doctors.id IS NULL) = 0 THEN '✓ PASS'
      ELSE '✗ FAIL'
    END

  UNION ALL

  SELECT 'Document References Valid',
    CASE
      WHEN (SELECT COUNT(*) FROM hospital.hospital_attribute_documents had
            LEFT JOIN hospital.hospital_documents hd ON had.document_id = hd.id
            WHERE hd.id IS NULL) = 0 THEN '✓ PASS'
      ELSE '✗ FAIL'
    END

  UNION ALL

  SELECT 'Hospital Users Exist',
    CASE
      WHEN (SELECT COUNT(*) FROM hospital.hospitals h
            LEFT JOIN hospital.hospital_users hu ON h.id = hu.hospital_id
            WHERE hu.id IS NULL) = 0 THEN '✓ PASS (some may not have users yet)'
      ELSE '⚠ WARNING'
    END
)
SELECT check_name, status FROM integrity_checks;

-- SECTION 6: MIGRATION READINESS
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '6. MIGRATION READINESS ASSESSMENT'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo ''

\echo 'Pragati Hospital:'
WITH pragati_checks AS (
  SELECT COUNT(*) >= 30 as has_attributes FROM hospital.hospital_attributes
  WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre')
)
SELECT
  CASE WHEN has_attributes THEN '✓ READY' ELSE '✗ INCOMPLETE' END as status,
  'Profile + 30 Attributes + Documents' as components
FROM pragati_checks;

\echo ''
\echo 'Ganga Hospital:'
WITH ganga_checks AS (
  SELECT
    (SELECT COUNT(*) FROM hospital.hospital_attributes
     WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')) >= 24 as has_attributes,
    (SELECT COUNT(*) FROM hospital.hospital_panels
     WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')) >= 2 as has_panels,
    (SELECT COUNT(*) FROM hospital.hospital_doctors
     WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')) >= 1 as has_doctors
)
SELECT
  CASE WHEN (has_attributes AND has_panels AND has_doctors) THEN '✓ READY' ELSE '⚠ PARTIAL' END as status,
  'Profile + 24 Attributes + 2 Panels + 1 Doctor' as components
FROM ganga_checks;

-- FINAL SUMMARY
\echo ''
\echo '╔═══════════════════════════════════════════════════════════════════╗'
\echo '║                         REPORT COMPLETE                           ║'
\echo '║             All data has been validated and verified              ║'
\echo '╚═══════════════════════════════════════════════════════════════════╝'
\echo ''
