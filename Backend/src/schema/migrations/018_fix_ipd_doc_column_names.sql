-- Migration 018: Fix trailing-space column names on ipd_doc
-- Date: 2026-05-17
-- Description:
--   Two columns on hospital.ipd_doc were defined with a trailing space in
--   their identifiers:
--     "doc_description "
--     "doc_metadata "
--
--   Postgres treats `doc_description` and `doc_description ` as distinct
--   identifiers, so any SQL that writes to "doc_description" (no trailing
--   space) errors with `column does not exist`.
--
--   This migration renames both columns to the intended clean form.
--   Existing rows preserve their data. Schema.sql already documents the
--   clean names, so this brings the live DB into agreement.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'hospital'
       AND table_name = 'ipd_doc'
       AND column_name = 'doc_description '
  ) THEN
    ALTER TABLE hospital.ipd_doc RENAME COLUMN "doc_description " TO doc_description;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'hospital'
       AND table_name = 'ipd_doc'
       AND column_name = 'doc_metadata '
  ) THEN
    ALTER TABLE hospital.ipd_doc RENAME COLUMN "doc_metadata " TO doc_metadata;
  END IF;
END $$;

COMMIT;
