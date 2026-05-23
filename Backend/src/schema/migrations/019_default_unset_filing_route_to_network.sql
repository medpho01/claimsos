-- Migration 019: Default unset claim_filing_route to 'network'
-- Date: 2026-05-17
-- Description:
--   Migration 017 left `claim_filing_route` NULL for IPDs whose panel does
--   not have `claim_submission_method = 'email'` set, so the FE rendered
--   them as "—" in the Patients list.
--
--   Hospitals onboarded today are empanelled with every insurer they accept,
--   so any IPD that isn't on the Cashless Everywhere flow is by definition
--   on the Network (portal/empanelment) route. Backfill the NULLs to
--   'network' so the UI shows a meaningful Claim Type for every patient.
--
--   New IPDs already get the right value at INSERT time via the rule in
--   patient.controller.ts addPatient() (sets 'cashless_everywhere' when the
--   panel's submission method is 'email', leaves the column to default to
--   NULL otherwise). This migration only fixes pre-existing rows.

BEGIN;

UPDATE hospital.ipds
   SET claim_filing_route = 'network'
 WHERE claim_filing_route IS NULL;

COMMIT;
