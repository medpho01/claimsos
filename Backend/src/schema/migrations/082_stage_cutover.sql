-- ==========================================================================
-- 082 — stage cutover: normalise every stage column onto claim_stages.code
-- ==========================================================================
-- Waves A-D (077-081) made the stage taxonomy configurable but deliberately
-- left the DATA alone: `legacy_codes` recorded what each new stage absorbs and
-- nothing read it. This migration performs the cutover.
--
-- HOW BIG IS THIS, REALLY
-- ------------------------------------------------------------------------
-- Measured on 2026-09-14, not assumed:
--   ipds.stage                          471 NULL, 4 non-null
--   claim_context.stage                 3 NULL, 3 rows
--   document_sections.stage             916 rows, ALL NULL   <- nothing to do
--   insurer_document_requirements.stage FINAL_CLAIM x19, PRE_AUTH x6
--   insurer_rule_sets.applicable_stages 13 packs, 9 distinct values
-- About 30 rows carry a value at all. An earlier plan described this as
-- "rewriting 475 claims"; that was wrong, and the smallness is why this can be
-- one migration rather than a staged backfill.
--
-- WHY THE MAPPING IS SPELLED OUT HERE INSTEAD OF READ FROM legacy_codes
-- ------------------------------------------------------------------------
-- Migrations run BEFORE seeds. Two spellings this data needs (`pre_auth`,
-- `final_claim`) are being added to seed 070 in the same commit, so reading
-- claim_stages.legacy_codes here would see the pre-edit array and silently
-- leave 25 requirement rows unmapped. A one-time data fix should also be
-- auditable on its own terms. The guard at the bottom catches any drift
-- between this list and the seed.
--
-- NORMALISATION
-- ------------------------------------------------------------------------
-- Values are compared as lower(replace(trim(v), ' ', '_')). That folds the
-- Title Case display values someone typed into ipds.stage ('Draft',
-- 'Claim Filed') onto the snake_case legacy codes for free, so they need no
-- entries of their own.
--
-- STATUS VALUES ARE DROPPED, NOT MAPPED
-- ------------------------------------------------------------------------
-- `preauth_approved`, `discharge_approved`, `discharged` and `admitted` are
-- insurer OUTCOMES or patient events, not stages — seed 070 excludes them by
-- the "a stage owns a document checklist" test.
--
-- In insurer_rule_sets.applicable_stages they always appear ALONGSIDE their
-- real stages, e.g.
--   ['discharge_draft','discharge_submitted','discharge_query_responded',
--    'discharge_approved','discharged']
-- The first three all map to FINAL_AUTH, so the pack keeps working; dropping
-- the tail loses nothing. MAPPING them would be worse than dropping: sending
-- `discharge_approved` to CLAIM_FILE would widen a discharge pack to fire on
-- claim-file documents — a behaviour change disguised as a translation.
-- Dropping preserves the authored intent exactly.
--
-- `Admitted` on one IPD row becomes NULL for the same reason. 471 of 475 rows
-- are already NULL, so NULL is the norm, not a loss of signal.
-- ==========================================================================

-- ── the mapping, as data ──────────────────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS _stage_map (legacy TEXT PRIMARY KEY, code TEXT NOT NULL) ON COMMIT DROP;

INSERT INTO _stage_map (legacy, code) VALUES
  ('draft',                        'ELIGIBILITY_CHECK'),
  ('preauth_submitted',            'PREAUTH'),
  ('preauth_query_responded',      'PREAUTH'),
  ('pre_auth',                     'PREAUTH'),
  ('enhancements_submitted',       'ENHANCEMENT'),
  ('enhancements_query_responded', 'ENHANCEMENT'),
  ('discharge_draft',              'FINAL_AUTH'),
  ('discharge_submitted',          'FINAL_AUTH'),
  ('discharge_query_responded',    'FINAL_AUTH'),
  ('claim_filed',                  'CLAIM_FILE'),
  ('claim_query_responded',        'CLAIM_FILE'),
  ('final_claim',                  'CLAIM_FILE');

-- Values that are real, recognised, and deliberately NOT stages. Listed so the
-- guard below can tell "known status" apart from "typo nobody noticed".
CREATE TEMP TABLE IF NOT EXISTS _stage_drop (legacy TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _stage_drop (legacy) VALUES
  ('preauth_approved'), ('preauth_queried'),
  ('enhancements_queried'),
  ('discharge_approved'), ('discharge_queried'), ('discharged'),
  ('claim_approved'), ('claim_queried'),
  ('admitted');

CREATE OR REPLACE FUNCTION pg_temp.norm_stage(v TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS $$ SELECT lower(replace(trim($1), ' ', '_')) $$;

-- ── 1. ipds.stage ─────────────────────────────────────────────────────────
UPDATE hospital.ipds i
   SET stage = m.code
  FROM _stage_map m
 WHERE i.stage IS NOT NULL
   AND pg_temp.norm_stage(i.stage) = m.legacy
   AND i.stage IS DISTINCT FROM m.code;

UPDATE hospital.ipds i
   SET stage = NULL
  FROM _stage_drop d
 WHERE i.stage IS NOT NULL
   AND pg_temp.norm_stage(i.stage) = d.legacy;

-- ── 2. claim_context.stage ────────────────────────────────────────────────
UPDATE hospital.claim_context c
   SET stage = m.code
  FROM _stage_map m
 WHERE c.stage IS NOT NULL
   AND pg_temp.norm_stage(c.stage) = m.legacy
   AND c.stage IS DISTINCT FROM m.code;

UPDATE hospital.claim_context c
   SET stage = NULL
  FROM _stage_drop d
 WHERE c.stage IS NOT NULL
   AND pg_temp.norm_stage(c.stage) = d.legacy;

-- ── 3. document_sections.stage ────────────────────────────────────────────
-- All NULL today. Written anyway so a row created between the measurement and
-- this migration running is not left behind.
UPDATE hospital.document_sections s
   SET stage = m.code
  FROM _stage_map m
 WHERE s.stage IS NOT NULL
   AND pg_temp.norm_stage(s.stage) = m.legacy
   AND s.stage IS DISTINCT FROM m.code;

UPDATE hospital.document_sections s
   SET stage = NULL
  FROM _stage_drop d
 WHERE s.stage IS NOT NULL
   AND pg_temp.norm_stage(s.stage) = d.legacy;

-- ── 3b. Drop legacy stage CHECK constraints, BY SHAPE NOT BY NAME ─────────
-- Migration 078 did `DROP CONSTRAINT IF EXISTS chk_idr_stage` — the name 044
-- gives the constraint when the table is built by migrations. Production was
-- built from a DUMP, where the same constraint came back under PostgreSQL's
-- default name `insurer_document_requirements_stage_check`. So 078 matched
-- nothing, IF EXISTS swallowed it silently, and the old constraint survived —
-- still allowing only ('PRE_AUTH','ENHANCEMENT','FINAL_CLAIM','QUERY_RESPONSE').
--
-- Section 4 below then tried to write 'CLAIM_FILE' and the migration aborted:
--     new row for relation "insurer_document_requirements"
--     violates check constraint "insurer_document_requirements_stage_check"
--
-- The post-deploy check that was supposed to catch this asked whether
-- `chk_idr_stage` existed. It did not — under that name — so the check passed
-- while the constraint was alive under another. Verifying a constraint by NAME
-- cannot see a renamed one; this drops by SHAPE instead, and is therefore
-- immune to whatever a future dump/restore decides to call it.
--
-- All four stage-bearing tables, not just the one that failed. The other three
-- happened to survive only because their UPDATEs matched zero rows
-- (document_sections.stage is 100% NULL), so a lurking constraint there would
-- not bite now — it would bite later, the first time a section gets stamped.
DO $$
DECLARE
  c RECORD;
  n INT := 0;
BEGIN
  FOR c IN
    SELECT rel.relname AS tbl, con.conname AS name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'hospital'
       AND con.contype = 'c'
       AND rel.relname IN (
         'insurer_document_requirements', 'document_sections', 'ipds', 'claim_context'
       )
       -- Only constraints that actually constrain `stage`. Matching on the
       -- definition rather than the name is the whole point; the word boundary
       -- keeps it off unrelated columns such as `stage_source`.
       AND pg_get_constraintdef(con.oid) ~ '\mstage\M'
  LOOP
    EXECUTE format('ALTER TABLE hospital.%I DROP CONSTRAINT %I', c.tbl, c.name);
    RAISE NOTICE '082: dropped legacy stage check %.% (superseded by claim_stages)', c.tbl, c.name;
    n := n + 1;
  END LOOP;

  IF n = 0 THEN
    RAISE NOTICE '082: no legacy stage check constraints found (already clean)';
  END IF;
END $$;

-- ── 4. insurer_document_requirements.stage ────────────────────────────────
-- 'ALL' is the sentinel migration 078 made the default — it means "every
-- stage" and must survive untouched.
UPDATE hospital.insurer_document_requirements r
   SET stage = m.code
  FROM _stage_map m
 WHERE r.stage IS NOT NULL
   AND r.stage <> 'ALL'
   AND pg_temp.norm_stage(r.stage) = m.legacy
   AND r.stage IS DISTINCT FROM m.code;

UPDATE hospital.insurer_document_requirements r
   SET stage = 'ALL'
  FROM _stage_drop d
 WHERE r.stage IS NOT NULL
   AND pg_temp.norm_stage(r.stage) = d.legacy;

-- ── 5. insurer_rule_sets.applicable_stages (TEXT[]) ───────────────────────
-- Map each element, drop the status tail, de-duplicate (three discharge_*
-- codes collapse to one FINAL_AUTH), and order by lifecycle position so the
-- array reads sensibly in the Rule Sets screen.
UPDATE hospital.insurer_rule_sets s
   SET applicable_stages = sub.mapped
  FROM (
    SELECT s2.id,
           -- ::text throughout: applicable_stages is text[] while claim_stages.code
           -- is varchar, and there is no equality operator between text[] and
           -- character varying[] — the IS DISTINCT FROM below fails with 42883
           -- ("no operator matches") if the two sides disagree on element type.
           ARRAY(
             SELECT d.code FROM (
               SELECT DISTINCT cs.code::text AS code, cs.sort_order
                 FROM unnest(s2.applicable_stages) AS v
                 -- LEFT JOIN, and COALESCE to the raw value: an ALREADY
                 -- CANONICAL code must pass through unchanged.
                 --
                 -- With an inner JOIN this statement was not idempotent. The
                 -- four scalar columns above no-op on a replay because their
                 -- WHERE clauses stop matching, but this REPLACES the whole
                 -- array — so on a second run every canonical code failed to
                 -- match a legacy key and the array collapsed to {}, silently
                 -- unscoping every rule pack. Found when migration 082 had to
                 -- be re-run after the production attempt rolled back.
                 --
                 -- Status values still drop out: they match no legacy key AND
                 -- no claim_stages row, so the inner JOIN below removes them.
                 LEFT JOIN _stage_map m ON m.legacy = pg_temp.norm_stage(v)
                 JOIN hospital.claim_stages cs ON cs.code = COALESCE(m.code, v)
             ) d ORDER BY d.sort_order
           ) AS mapped
      FROM hospital.insurer_rule_sets s2
     WHERE s2.applicable_stages IS NOT NULL
       AND array_length(s2.applicable_stages, 1) > 0
  ) sub
 WHERE sub.id = s.id
   AND s.applicable_stages::text[] IS DISTINCT FROM sub.mapped;

-- ── Guard ─────────────────────────────────────────────────────────────────
-- Nothing may be left that is neither a live stage code nor the 'ALL'
-- sentinel. A leftover means a spelling exists in the data that neither the
-- map nor the drop list knows about — fail loudly rather than leave a column
-- half-migrated, because none of these columns has an FK to catch it later.
DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(DISTINCT src || '=' || val, ', ') INTO bad FROM (
    SELECT 'ipds.stage' AS src, stage AS val FROM hospital.ipds WHERE stage IS NOT NULL
    UNION ALL
    SELECT 'claim_context.stage', stage FROM hospital.claim_context WHERE stage IS NOT NULL
    UNION ALL
    SELECT 'document_sections.stage', stage FROM hospital.document_sections WHERE stage IS NOT NULL
    UNION ALL
    SELECT 'insurer_document_requirements.stage', stage
      FROM hospital.insurer_document_requirements WHERE stage IS NOT NULL AND stage <> 'ALL'
    UNION ALL
    SELECT 'insurer_rule_sets.applicable_stages', unnest(applicable_stages)
      FROM hospital.insurer_rule_sets
  ) x
  WHERE val NOT IN (SELECT code FROM hospital.claim_stages);

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '082 stage cutover: unmapped stage value(s) remain: %', bad;
  END IF;

  RAISE NOTICE '082 stage cutover: ipds=%, claim_context=%, document_sections=%, requirements=%, rule_sets=%',
    (SELECT count(*) FROM hospital.ipds WHERE stage IS NOT NULL),
    (SELECT count(*) FROM hospital.claim_context WHERE stage IS NOT NULL),
    (SELECT count(*) FROM hospital.document_sections WHERE stage IS NOT NULL),
    (SELECT count(*) FROM hospital.insurer_document_requirements WHERE stage IS NOT NULL AND stage <> 'ALL'),
    (SELECT count(*) FROM hospital.insurer_rule_sets WHERE array_length(applicable_stages, 1) > 0);
END $$;
