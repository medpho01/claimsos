-- ============================================================================
-- MANUAL-RUN ONLY. NOT executed by the node-pg-migrate runner.
-- Standalone rollback script kept for archival reference. Apply with psql only
-- after confirming the corresponding migration is the one you intend to undo.
-- Moved from migrations/ to data-seeds/ on 2026-05-14 (BE-review M21).
-- ============================================================================
-- Rollback for migration 002b_hospital_table_updates.sql
-- WARNING: Restores drive_folder_id NOT NULL constraint — ensure all rows have a value first.

BEGIN;

ALTER TABLE hospital_panels DROP COLUMN IF EXISTS has_empanelment_record;
ALTER TABLE panels DROP COLUMN IF EXISTS is_system_panel;
ALTER TABLE panels DROP COLUMN IF EXISTS panel_type;
DROP INDEX IF EXISTS idx_hospital_doc_category;
ALTER TABLE hospital_doc DROP COLUMN IF EXISTS verified_at;
ALTER TABLE hospital_doc DROP COLUMN IF EXISTS verified_by;
ALTER TABLE hospital_doc DROP COLUMN IF EXISTS expiry_date;
ALTER TABLE hospital_doc DROP COLUMN IF EXISTS is_public;
ALTER TABLE hospital_doc DROP COLUMN IF EXISTS doc_category;
ALTER TABLE hospitals DROP COLUMN IF EXISTS ce_activated_at;
ALTER TABLE hospitals DROP COLUMN IF EXISTS ce_hospital_code;
ALTER TABLE hospitals DROP COLUMN IF EXISTS ce_opted_in;
-- NOTE: Only restore NOT NULL if all rows have drive_folder_id set:
-- ALTER TABLE hospitals ALTER COLUMN drive_folder_id SET NOT NULL;

COMMIT;
