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
--
-- CRITICAL: 016_seed_sop_data.sql relies on `ON CONFLICT (code)` resolving
-- against this constraint, so it MUST exist — but ADD CONSTRAINT has no
-- IF NOT EXISTS and errors on a second run. Guard it (conrelid-scoped so an
-- identically named constraint elsewhere cannot mask it), never skip it.
-- The de-dup mirrors the pattern at 010:38-42: the UPPER(name) backfill above
-- can collide (e.g. "Star Health" and "Star-Health" both -> STAR_HEALTH) and
-- the constraint would then fail on a dirty database.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'hospital'
       AND t.relname = 'panels'
       AND c.conname = 'panels_code_unique'
  ) THEN
    -- idempotent: keeps the earliest physical row of each duplicate code
    DELETE FROM hospital.panels a
     USING hospital.panels b
     WHERE a.ctid < b.ctid
       AND a.code = b.code;

    ALTER TABLE hospital.panels
      ADD CONSTRAINT panels_code_unique UNIQUE (code);
  END IF;
END $$;

COMMIT;
