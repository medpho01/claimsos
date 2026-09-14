-- =============================================================================
-- 077 — claim_stages: the configurable stage taxonomy  (2026-09-14)
-- =============================================================================
-- Gives the claim lifecycle a real table so a Finclarity superadmin can own it
-- from the UI, and so a stage can carry the metadata the adjudication layer and
-- the upload dropdown both need (definition, entry/exit, TAT, order, which
-- cycle types apply).
--
-- WHY A TABLE RATHER THAN master_options(category='ipd_stage')
-- ------------------------------------------------------------------
-- The 19 codes in migration 024 live in master_options, which has room for
-- code/label/description/sort_order and nothing else. A stage now needs to
-- carry an entry trigger, an exit trigger, a TAT, and its applicable cycle
-- types — and the adjudication engine selects rule packs on it. Bolting four
-- more columns onto a generic dropdown table would make master_options the
-- de-facto stage registry for every future reader; a named table says what it
-- is.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ------------------------------------------------------------------
-- It does NOT touch ipds.stage, claim_context.stage, document_sections.stage,
-- or insurer_rule_sets.applicable_stages. Those are free-text VARCHAR with no
-- FK (by design, per 067), holding 19 lowercase codes today, and a rename is a
-- SILENT data migration across four columns plus a TEXT[]. Doing that in the
-- same change that introduces the vocabulary would make it impossible to
-- verify either half.
--
-- Instead each new stage records `legacy_codes` — the migration-024 codes it
-- absorbs — so the mapping is data, reviewable in the UI, and the cutover is a
-- separate step that can be previewed against live claims first.
--
-- WHY 13 AND NOT 19
-- ------------------------------------------------------------------
-- A stage owns a DOCUMENT CHECKLIST. If the hospital files nothing during it,
-- it is a status, not a stage. Eight of the 19 (`*_queried`, `*_approved`,
-- `admitted`, `discharged`) are things the INSURER did or states the patient
-- is in — and 028_ontology_foundations.sql:102 already says so explicitly:
-- "outcome describes what the insurer said, stage describes where the claim is
-- in our internal workflow". Those become insurer_outcome values.
--
-- Meanwhile six real filing events were missing entirely — eligibility/KYC,
-- settlement, deduction appeal, pre/post hospitalisation, reimbursement
-- handover, and closure. DEDUCTION_APPEAL matters commercially: IRDAI's
-- FY2024-25 numbers put disallowance at ₹18,521 cr against ₹11,412 cr of
-- outright repudiation, and that is the stage where a hospital-side TPA
-- actually recovers it.
--
-- Forward-only, additive, idempotent.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.claim_stages (
  code                VARCHAR(64) PRIMARY KEY,

  -- What the ward clerk sees in the upload dropdown. Always editable; `code`
  -- is not, once claims reference it.
  label               VARCHAR(160) NOT NULL,

  -- One line. Shown as dropdown help text — this is what stops a clerk at 7pm
  -- picking the wrong bucket, so it is NOT optional.
  definition          TEXT         NOT NULL,

  -- What moves a claim in, and what moves it out. Operational documentation
  -- that lives next to the thing it describes rather than in a wiki.
  entry_trigger       TEXT,
  exit_trigger        TEXT,

  -- Expected turnaround, free text because the unit varies wildly (minutes for
  -- discharge authorisation, days for a claim file). The BINDING per-panel
  -- numbers live in panel config, not here: claim-file submission alone has
  -- four different answers across four TPAs, and two of them contradict
  -- themselves. This column is guidance, never an enforced deadline.
  expected_tat        TEXT,

  -- Lifecycle position. Drives dropdown order AND the "past stages free /
  -- next stage with a confirm" rule in the upload picker.
  sort_order          INT          NOT NULL,

  -- Which submission cycles apply. A query reply files DIFFERENT documents
  -- from the initial submission, but it is a repeat OF the stage, not a
  -- separate stage — so requirements key on (stage, cycle_type) rather than
  -- the taxonomy growing a QUERY_RESPONSE member.
  cycle_types         TEXT[]       NOT NULL DEFAULT ARRAY['initial']::TEXT[],

  -- The migration-024 codes this stage absorbs. The cutover reads this; it is
  -- also what the UI shows an admin so the mapping is reviewable BEFORE any
  -- claim data moves.
  legacy_codes        TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Retire, never delete: codes are referenced by rule sets, document
  -- requirements and live claims.
  is_active           BOOLEAN      NOT NULL DEFAULT TRUE,

  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_stages_sort
  ON hospital.claim_stages (sort_order);

CREATE INDEX IF NOT EXISTS idx_claim_stages_active
  ON hospital.claim_stages (sort_order) WHERE is_active;

CREATE OR REPLACE FUNCTION hospital.touch_claim_stages_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_claim_stages_updated_at ON hospital.claim_stages;
CREATE TRIGGER trg_claim_stages_updated_at
  BEFORE UPDATE ON hospital.claim_stages
  FOR EACH ROW EXECUTE FUNCTION hospital.touch_claim_stages_updated_at();

COMMENT ON TABLE hospital.claim_stages IS
  'Configurable claim lifecycle stages. A stage owns a document checklist; if '
  'the hospital files nothing during it, it belongs in insurer_outcome instead. '
  'Superadmin-editable. Does NOT yet drive ipds.stage — see legacy_codes.';

COMMIT;
