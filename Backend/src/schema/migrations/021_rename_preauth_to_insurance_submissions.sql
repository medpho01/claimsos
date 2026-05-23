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

BEGIN;

-- 1) Rename the table.
ALTER TABLE hospital.preauth_submissions
  RENAME TO insurance_submissions;

-- 2) Rename the FK column on emails_outbound for symmetry.
ALTER TABLE hospital.emails_outbound
  RENAME COLUMN preauth_submission_id TO insurance_submission_id;

-- 3) Rename the FK constraint on emails_outbound.
ALTER TABLE hospital.emails_outbound
  RENAME CONSTRAINT fk_emails_outbound_preauth_submission
  TO fk_emails_outbound_insurance_submission;

-- 4) Rename indexes for clarity. These are not functional renames —
--    Postgres uses indexes by id, not by name — but keeping the
--    naming convention consistent helps anyone reading the schema.
ALTER INDEX hospital.preauth_submissions_pkey      RENAME TO insurance_submissions_pkey;
ALTER INDEX hospital.idx_ps_ipd                    RENAME TO idx_is_ipd;
ALTER INDEX hospital.idx_ps_external               RENAME TO idx_is_external;
ALTER INDEX hospital.idx_ps_status_deadline        RENAME TO idx_is_status_deadline;
ALTER INDEX hospital.idx_ps_hospital_panel         RENAME TO idx_is_hospital_panel;

-- 5) Rename FK constraints on the renamed table itself.
ALTER TABLE hospital.insurance_submissions
  RENAME CONSTRAINT preauth_submissions_ipd_id_fkey                TO insurance_submissions_ipd_id_fkey;
ALTER TABLE hospital.insurance_submissions
  RENAME CONSTRAINT preauth_submissions_hospital_id_fkey           TO insurance_submissions_hospital_id_fkey;
ALTER TABLE hospital.insurance_submissions
  RENAME CONSTRAINT preauth_submissions_hospital_panel_id_fkey     TO insurance_submissions_hospital_panel_id_fkey;
ALTER TABLE hospital.insurance_submissions
  RENAME CONSTRAINT preauth_submissions_preauth_form_template_id_fkey TO insurance_submissions_preauth_form_template_id_fkey;
ALTER TABLE hospital.insurance_submissions
  RENAME CONSTRAINT preauth_submissions_email_outbound_id_fkey     TO insurance_submissions_email_outbound_id_fkey;
ALTER TABLE hospital.insurance_submissions
  RENAME CONSTRAINT preauth_submissions_resubmission_of_id_fkey    TO insurance_submissions_resubmission_of_id_fkey;
ALTER TABLE hospital.insurance_submissions
  RENAME CONSTRAINT preauth_submissions_submitted_by_fkey          TO insurance_submissions_submitted_by_fkey;

COMMIT;
