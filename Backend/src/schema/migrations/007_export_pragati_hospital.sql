-- Migration Script 007: Export Pragati Hospital Complete Data Bundle
-- Purpose: Extract all data for Pragati Hospital including profile, attributes, documents, contacts
-- Output: Complete hospital data snapshot for backup or migration
-- Status: Diagnostic - no changes to database

\set hospital_name 'Pragati Hospital and Stem Cell Centre'

\echo ''
\echo '==================================================='
\echo 'EXPORT 007: PRAGATI HOSPITAL DATA BUNDLE'
\echo '==================================================='
\echo ''

-- Store hospital ID for reference
\set ON_ERROR_STOP on

-- Get hospital ID
DO $$
DECLARE
  v_hospital_id UUID;
BEGIN
  SELECT id INTO v_hospital_id
  FROM hospital.hospitals
  WHERE name = 'Pragati Hospital and Stem Cell Centre'
  LIMIT 1;

  IF v_hospital_id IS NULL THEN
    RAISE EXCEPTION 'Hospital not found: Pragati Hospital and Stem Cell Centre';
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
WHERE h.name = 'Pragati Hospital and Stem Cell Centre';

\echo ''
\echo '2. HOSPITAL ATTRIBUTES (30 attributes)'
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
  WHERE name = 'Pragati Hospital and Stem Cell Centre'
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
  WHERE name = 'Pragati Hospital and Stem Cell Centre'
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
  WHERE name = 'Pragati Hospital and Stem Cell Centre'
)
ORDER BY designation, name;

\echo ''
\echo '5. HOSPITAL PANELS'
SELECT '--- HOSPITAL PANELS (0 panels found) ---'::text;
SELECT COUNT(*) as panel_count
FROM hospital.hospital_panels
WHERE hospital_id = (
  SELECT id FROM hospital.hospitals
  WHERE name = 'Pragati Hospital and Stem Cell Centre'
);

\echo ''
\echo '6. HOSPITAL DOCTORS'
SELECT '--- HOSPITAL DOCTORS (0 doctors found) ---'::text;
SELECT COUNT(*) as doctor_count
FROM hospital.hospital_doctors
WHERE hospital_id = (
  SELECT id FROM hospital.hospitals
  WHERE name = 'Pragati Hospital and Stem Cell Centre'
);

\echo ''
\echo '=== DATA SUMMARY ==='
SELECT
  'Total Attributes' as metric,
  COUNT(*)::text as value
FROM hospital.hospital_attributes
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre')

UNION ALL

SELECT 'Attributes with Documents',
  COUNT(DISTINCT ha.id)::text
FROM hospital.hospital_attributes ha
JOIN hospital.hospital_attribute_documents had ON ha.id = had.hospital_attribute_id
WHERE ha.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre')

UNION ALL

SELECT 'Total Documents',
  COUNT(DISTINCT hd.id)::text
FROM hospital.hospital_attribute_documents had
JOIN hospital.hospital_attributes ha ON ha.id = had.hospital_attribute_id
JOIN hospital.hospital_documents hd ON had.document_id = hd.id
WHERE ha.hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre')

UNION ALL

SELECT 'Key Contacts',
  COUNT(*)::text
FROM hospital.hospital_key_contacts
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre')

UNION ALL

SELECT 'Verified Attributes',
  COUNT(*)::text
FROM hospital.hospital_attributes
WHERE hospital_id = (SELECT id FROM hospital.hospitals WHERE name = 'Pragati Hospital and Stem Cell Centre')
  AND verification_status = 'verified_by_doc';

\echo ''
\echo '==================================================='
\echo 'PRAGATI HOSPITAL EXPORT COMPLETE'
\echo '==================================================='
\echo ''
