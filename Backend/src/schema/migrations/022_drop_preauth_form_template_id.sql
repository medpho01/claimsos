-- Migration 022: Remove preauth_form_template_id from everywhere except
-- the master `preauth_form_templates` table (kept as reference data —
-- 42 rows of per-insurer blank pre-auth PDF URLs).
-- Date: 2026-05-17
-- Description:
--   The `preauth_form_template_id` field was created when we planned to
--   auto-fill the pre-auth PDF (AcroForm) and attach it to outbound email.
--   That feature was dropped (most insurer PDFs are image-based, no
--   AcroForm fields) — hospital admins upload their own filled form as a
--   normal patient document and pick it from the compose modal's document
--   picker like any other doc.
--
--   The column on `insurance_submissions`, the panel_attribute_definition,
--   and all its panel_attributes / panel_default_attributes values are
--   unused dead weight. Drop them.
--
--   Confirmed by audit before this migration ran:
--     - 0 rows in insurance_submissions have preauth_form_template_id set
--     - panel_attributes rows: 2 (will be dropped)
--     - panel_default_attributes rows: 36 (will be dropped)
--     - panel_attribute_definitions rows: 1 (will be dropped)
--     - Only FK referencing the master table is on insurance_submissions
--       (about to be removed)
--
--   What we KEEP:
--     - hospital.preauth_form_templates table (42 reference rows). Becomes
--       free-standing platform reference data. How it gets plumbed into the
--       UI is a future decision.

BEGIN;

-- 1) Drop FK + column from insurance_submissions (the only FK pointing at
--    preauth_form_templates).
ALTER TABLE hospital.insurance_submissions
  DROP CONSTRAINT IF EXISTS insurance_submissions_preauth_form_template_id_fkey;
ALTER TABLE hospital.insurance_submissions
  DROP COLUMN IF EXISTS preauth_form_template_id;

-- 2) Drop dependent attribute values BEFORE the definition row.
--    panel_default_attributes references panel_attribute_definitions by FK.
DELETE FROM hospital.panel_default_attributes
 WHERE panel_attribute_definition_id IN (
   SELECT id FROM hospital.panel_attribute_definitions WHERE key = 'preauth_form_template_id'
 );

-- panel_attributes also references panel_attribute_definitions (typically RESTRICT)
DELETE FROM hospital.panel_attributes
 WHERE panel_attribute_definition_id IN (
   SELECT id FROM hospital.panel_attribute_definitions WHERE key = 'preauth_form_template_id'
 );

-- 3) Drop the panel_attribute_definitions row now that nothing references it.
DELETE FROM hospital.panel_attribute_definitions
 WHERE key = 'preauth_form_template_id';

-- 4) preauth_form_templates table is INTENTIONALLY NOT dropped. It stays as
--    platform-level reference data (42 rows) — name/code/source_url per
--    insurer's blank pre-auth PDF. Future UI work may surface these as
--    "Download blank form for {insurer}" links inside the Panels tab.

COMMIT;
