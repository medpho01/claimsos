-- Migration 012: Add stable `code` identifier to panels
-- Date: 2026-05-16
-- Description:
--   Adds a `code VARCHAR(50) UNIQUE` column to the existing panels table so we
--   have a stable, all-caps identifier for use in migrations, app config, and
--   logs. Names alone are not stable identifiers (typos, aliases, casing).
--
--   The SOP seed (migration 015) populates 49 panels with explicit codes. The
--   existing CE system panel (UUID 00000000-0000-0000-0000-000000000001) is
--   backfilled with code 'CASHLESS_EVERYWHERE'.

BEGIN;

ALTER TABLE hospital.panels
  ADD COLUMN IF NOT EXISTS code VARCHAR(50);

-- Backfill the existing CE system panel
UPDATE hospital.panels
SET code = 'CASHLESS_EVERYWHERE'
WHERE id = '00000000-0000-0000-0000-000000000001'::uuid
  AND code IS NULL;

-- Any other existing panels (PMJAY etc.) need codes too. Generate from
-- the name where possible; admins can update manually.
UPDATE hospital.panels
SET code = UPPER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '_', 'g'))
WHERE code IS NULL
  AND name IS NOT NULL;

-- Enforce uniqueness going forward.
-- We use a UNIQUE constraint (not a partial unique index) so ON CONFLICT
-- (code) clauses in subsequent seed migrations can target it directly.
ALTER TABLE hospital.panels
  ADD CONSTRAINT panels_code_unique UNIQUE (code);

COMMIT;
