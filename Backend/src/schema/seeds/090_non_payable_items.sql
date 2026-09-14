-- ==========================================================================
-- 090 — non_payable_items: IRDAI's four lists
-- ==========================================================================
-- Applied by src/schema/run-seeds.cjs, which owns the transaction and records
-- this file's sha256 in hospital.seed_applications.
--
-- ⚠ THIS IS A PARTIAL IMPORT AND THE SCREEN SAYS SO.
--
-- IRDAI/HLT/REG/CIR/176/09/2019 Annexure-I contains 146 items: List I 68,
-- List II 37, List III 23, List IV 18. Counted directly from the circular.
-- (NOT the 199 repeated across vendor blogs — that figure traces to the
-- superseded 2016 circular and appears in no current primary source.)
--
-- Seeded below are only the items quoted VERBATIM in sources I could verify.
-- The rest have to be imported from the circular PDF itself. Seeding invented
-- item names would be worse than leaving them out: a wrong entry produces a
-- false deduction warning on a legitimate bill line, and the reviewer who
-- disproves it learns to distrust the whole check.
--
-- Until the full import lands, a bill line matching NOTHING here is not
-- evidence it is payable. The screen reports coverage so nobody mistakes a
-- quiet result for a clean bill.
--
-- WHY `aliases` MATTERS MORE THAN THE NAMES
-- --------------------------------------------------------------------------
-- Hospital billing systems do not write the circular's wording. One catalogued
-- item appears as "GLOVES", "SURGICAL GLOVES", "GLOVE PAIR STERILE". A literal
-- match finds almost nothing, so aliases are learned from real bills — the
-- Non-Payables screen surfaces unmatched bill lines for exactly that.
--
-- WHY `list_number` MATTERS COMMERCIALLY
-- --------------------------------------------------------------------------
-- Para 2 of the circular requires insurers to make "such items shall not be
-- billed to the policyholders by the hospitals" part of the SLA with network
-- providers. So for a NETWORK CASHLESS claim, a List II/III/IV line is the
-- hospital breaching its own empanelment agreement — a stronger lever with a
-- billing team than "we lost money".
-- ==========================================================================

INSERT INTO hospital.non_payable_items (item_name, list_number, aliases, notes) VALUES
  -- ── List I — optional cover; non-payable unless the policy bought it ────
  ('BABY FOOD',                    'I',  ARRAY['baby food','infant formula','baby milk'], NULL),
  ('BEAUTY SERVICES',              'I',  ARRAY['beauty services','salon'], NULL),
  ('BELTS/BRACES',                 'I',  ARRAY['belt','brace','abdominal belt','lumbar belt'], NULL),
  ('AMBULANCE',                    'I',  ARRAY['ambulance','ambulance charges','ambulance service'],
   'Often covered by a separate policy sub-limit — check before flagging.'),
  ('VASOFIX SAFETY',               'I',  ARRAY['vasofix','vasofix safety'], NULL),

  -- ── List II — subsumed into ROOM charges ───────────────────────────────
  ('HAND WASH',                    'II', ARRAY['hand wash','handwash','hand rub'], NULL),
  ('SHOE COVER',                   'II', ARRAY['shoe cover','shoe covers'], NULL),
  ('CAPS',                         'II', ARRAY['cap','caps','surgical cap'], NULL),
  ('CRADLE CHARGES',               'II', ARRAY['cradle','cradle charges'], NULL),
  ('FILE OPENING CHARGES',         'II', ARRAY['file opening','file charges','record charges'], NULL),
  ('PATIENT IDENTIFICATION BAND',  'II', ARRAY['id band','identification band','patient band','wrist band'], NULL),
  ('PULSEOXYMETER CHARGES',        'II', ARRAY['pulseoximeter','pulse oximeter','spo2 probe'], NULL),
  ('INCIDENTAL EXPENSES / MISC. CHARGES (NOT EXPLAINED)', 'II',
   ARRAY['incidental','miscellaneous','misc charges','other charges','sundry'],
   'The catch-all the circular names explicitly. An unexplained miscellaneous line is non-payable by default.'),

  -- ── List III — subsumed into PROCEDURE charges ─────────────────────────
  ('HAIR REMOVAL CREAM',           'III', ARRAY['hair removal cream','depilatory'], NULL),
  ('DISPOSABLE RAZORS',            'III', ARRAY['razor','disposable razor','shaving'], NULL),
  ('EYE PAD',                      'III', ARRAY['eye pad','eye patch'], NULL),
  ('APRON',                        'III', ARRAY['apron','disposable apron'], NULL),
  ('TORNIQUET',                    'III', ARRAY['torniquet','tourniquet'], NULL),
  ('ORTHOBUNDLE / GYNAEC BUNDLE',  'III', ARRAY['orthobundle','gynaec bundle','ortho bundle','surgical bundle'], NULL),

  -- ── List IV — subsumed into the COST OF TREATMENT ──────────────────────
  ('ADMISSION / REGISTRATION CHARGES', 'IV',
   ARRAY['admission charges','registration charges','admission fee','registration fee'],
   'A common and easily-detected line — it appears on most Indian hospital bills.'),
  ('URINE CONTAINER',              'IV', ARRAY['urine container','urine jar'], NULL),
  ('BIPAP MACHINE',                'IV', ARRAY['bipap','bipap machine','bipap charges'], NULL),
  ('INFUSION PUMP - COST',         'IV', ARRAY['infusion pump','syringe pump'], NULL),
  ('DIETICIAN / DIET CHARGES',     'IV', ARRAY['dietician','diet charges','dietary','nutrition charges'], NULL),
  ('VACCINATION CHARGES',          'IV', ARRAY['vaccination','vaccine charges','immunisation'], NULL),
  ('GLUCOMETER & STRIPS',          'IV', ARRAY['glucometer','glucose strips','glucostrips','bsl strips'], NULL),
  ('URINE BAG',                    'IV', ARRAY['urine bag','urobag','urine collection bag'], NULL)

ON CONFLICT (lower(item_name)) WHERE panel_id IS NULL DO UPDATE SET
  list_number = EXCLUDED.list_number,
  -- Aliases are LEARNED from real bills through the UI, so a re-seed must add
  -- the baseline back without discarding what has been observed since.
  aliases     = ARRAY(SELECT DISTINCT unnest(
                  hospital.non_payable_items.aliases || EXCLUDED.aliases)),
  notes       = COALESCE(hospital.non_payable_items.notes, EXCLUDED.notes);

DO $$
DECLARE
  n INT;
BEGIN
  SELECT count(*) INTO n FROM hospital.non_payable_items WHERE panel_id IS NULL;
  RAISE NOTICE '090_non_payable_items: % of 146 IRDAI items seeded (PARTIAL - '
    'the remainder must be imported from IRDAI/HLT/REG/CIR/176/09/2019 '
    'Annexure-I; a bill line matching nothing is NOT evidence it is payable)', n;
END $$;
