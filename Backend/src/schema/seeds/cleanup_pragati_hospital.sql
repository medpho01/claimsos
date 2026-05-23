-- Cleanup: Pragati Hospital and Stem Cell Centre
-- Hospital ID: 9a16278c-5605-4116-b19e-d434716af27a
--
-- Pre-execution counts (verified 2026-05-13):
--   hospital_attribute_documents: 20
--   hospital_attributes:          30
--   hospital_documents:           21
--   hospital_profile:              1
--   hospitals:                     1
--   (all patient/doctor/panel/user tables: 0)
--
-- Run as a single transaction. Comment out the COMMIT and uncomment ROLLBACK
-- to dry-run.

\set hid '9a16278c-5605-4116-b19e-d434716af27a'

BEGIN;

SET search_path TO hospital, public;

-- Snapshot pre-state into a temp table for the audit row at the end.
CREATE TEMP TABLE _pre_counts ON COMMIT DROP AS
SELECT 'hospital_attribute_documents' AS tbl, COUNT(*)::int AS n
  FROM hospital_attribute_documents had
  JOIN hospital_attributes ha ON had.hospital_attribute_id = ha.id
  WHERE ha.hospital_id = :'hid'::uuid
UNION ALL SELECT 'hospital_attributes', COUNT(*) FROM hospital_attributes WHERE hospital_id = :'hid'::uuid
UNION ALL SELECT 'hospital_documents',  COUNT(*) FROM hospital_documents  WHERE hospital_id = :'hid'::uuid
UNION ALL SELECT 'hospital_profile',    COUNT(*) FROM hospital_profile    WHERE hospital_id = :'hid'::uuid
UNION ALL SELECT 'public_share_tokens', COUNT(*) FROM public_share_tokens WHERE resource_type = 'hospital' AND resource_id = :'hid'::uuid
UNION ALL SELECT 'hospitals',           COUNT(*) FROM hospitals           WHERE id = :'hid'::uuid;

-- 1. Junction rows: attribute ↔ document
DELETE FROM hospital_attribute_documents
WHERE hospital_attribute_id IN (
    SELECT id FROM hospital_attributes WHERE hospital_id = :'hid'::uuid
);

-- 2. Attribute values
DELETE FROM hospital_attributes WHERE hospital_id = :'hid'::uuid;

-- 3. Documents (the S3 metadata rows; the S3 objects themselves are NOT touched here)
DELETE FROM hospital_documents WHERE hospital_id = :'hid'::uuid;

-- 4. Profile
DELETE FROM hospital_profile WHERE hospital_id = :'hid'::uuid;

-- 5. Any share tokens (zero today, but defensive)
DELETE FROM public_share_tokens WHERE resource_type = 'hospital' AND resource_id = :'hid'::uuid;

-- 6. Defensive cleanup of any other linked rows (all 0 today, but safe if data appears between dry-run and commit)
DELETE FROM hospital_key_contacts      WHERE hospital_id = :'hid'::uuid;
DELETE FROM hospital_assignments       WHERE hospital_id = :'hid'::uuid;
DELETE FROM hospital_users             WHERE hospital_id = :'hid'::uuid;
DELETE FROM hospital_doctors           WHERE hospital_id = :'hid'::uuid;
DELETE FROM panel_attributes           WHERE hospital_id = :'hid'::uuid;
DELETE FROM panel_documents
  WHERE panel_empanelment_id IN (SELECT id FROM panel_empanelments WHERE hospital_id = :'hid'::uuid);
DELETE FROM panel_empanelments         WHERE hospital_id = :'hid'::uuid;
DELETE FROM hospital_panels            WHERE hospital_id = :'hid'::uuid;
DELETE FROM hospital_doc               WHERE hospital_id = :'hid'::uuid;
-- ipd_doc has no hospital_id; deleted via ipds cascade if any
DELETE FROM claims WHERE ipd_id IN (SELECT id FROM ipds WHERE hospital_id = :'hid'::uuid);
DELETE FROM ipd_doc WHERE ipd_id IN (SELECT id FROM ipds WHERE hospital_id = :'hid'::uuid);
DELETE FROM ipds                       WHERE hospital_id = :'hid'::uuid;

-- 7. Finally the hospital row itself
DELETE FROM hospitals WHERE id = :'hid'::uuid;

-- Verify post-state
\echo
\echo === BEFORE / AFTER ===
SELECT pre.tbl, pre.n AS before,
       CASE pre.tbl
         WHEN 'hospital_attribute_documents' THEN (SELECT COUNT(*) FROM hospital_attribute_documents had JOIN hospital_attributes ha ON had.hospital_attribute_id=ha.id WHERE ha.hospital_id = :'hid'::uuid)
         WHEN 'hospital_attributes' THEN (SELECT COUNT(*) FROM hospital_attributes WHERE hospital_id = :'hid'::uuid)
         WHEN 'hospital_documents'  THEN (SELECT COUNT(*) FROM hospital_documents WHERE hospital_id = :'hid'::uuid)
         WHEN 'hospital_profile'    THEN (SELECT COUNT(*) FROM hospital_profile WHERE hospital_id = :'hid'::uuid)
         WHEN 'public_share_tokens' THEN (SELECT COUNT(*) FROM public_share_tokens WHERE resource_type='hospital' AND resource_id = :'hid'::uuid)
         WHEN 'hospitals'           THEN (SELECT COUNT(*) FROM hospitals WHERE id = :'hid'::uuid)
       END::int AS after
FROM _pre_counts pre
ORDER BY pre.tbl;

-- Uncomment ROLLBACK and comment COMMIT to dry-run.
COMMIT;
-- ROLLBACK;
