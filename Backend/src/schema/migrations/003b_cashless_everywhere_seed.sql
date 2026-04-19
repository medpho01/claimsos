-- Migration 003b: Seed Cashless Everywhere panel and activate for all existing hospitals
-- Run after: 003_migrate_hospital_details.sql

BEGIN;

-- Create the Cashless Everywhere system panel (idempotent)
INSERT INTO panels (id, name, panel_type, is_system_panel, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',   -- Fixed UUID for system panel
  'Cashless Everywhere',
  'cashless_everywhere',
  TRUE,
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Auto-enroll all existing hospitals in Cashless Everywhere
-- Creates hospital_panels + panel_empanelments for each hospital not yet enrolled
WITH new_hospital_panels AS (
  INSERT INTO hospital_panels (id, hospital_id, panel_id, created_at)
  SELECT
    gen_random_uuid(),
    h.id,
    '00000000-0000-0000-0000-000000000001',
    NOW()
  FROM hospitals h
  WHERE NOT EXISTS (
    SELECT 1 FROM hospital_panels hp
    WHERE hp.hospital_id = h.id
      AND hp.panel_id = '00000000-0000-0000-0000-000000000001'
  )
  RETURNING id, hospital_id
)
INSERT INTO panel_empanelments (
  hospital_panel_id,
  hospital_id,
  panel_id,
  empanelment_start_date,
  empanelment_status,
  empanelment_type,
  created_at
)
SELECT
  nhp.id,
  nhp.hospital_id,
  '00000000-0000-0000-0000-000000000001',
  CURRENT_DATE,
  'active',
  'cashless',
  NOW()
FROM new_hospital_panels nhp;

-- Update has_empanelment_record flag
UPDATE hospital_panels hp
SET has_empanelment_record = TRUE
WHERE panel_id = '00000000-0000-0000-0000-000000000001'
  AND EXISTS (
    SELECT 1 FROM panel_empanelments pe WHERE pe.hospital_panel_id = hp.id
  );

-- Activate CE on all hospitals
UPDATE hospitals
SET
  ce_opted_in = TRUE,
  ce_activated_at = NOW()
WHERE ce_activated_at IS NULL;

COMMIT;
