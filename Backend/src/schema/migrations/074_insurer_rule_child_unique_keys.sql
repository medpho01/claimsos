-- =============================================================================
-- 074 — unique keys on the insurer rule-set child tables  (2026-09-13)
--
-- Purpose: make insurer rule-set seeding idempotent.
--
-- 044_insurer_rule_sets.sql seeds three child tables with NO conflict target:
--   044:284-295  INSERT INTO hospital.insurer_document_requirements ...
--   044:298-306  INSERT INTO hospital.insurer_financial_limits ...
--   044:309-320  INSERT INTO hospital.insurer_los_benchmarks ...
-- and the same three blocks repeat for STAR_HEALTH_ORTHOPEDIC_V1 from 044:322.
-- Every re-run therefore duplicates every child row. The parents are already
-- safe (insurer_rule_sets.rule_set_id UNIQUE at 044:41; uq_insurance_rules_set_rule
-- at 044:89) — only the children were missing keys.
--
-- CONTRACT: seeds/040_insurer_rule_sets.sql targets these three constraint
-- names in its ON CONFLICT clauses. Renaming them breaks the seed runner.
--   uq_insurer_doc_req_set_type_stage  (rule_set_id, document_type, stage)
--   uq_insurer_fin_limit_set_kind      (rule_set_id, limit_kind)
--   uq_insurer_los_set_procedure       (rule_set_id, procedure_code)
--
-- Forward-only + idempotent.
-- =============================================================================

BEGIN;

-- ── A. insurer_document_requirements ────────────────────────────────────────
-- A UNIQUE constraint over a nullable `stage` treats NULLs as distinct, which
-- would make the key meaningless for stage-less rows. Every row 044 seeds
-- supplies a non-null stage ('PRE_AUTH' / 'FINAL_CLAIM'), so default + backfill
-- the column to 'FINAL_CLAIM' first. Deliberately NOT `SET NOT NULL`:
-- production may hold rows we cannot see, and a failed NOT NULL validation
-- would abort the whole deploy.
ALTER TABLE hospital.insurer_document_requirements
  ALTER COLUMN stage SET DEFAULT 'FINAL_CLAIM';

UPDATE hospital.insurer_document_requirements
   SET stage = 'FINAL_CLAIM'
 WHERE stage IS NULL;

-- De-duplicate, keeping the EARLIEST physical row (`a.ctid > b.ctid` deletes
-- every row that has a smaller-ctid twin), mirroring the pattern at 010:38-42.
-- `a.ctid < b.ctid` would have kept the LAST row instead — i.e. preferred a
-- re-seeded stock default over the row an operator had already tuned.
--
-- The match is on ALL columns, not just the new key. `required_when` and
-- `mandatory` live OUTSIDE (rule_set_id, document_type, stage), so two rows
-- like ("required_when: age>60") and ("required_when: implant used") are
-- legitimately distinct business rules; collapsing them on the key alone would
-- destroy real configuration. Only byte-identical re-seeds are removed here.
-- If genuinely distinct rows still collide on the key, the ADD CONSTRAINT
-- below fails loudly with the offending key — which is the correct outcome:
-- a human has to decide which rule survives.
--
-- IS NOT DISTINCT FROM rather than = throughout, because every column except
-- rule_set_id/document_type is nullable.
DO $$
DECLARE
  removed  integer;
  colliding integer;
BEGIN
  WITH dropped AS (
    DELETE FROM hospital.insurer_document_requirements a
     USING hospital.insurer_document_requirements b
     WHERE a.ctid > b.ctid
       AND a.rule_set_id = b.rule_set_id
       AND a.document_type = b.document_type
       AND a.stage                IS NOT DISTINCT FROM b.stage
       AND a.required_when        IS NOT DISTINCT FROM b.required_when
       AND a.mandatory            IS NOT DISTINCT FROM b.mandatory
       AND a.quality_requirements IS NOT DISTINCT FROM b.quality_requirements
    RETURNING 1
  )
  SELECT count(*) INTO removed FROM dropped;

  SELECT count(*) INTO colliding FROM (
    SELECT 1 FROM hospital.insurer_document_requirements
     WHERE stage IS NOT NULL          -- UNIQUE treats NULL key parts as distinct
     GROUP BY rule_set_id, document_type, stage
    HAVING count(*) > 1
  ) c;

  RAISE NOTICE '074: insurer_document_requirements — removed % identical duplicate row(s)', removed;
  IF colliding > 0 THEN
    RAISE NOTICE '074: insurer_document_requirements — % key(s) still hold rows that DIFFER outside (rule_set_id, document_type, stage); uq_insurer_doc_req_set_type_stage cannot be added until one of each is resolved by hand', colliding;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'hospital'
       AND t.relname = 'insurer_document_requirements'
       AND c.conname = 'uq_insurer_doc_req_set_type_stage'
  ) THEN
    ALTER TABLE hospital.insurer_document_requirements
      ADD CONSTRAINT uq_insurer_doc_req_set_type_stage
      UNIQUE (rule_set_id, document_type, stage);
  END IF;
END $$;

-- ── B. insurer_financial_limits ─────────────────────────────────────────────
-- Same rules as A: keep the earliest row, and only collapse rows whose
-- `config` JSONB is identical too — an operator-tuned room_rent cap must never
-- lose to a re-seeded default.
DO $$
DECLARE
  removed   integer;
  colliding integer;
BEGIN
  WITH dropped AS (
    DELETE FROM hospital.insurer_financial_limits a
     USING hospital.insurer_financial_limits b
     WHERE a.ctid > b.ctid
       AND a.rule_set_id = b.rule_set_id
       AND a.limit_kind IS NOT DISTINCT FROM b.limit_kind
       AND a.config     IS NOT DISTINCT FROM b.config
    RETURNING 1
  )
  SELECT count(*) INTO removed FROM dropped;

  SELECT count(*) INTO colliding FROM (
    SELECT 1 FROM hospital.insurer_financial_limits
     GROUP BY rule_set_id, limit_kind
    HAVING count(*) > 1
  ) c;

  RAISE NOTICE '074: insurer_financial_limits — removed % identical duplicate row(s)', removed;
  IF colliding > 0 THEN
    RAISE NOTICE '074: insurer_financial_limits — % key(s) still hold rows with DIFFERENT config; uq_insurer_fin_limit_set_kind cannot be added until one of each is resolved by hand', colliding;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'hospital'
       AND t.relname = 'insurer_financial_limits'
       AND c.conname = 'uq_insurer_fin_limit_set_kind'
  ) THEN
    ALTER TABLE hospital.insurer_financial_limits
      ADD CONSTRAINT uq_insurer_fin_limit_set_kind
      UNIQUE (rule_set_id, limit_kind);
  END IF;
END $$;

-- ── C. insurer_los_benchmarks ───────────────────────────────────────────────
-- Same rules as A: keep the earliest row, and only collapse rows whose LOS /
-- ICU / tolerance numbers are identical as well.
DO $$
DECLARE
  removed   integer;
  colliding integer;
BEGIN
  WITH dropped AS (
    DELETE FROM hospital.insurer_los_benchmarks a
     USING hospital.insurer_los_benchmarks b
     WHERE a.ctid > b.ctid
       AND a.rule_set_id = b.rule_set_id
       AND a.procedure_code                IS NOT DISTINCT FROM b.procedure_code
       AND a.procedure_name                IS NOT DISTINCT FROM b.procedure_name
       AND a.expected_los_days             IS NOT DISTINCT FROM b.expected_los_days
       AND a.expected_icu_days             IS NOT DISTINCT FROM b.expected_icu_days
       AND a.tolerance_days                IS NOT DISTINCT FROM b.tolerance_days
       AND a.justification_required_beyond IS NOT DISTINCT FROM b.justification_required_beyond
    RETURNING 1
  )
  SELECT count(*) INTO removed FROM dropped;

  SELECT count(*) INTO colliding FROM (
    SELECT 1 FROM hospital.insurer_los_benchmarks
     WHERE procedure_code IS NOT NULL -- UNIQUE treats NULL key parts as distinct
     GROUP BY rule_set_id, procedure_code
    HAVING count(*) > 1
  ) c;

  RAISE NOTICE '074: insurer_los_benchmarks — removed % identical duplicate row(s)', removed;
  IF colliding > 0 THEN
    RAISE NOTICE '074: insurer_los_benchmarks — % key(s) still hold rows with DIFFERENT benchmarks; uq_insurer_los_set_procedure cannot be added until one of each is resolved by hand', colliding;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'hospital'
       AND t.relname = 'insurer_los_benchmarks'
       AND c.conname = 'uq_insurer_los_set_procedure'
  ) THEN
    ALTER TABLE hospital.insurer_los_benchmarks
      ADD CONSTRAINT uq_insurer_los_set_procedure
      UNIQUE (rule_set_id, procedure_code);
  END IF;
END $$;

COMMIT;
