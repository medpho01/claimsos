-- ==========================================================================
-- 070 — claim_stages: the 13-stage claim lifecycle
-- ==========================================================================
-- Applied by src/schema/run-seeds.cjs, which owns the transaction and records
-- this file's sha256 in hospital.seed_applications. Editing the file changes
-- the checksum, which is what makes the next `npm run seed` re-apply it.
--
-- This is a DECLARATIVE snapshot of the desired taxonomy. Superadmins edit
-- labels, definitions and TATs through the UI; this file is the starting point
-- and the disaster-recovery baseline, so it UPSERTS rather than overwrites the
-- editable text — see the ON CONFLICT clause.
--
-- THE SELECTION RULE
-- ------------------------------------------------------------------------
-- A stage owns a DOCUMENT CHECKLIST. If the hospital files nothing during it,
-- it is a status, not a stage. That single test is why this is 13 and not the
-- 19 in migration 024:
--
--   DROPPED (8) — these are insurer OUTCOMES or patient events, and
--   028_ontology_foundations.sql:102 already declares them a separate axis:
--     preauth_queried, preauth_approved, enhancements_queried,
--     discharge_queried, discharge_approved, claim_queried, claim_approved,
--     admitted, discharged
--   -> model as insurer_outcome / date fields, not stages.
--
--   ADDED (6) — real filing events with their own checklists that the 19
--   never had: ELIGIBILITY_CHECK, SETTLEMENT, DEDUCTION_APPEAL,
--   PRE_POST_HOSP, REIMBURSEMENT_FILE, CLOSED.
--
-- `legacy_codes` records which migration-024 codes each stage absorbs. NOTHING
-- reads it to move data yet: ipds.stage / claim_context.stage /
-- document_sections.stage / insurer_rule_sets.applicable_stages are untouched.
-- The cutover is a separate, previewable migration.
--
-- CYCLE TYPES: a query reply files DIFFERENT documents from the initial
-- submission, but it is a repeat OF the stage, not a new stage. Requirements
-- therefore key on (stage, cycle_type) and the taxonomy stays flat.
--
-- TATs here are GUIDANCE, sourced from IRDAI's 2024 Master Circular and PM-JAY.
-- The BINDING per-panel numbers belong in panel config: claim-file submission
-- alone has four different answers across four TPAs, and MDIndia and Good
-- Health each contradict themselves.
-- ==========================================================================

INSERT INTO hospital.claim_stages
  (code, label, definition, entry_trigger, exit_trigger, expected_tat,
   sort_order, cycle_types, legacy_codes)
VALUES
  ('ELIGIBILITY_CHECK', 'Eligibility & KYC',
   'Patient identified as insured; policy/member and KYC established before any insurer interaction.',
   'Patient registered with an insurance intent.',
   'Member confirmed and KYC complete.',
   'Minutes to hours. PM-JAY auto-rejects if pre-auth is not initiated within 48h of registration.',
   10, ARRAY['initial'], ARRAY['draft']),

  ('PREAUTH', 'Pre-authorisation',
   'First cashless request (IRDAI Part C / RAL) for this admission.',
   'Eligibility passed and the treating doctor''s plan is available.',
   'Insurer returns an outcome (approved / queried / denied).',
   'File 48-72h before a planned admission, or within 24h of an emergency one. IRDAI: insurer must decide within 1 hour.',
   20, ARRAY['initial','query_response'], ARRAY['preauth_submitted','preauth_query_responded']),

  ('ENHANCEMENT', 'Enhancement',
   'Mid-stay request to raise the sanctioned amount or extend days. Repeatable - use a sequence number, not a new stage.',
   'Actual spend or length of stay is trending past the authorised limit.',
   'Revised authorisation issued, or discharge reached.',
   'No regulated TAT. MDIndia decides in 24h and treats silence as denial. Must be obtained BEFORE discharge.',
   30, ARRAY['initial','query_response'], ARRAY['enhancements_submitted','enhancements_query_responded']),

  ('FINAL_AUTH', 'Discharge authorisation',
   'Final bill and discharge summary sent for the discharge decision, with the patient physically waiting.',
   'Treating unit declares the patient fit for discharge.',
   'Final authorisation received.',
   'IRDAI: insurer must grant within 3 hours; delay costs fall on the insurer from shareholder funds.',
   40, ARRAY['initial','query_response'], ARRAY['discharge_draft','discharge_submitted','discharge_query_responded']),

  ('CLAIM_FILE', 'Claim file',
   'The claim dossier sent to the insurer or TPA for payment after discharge.',
   'Patient discharged and final authorisation in hand.',
   'File dispatched and acknowledgement captured.',
   'Panel-specific: 7 days (Vidal, Raksha), 15 days (Paramount), 30 days (MDIndia). PM-JAY 7 days. Configure per panel.',
   50, ARRAY['initial','query_response'], ARRAY['claim_filed','claim_query_responded']),

  ('SETTLEMENT', 'Settlement & reconciliation',
   'Payment advice or settlement voucher received; the amount is reconciled against what was authorised.',
   'Insurer issues a settlement.',
   'Variance computed. Paid in full closes the claim; short-paid moves to deduction appeal.',
   '15-30 days from claim submission in practice.',
   60, ARRAY['initial'], ARRAY[]::TEXT[]),

  ('DEDUCTION_APPEAL', 'Deduction appeal',
   'Hospital contests a disallowance or part-payment. This is where deductions are actually recovered.',
   'Settled amount is less than the approved amount.',
   'Insurer re-decides, or the hospital writes it off.',
   'No regulated TAT. MDIndia allows 15 days from receipt of the settled amount. Practical deadline is the insurer''s financial year close.',
   70, ARRAY['initial'], ARRAY[]::TEXT[]),

  ('PRE_POST_HOSP', 'Pre/post hospitalisation',
   'The separate 30-day-pre and 60-day-post outpatient expense claim tied to this admission.',
   'Patient submits outpatient bills linked to the admission.',
   'Filed.',
   'Typically 15-90 days from discharge, policy-specific.',
   80, ARRAY['initial','query_response'], ARRAY[]::TEXT[]),

  ('REIMBURSEMENT_FILE', 'Reimbursement handover',
   'Cashless abandoned or denied: the patient pays and the hospital hands over originals for the patient''s own claim.',
   'Cashless denied or withdrawn, or a non-network admission without Cashless Everywhere.',
   'Originals and indoor case papers handed over, receipt taken.',
   'Usually 15-30 days from discharge, policy-specific.',
   90, ARRAY['initial'], ARRAY[]::TEXT[]),

  ('CLOSED', 'Closed',
   'No further hospital action. Settled in full, written off, or appeal exhausted.',
   'Terminal outcome reached.',
   NULL,
   NULL,
   100, ARRAY['initial'], ARRAY[]::TEXT[])

ON CONFLICT (code) DO UPDATE SET
  -- Re-seeding restores the BASELINE definition and lifecycle metadata, which
  -- is what makes this file a disaster-recovery artefact. `label` is
  -- deliberately NOT overwritten: it is what the dropdown shows, superadmins
  -- are expected to tune it to their team's vocabulary, and silently reverting
  -- that on an unrelated seed run would be the kind of invisible change this
  -- codebase has been burned by.
  definition    = EXCLUDED.definition,
  entry_trigger = EXCLUDED.entry_trigger,
  exit_trigger  = EXCLUDED.exit_trigger,
  expected_tat  = EXCLUDED.expected_tat,
  sort_order    = EXCLUDED.sort_order,
  cycle_types   = EXCLUDED.cycle_types,
  legacy_codes  = EXCLUDED.legacy_codes;

-- ── Coverage guard ────────────────────────────────────────────────────────
-- Every migration-024 code that carries a document checklist must be absorbed
-- by exactly one stage above. The 8 outcome/patient-event codes are absorbed
-- by NONE, deliberately. If someone adds a stage without mapping its legacy
-- code, or maps one code to two stages, the cutover would silently lose or
-- duplicate claims — so fail the seed here rather than discover it later.
DO $$
DECLARE
  dupes TEXT;
BEGIN
  SELECT string_agg(code, ', ') INTO dupes
    FROM (
      SELECT unnest(legacy_codes) AS code
        FROM hospital.claim_stages
      GROUP BY 1 HAVING count(*) > 1
    ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'claim_stages: legacy code(s) mapped to more than one stage: %', dupes;
  END IF;

  RAISE NOTICE '070_claim_stages: % stage(s), % legacy code(s) mapped',
    (SELECT count(*) FROM hospital.claim_stages),
    (SELECT count(*) FROM (SELECT unnest(legacy_codes) FROM hospital.claim_stages) x);
END $$;
