-- ============================================================================
-- MANUAL-RUN ONLY. NOT executed by the node-pg-migrate runner.
-- Diagnostic export. Apply with: psql -f 008_export_ganga_hospital.sql
-- Moved from migrations/ to data-seeds/ on 2026-05-14 (BE-review M21).
-- ============================================================================
-- Migration Script 008: Export Ganga Hospital Complete Data Bundle
-- Purpose: Extract all data for Ganga Hospital including profile, attributes, panels, doctors, empanelments
-- Output: Complete hospital data snapshot for backup or migration
-- Status: Diagnostic - no changes to database

\echo ''
\echo '==================================================='
\echo 'EXPORT 008: GANGA HOSPITAL DATA BUNDLE'
\echo '==================================================='
\echo ''

\set ON_ERROR_STOP on

-- Verify hospital exists
DO $$
DECLARE
  v_hospital_id UUID;
BEGIN
  SELECT id INTO v_hospital_id
  FROM hospital.hospitals
  WHERE name = 'Ganga Multi Speciality Hospital'
  LIMIT 1;

  IF v_hospital_id IS NULL THEN
    RAISE EXCEPTION 'Hospital not found: Ganga Multi Speciality Hospital';
  END IF;

  RAISE NOTICE 'Hospital ID: %', v_hospital_id;
END
$$;

\echo ''
\echo '1. HOSPITAL PROFILE'
SELECT '--- HOSPITAL PROFILE ---'::text;
SELECT
  h.id,
  h.name,
  h.city,
  h.pincode,
  h.phone,
  h.email,
  h.website,
  h.established_year,
  h.hospital_type,
  h.registration_number,
  hp.legal_name,
  hp.address_line1,
  hp.address_line2,
  hp.landmark,
  hp.emergency_helpline,
  hp.website as profile_website,
  hp.is_public_profile_enabled,
  hp.verification_status,
  hp.verification_level,
  hp.verified_at
FROM hospital.hospitals h
LEFT JOIN hospital.hospital_profile hp ON h.id = hp.hospital_id
WHERE h.name = 'Ganga Multi Speciality Hospital';

\echo ''
\echo '2. HOSPITAL ATTRIBUTES (24 attributes)'
SELECT '--- HOSPITAL ATTRIBUTES ---'::text;
SELECT
  ha.id,
  ad.key,
  ad.label,
  ad.category,
  ad.data_type,
  ha.value_text,
  ha.value_date,
  ha.value_boolean,
  ha.value_integer,
  ha.verification_status,
  ha.verification_method,
  ha.verified_at,
  ha.verification_notes,
  COUNT(DISTINCT had.id) as document_count
FROM hospital.hospital_attributes ha
JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
LEFT JOIN hospital.hospital_attribute_documents had ON ha.id = had.hospital_attribute_id
WHERE ha.hospital_id = (
  SELECT id FROM hospital.hospitals
  WHERE name = 'Ganga Multi Speciality Hospital'
)
GROUP BY ha.id, ad.key, ad.label, ad.category, ad.data_type,
         ha.value_text, ha.value_date, ha.value_boolean, ha.value_integer,
         ha.verification_status, ha.verification_method, ha.verified_at, ha.verification_notes
ORDER BY ad.category, ad.label;

\echo ''
\echo '3. HOSPITAL ATTRIBUTE DOCUMENTS'
SELECT '--- HOSPITAL ATTRIBUTE DOCUMENTS ---'::text;
SELECT
  ha.id as attribute_id,
  ad.label as attribute_label,
  hd.id as document_id,
  hd.original_filename,
  hd.mime_type,
  hd.file_size,
  hd.s3_key,
  hd.uploaded_by,
  hd.created_at,
  had.is_primary
FROM hospital.hospital_attributes ha
JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
JOIN hospital.hospital_attribute_documents had ON ha.id = had.hospital_attribute_id
JOIN hospital.hospital_documents hd ON had.document_id = hd.id
WHERE ha.hospital_id = (
  SELECT id FROM hospital.hospitals
  WHERE name = 'Ganga Multi Speciality Hospital'
)
ORDER BY ad.category, ad.label, hd.created_at;

\echo ''
\echo '4. HOSPITAL KEY CONTACTS'
SELECT '--- HOSPITAL KEY CONTACTS ---'::text;
SELECT
  id,
  name,
  designation,
  phone,
  email,
  department,
  notes
FROM hospital.hospital_key_contacts
WHERE hospital_id = (
  SELECT id FROM hospital.hospitals
  WHERE name = 'Ganga Multi Speciality Hospital'
)
ORDER BY designation, name;

\echo ''
\echo '5. HOSPITAL PANELS (2 panels)'
SELECT '--- HOSPITAL PANELS ---'::text;
SELECT
  hp.id,
  hp.name,
  hp.category,
  hp.insurance_provider,
  hp.network_id,
  hp.status,
  hp.created_at,
  COUNT(DISTINCT pe.id) as empanelments_count,
  COUNT(DISTINCT pa.id) as panel_attributes_count
FROM hospital.hospital_panels hp
LEFT JOIN hospital.panel_empanelments pe ON hp.id = pe.hospital_panel_id
LEFT JOIN hospital.panel_attributes pa ON hp.id = pa.hospital_panel_id
WHERE hp.hospital_id = (
  SELECT id FROM hospital.hospitals
  WHERE name = 'Ganga Multi Speciality Hospital'
)
GROUP BY hp.id, hp.name, hp.category, hp.insurance_provider, hp.network_id,
         hp.status, hp.created_at
ORDER BY hp.name;

\echo ''
\echo '6. PANEL ATTRIBUTES & DOCUMENTS'
SELECT '--- PANEL ATTRIBUTES ---'::text;
SELECT
  hp.name as panel_name,
  pad.label as attribute_label,
  pad.category,
  pad.data_type,
  pa.value_text,
  pa.value_date,
  pa.value_boolean,
  pa.value_integer,
  pa.verification_status,
  COUNT(DISTINCT padoc.id) as document_count
FROM hospital.hospital_panels hp
JOIN hospital.panel_attributes pa ON hp.id = pa.hospital_panel_id
JOIN hospital.panel_attribute_definitions pad ON pa.attribute_key = pad.key
LEFT JOIN hospital.panel_attribute_documents padoc ON pa.id = padoc.panel_attribute_id
WHERE hp.hospital_id = (
  SELECT id FROM hospital.hospitals
  WHERE name = 'Ganga Multi Speciality Hospital'
)
GROUP BY hp.id, hp.name, pad.id, pad.label, pad.category, pad.data_type,
         pa.value_text, pa.value_date, pa.value_boolean, pa.value_integer,
         pa.verification_status
ORDER BY hp.name, pad.category, pad.label;

\echo ''
\echo '7. PANEL EMPANELMENTS'
SELECT '--- PANEL EMPANELMENTS ---'::text;
SELECT
  hp.name as panel_name,
  pe.id,
  pe.network_id as empanel_network_id,
  pe.empanel_status,
  pe.valid_from,
  pe.valid_till,
  pe.remarks,
  pe.is_active
FROM hospital.hospital_panels hp
LEFT JOIN hospital.panel_empanelments pe ON hp.id = pe.hospital_panel_id
WHERE hp.hospital_id = (
  SELECT id FROM hospital.hospitals
  WHERE name = 'Ganga Multi Speciality Hospital'
)
ORDER BY hp.name;

\echo ''
\echo '8. HOSPITAL DOCTORS (1 doctor)'
SELECT '--- HOSPITAL DOCTORS ---'::text;
SELECT
  hd.id,
  d.id as doctor_id,
  d.first_name,
  d.last_name,
  d.email,
  d.phone,
  d.nmc_registration_number,
  hd.employment_type,
  hd.department,
  hd.designation,
  hd.start_date,
  hd.end_date,
  hd.status,
  hd.employee_id,
  COUNT(DISTINCT da.id) as doctor_attributes_count,
  COUNT(DISTINCT dhosp.id) as hospital_doctor_overrides_count
FROM hospital.hospital_doctors hd
LEFT JOIN hospital.doctors d ON hd.doctor_id = d.id
LEFT JOIN hospital.doctor_attributes da ON d.id = da.doctor_id
LEFT JOIN hospital.hospital_doctor_attributes dhosp ON hd.id = dhosp.hospital_doctor_id
WHERE hd.hospital_id = (
  SELECT id FROM hospital.hospitals
  WHERE name = 'Ganga Multi Speciality Hospital'
)
GROUP BY hd.id, d.id, d.first_name, d.last_name, d.email, d.phone,
         d.nmc_registration_number, hd.employment_type, hd.department,
         hd.designation, hd.start_date, hd.end_date, hd.status, hd.employee_id;

\echo ''
\echo '9. DOCTOR ATTRIBUTES (per doctor)'
SELECT '--- DOCTOR ATTRIBUTES ---'::text;
SELECT
  d.first_name || ' ' || d.last_name as doctor_name,
  dad.label as attribute_label,
  dad.category,
  dad.data_type,
  da.value_text,
  da.value_date,
  da.value_boolean,
  da.verification_status,
  COUNT(DISTINCT doadoc.id) as document_count
FROM hospital.hospitals h
JOIN hospital.hospital_doctors hd ON h.id = hd.hospital_id
JOIN hospital.doctors d ON hd.doctor_id = d.id
LEFT JOIN hospital.doctor_attributes da ON d.id = da.doctor_id
LEFT JOIN hospital.doctor_attribute_definitions dad ON da.attribute_key = dad.key
LEFT JOIN hospital.doctor_attribute_documents doadoc ON da.id = doadoc.doctor_attribute_id
WHERE h.name = 'Ganga Multi Speciality Hospital'
GROUP BY d.id, d.first_name, d.last_name, dad.id, dad.label, dad.category, dad.data_type,
         da.value_text, da.value_date, da.value_boolean, da.verification_status
ORDER BY d.first_name, dad.category, dad.label;

\echo ''
\echo '=== DATA SUMMARY ==='
SELECT
  'Total Hospital Attributes' as metric,
  COUNT(*)::text as value
FROM hospital.hospital_attributes
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT 'Hospital Attributes with Documents',
  COUNT(DISTINCT ha.id)::text
FROM hospital.hospital_attributes ha
JOIN hospital.hospital_attribute_documents had ON ha.id = had.hospital_attribute_id
WHERE ha.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT 'Total Hospital Documents',
  COUNT(DISTINCT hd.id)::text
FROM hospital.hospital_attribute_documents had
JOIN hospital.hospital_attributes ha ON ha.id = had.hospital_attribute_id
JOIN hospital.hospital_documents hd ON had.document_id = hd.id
WHERE ha.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT 'Hospital Panels',
  COUNT(*)::text
FROM hospital.hospital_panels
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT 'Panel Attributes',
  COUNT(*)::text
FROM hospital.panel_attributes pa
JOIN hospital.hospital_panels hp ON pa.hospital_panel_id = hp.id
WHERE hp.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT 'Panel Empanelments',
  COUNT(*)::text
FROM hospital.panel_empanelments pe
JOIN hospital.hospital_panels hp ON pe.hospital_panel_id = hp.id
WHERE hp.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT 'Doctors at Hospital',
  COUNT(*)::text
FROM hospital.hospital_doctors
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT 'Doctor Attributes',
  COUNT(*)::text
FROM hospital.doctor_attributes da
JOIN hospital.hospital_doctors hd ON da.doctor_id = hd.doctor_id
WHERE hd.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital')

UNION ALL

SELECT 'Key Contacts',
  COUNT(*)::text
FROM hospital.hospital_key_contacts
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Ganga Multi Speciality Hospital');

\echo ''
\echo '==================================================='
\echo 'GANGA HOSPITAL EXPORT COMPLETE'
\echo '==================================================='
\echo ''
