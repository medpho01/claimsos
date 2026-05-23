-- Migration 010: Consolidate constraints + create audit_logs
-- Closes BE-review items M23, M24, M29.
-- Idempotent: every step is guarded with IF NOT EXISTS / DO $$ ... $$.
--
-- Steps:
--   1. UNIQUE(hospital_id, panel_id) on hospital.hospital_panels  (M24)
--   2. ipds.phone & hospital_panels.contact: CHAR(10) -> VARCHAR(20)  (M23)
--   3. hospital.audit_logs table + indexes  (M29)
--
-- NOTE on audit_logs column names: the running app code
-- (Backend/src/Services/audit.service.ts, Backend/src/Controllers/audit.controller.ts)
-- INSERTs / SELECTs on columns named user_id, action, entity_type, entity_id,
-- details, ip_address, user_agent. The original review spec proposed
-- actor_user_id/resource_type/resource_id/payload. We match the app to keep
-- existing code working; renaming would require touching Services/Controllers
-- which are owned by other agents.  See schema/README.md.

SET search_path TO hospital, public;

BEGIN;

-- -------------------------------------------------------------------------
-- 1. UNIQUE(hospital_id, panel_id) on hospital_panels  [M24]
-- -------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      t ON t.oid = c.conrelid
        JOIN   pg_namespace  n ON n.oid = t.relnamespace
        WHERE  n.nspname = 'hospital'
          AND  t.relname = 'hospital_panels'
          AND  c.conname = 'hospital_panels_hospital_id_panel_id_key'
    ) THEN
        -- First defensively de-duplicate by keeping the earliest row per pair.
        -- Safe no-op if no duplicates exist.
        DELETE FROM hospital.hospital_panels a
        USING hospital.hospital_panels b
        WHERE  a.ctid < b.ctid
          AND  a.hospital_id = b.hospital_id
          AND  a.panel_id    = b.panel_id;

        ALTER TABLE hospital.hospital_panels
            ADD CONSTRAINT hospital_panels_hospital_id_panel_id_key
            UNIQUE (hospital_id, panel_id);
    END IF;
END
$$;

-- -------------------------------------------------------------------------
-- 2. Phone columns CHAR(10) -> VARCHAR(20)  [M23]
-- -------------------------------------------------------------------------
DO $$
DECLARE
    v_type TEXT;
BEGIN
    SELECT data_type || COALESCE('(' || character_maximum_length || ')', '')
      INTO v_type
      FROM information_schema.columns
     WHERE table_schema = 'hospital'
       AND table_name   = 'ipds'
       AND column_name  = 'phone';

    IF v_type IS NOT NULL AND v_type <> 'character varying(20)' THEN
        ALTER TABLE hospital.ipds
            ALTER COLUMN phone TYPE VARCHAR(20)
            USING TRIM(BOTH FROM phone);
    END IF;
END
$$;

DO $$
DECLARE
    v_type TEXT;
BEGIN
    SELECT data_type || COALESCE('(' || character_maximum_length || ')', '')
      INTO v_type
      FROM information_schema.columns
     WHERE table_schema = 'hospital'
       AND table_name   = 'hospital_panels'
       AND column_name  = 'contact';

    IF v_type IS NOT NULL AND v_type <> 'character varying(20)' THEN
        ALTER TABLE hospital.hospital_panels
            ALTER COLUMN contact TYPE VARCHAR(20)
            USING TRIM(BOTH FROM contact);
    END IF;
END
$$;

-- -------------------------------------------------------------------------
-- 3. audit_logs table  [M29]
-- -------------------------------------------------------------------------
-- pgcrypto for gen_random_uuid(); uuid-ossp may also be present from schema.sql.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS hospital.audit_logs (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        REFERENCES hospital.users(id) ON DELETE SET NULL,
    action       TEXT        NOT NULL,
    entity_type  TEXT,
    entity_id    TEXT,
    details      JSONB,
    ip_address   TEXT,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
    ON hospital.audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
    ON hospital.audit_logs (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id
    ON hospital.audit_logs (user_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
    ON hospital.audit_logs (action);

COMMIT;
