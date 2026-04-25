-- Migration 003: Migrate existing hospitals.details JSONB to hospital_profile table
-- Run after: 002b_hospital_table_updates.sql
-- This is a data migration — safe to re-run (INSERT ... WHERE NOT EXISTS)
-- Rollback: 003_migrate_hospital_details_rollback.sql

BEGIN;

-- Migrate all hospitals that don't yet have a hospital_profile record
INSERT INTO hospital_profile (
  hospital_id,
  rohini_id,
  hfr_id,
  pan_number,
  website,
  email,
  phone,
  address_line1,
  city,
  district,
  state,
  pincode,
  hospital_type,
  specialties,
  verification_status,
  created_at,
  updated_at
)
SELECT
  h.id,
  NULLIF(TRIM(h.details->>'rohini_id'), ''),
  NULLIF(TRIM(h.details->>'hfr_id'), ''),
  NULLIF(TRIM(h.details->>'pan_number'), ''),
  NULLIF(TRIM(h.details->>'website'), ''),
  NULLIF(TRIM(h.details->>'email'), ''),
  NULLIF(TRIM(h.details->>'phone'), ''),
  NULLIF(TRIM(h.details->>'address'), ''),
  NULLIF(TRIM(h.details->>'city'), ''),
  NULLIF(TRIM(h.details->>'district'), ''),
  NULLIF(TRIM(h.details->>'state'), ''),
  NULLIF(TRIM(h.details->>'pincode'), ''),
  CASE
    WHEN lower(h.details->>'hospital_type') LIKE '%single%'   THEN 'single_specialty'
    WHEN lower(h.details->>'hospital_type') LIKE '%multi%'    THEN 'multi_specialty'
    WHEN lower(h.details->>'hospital_type') LIKE '%nursing%'  THEN 'nursing_home'
    WHEN lower(h.details->>'hospital_type') LIKE '%day%'      THEN 'day_care_center'
    ELSE NULL
  END,
  CASE
    WHEN h.details->'specialties' IS NOT NULL AND jsonb_typeof(h.details->'specialties') = 'array'
    THEN ARRAY(SELECT jsonb_array_elements_text(h.details->'specialties'))
    ELSE '{}'
  END,
  'not_submitted',
  h.created_at,
  NOW()
FROM hospitals h
WHERE NOT EXISTS (
  SELECT 1 FROM hospital_profile hp WHERE hp.hospital_id = h.id
);

-- Also migrate key contacts from hospitals.details JSONB if present
-- (TPA CMO and finance contact fields in current details schema)
INSERT INTO hospital_key_contacts (
  hospital_id,
  contact_type,
  name,
  phone,
  email,
  is_primary,
  created_at
)
SELECT
  h.id,
  'tpa_contact',
  NULLIF(TRIM(h.details->>'tpa_cmo_name'), ''),
  NULLIF(TRIM(h.details->>'tpa_cmo_contact'), ''),
  NULL,
  TRUE,
  NOW()
FROM hospitals h
WHERE h.details->>'tpa_cmo_name' IS NOT NULL
  AND TRIM(h.details->>'tpa_cmo_name') != ''
  AND NOT EXISTS (
    SELECT 1 FROM hospital_key_contacts hkc
    WHERE hkc.hospital_id = h.id AND hkc.contact_type = 'tpa_contact'
  );

COMMIT;
