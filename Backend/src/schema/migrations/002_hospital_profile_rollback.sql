-- Rollback for migration 002_hospital_profile.sql
-- WARNING: This drops tables and all data in them.

BEGIN;

DROP TABLE IF EXISTS public_share_tokens CASCADE;
DROP TABLE IF EXISTS panel_documents CASCADE;
DROP TABLE IF EXISTS panel_empanelments CASCADE;
DROP TABLE IF EXISTS hospital_key_contacts CASCADE;
DROP TABLE IF EXISTS hospital_certifications CASCADE;
DROP TABLE IF EXISTS hospital_profile CASCADE;

COMMIT;
