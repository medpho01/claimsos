-- Migration 020: Empanelment flag on (hospital × panel) + filing-route recompute
-- Date: 2026-05-17
-- Description:
--   Adds a single new panel_attribute_definitions row (`is_empanelled`) and
--   uses it to drive `ipds.claim_filing_route` derivation. Removes the need
--   for any new tables, columns, or panel_type values.
--
--   Rules:
--     is_empanelled = TRUE   → claim_filing_route = 'network'
--     is_empanelled = FALSE  → claim_filing_route = 'cashless_everywhere'
--
--   Backfill assumptions (per product owner, 2026-05-17):
--     - Default every (hospital × panel) to is_empanelled=FALSE.
--     - PMJAY is a government scheme that *only* operates through empanelment,
--       so any (hospital × PMJAY) row is by definition empanelled. Flip those
--       to TRUE.
--     - The CASHLESS_EVERYWHERE pseudo-panel rows are skipped — they're the
--       email-interface config holders, not real insurer relationships.
--
--   This supersedes migration 019's "default to network" backfill, which was
--   too generous. After this migration, the great majority of IPDs sit on
--   the CEW route, which matches the reality on the ground.

BEGIN;

-- 1) Definition: is_empanelled (boolean, operational)
INSERT INTO hospital.panel_attribute_definitions
  (key, label, data_type, category, is_required, sort_order, description)
VALUES (
  'is_empanelled',
  'Empanelled with this panel',
  'boolean',
  'operational',
  FALSE,
  59,  -- just before claim_submission_method (60)
  'TRUE = hospital has a direct contract with this insurer/TPA (Network route, portal/empanelled email). FALSE = hospital is not empanelled and files via Cashless Everywhere.'
)
ON CONFLICT (key) DO NOTHING;

-- 2) Seed: every existing hospital_panels row gets a default is_empanelled=FALSE
--    Skip the CEW pseudo-panel rows (those hold OAuth, not an insurer relationship).
WITH def AS (
  SELECT id FROM hospital.panel_attribute_definitions WHERE key = 'is_empanelled'
),
target_rows AS (
  SELECT hp.id AS hospital_panel_id, hp.hospital_id, hp.panel_id, def.id AS def_id
    FROM hospital.hospital_panels hp
    JOIN hospital.panels pn ON pn.id = hp.panel_id
    CROSS JOIN def
   WHERE pn.code <> 'CASHLESS_EVERYWHERE'
)
INSERT INTO hospital.panel_attributes
  (hospital_panel_id, hospital_id, panel_id, panel_attribute_definition_id, attribute_key, value_boolean)
SELECT hospital_panel_id, hospital_id, panel_id, def_id, 'is_empanelled', FALSE
  FROM target_rows
 ON CONFLICT DO NOTHING;

-- 3) PMJAY exception: any (hospital × PMJAY) row is empanelled by definition.
UPDATE hospital.panel_attributes pa
   SET value_boolean = TRUE,
       updated_at = NOW()
  FROM hospital.hospital_panels hp
  JOIN hospital.panels pn ON pn.id = hp.panel_id
 WHERE pa.hospital_panel_id = hp.id
   AND pa.attribute_key = 'is_empanelled'
   AND pn.code = 'PMJAY';

-- 4) Recompute IPD claim_filing_route from is_empanelled.
--    Supersedes migration 019's "everything to network" backfill.
UPDATE hospital.ipds i
   SET claim_filing_route = CASE WHEN pa.value_boolean THEN 'network'
                                 ELSE 'cashless_everywhere'
                            END,
       updated_at = NOW()
  FROM hospital.panel_attributes pa
 WHERE pa.hospital_panel_id = i.hospital_panel_id
   AND pa.attribute_key = 'is_empanelled';

COMMIT;
