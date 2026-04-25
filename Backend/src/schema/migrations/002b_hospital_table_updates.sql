-- Migration 002b: Modifications to existing tables for Hospital Profile feature
-- Run after: 002_hospital_profile.sql
-- Rollback: 002b_hospital_table_updates_rollback.sql

BEGIN;

-- ============================================================
-- hospitals table
-- ============================================================

-- Fix: drive_folder_id must be nullable (hospitals should work without Drive)
ALTER TABLE hospitals ALTER COLUMN drive_folder_id DROP NOT NULL;

-- Cashless Everywhere support
ALTER TABLE hospitals
  ADD COLUMN IF NOT EXISTS ce_opted_in BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ce_hospital_code TEXT,
  ADD COLUMN IF NOT EXISTS ce_activated_at TIMESTAMPTZ;

-- Mark details as deprecated (will be removed in migration 005)
COMMENT ON COLUMN hospitals.details IS
  'DEPRECATED as of migration 002: Use hospital_profile table instead. Will be dropped in migration 005 once all data is confirmed migrated.';


-- ============================================================
-- hospital_doc table — add category and metadata fields
-- ============================================================

ALTER TABLE hospital_doc
  ADD COLUMN IF NOT EXISTS doc_category TEXT CHECK (doc_category IN (
    'registration', 'accreditation', 'legal', 'mou', 'contract',
    'id_proof', 'logo', 'photo', 'brochure', 'other'
  )) DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS expiry_date DATE,
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_hospital_doc_category ON hospital_doc(hospital_id, doc_category);


-- ============================================================
-- panels table — add type and system panel flag
-- ============================================================

ALTER TABLE panels
  ADD COLUMN IF NOT EXISTS panel_type TEXT CHECK (panel_type IN (
    'insurance', 'tpa', 'government', 'cashless_everywhere', 'other'
  )) DEFAULT 'insurance',
  ADD COLUMN IF NOT EXISTS is_system_panel BOOLEAN DEFAULT FALSE;


-- ============================================================
-- hospital_panels table — track if enriched empanelment record exists
-- ============================================================

ALTER TABLE hospital_panels
  ADD COLUMN IF NOT EXISTS has_empanelment_record BOOLEAN DEFAULT FALSE;

COMMIT;
