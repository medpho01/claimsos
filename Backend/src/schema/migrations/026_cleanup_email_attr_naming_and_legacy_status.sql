-- Migration 026: Schema & naming cleanup (Batch 1: A3 + A4)
-- Date: 2026-05-17
--
-- A3 — Drop the duplicate `claim_submission_email` panel_attribute_definition.
--      Canonical key for the recipient list is `cashless_email_to_list` (about
--      to be renamed to `email_to_list`). Master rows had the same value in
--      both; we verified 0 rows would lose data by dropping the dupe.
--
-- A4 — Rename `cashless_*` keys → `email_*`. The "cashless" prefix dates from
--      when CEW email was the only flow we supported. After the table rename
--      to insurance_submissions and the channel-agnostic refactor, these
--      attributes apply to every stage of every claim. Drop the prefix.
--
-- A6 (DEFERRED): claims.latest_status is still actively used by the standalone
--      Claims Management UI (claims.controller.ts INSERT/UPDATE). Dropping the
--      column would break that feature. Removed from this batch. The patient
--      header pill (P10) is removed at the FE level only.
--
-- A10 (code-only): handled in gmailAuth.service.ts, no DB change here.
--
-- All steps run in a single transaction so a failure rolls everything back.

BEGIN;

-- ─── A3: Drop the duplicate claim_submission_email definition ──────────────
-- Sanity: at this point we already know no (hospital × panel) row has it set
-- without the cashless_email_to_list dupe (verified pre-flight).
DELETE FROM hospital.panel_default_attributes
 WHERE panel_attribute_definition_id IN (
   SELECT id FROM hospital.panel_attribute_definitions WHERE key = 'claim_submission_email'
 );
DELETE FROM hospital.panel_attributes
 WHERE panel_attribute_definition_id IN (
   SELECT id FROM hospital.panel_attribute_definitions WHERE key = 'claim_submission_email'
 );
DELETE FROM hospital.panel_attribute_definitions
 WHERE key = 'claim_submission_email';

-- ─── A4: Rename cashless_* → email_* ──────────────────────────────────────
-- The panel_attribute_definitions row carries the canonical key. The
-- denormalized `panel_attributes.attribute_key` column needs to be updated
-- in step too — the FK is the definition_id, but the redundant column is
-- written by application code and we want it to match.

UPDATE hospital.panel_attribute_definitions
   SET key   = 'email_to_list',
       label = REGEXP_REPLACE(label, '^Cashless Pre-Auth: ', '', 'g')
 WHERE key = 'cashless_email_to_list';

UPDATE hospital.panel_attribute_definitions
   SET key   = 'email_cc_list',
       label = REGEXP_REPLACE(label, '^Cashless Pre-Auth: ', '', 'g')
 WHERE key = 'cashless_email_cc_list';

UPDATE hospital.panel_attribute_definitions
   SET key   = 'email_subject_template',
       label = REGEXP_REPLACE(label, '^Cashless Pre-Auth: ', '', 'g')
 WHERE key = 'cashless_subject_template';

-- Sync the denormalized attribute_key column on panel_attributes
UPDATE hospital.panel_attributes
   SET attribute_key = 'email_to_list'
 WHERE attribute_key = 'cashless_email_to_list';

UPDATE hospital.panel_attributes
   SET attribute_key = 'email_cc_list'
 WHERE attribute_key = 'cashless_email_cc_list';

UPDATE hospital.panel_attributes
   SET attribute_key = 'email_subject_template'
 WHERE attribute_key = 'cashless_subject_template';

COMMIT;
