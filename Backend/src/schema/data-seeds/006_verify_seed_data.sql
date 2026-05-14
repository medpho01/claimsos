-- ============================================================================
-- MANUAL-RUN ONLY. NOT executed by the node-pg-migrate runner.
-- Diagnostic script. Apply with: psql -f 006_verify_seed_data.sql
-- Moved from migrations/ to data-seeds/ on 2026-05-14 (BE-review M21).
-- ============================================================================
-- Migration Script 006: Verify Seed Data Integrity
-- Purpose: Check if all seed data is properly populated
-- Status: Diagnostic - no changes to database

\echo ''
\echo '==================================================='
\echo 'MIGRATION 006: SEED DATA VERIFICATION'
\echo '==================================================='
\echo ''

-- 1. ATTRIBUTE DEFINITIONS INVENTORY
\echo '1. ATTRIBUTE DEFINITIONS (Hospital)'
SELECT
    category,
    COUNT(*) as count,
    STRING_AGG(label, ', ' ORDER BY label) as definitions
FROM hospital.attribute_definitions
GROUP BY category
ORDER BY category;

\echo ''
\echo '2. PANEL ATTRIBUTE DEFINITIONS'
SELECT
    category,
    COUNT(*) as count,
    STRING_AGG(label, ', ' ORDER BY label) as definitions
FROM hospital.panel_attribute_definitions
GROUP BY category
ORDER BY category;

\echo ''
\echo '3. DOCTOR ATTRIBUTE DEFINITIONS'
SELECT
    category,
    COUNT(*) as count,
    STRING_AGG(label, ', ' ORDER BY label) as definitions
FROM hospital.doctor_attribute_definitions
GROUP BY category
ORDER BY category;

-- 2. MASTER OPTIONS INVENTORY
\echo ''
\echo '4. MASTER OPTIONS (Dropdowns/Enums)'
SELECT
    category,
    COUNT(*) as options,
    STRING_AGG(value, ', ' ORDER BY value LIMIT 5) as sample_values
FROM hospital.master_options
WHERE is_active = true
GROUP BY category
ORDER BY category;

-- 3. DEFAULT DATA
\echo ''
\echo '5. HOSPITALS REGISTERED'
SELECT
    id,
    name,
    city,
    COUNT(DISTINCT ha.id) as attribute_count,
    COUNT(DISTINCT hp.id) as panel_count,
    COUNT(DISTINCT hd.id) as doctor_count
FROM hospital.hospitals h
LEFT JOIN hospital.hospital_attributes ha ON h.id = ha.hospital_id
LEFT JOIN hospital.hospital_panels hp ON h.id = hp.hospital_id
LEFT JOIN hospital.hospital_doctors hd ON h.id = hd.hospital_id
GROUP BY h.id, h.name, h.city
ORDER BY h.name;

-- 4. DATA SUMMARY
\echo ''
\echo '=== DATA SUMMARY ==='

\echo ''
\echo 'Hospital Attributes per Definition Type'
SELECT
    ad.label,
    ad.data_type,
    COUNT(ha.id) as count
FROM hospital.attribute_definitions ad
LEFT JOIN hospital.hospital_attributes ha ON ad.key = ha.attribute_key
GROUP BY ad.id, ad.label, ad.data_type
ORDER BY ad.label;

\echo ''
\echo 'Hospital Attribute Documents'
SELECT
    h.name as hospital,
    COUNT(DISTINCT had.id) as document_count,
    COUNT(DISTINCT ha.id) as attributes_with_docs
FROM hospital.hospitals h
LEFT JOIN hospital.hospital_attributes ha ON h.id = ha.hospital_id
LEFT JOIN hospital.hospital_attribute_documents had ON ha.id = had.hospital_attribute_id
GROUP BY h.id, h.name
ORDER BY h.name;

-- 5. VERIFICATION STATUS CHECK
\echo ''
\echo 'Verification Status Distribution (Hospital Attributes)'
SELECT
    verification_status,
    COUNT(*) as count
FROM hospital.hospital_attributes
GROUP BY verification_status
ORDER BY count DESC;

-- 6. ORPHANED RECORDS CHECK
\echo ''
\echo '=== DATA INTEGRITY CHECKS ==='

\echo ''
\echo 'Orphaned Hospital Attributes (definition not found)'
SELECT
    h.name as hospital,
    ha.attribute_key,
    COUNT(*) as count
FROM hospital.hospital_attributes ha
LEFT JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
LEFT JOIN hospital.hospitals h ON ha.hospital_id = h.id
WHERE ad.id IS NULL
GROUP BY h.id, h.name, ha.attribute_key;

\echo ''
\echo 'Panel Attributes without Panel'
SELECT
    COUNT(*) as orphaned_count
FROM hospital.panel_attributes pa
LEFT JOIN hospital.hospital_panels hp ON pa.hospital_panel_id = hp.id
WHERE hp.id IS NULL;

\echo ''
\echo 'Doctor Attributes without Doctor'
SELECT
    COUNT(*) as orphaned_count
FROM hospital.doctor_attributes da
LEFT JOIN hospital.doctors d ON da.doctor_id = d.id
WHERE d.id IS NULL;

-- 7. FINAL STATUS
\echo ''
\echo '=== MIGRATION READINESS ==='
SELECT
    'Attribute Definitions (Hospital)' as check_name,
    CASE WHEN COUNT(*) > 30 THEN '✓ PASS' ELSE '✗ FAIL' END as status
FROM hospital.attribute_definitions

UNION ALL

SELECT
    'Hospital Attributes (Pragati)',
    CASE WHEN COUNT(*) > 20 THEN '✓ PASS' ELSE '✗ FAIL' END
FROM hospital.hospital_attributes ha
JOIN hospital.hospitals h ON ha.hospital_id = h.id
WHERE h.name ILIKE '%pragati%'

UNION ALL

SELECT
    'Hospital Attributes (Ganga)',
    CASE WHEN COUNT(*) > 15 THEN '✓ PASS' ELSE '✗ FAIL' END
FROM hospital.hospital_attributes ha
JOIN hospital.hospitals h ON ha.hospital_id = h.id
WHERE h.name ILIKE '%ganga%'

UNION ALL

SELECT
    'Master Options',
    CASE WHEN COUNT(*) > 50 THEN '✓ PASS' ELSE '✗ FAIL' END
FROM hospital.master_options

UNION ALL

SELECT
    'No Orphaned Records',
    CASE WHEN COUNT(*) = 0 THEN '✓ PASS' ELSE '✗ FAIL' END
FROM (
    SELECT 1 FROM hospital.panel_attributes pa
    LEFT JOIN hospital.hospital_panels hp ON pa.hospital_panel_id = hp.id
    WHERE hp.id IS NULL
    UNION ALL
    SELECT 1 FROM hospital.doctor_attributes da
    LEFT JOIN hospital.doctors d ON da.doctor_id = d.id
    WHERE d.id IS NULL
) orphans;

\echo ''
\echo '==================================================='
\echo 'VERIFICATION COMPLETE'
\echo '==================================================='
\echo ''
