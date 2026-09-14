-- ==========================================================================
-- 080 — document_stage_affinity: evergreen flags and stage floors
-- ==========================================================================
-- Applied by src/schema/run-seeds.cjs, which owns the transaction and records
-- this file's sha256 in hospital.seed_applications.
--
-- The baseline mapping. Superadmins tune it through the Document Mapping
-- screen; this file is the starting point and the disaster-recovery artefact.
--
-- Only the categories with a DEFENSIBLE mapping appear here. The other ~215 of
-- the 246 have no row, which correctly means "no floor, not evergreen, no
-- affinity" — the human's upload choice stands unconditionally. Filling in
-- rows we cannot justify would be worse than leaving them empty: a wrong
-- stage_floor REJECTS a correct human choice.
--
-- Every slug below was verified to exist in seeds/010 before being written.
-- That check is not paranoia: Services/context/resolver.ts:44-54 has shipped a
-- nine-slug dictionary of which six do not exist, which is why enhancement
-- inference has never once fired in production.
-- ==========================================================================

-- ── A. EVERGREEN — evidence at every stage ────────────────────────────────
-- Test applied: does this assert a fact about the PERSON or the POLICY, rather
-- than about this episode? If yes it cannot go stale between pre-auth and
-- settlement, and a copy filed once satisfies every stage.
--
-- Insurers really do re-demand these late: Vidal's settlement checklist asks
-- for "ID proof - submitted during Preliminary Pre-auth process", i.e. the
-- identical artefact, re-filed. And IRDAI's KYC obligation is PAYOUT-triggered
-- (mandatory above 1 lakh per IRDA/SDD/GDL/CIR/020/02/2013), not stage-
-- triggered, so identity has to be retrievable at whatever stage the value
-- test fires.
--
-- NOT the whole kyc_identity_insurance group. Two members fail the test and
-- are deliberately excluded:
--   referral_letter          - refers the patient for THIS treatment. Episode
--                              evidence wearing a KYC group label.
--   patient_registration_form - produced per admission, not per person.
INSERT INTO hospital.document_stage_affinity (doc_category, is_evergreen, notes) VALUES
  ('aadhaar_front',             TRUE, 'Identity — fact about the person.'),
  ('aadhaar_back',              TRUE, 'Identity — fact about the person.'),
  ('aadhaar_card',              TRUE, 'Identity — fact about the person.'),
  ('pan_card',                  TRUE, 'Identity — required for KYC above ₹1 lakh payout.'),
  ('identity_proof',            TRUE, 'Identity — fact about the person.'),
  ('voter_id',                  TRUE, 'Identity — fact about the person.'),
  ('passport',                  TRUE, 'Identity — fact about the person.'),
  ('driving_license',           TRUE, 'Identity — fact about the person.'),
  ('address_proof',             TRUE, 'Identity — required for KYC above ₹1 lakh payout.'),
  ('age_proof',                 TRUE, 'Identity — fact about the person.'),
  ('relationship_proof',        TRUE, 'Eligibility — dependant relationship to the policyholder.'),
  ('ration_card',               TRUE, 'Identity / eligibility — fact about the household.'),
  ('policy_card',               TRUE, 'Eligibility — fact about the policy.'),
  ('insurance_e_card',          TRUE, 'Eligibility — fact about the policy.'),
  ('tpa_id_card',               TRUE, 'Eligibility — fact about the policy.'),
  ('employee_id_card',          TRUE, 'Eligibility — corporate policy membership.'),
  ('corporate_id_card',         TRUE, 'Eligibility — corporate policy membership.'),
  ('abha_card',                 TRUE, 'Identity — national health ID.'),
  ('pmjay_card',                TRUE, 'Eligibility — scheme beneficiary status.'),
  ('insurance_enrollment_form', TRUE, 'Eligibility — fact about the policy.')
ON CONFLICT (doc_category) DO UPDATE SET
  is_evergreen = EXCLUDED.is_evergreen,
  notes        = COALESCE(hospital.document_stage_affinity.notes, EXCLUDED.notes);

-- ── B. CONDITIONALLY EVERGREEN ────────────────────────────────────────────
-- Facts about the INCIDENT, not about a stage. Vidal asks for MLC/FIR at
-- pre-auth, again at final approval "if not submitted at the time of
-- Preliminary Authorisation", and again as a certified copy at settlement —
-- the same artefact three times. Gated on an accident case flag so they are
-- not demanded of every claim.
INSERT INTO hospital.document_stage_affinity
  (doc_category, is_evergreen, required_when, notes) VALUES
  ('mlc_documents', TRUE, 'accident OR rta OR assault OR poisoning OR burn',
   'Fact about the incident — re-demanded at pre-auth, final approval and settlement.'),
  ('fir_copy',      TRUE, 'accident OR rta OR assault OR poisoning OR burn',
   'Fact about the incident — re-demanded at pre-auth, final approval and settlement.')
ON CONFLICT (doc_category) DO UPDATE SET
  is_evergreen  = EXCLUDED.is_evergreen,
  required_when = COALESCE(hospital.document_stage_affinity.required_when, EXCLUDED.required_when),
  notes         = COALESCE(hospital.document_stage_affinity.notes, EXCLUDED.notes);

-- ── C. STAGE FLOORS — the earliest stage an artefact can PHYSICALLY exist ──
-- This is the ONLY field allowed to override a human's upload choice, and only
-- ever to reject the impossible. A `final_bill` tagged PREAUTH is rejected
-- because no final bill exists before discharge; a `final_bill` tagged
-- SETTLEMENT is ACCEPTED, because the same artefact legitimately travels with
-- the claim file and the deduction appeal.
--
-- Conservative by design: a category earns a floor only when no realistic
-- counter-example exists. `cashless_approval_letter` is deliberately absent —
-- IRDAI's Part D is issued at initial authorisation, at EVERY enhancement and
-- at final authorisation, so it is ambiguous, not locked.
INSERT INTO hospital.document_stage_affinity
  (doc_category, stage_floor, affinity_stage, notes) VALUES
  ('pre_authorization_form',    'PREAUTH',     'PREAUTH',
   'IRDAI Part C. Evidence FOR pre-auth even when it physically arrives inside the post-discharge envelope.'),
  ('cost_estimate',             'PREAUTH',     'PREAUTH',
   'Part C cost block. Superseded by revised_estimate at enhancement and final_bill later.'),
  ('package_estimate',          'PREAUTH',     'PREAUTH',
   'As cost_estimate.'),
  ('enhancement_request_form',  'ENHANCEMENT', 'ENHANCEMENT',
   'Exists only to request an increase on a LIVE authorisation — cannot precede admission, meaningless after final authorisation.'),
  ('revised_estimate',          'ENHANCEMENT', 'ENHANCEMENT',
   'Revises a cost_estimate that already went with a pre-auth.'),
  ('interim_bill',              'ENHANCEMENT', 'ENHANCEMENT',
   'Before admission there is no bill; at discharge the artefact is final_bill.'),
  ('final_bill',                'FINAL_AUTH',  'CLAIM_FILE',
   'Cannot precede discharge. Floor only — it travels with the claim file and the deduction appeal too.'),
  ('discharge_summary',         'FINAL_AUTH',  'CLAIM_FILE',
   'Cannot precede discharge. Most-queried document in Indian claims.'),
  ('discharge_slip',            'FINAL_AUTH',  'FINAL_AUTH',
   'Cannot precede discharge.'),
  ('ot_notes',                  'FINAL_AUTH',  'CLAIM_FILE',
   'Cannot precede the surgery it records.'),
  ('implant_invoice',           'FINAL_AUTH',  'CLAIM_FILE',
   'Cannot precede the implant being used.'),
  ('implant_sticker',           'FINAL_AUTH',  'CLAIM_FILE',
   'Cannot precede the implant being used. Count must match implants billed.'),
  ('final_authorization_letter','FINAL_AUTH',  'FINAL_AUTH',
   'The discharge decision itself.'),
  ('reimbursement_claim_form',  'CLAIM_FILE',  'CLAIM_FILE',
   'IRDAI Part A + B, filed with the claim folder.'),
  ('insurance_deduction_sheet', 'SETTLEMENT',  'SETTLEMENT',
   'Can only exist after the payer has adjudicated. This is Part D''s deduction table.'),
  ('tpa_settlement_sheet',      'SETTLEMENT',  'SETTLEMENT',
   'Post-payment artefact.'),
  ('payment_settlement_summary','SETTLEMENT',  'SETTLEMENT',
   'Post-payment artefact.')
ON CONFLICT (doc_category) DO UPDATE SET
  stage_floor    = EXCLUDED.stage_floor,
  affinity_stage = EXCLUDED.affinity_stage,
  notes          = COALESCE(hospital.document_stage_affinity.notes, EXCLUDED.notes);

-- ── Integrity guards ──────────────────────────────────────────────────────
DO $$
DECLARE
  bad_cat   TEXT;
  bad_stage TEXT;
  ever_cnt  INT;
  floor_cnt INT;
BEGIN
  -- Every doc_category referenced must actually exist. There is no FK
  -- (master_options has a composite key), and a typo would otherwise sit here
  -- silently doing nothing — the exact failure mode of docMixStageClass.
  SELECT string_agg(a.doc_category, ', ') INTO bad_cat
    FROM hospital.document_stage_affinity a
   WHERE NOT EXISTS (
     SELECT 1 FROM hospital.master_options m
      WHERE m.category = 'doc_category' AND m.code = a.doc_category);
  IF bad_cat IS NOT NULL THEN
    RAISE EXCEPTION '080: unknown doc_category slug(s): %', bad_cat;
  END IF;

  -- Every stage referenced must exist in the registry, or a floor silently
  -- rejects nothing and an affinity silently points nowhere.
  SELECT string_agg(DISTINCT s, ', ') INTO bad_stage FROM (
    SELECT stage_floor AS s FROM hospital.document_stage_affinity WHERE stage_floor IS NOT NULL
    UNION
    SELECT affinity_stage FROM hospital.document_stage_affinity WHERE affinity_stage IS NOT NULL
  ) u WHERE NOT EXISTS (SELECT 1 FROM hospital.claim_stages c WHERE c.code = u.s);
  IF bad_stage IS NOT NULL THEN
    RAISE EXCEPTION '080: unknown stage code(s): % (see seeds/070_claim_stages.sql)', bad_stage;
  END IF;

  -- An evergreen document with a stage floor is a contradiction: "counts at
  -- every stage" versus "cannot exist before stage X".
  IF EXISTS (SELECT 1 FROM hospital.document_stage_affinity
              WHERE is_evergreen AND stage_floor IS NOT NULL) THEN
    RAISE EXCEPTION '080: a category cannot be both evergreen and floored';
  END IF;

  SELECT count(*) INTO ever_cnt  FROM hospital.document_stage_affinity WHERE is_evergreen;
  SELECT count(*) INTO floor_cnt FROM hospital.document_stage_affinity WHERE stage_floor IS NOT NULL;
  RAISE NOTICE '080_document_stage_affinity: % evergreen, % floored', ever_cnt, floor_cnt;
END $$;
