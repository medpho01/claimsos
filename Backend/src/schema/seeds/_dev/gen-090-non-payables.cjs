#!/usr/bin/env node
'use strict';
/* Emits seeds/090_non_payable_items.sql from the Annexure-I data below.
 * Generated rather than hand-typed so 146 rows cannot drift in formatting;
 * the DATA is transcribed from the circular and reviewed by hand. */

// [name, extraAliases]  — every item also gets lower(name) as an alias.
const L1 = [
  ['BABY FOOD', ['infant formula', 'baby milk', 'formula feed']],
  ['BABY UTILITIES CHARGES', ['baby utility', 'baby utilities']],
  ['BEAUTY SERVICES', ['salon', 'beautician']],
  ['BELTS/BRACES', ['belt', 'brace', 'abdominal belt', 'lumbar belt']],
  ['BUDS', ['cotton buds', 'ear buds']],
  ['COLD PACK/HOT PACK', ['cold pack', 'hot pack', 'ice pack']],
  ['CARRY BAGS', ['carry bag', 'plastic bag', 'polythene bag']],
  ['EMAIL/ INTERNET CHARGES', ['internet charges', 'email charges', 'wifi charges']],
  ["FOOD CHARGES (OTHER THAN PATIENT's DIET PROVIDED BY HOSPITAL)", ['food charges', 'canteen', 'attendant food']],
  ['LEGGINGS', ['legging', 'leggings']],
  ['LAUNDRY CHARGES', ['laundry', 'washing charges']],
  ['MINERAL WATER', ['water bottle', 'drinking water', 'packaged water']],
  ['SANITARY PAD', ['sanitary napkin', 'sanitary pads']],
  ['TELEPHONE CHARGES', ['telephone', 'phone charges', 'std charges']],
  ['GUEST SERVICES', ['guest service', 'visitor services']],
  ['CREPE BANDAGE', ['crepe bandage', 'crape bandage', 'elastic bandage']],
  ['DIAPER OF ANY TYPE', ['diaper', 'diapers', 'adult diaper', 'pampers']],
  ['EYELET COLLAR', ['eyelet collar']],
  ['SLINGS', ['sling', 'arm sling']],
  ['BLOOD GROUPING AND CROSS MATCHING OF DONORS SAMPLES', ['blood grouping', 'cross matching', 'donor screening']],
  ['SERVICE CHARGES WHERE NURSING CHARGE ALSO CHARGED', ['service charges', 'service charge']],
  ['TELEVISION CHARGES', ['television', 'tv charges']],
  ['SURCHARGES', ['surcharge']],
  ['ATTENDANT CHARGES', ['attendant', 'attender charges', 'bystander charges']],
  ['EXTRA DIET OF PATIENT (OTHER THAN THAT WHICH FORMS PART OF BED CHARGE)', ['extra diet', 'special diet']],
  ['BIRTH CERTIFICATE', ['birth certificate']],
  ['CERTIFICATE CHARGES', ['certificate charges', 'certificate fee']],
  ['COURIER CHARGES', ['courier', 'postage']],
  ['CONVEYANCE CHARGES', ['conveyance', 'transport charges', 'travel charges']],
  ['MEDICAL CERTIFICATE', ['medical certificate', 'fitness certificate']],
  ['MEDICAL RECORDS', ['medical records', 'mrd charges', 'case sheet charges']],
  ['PHOTOCOPIES CHARGES', ['photocopy', 'xerox', 'photocopies']],
  ['MORTUARY CHARGES', ['mortuary', 'morgue charges']],
  ['WALKING AIDS CHARGES', ['walker', 'walking aid', 'crutches']],
  ['OXYGEN CYLINDER (FOR USAGE OUTSIDE THE HOSPITAL)', ['oxygen cylinder']],
  ['SPACER', ['spacer', 'inhaler spacer']],
  ['SPIROMETRE', ['spirometer', 'spirometre', 'incentive spirometry']],
  ['NEBULIZER KIT', ['nebulizer kit', 'nebuliser kit']],
  ['STEAM INHALER', ['steam inhaler', 'steam vaporizer']],
  ['ARMSLING', ['arm sling', 'armsling']],
  ['THERMOMETER', ['thermometer', 'digital thermometer']],
  ['CERVICAL COLLAR', ['cervical collar', 'neck collar']],
  ['SPLINT', ['splint', 'finger splint']],
  ['DIABETIC FOOT WEAR', ['diabetic footwear', 'diabetic shoe', 'mcr chappal']],
  ['KNEE BRACES (LONG/ SHORT/ HINGED)', ['knee brace', 'knee braces', 'hinged knee brace']],
  ['KNEE IMMOBILIZER/SHOULDER IMMOBILIZER', ['knee immobilizer', 'shoulder immobilizer', 'immobiliser']],
  ['LUMBO SACRAL BELT', ['lumbo sacral belt', 'ls belt', 'lumbar support']],
  ['NIMBUS BED OR WATER OR AIR BED CHARGES', ['air bed', 'water bed', 'nimbus bed', 'air mattress']],
  ['AMBULANCE COLLAR', ['ambulance collar']],
  ['AMBULANCE EQUIPMENT', ['ambulance equipment']],
  ['ABDOMINAL BINDER', ['abdominal binder', 'abdominal belt']],
  ['PRIVATE NURSES CHARGES- SPECIAL NURSING CHARGES', ['private nurse', 'special nursing', 'ayah charges']],
  ['SUGAR FREE TABLETS', ['sugar free', 'sugarfree tablets']],
  ['CREAMS POWDERS LOTIONS', ['cream', 'powder', 'lotion', 'talcum']],
  ['ECG ELECTRODES', ['ecg electrode', 'ecg electrodes', 'ecg gel']],
  ['GLOVES', ['glove', 'gloves', 'surgical gloves', 'examination gloves', 'sterile gloves']],
  ['NEBULISATION KIT', ['nebulisation kit', 'nebulization kit', 'nebuliser mask']],
  ['ANY KIT WITH NO DETAILS MENTIONED [DELIVERY KIT, ORTHOKIT, RECOVERY KIT, ETC]',
   ['delivery kit', 'orthokit', 'ortho kit', 'recovery kit', 'kit charges']],
  ['KIDNEY TRAY', ['kidney tray', 'kidney dish']],
  ['MASK', ['mask', 'face mask']],
  ['OUNCE GLASS', ['ounce glass', 'measuring glass']],
  ['OXYGEN MASK', ['oxygen mask', 'o2 mask']],
  ['PELVIC TRACTION BELT', ['pelvic traction belt', 'traction belt']],
  ['PAN CAN', ['pan can']],
  ['TROLLY COVER', ['trolley cover', 'trolly cover']],
  ['UROMETER, URINE JUG', ['urometer', 'urine jug', 'urine measuring jar']],
  ['AMBULANCE', ['ambulance charges', 'ambulance service']],
  ['VASOFIX SAFETY', ['vasofix', 'vasofix safety']],
];

const L2 = [
  ['BABY CHARGES (UNLESS SPECIFIED/INDICATED)', ['baby charges', 'newborn charges']],
  ['HAND WASH', ['handwash', 'hand rub', 'hand sanitizer']],
  ['SHOE COVER', ['shoe covers', 'shoecover']],
  ['CAPS', ['cap', 'surgical cap', 'bouffant cap']],
  ['CRADLE CHARGES', ['cradle', 'baby cradle']],
  ['COMB', ['comb']],
  ['EAU-DE-COLOGNE/ ROOM FRESHENERS', ['room freshener', 'eau de cologne', 'air freshener']],
  ['FOOT COVER', ['foot cover', 'foot covers']],
  ['GOWN', ['gown', 'patient gown', 'surgical gown']],
  ['SLIPPERS', ['slipper', 'slippers']],
  ['TISSUE PAPER', ['tissue', 'tissue paper', 'tissue roll']],
  ['TOOTH PASTE', ['toothpaste', 'tooth paste']],
  ['TOOTH BRUSH', ['toothbrush', 'tooth brush']],
  ['BED PAN', ['bedpan', 'bed pan']],
  ['FACE MASK', ['face mask', 'surgical mask', '3 ply mask']],
  ['FLEXI MASK', ['flexi mask']],
  ['HAND HOLDER', ['hand holder']],
  ['SPUTUM CUP', ['sputum cup', 'sputum container']],
  ['DISINFECTANT LOTIONS', ['disinfectant lotion', 'disinfectant']],
  ['LUXURY TAX', ['luxury tax']],
  ['HVAC', ['hvac', 'hvac charges']],
  ['HOUSE KEEPING CHARGES', ['housekeeping', 'house keeping', 'cleaning charges']],
  ['AIR CONDITIONER CHARGES', ['air conditioner', 'ac charges', 'a/c charges']],
  ['IM IV INJECTION CHARGES', ['im injection charges', 'iv injection charges', 'injection charges']],
  ['CLEAN SHEET', ['clean sheet', 'bed sheet', 'linen charges']],
  ['BLANKET/WARMER BLANKET', ['blanket', 'warmer blanket']],
  ['ADMISSION KIT', ['admission kit', 'welcome kit']],
  ['DIABETIC CHART CHARGES', ['diabetic chart']],
  ['DOCUMENTATION CHARGES/ ADMINISTRATIVE EXPENSES',
   ['documentation charges', 'administrative charges', 'admin charges', 'administration charges']],
  ['DISCHARGE PROCEDURE CHARGES', ['discharge charges', 'discharge procedure']],
  ['DAILY CHART CHARGES', ['daily chart', 'chart charges']],
  ['ENTRANCE PASS/ VISITORS PASS CHARGES', ['visitor pass', 'entrance pass', 'attendant pass']],
  ['EXPENSES RELATED TO PRESCRIPTION ON DISCHARGE', ['discharge medicines', 'discharge prescription', 'take home medicines']],
  ['FILE OPENING CHARGES', ['file opening', 'file charges', 'record charges']],
  ['INCIDENTAL EXPENSES/ MISC. CHARGES (NOT EXPLAINED)',
   ['incidental', 'miscellaneous', 'misc charges', 'other charges', 'sundry']],
  ['PATIENT IDENTIFICATION BAND/ NAME TAG', ['id band', 'identification band', 'patient band', 'wrist band', 'name tag']],
  ['PULSEOXYMETER CHARGES', ['pulseoximeter', 'pulse oximeter', 'spo2 probe']],
];

const L3 = [
  ['HAIR REMOVAL CREAM', ['hair removal cream', 'depilatory cream']],
  ['DISPOSABLE RAZOR CHARGES (FOR SITE PREPARATIONS)', ['razor', 'disposable razor', 'shaving charges']],
  ['EYE PAD', ['eye pad', 'eye patch']],
  ['EYE SHEILD', ['eye shield', 'eye sheild']],
  ['CAMERA COVER', ['camera cover']],
  ['DVD, CD CHARGES', ['cd charges', 'dvd charges', 'cd/dvd']],
  ['GAUSE SOFT', ['gause soft', 'gauze soft']],
  ['GAUZE', ['gauze', 'gauze piece', 'sterile gauze']],
  ['WARD AND THEATRE BOOKING CHARGES', ['theatre booking', 'ot booking', 'ward booking']],
  ['ARTHROSCOPY AND ENDOSCOPY INSTRUMENTS', ['arthroscopy instruments', 'endoscopy instruments']],
  ['MICROSCOPE COVER', ['microscope cover']],
  ['SURGICAL BLADES, HARMONICS SCALPEL, SHAVER', ['surgical blade', 'scalpel', 'harmonic scalpel', 'shaver blade']],
  ['SURGICAL DRILL', ['surgical drill', 'drill bit']],
  ['EYE KIT', ['eye kit']],
  ['EYE DRAPE', ['eye drape']],
  ['X-RAY FILM', ['x-ray film', 'xray film', 'radiograph film']],
  ['BOYLES APPARATUS CHARGES', ['boyles apparatus', 'boyle apparatus']],
  ['COTTON', ['cotton', 'absorbent cotton', 'cotton roll']],
  ['COTTON BANDAGE', ['cotton bandage']],
  ['SURGICAL TAPE', ['surgical tape', 'micropore', 'adhesive tape']],
  ['APRON', ['apron', 'lead apron', 'disposable apron']],
  ['TORNIQUET', ['tourniquet', 'torniquet']],
  ['ORTHOBUNDLE, GYNAEC BUNDLE', ['orthobundle', 'gynaec bundle', 'ortho bundle']],
];

const L4 = [
  ['ADMISSION/REGISTRATION CHARGES', ['admission charges', 'registration charges', 'admission fee', 'registration fee']],
  ['HOSPITALISATION FOR EVALUATION/ DIAGNOSTIC PURPOSE', ['evaluation charges', 'diagnostic admission']],
  ['URINE CONTAINER', ['urine container', 'urine jar']],
  ['BLOOD RESERVATION CHARGES AND ANTE NATAL BOOKING CHARGES',
   ['blood reservation', 'ante natal booking', 'antenatal booking']],
  ['BIPAP MACHINE', ['bipap', 'bipap machine', 'bipap charges']],
  ['CPAP/ CAPO EQUIPMENTS', ['cpap', 'cpap machine', 'capo equipment']],
  ['INFUSION PUMP- COST', ['infusion pump', 'syringe pump']],
  ['HYDROGEN PEROXIDE\\SPIRIT\\ DISINFECTANTS ETC.', ['hydrogen peroxide', 'spirit', 'disinfectant']],
  ['NUTRITION PLANNING CHARGES - DIETICIAN CHARGES- DIET CHARGES',
   ['dietician', 'diet charges', 'dietary', 'nutrition charges']],
  ['HIV KIT', ['hiv kit', 'hiv test kit']],
  ['ANTISEPTIC MOUTHWASH', ['mouthwash', 'antiseptic mouthwash', 'betadine gargle']],
  ['LOZENGES', ['lozenges', 'throat lozenges']],
  ['MOUTH PAINT', ['mouth paint']],
  ['VACCINATION CHARGES', ['vaccination', 'vaccine charges', 'immunisation']],
  ['ALCOHOL SWABS', ['alcohol swab', 'spirit swab']],
  ['SCRUB SOLUTION / STERILLIUM', ['scrub solution', 'sterillium', 'hand scrub']],
  ['GLUCO METER & STRIPS', ['glucometer', 'glucose strips', 'glucostrips', 'bsl strips']],
  ['URINE BAG', ['urine bag', 'urobag', 'urine collection bag']],
];

const LISTS = [['I', L1], ['II', L2], ['III', L3], ['IV', L4]];

// Rows seeded under a spelling the circular does not use. Renaming without
// this would orphan the old row AND lose the aliases learned against it.
const RENAMES = [
  ['INCIDENTAL EXPENSES / MISC. CHARGES (NOT EXPLAINED)', 'INCIDENTAL EXPENSES/ MISC. CHARGES (NOT EXPLAINED)'],
  ['PATIENT IDENTIFICATION BAND', 'PATIENT IDENTIFICATION BAND/ NAME TAG'],
  ['DISPOSABLE RAZORS', 'DISPOSABLE RAZOR CHARGES (FOR SITE PREPARATIONS)'],
  ['ORTHOBUNDLE / GYNAEC BUNDLE', 'ORTHOBUNDLE, GYNAEC BUNDLE'],
  ['ADMISSION / REGISTRATION CHARGES', 'ADMISSION/REGISTRATION CHARGES'],
  ['DIETICIAN / DIET CHARGES', 'NUTRITION PLANNING CHARGES - DIETICIAN CHARGES- DIET CHARGES'],
  ['GLUCOMETER & STRIPS', 'GLUCO METER & STRIPS'],
  ['INFUSION PUMP - COST', 'INFUSION PUMP- COST'],
];

// Notes worth carrying — kept from the partial seed, plus the ones that change
// what a reviewer should DO.
const NOTES = {
  'AMBULANCE': 'Often covered by a separate policy sub-limit — check before flagging.',
  'INCIDENTAL EXPENSES/ MISC. CHARGES (NOT EXPLAINED)':
    'The catch-all the circular names explicitly. An unexplained miscellaneous line is non-payable by default.',
  'ADMISSION/REGISTRATION CHARGES':
    'A common and easily-detected line — it appears on most Indian hospital bills.',
  'CREAMS POWDERS LOTIONS':
    'The circular adds: toiletries are not payable, only prescribed medical pharmaceuticals are.',
  'GLOVES':
    'High-frequency line. List I means it is not payable at all, not merely subsumed.',
  'DOCUMENTATION CHARGES/ ADMINISTRATIVE EXPENSES':
    'Frequently billed as a flat fee and frequently deducted in full.',
};

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const arr = (a) => 'ARRAY[' + a.map(q).join(',') + ']';

const out = [];
out.push(`-- ==========================================================================
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
-- WHY \`aliases\` MATTERS MORE THAN THE NAMES
-- --------------------------------------------------------------------------
-- Hospital billing systems do not write the circular's wording. One catalogued
-- item appears as "GLOVES", "SURGICAL GLOVES", "GLOVE PAIR STERILE". A literal
-- match finds almost nothing, so aliases are learned from real bills — the
-- Non-Payables screen surfaces unmatched bill lines for exactly that. The
-- aliases below are a STARTING POINT, not a finished mapping.
--
-- WHY \`list_number\` MATTERS COMMERCIALLY
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
  FOR r IN SELECT * FROM (VALUES`);

out.push(RENAMES.map(([a, b]) => `    (${q(a)}, ${q(b)})`).join(',\n'));
out.push(`  ) AS t(old_name, new_name) LOOP
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

INSERT INTO hospital.non_payable_items (item_name, list_number, aliases, notes) VALUES`);

const rows = [];
const LIST_HEADER = {
  I: '  -- ── List I — coverage not available in the policy (68) ─────────────────',
  II: '  -- ── List II — subsumed into ROOM charges (37) ──────────────────────────',
  III: '  -- ── List III — subsumed into PROCEDURE charges (23) ────────────────────',
  IV: '  -- ── List IV — subsumed into the COST OF TREATMENT (18) ─────────────────',
};

for (const [num, items] of LISTS) {
  rows.push({ header: LIST_HEADER[num] });
  for (const [name, extra] of items) {
    const aliases = [...new Set([name.toLowerCase(), ...extra])];
    const note = NOTES[name];
    rows.push({
      sql: `  (${q(name)}, ${q(num)}, ${arr(aliases)}, ${note ? q(note) : 'NULL'})`,
    });
  }
}

const sqlRows = rows.filter((r) => r.sql);
let i = 0;
for (const r of rows) {
  if (r.header) { out.push(''); out.push(r.header); continue; }
  i++;
  out.push(r.sql + (i < sqlRows.length ? ',' : ''));
}

out.push(`
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
END $$;`);

require('fs').writeFileSync(
  require('path').resolve(__dirname, '../090_non_payable_items.sql'),
  out.join('\n') + '\n',
);
console.log(`wrote ${sqlRows.length} items (I=${L1.length} II=${L2.length} III=${L3.length} IV=${L4.length})`);
