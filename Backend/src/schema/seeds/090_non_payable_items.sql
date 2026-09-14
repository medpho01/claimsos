-- ==========================================================================
-- 090 — non_payable_items: IRDAI's four lists, COMPLETE
-- ==========================================================================
-- Applied by src/schema/run-seeds.cjs, which owns the transaction and records
-- this file's sha256 in hospital.seed_applications.
--
-- SOURCE
-- IRDAI/HLT/REG/CIR/176/09/2019 Annexure-I, all four lists, transcribed from
-- the published annexure:
--     List I   68  items for which coverage is not available in the policy
--     List II  37  items to be subsumed into ROOM charges
--     List III 23  items to be subsumed into PROCEDURE charges
--     List IV  18  items to be subsumed into COSTS OF TREATMENT
--                 = 146
--
-- 146, not the 199 repeated across vendor blogs — that figure traces to the
-- superseded 2016 circular and appears in no current primary source. The count
-- is asserted at the bottom of this file, so a partial edit fails the seed
-- rather than quietly shrinking the catalog.
--
-- An earlier revision of this file carried only the 27 items quoted verbatim
-- in secondary sources, with a banner saying so. The banner is gone because
-- the gap is gone.
--
-- WHY THE FOUR LISTS ARE NOT INTERCHANGEABLE
-- --------------------------------------------------------------------------
-- List I is "not payable at all". Lists II-IV are "payable, but ALREADY paid
-- for" — the item is subsumed into the room rate, the procedure charge or the
-- treatment cost, so billing it as a separate line is double-charging. The
-- remedy differs: a List I line is removed, a List II-IV line is folded back
-- into its parent charge. A reviewer needs to know which.
--
-- WHY `aliases` MATTERS MORE THAN THE NAMES
-- --------------------------------------------------------------------------
-- Hospital billing systems do not write the circular's wording. One catalogued
-- item appears as "GLOVES", "SURGICAL GLOVES", "GLOVE PAIR STERILE". A literal
-- match finds almost nothing, so aliases are learned from real bills — the
-- Non-Payables screen surfaces unmatched bill lines for exactly that. The
-- aliases below are a STARTING POINT, not a finished mapping.
--
-- WHY `list_number` MATTERS COMMERCIALLY
-- --------------------------------------------------------------------------
-- Para 2 of the circular requires insurers to make "such items shall not be
-- billed to the policyholders by the hospitals" part of the SLA with network
-- providers. So for a NETWORK CASHLESS claim, a List II/III/IV line is the
-- hospital breaching its own empanelment agreement — a stronger lever with a
-- billing team than "we lost money".
-- ==========================================================================

-- ── Renames ───────────────────────────────────────────────────────────────
-- Eight items were first seeded under a spelling the circular does not use.
-- The unique index is on lower(item_name), so inserting the correct spelling
-- would create a SECOND row and strand the first — along with every alias
-- learned against it. Fold the aliases forward, then drop the old row.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('INCIDENTAL EXPENSES / MISC. CHARGES (NOT EXPLAINED)', 'INCIDENTAL EXPENSES/ MISC. CHARGES (NOT EXPLAINED)'),
    ('PATIENT IDENTIFICATION BAND', 'PATIENT IDENTIFICATION BAND/ NAME TAG'),
    ('DISPOSABLE RAZORS', 'DISPOSABLE RAZOR CHARGES (FOR SITE PREPARATIONS)'),
    ('ORTHOBUNDLE / GYNAEC BUNDLE', 'ORTHOBUNDLE, GYNAEC BUNDLE'),
    ('ADMISSION / REGISTRATION CHARGES', 'ADMISSION/REGISTRATION CHARGES'),
    ('DIETICIAN / DIET CHARGES', 'NUTRITION PLANNING CHARGES - DIETICIAN CHARGES- DIET CHARGES'),
    ('GLUCOMETER & STRIPS', 'GLUCO METER & STRIPS'),
    ('INFUSION PUMP - COST', 'INFUSION PUMP- COST')
  ) AS t(old_name, new_name) LOOP
    UPDATE hospital.non_payable_items tgt
       SET aliases = ARRAY(SELECT DISTINCT unnest(tgt.aliases || src.aliases))
      FROM hospital.non_payable_items src
     WHERE src.panel_id IS NULL AND lower(src.item_name) = lower(r.old_name)
       AND tgt.panel_id IS NULL AND lower(tgt.item_name) = lower(r.new_name);

    -- No target row yet (first run after this change): rename in place so the
    -- aliases travel with it rather than being dropped on the floor.
    UPDATE hospital.non_payable_items
       SET item_name = r.new_name
     WHERE panel_id IS NULL AND lower(item_name) = lower(r.old_name)
       AND NOT EXISTS (
         SELECT 1 FROM hospital.non_payable_items x
          WHERE x.panel_id IS NULL AND lower(x.item_name) = lower(r.new_name));

    DELETE FROM hospital.non_payable_items
     WHERE panel_id IS NULL AND lower(item_name) = lower(r.old_name);
  END LOOP;
END $$;

INSERT INTO hospital.non_payable_items (item_name, list_number, aliases, notes) VALUES

  -- ── List I — coverage not available in the policy (68) ─────────────────
  ('BABY FOOD', 'I', ARRAY['baby food','infant formula','baby milk','formula feed'], NULL),
  ('BABY UTILITIES CHARGES', 'I', ARRAY['baby utilities charges','baby utility','baby utilities'], NULL),
  ('BEAUTY SERVICES', 'I', ARRAY['beauty services','salon','beautician'], NULL),
  ('BELTS/BRACES', 'I', ARRAY['belts/braces','belt','brace','abdominal belt','lumbar belt'], NULL),
  ('BUDS', 'I', ARRAY['buds','cotton buds','ear buds'], NULL),
  ('COLD PACK/HOT PACK', 'I', ARRAY['cold pack/hot pack','cold pack','hot pack','ice pack'], NULL),
  ('CARRY BAGS', 'I', ARRAY['carry bags','carry bag','plastic bag','polythene bag'], NULL),
  ('EMAIL/ INTERNET CHARGES', 'I', ARRAY['email/ internet charges','internet charges','email charges','wifi charges'], NULL),
  ('FOOD CHARGES (OTHER THAN PATIENT''s DIET PROVIDED BY HOSPITAL)', 'I', ARRAY['food charges (other than patient''s diet provided by hospital)','food charges','canteen','attendant food'], NULL),
  ('LEGGINGS', 'I', ARRAY['leggings','legging'], NULL),
  ('LAUNDRY CHARGES', 'I', ARRAY['laundry charges','laundry','washing charges'], NULL),
  ('MINERAL WATER', 'I', ARRAY['mineral water','water bottle','drinking water','packaged water'], NULL),
  ('SANITARY PAD', 'I', ARRAY['sanitary pad','sanitary napkin','sanitary pads'], NULL),
  ('TELEPHONE CHARGES', 'I', ARRAY['telephone charges','telephone','phone charges','std charges'], NULL),
  ('GUEST SERVICES', 'I', ARRAY['guest services','guest service','visitor services'], NULL),
  ('CREPE BANDAGE', 'I', ARRAY['crepe bandage','crape bandage','elastic bandage'], NULL),
  ('DIAPER OF ANY TYPE', 'I', ARRAY['diaper of any type','diaper','diapers','adult diaper','pampers'], NULL),
  ('EYELET COLLAR', 'I', ARRAY['eyelet collar'], NULL),
  ('SLINGS', 'I', ARRAY['slings','sling','arm sling'], NULL),
  ('BLOOD GROUPING AND CROSS MATCHING OF DONORS SAMPLES', 'I', ARRAY['blood grouping and cross matching of donors samples','blood grouping','cross matching','donor screening'], NULL),
  ('SERVICE CHARGES WHERE NURSING CHARGE ALSO CHARGED', 'I', ARRAY['service charges where nursing charge also charged','service charges','service charge'], NULL),
  ('TELEVISION CHARGES', 'I', ARRAY['television charges','television','tv charges'], NULL),
  ('SURCHARGES', 'I', ARRAY['surcharges','surcharge'], NULL),
  ('ATTENDANT CHARGES', 'I', ARRAY['attendant charges','attendant','attender charges','bystander charges'], NULL),
  ('EXTRA DIET OF PATIENT (OTHER THAN THAT WHICH FORMS PART OF BED CHARGE)', 'I', ARRAY['extra diet of patient (other than that which forms part of bed charge)','extra diet','special diet'], NULL),
  ('BIRTH CERTIFICATE', 'I', ARRAY['birth certificate'], NULL),
  ('CERTIFICATE CHARGES', 'I', ARRAY['certificate charges','certificate fee'], NULL),
  ('COURIER CHARGES', 'I', ARRAY['courier charges','courier','postage'], NULL),
  ('CONVEYANCE CHARGES', 'I', ARRAY['conveyance charges','conveyance','transport charges','travel charges'], NULL),
  ('MEDICAL CERTIFICATE', 'I', ARRAY['medical certificate','fitness certificate'], NULL),
  ('MEDICAL RECORDS', 'I', ARRAY['medical records','mrd charges','case sheet charges'], NULL),
  ('PHOTOCOPIES CHARGES', 'I', ARRAY['photocopies charges','photocopy','xerox','photocopies'], NULL),
  ('MORTUARY CHARGES', 'I', ARRAY['mortuary charges','mortuary','morgue charges'], NULL),
  ('WALKING AIDS CHARGES', 'I', ARRAY['walking aids charges','walker','walking aid','crutches'], NULL),
  ('OXYGEN CYLINDER (FOR USAGE OUTSIDE THE HOSPITAL)', 'I', ARRAY['oxygen cylinder (for usage outside the hospital)','oxygen cylinder'], NULL),
  ('SPACER', 'I', ARRAY['spacer','inhaler spacer'], NULL),
  ('SPIROMETRE', 'I', ARRAY['spirometre','spirometer','incentive spirometry'], NULL),
  ('NEBULIZER KIT', 'I', ARRAY['nebulizer kit','nebuliser kit'], NULL),
  ('STEAM INHALER', 'I', ARRAY['steam inhaler','steam vaporizer'], NULL),
  ('ARMSLING', 'I', ARRAY['armsling','arm sling'], NULL),
  ('THERMOMETER', 'I', ARRAY['thermometer','digital thermometer'], NULL),
  ('CERVICAL COLLAR', 'I', ARRAY['cervical collar','neck collar'], NULL),
  ('SPLINT', 'I', ARRAY['splint','finger splint'], NULL),
  ('DIABETIC FOOT WEAR', 'I', ARRAY['diabetic foot wear','diabetic footwear','diabetic shoe','mcr chappal'], NULL),
  ('KNEE BRACES (LONG/ SHORT/ HINGED)', 'I', ARRAY['knee braces (long/ short/ hinged)','knee brace','knee braces','hinged knee brace'], NULL),
  ('KNEE IMMOBILIZER/SHOULDER IMMOBILIZER', 'I', ARRAY['knee immobilizer/shoulder immobilizer','knee immobilizer','shoulder immobilizer','immobiliser'], NULL),
  ('LUMBO SACRAL BELT', 'I', ARRAY['lumbo sacral belt','ls belt','lumbar support'], NULL),
  ('NIMBUS BED OR WATER OR AIR BED CHARGES', 'I', ARRAY['nimbus bed or water or air bed charges','air bed','water bed','nimbus bed','air mattress'], NULL),
  ('AMBULANCE COLLAR', 'I', ARRAY['ambulance collar'], NULL),
  ('AMBULANCE EQUIPMENT', 'I', ARRAY['ambulance equipment'], NULL),
  ('ABDOMINAL BINDER', 'I', ARRAY['abdominal binder','abdominal belt'], NULL),
  ('PRIVATE NURSES CHARGES- SPECIAL NURSING CHARGES', 'I', ARRAY['private nurses charges- special nursing charges','private nurse','special nursing','ayah charges'], NULL),
  ('SUGAR FREE TABLETS', 'I', ARRAY['sugar free tablets','sugar free','sugarfree tablets'], NULL),
  ('CREAMS POWDERS LOTIONS', 'I', ARRAY['creams powders lotions','cream','powder','lotion','talcum'], 'The circular adds: toiletries are not payable, only prescribed medical pharmaceuticals are.'),
  ('ECG ELECTRODES', 'I', ARRAY['ecg electrodes','ecg electrode','ecg gel'], NULL),
  ('GLOVES', 'I', ARRAY['gloves','glove','surgical gloves','examination gloves','sterile gloves'], 'High-frequency line. List I means it is not payable at all, not merely subsumed.'),
  ('NEBULISATION KIT', 'I', ARRAY['nebulisation kit','nebulization kit','nebuliser mask'], NULL),
  ('ANY KIT WITH NO DETAILS MENTIONED [DELIVERY KIT, ORTHOKIT, RECOVERY KIT, ETC]', 'I', ARRAY['any kit with no details mentioned [delivery kit, orthokit, recovery kit, etc]','delivery kit','orthokit','ortho kit','recovery kit','kit charges'], NULL),
  ('KIDNEY TRAY', 'I', ARRAY['kidney tray','kidney dish'], NULL),
  ('MASK', 'I', ARRAY['mask','face mask'], NULL),
  ('OUNCE GLASS', 'I', ARRAY['ounce glass','measuring glass'], NULL),
  ('OXYGEN MASK', 'I', ARRAY['oxygen mask','o2 mask'], NULL),
  ('PELVIC TRACTION BELT', 'I', ARRAY['pelvic traction belt','traction belt'], NULL),
  ('PAN CAN', 'I', ARRAY['pan can'], NULL),
  ('TROLLY COVER', 'I', ARRAY['trolly cover','trolley cover'], NULL),
  ('UROMETER, URINE JUG', 'I', ARRAY['urometer, urine jug','urometer','urine jug','urine measuring jar'], NULL),
  ('AMBULANCE', 'I', ARRAY['ambulance','ambulance charges','ambulance service'], 'Often covered by a separate policy sub-limit — check before flagging.'),
  ('VASOFIX SAFETY', 'I', ARRAY['vasofix safety','vasofix'], NULL),

  -- ── List II — subsumed into ROOM charges (37) ──────────────────────────
  ('BABY CHARGES (UNLESS SPECIFIED/INDICATED)', 'II', ARRAY['baby charges (unless specified/indicated)','baby charges','newborn charges'], NULL),
  ('HAND WASH', 'II', ARRAY['hand wash','handwash','hand rub','hand sanitizer'], NULL),
  ('SHOE COVER', 'II', ARRAY['shoe cover','shoe covers','shoecover'], NULL),
  ('CAPS', 'II', ARRAY['caps','cap','surgical cap','bouffant cap'], NULL),
  ('CRADLE CHARGES', 'II', ARRAY['cradle charges','cradle','baby cradle'], NULL),
  ('COMB', 'II', ARRAY['comb'], NULL),
  ('EAU-DE-COLOGNE/ ROOM FRESHENERS', 'II', ARRAY['eau-de-cologne/ room fresheners','room freshener','eau de cologne','air freshener'], NULL),
  ('FOOT COVER', 'II', ARRAY['foot cover','foot covers'], NULL),
  ('GOWN', 'II', ARRAY['gown','patient gown','surgical gown'], NULL),
  ('SLIPPERS', 'II', ARRAY['slippers','slipper'], NULL),
  ('TISSUE PAPER', 'II', ARRAY['tissue paper','tissue','tissue roll'], NULL),
  ('TOOTH PASTE', 'II', ARRAY['tooth paste','toothpaste'], NULL),
  ('TOOTH BRUSH', 'II', ARRAY['tooth brush','toothbrush'], NULL),
  ('BED PAN', 'II', ARRAY['bed pan','bedpan'], NULL),
  ('FACE MASK', 'II', ARRAY['face mask','surgical mask','3 ply mask'], NULL),
  ('FLEXI MASK', 'II', ARRAY['flexi mask'], NULL),
  ('HAND HOLDER', 'II', ARRAY['hand holder'], NULL),
  ('SPUTUM CUP', 'II', ARRAY['sputum cup','sputum container'], NULL),
  ('DISINFECTANT LOTIONS', 'II', ARRAY['disinfectant lotions','disinfectant lotion','disinfectant'], NULL),
  ('LUXURY TAX', 'II', ARRAY['luxury tax'], NULL),
  ('HVAC', 'II', ARRAY['hvac','hvac charges'], NULL),
  ('HOUSE KEEPING CHARGES', 'II', ARRAY['house keeping charges','housekeeping','house keeping','cleaning charges'], NULL),
  ('AIR CONDITIONER CHARGES', 'II', ARRAY['air conditioner charges','air conditioner','ac charges','a/c charges'], NULL),
  ('IM IV INJECTION CHARGES', 'II', ARRAY['im iv injection charges','im injection charges','iv injection charges','injection charges'], NULL),
  ('CLEAN SHEET', 'II', ARRAY['clean sheet','bed sheet','linen charges'], NULL),
  ('BLANKET/WARMER BLANKET', 'II', ARRAY['blanket/warmer blanket','blanket','warmer blanket'], NULL),
  ('ADMISSION KIT', 'II', ARRAY['admission kit','welcome kit'], NULL),
  ('DIABETIC CHART CHARGES', 'II', ARRAY['diabetic chart charges','diabetic chart'], NULL),
  ('DOCUMENTATION CHARGES/ ADMINISTRATIVE EXPENSES', 'II', ARRAY['documentation charges/ administrative expenses','documentation charges','administrative charges','admin charges','administration charges'], 'Frequently billed as a flat fee and frequently deducted in full.'),
  ('DISCHARGE PROCEDURE CHARGES', 'II', ARRAY['discharge procedure charges','discharge charges','discharge procedure'], NULL),
  ('DAILY CHART CHARGES', 'II', ARRAY['daily chart charges','daily chart','chart charges'], NULL),
  ('ENTRANCE PASS/ VISITORS PASS CHARGES', 'II', ARRAY['entrance pass/ visitors pass charges','visitor pass','entrance pass','attendant pass'], NULL),
  ('EXPENSES RELATED TO PRESCRIPTION ON DISCHARGE', 'II', ARRAY['expenses related to prescription on discharge','discharge medicines','discharge prescription','take home medicines'], NULL),
  ('FILE OPENING CHARGES', 'II', ARRAY['file opening charges','file opening','file charges','record charges'], NULL),
  ('INCIDENTAL EXPENSES/ MISC. CHARGES (NOT EXPLAINED)', 'II', ARRAY['incidental expenses/ misc. charges (not explained)','incidental','miscellaneous','misc charges','other charges','sundry'], 'The catch-all the circular names explicitly. An unexplained miscellaneous line is non-payable by default.'),
  ('PATIENT IDENTIFICATION BAND/ NAME TAG', 'II', ARRAY['patient identification band/ name tag','id band','identification band','patient band','wrist band','name tag'], NULL),
  ('PULSEOXYMETER CHARGES', 'II', ARRAY['pulseoxymeter charges','pulseoximeter','pulse oximeter','spo2 probe'], NULL),

  -- ── List III — subsumed into PROCEDURE charges (23) ────────────────────
  ('HAIR REMOVAL CREAM', 'III', ARRAY['hair removal cream','depilatory cream'], NULL),
  ('DISPOSABLE RAZOR CHARGES (FOR SITE PREPARATIONS)', 'III', ARRAY['disposable razor charges (for site preparations)','razor','disposable razor','shaving charges'], NULL),
  ('EYE PAD', 'III', ARRAY['eye pad','eye patch'], NULL),
  ('EYE SHEILD', 'III', ARRAY['eye sheild','eye shield'], NULL),
  ('CAMERA COVER', 'III', ARRAY['camera cover'], NULL),
  ('DVD, CD CHARGES', 'III', ARRAY['dvd, cd charges','cd charges','dvd charges','cd/dvd'], NULL),
  ('GAUSE SOFT', 'III', ARRAY['gause soft','gauze soft'], NULL),
  ('GAUZE', 'III', ARRAY['gauze','gauze piece','sterile gauze'], NULL),
  ('WARD AND THEATRE BOOKING CHARGES', 'III', ARRAY['ward and theatre booking charges','theatre booking','ot booking','ward booking'], NULL),
  ('ARTHROSCOPY AND ENDOSCOPY INSTRUMENTS', 'III', ARRAY['arthroscopy and endoscopy instruments','arthroscopy instruments','endoscopy instruments'], NULL),
  ('MICROSCOPE COVER', 'III', ARRAY['microscope cover'], NULL),
  ('SURGICAL BLADES, HARMONICS SCALPEL, SHAVER', 'III', ARRAY['surgical blades, harmonics scalpel, shaver','surgical blade','scalpel','harmonic scalpel','shaver blade'], NULL),
  ('SURGICAL DRILL', 'III', ARRAY['surgical drill','drill bit'], NULL),
  ('EYE KIT', 'III', ARRAY['eye kit'], NULL),
  ('EYE DRAPE', 'III', ARRAY['eye drape'], NULL),
  ('X-RAY FILM', 'III', ARRAY['x-ray film','xray film','radiograph film'], NULL),
  ('BOYLES APPARATUS CHARGES', 'III', ARRAY['boyles apparatus charges','boyles apparatus','boyle apparatus'], NULL),
  ('COTTON', 'III', ARRAY['cotton','absorbent cotton','cotton roll'], NULL),
  ('COTTON BANDAGE', 'III', ARRAY['cotton bandage'], NULL),
  ('SURGICAL TAPE', 'III', ARRAY['surgical tape','micropore','adhesive tape'], NULL),
  ('APRON', 'III', ARRAY['apron','lead apron','disposable apron'], NULL),
  ('TORNIQUET', 'III', ARRAY['torniquet','tourniquet'], NULL),
  ('ORTHOBUNDLE, GYNAEC BUNDLE', 'III', ARRAY['orthobundle, gynaec bundle','orthobundle','gynaec bundle','ortho bundle'], NULL),

  -- ── List IV — subsumed into the COST OF TREATMENT (18) ─────────────────
  ('ADMISSION/REGISTRATION CHARGES', 'IV', ARRAY['admission/registration charges','admission charges','registration charges','admission fee','registration fee'], 'A common and easily-detected line — it appears on most Indian hospital bills.'),
  ('HOSPITALISATION FOR EVALUATION/ DIAGNOSTIC PURPOSE', 'IV', ARRAY['hospitalisation for evaluation/ diagnostic purpose','evaluation charges','diagnostic admission'], NULL),
  ('URINE CONTAINER', 'IV', ARRAY['urine container','urine jar'], NULL),
  ('BLOOD RESERVATION CHARGES AND ANTE NATAL BOOKING CHARGES', 'IV', ARRAY['blood reservation charges and ante natal booking charges','blood reservation','ante natal booking','antenatal booking'], NULL),
  ('BIPAP MACHINE', 'IV', ARRAY['bipap machine','bipap','bipap charges'], NULL),
  ('CPAP/ CAPO EQUIPMENTS', 'IV', ARRAY['cpap/ capo equipments','cpap','cpap machine','capo equipment'], NULL),
  ('INFUSION PUMP- COST', 'IV', ARRAY['infusion pump- cost','infusion pump','syringe pump'], NULL),
  ('HYDROGEN PEROXIDE\SPIRIT\ DISINFECTANTS ETC.', 'IV', ARRAY['hydrogen peroxide\spirit\ disinfectants etc.','hydrogen peroxide','spirit','disinfectant'], NULL),
  ('NUTRITION PLANNING CHARGES - DIETICIAN CHARGES- DIET CHARGES', 'IV', ARRAY['nutrition planning charges - dietician charges- diet charges','dietician','diet charges','dietary','nutrition charges'], NULL),
  ('HIV KIT', 'IV', ARRAY['hiv kit','hiv test kit'], NULL),
  ('ANTISEPTIC MOUTHWASH', 'IV', ARRAY['antiseptic mouthwash','mouthwash','betadine gargle'], NULL),
  ('LOZENGES', 'IV', ARRAY['lozenges','throat lozenges'], NULL),
  ('MOUTH PAINT', 'IV', ARRAY['mouth paint'], NULL),
  ('VACCINATION CHARGES', 'IV', ARRAY['vaccination charges','vaccination','vaccine charges','immunisation'], NULL),
  ('ALCOHOL SWABS', 'IV', ARRAY['alcohol swabs','alcohol swab','spirit swab'], NULL),
  ('SCRUB SOLUTION / STERILLIUM', 'IV', ARRAY['scrub solution / sterillium','scrub solution','sterillium','hand scrub'], NULL),
  ('GLUCO METER & STRIPS', 'IV', ARRAY['gluco meter & strips','glucometer','glucose strips','glucostrips','bsl strips'], NULL),
  ('URINE BAG', 'IV', ARRAY['urine bag','urobag','urine collection bag'], NULL)

ON CONFLICT (lower(item_name)) WHERE panel_id IS NULL DO UPDATE SET
  list_number = EXCLUDED.list_number,
  -- Aliases are LEARNED from real bills through the UI, so a re-seed must add
  -- the baseline back without discarding what has been observed since.
  aliases     = ARRAY(SELECT DISTINCT unnest(
                  hospital.non_payable_items.aliases || EXCLUDED.aliases)),
  notes       = COALESCE(hospital.non_payable_items.notes, EXCLUDED.notes);

-- ── Coverage guard ────────────────────────────────────────────────────────
-- The whole point of this revision is that the catalog is COMPLETE. If a later
-- edit drops a row, a bill line that should be flagged silently stops being
-- flagged — a false clean bill, which is the failure mode this product exists
-- to prevent. Assert the counts rather than trust them.
DO $$
DECLARE
  total INT; l1 INT; l2 INT; l3 INT; l4 INT;
BEGIN
  SELECT count(*) INTO total FROM hospital.non_payable_items WHERE panel_id IS NULL;
  SELECT count(*) INTO l1 FROM hospital.non_payable_items WHERE panel_id IS NULL AND list_number='I';
  SELECT count(*) INTO l2 FROM hospital.non_payable_items WHERE panel_id IS NULL AND list_number='II';
  SELECT count(*) INTO l3 FROM hospital.non_payable_items WHERE panel_id IS NULL AND list_number='III';
  SELECT count(*) INTO l4 FROM hospital.non_payable_items WHERE panel_id IS NULL AND list_number='IV';

  IF (l1, l2, l3, l4) IS DISTINCT FROM (68, 37, 23, 18) THEN
    RAISE EXCEPTION '090_non_payable_items: expected List I/II/III/IV = 68/37/23/18, got %/%/%/%', l1, l2, l3, l4;
  END IF;

  RAISE NOTICE '090_non_payable_items: % IRDAI items (I=% II=% III=% IV=%) — complete',
    total, l1, l2, l3, l4;
END $$;
