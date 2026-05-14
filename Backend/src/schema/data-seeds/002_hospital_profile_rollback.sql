-- ============================================================================
-- MANUAL-RUN ONLY. NOT executed by the node-pg-migrate runner.
-- Standalone rollback script kept for archival reference. Apply with psql only
-- after confirming the corresponding migration is the one you intend to undo.
-- Moved from migrations/ to data-seeds/ on 2026-05-14 (BE-review M21).
-- ============================================================================
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
