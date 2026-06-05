-- Migration 072: claim financials (the four amounts)
-- Date: 2026-06-03
-- Description:
--   One row per claim tracking the pre-auth and final money, with provenance
--   for the LLM-extracted approved amounts:
--     * preauth_claimed / final_claimed  → admin-entered (what the hospital asked)
--     * preauth_approved / final_approved → extracted from the insurer email by
--       the email-intelligence pipeline, written when the reviewer APPLIES the
--       draft (i.e. confirms it). Provenance columns trace each approved amount
--       back to the exact inbound email + the extraction confidence.
--   Deduction at each stage = claimed - approved (derived in queries).

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.claim_financials (
  claim_id                            uuid PRIMARY KEY
                                        REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  preauth_claimed_amount              numeric(14,2),
  preauth_approved_amount             numeric(14,2),
  final_claimed_amount                numeric(14,2),
  final_approved_amount               numeric(14,2),
  -- provenance for the two LLM-extracted approved amounts
  preauth_approved_source_inbound_id  uuid,
  preauth_approved_confidence         numeric(4,3),
  final_approved_source_inbound_id    uuid,
  final_approved_confidence           numeric(4,3),
  updated_by                          text,
  created_at                          timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now()
);

COMMIT;
