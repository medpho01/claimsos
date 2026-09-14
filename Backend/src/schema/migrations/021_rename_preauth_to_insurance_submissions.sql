-- Migration 021: rename hospital.preauth_submissions → hospital.insurance_submissions
-- Date: 2026-05-17
-- Description:
--   The table was misnamed. It already holds (and was always intended to
--   hold) every stage of insurance communication on an IPD: pre-auth,
--   enhancement, discharge intimation, final-bill submission, query
--   responses, etc. The "preauth" prefix biased the entire codebase
--   toward pre-auth being THE thing.
--
--   This migration renames the table and the FK column on emails_outbound
--   without altering any data. Stage tagging (which stage each row
--   represents) is deferred — for now every existing row remains a single
--   row in the same shape.
--
--   Forward-compat: future migration will add a `stage` column and
--   backfill all existing rows to 'preauth'.
--
-- Backwards-compat strategy:
--   - We do NOT keep a view alias for the old table name. The codebase
--     is small enough that all references are updated in the same PR.
--   - Index/constraint names are renamed to match for clarity but the
--     constraint definitions themselves are unchanged.
--
-- IDEMPOTENCY (added during the idempotency sweep):
--   RENAME has no IF EXISTS form, so every statement here was single-use —
--   a re-run died on `relation "insurance_submissions" already exists`.
--   Each rename is now guarded on "old name present AND new name absent",
--   which is the only state in which the rename is meaningful. Re-running
--   this file against an already-renamed schema is now a clean no-op.

BEGIN;

-- 1) Rename the table.
DO $$ BEGIN
  IF to_regclass('hospital.preauth_submissions') IS NOT NULL
     AND to_regclass('hospital.insurance_submissions') IS NULL THEN
    ALTER TABLE hospital.preauth_submissions
      RENAME TO insurance_submissions;
  END IF;
END $$;

-- 2) Rename the FK column on emails_outbound for symmetry.
DO $$ BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'hospital' AND table_name = 'emails_outbound'
           AND column_name = 'preauth_submission_id')
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'hospital' AND table_name = 'emails_outbound'
           AND column_name = 'insurance_submission_id') THEN
    ALTER TABLE hospital.emails_outbound
      RENAME COLUMN preauth_submission_id TO insurance_submission_id;
  END IF;
END $$;

-- 3) Rename the FK constraint on emails_outbound.
DO $$ BEGIN
  IF EXISTS (
        SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'hospital' AND t.relname = 'emails_outbound'
           AND c.conname = 'fk_emails_outbound_preauth_submission') THEN
    ALTER TABLE hospital.emails_outbound
      RENAME CONSTRAINT fk_emails_outbound_preauth_submission
      TO fk_emails_outbound_insurance_submission;
  END IF;
END $$;

-- 4) Rename indexes for clarity. These are not functional renames —
--    Postgres uses indexes by id, not by name — but keeping the
--    naming convention consistent helps anyone reading the schema.
DO $$
DECLARE
  pair TEXT[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ARRAY['preauth_submissions_pkey', 'insurance_submissions_pkey'],
    ARRAY['idx_ps_ipd',               'idx_is_ipd'],
    ARRAY['idx_ps_external',          'idx_is_external'],
    ARRAY['idx_ps_status_deadline',   'idx_is_status_deadline'],
    ARRAY['idx_ps_hospital_panel',    'idx_is_hospital_panel']
  ] LOOP
    IF to_regclass('hospital.' || quote_ident(pair[1])) IS NOT NULL
       AND to_regclass('hospital.' || quote_ident(pair[2])) IS NULL THEN
      EXECUTE format('ALTER INDEX hospital.%I RENAME TO %I', pair[1], pair[2]);
    END IF;
  END LOOP;
END $$;

-- 5) Rename FK constraints on the renamed table itself.
DO $$
DECLARE
  pair TEXT[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ARRAY['preauth_submissions_ipd_id_fkey',                    'insurance_submissions_ipd_id_fkey'],
    ARRAY['preauth_submissions_hospital_id_fkey',               'insurance_submissions_hospital_id_fkey'],
    ARRAY['preauth_submissions_hospital_panel_id_fkey',         'insurance_submissions_hospital_panel_id_fkey'],
    ARRAY['preauth_submissions_preauth_form_template_id_fkey',  'insurance_submissions_preauth_form_template_id_fkey'],
    ARRAY['preauth_submissions_email_outbound_id_fkey',         'insurance_submissions_email_outbound_id_fkey'],
    ARRAY['preauth_submissions_resubmission_of_id_fkey',        'insurance_submissions_resubmission_of_id_fkey'],
    ARRAY['preauth_submissions_submitted_by_fkey',              'insurance_submissions_submitted_by_fkey']
  ] LOOP
    IF EXISTS (
         SELECT 1 FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'hospital' AND t.relname = 'insurance_submissions'
            AND c.conname = pair[1]) THEN
      EXECUTE format('ALTER TABLE hospital.insurance_submissions RENAME CONSTRAINT %I TO %I', pair[1], pair[2]);
    END IF;
  END LOOP;
END $$;

COMMIT;
