-- =============================================================================
-- 075 — seed ledger + pgmigrations unique key  (2026-09-13)
--
-- Creates hospital.seed_applications, the checksum ledger consumed by
-- src/schema/run-seeds.cjs, and repairs the missing unique key on
-- hospital.pgmigrations that makes prod-bootstrap-final.sql's stamping block
-- duplicate rows on every re-run.
--
-- Forward-only + idempotent.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.seed_applications (
  seed_name     TEXT PRIMARY KEY,
  checksum      TEXT        NOT NULL,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rows_affected INTEGER     NOT NULL DEFAULT 0
);

COMMENT ON TABLE hospital.seed_applications IS
  'Versioned seed ledger. A seed re-applies when its sha256 checksum changes. Written only by src/schema/run-seeds.cjs.';

-- hospital.pgmigrations was created by prod-bootstrap-final.sql with only a
-- SERIAL PK (prod-bootstrap-final.sql:1111), so the `ON CONFLICT DO NOTHING`
-- on its 65-name stamping block (:1192) never fires and re-runs duplicate
-- every row. De-dupe, then add the unique index the conflict target needs.
--
-- Guarded on to_regclass because on a truly fresh database node-pg-migrate
-- creates hospital.pgmigrations itself — and does so AFTER this file is parsed
-- but BEFORE it is executed, so the table is normally present by now; the
-- guard just makes the ordering irrelevant.
DO $$ BEGIN
  IF to_regclass('hospital.pgmigrations') IS NOT NULL THEN
    -- idempotent: keeps the lowest id of each duplicated name
    DELETE FROM hospital.pgmigrations a
     USING hospital.pgmigrations b
     WHERE a.id > b.id
       AND a.name = b.name;

    CREATE UNIQUE INDEX IF NOT EXISTS pgmigrations_name_uniq
      ON hospital.pgmigrations (name);
  END IF;
END $$;

COMMIT;
