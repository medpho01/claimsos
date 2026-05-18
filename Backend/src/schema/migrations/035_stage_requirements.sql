-- Migration 035: Stage Requirements (Sprint 3, Wave 3A — Rules Engine)
-- Date: 2026-05-18
--
-- The Rules Engine evaluates "is this claim ready to move to target_stage X?"
-- by checking whether the dossier satisfies a configurable set of stage
-- requirements. This migration introduces the catalogue of those rules.
--
-- Design notes:
--
--   * One table — `hospital.stage_requirements` — holds both the rule
--     metadata and its scope cascade. We deliberately avoid splitting rules
--     vs scopes vs versions into separate tables; a rule version is the
--     atomic editable unit, and a rule applies to a *single* scope vector
--     (global, panel, insurer, procedure, diagnosis_class). To author a
--     rule that should fire under multiple scopes, seed multiple rows.
--
--   * `rule_key` is a stable, human-readable identifier. Versions of the same
--     logical rule reuse the same key and bump `version`. UNIQUE(rule_key,
--     version) prevents accidental duplicates.
--
--   * `target_stage` references master_options(code) for category='ipd_stage'
--     (migration 024) by convention only — no FK, because master_options uses
--     a composite (category, code) primary key and stage codes are curated.
--
--   * Insurer scoping is currently mapped to `panels` — there is no separate
--     insurers table in this schema (panels = insurer/TPA entities, and
--     hospital_panels is the per-hospital join). `scope_insurer_id` therefore
--     FK's to panels(id); flag it for review when a real insurer dimension
--     is introduced.
--
--   * The CHECK constraint enforces "rule must declare at least one scope" —
--     a rule with every scope NULL/false would never apply.
--
-- Single transaction; ON CONFLICT clauses make seed re-runs idempotent.

BEGIN;

-- ============================================================================
-- A. hospital.stage_requirements
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.stage_requirements (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable human-readable identifier. Versions share key, bump version.
  rule_key                 VARCHAR(128) NOT NULL,

  -- master_options(code) for category='ipd_stage'. No FK (master_options has
  -- a composite key); curated as convention.
  target_stage             VARCHAR(100) NOT NULL,

  -- master_options(code) for category='doc_category'. NULL allowed only when
  -- required_fields is non-null (see CHECK constraint below).
  required_doc_category    VARCHAR(100),

  -- Alternative / additional check for specific extracted fields. Shape is
  -- a JSON array of { field_key: string, allowed_categories?: string[] }.
  required_fields          JSONB,

  severity                 VARCHAR(16) NOT NULL,

  -- Scope cascade — at least one must be set / true (see CHECK below).
  scope_global             BOOLEAN NOT NULL DEFAULT false,
  scope_panel_id           UUID REFERENCES hospital.panels(id) ON DELETE CASCADE,
  -- No separate insurer table currently — panels also represents insurers/
  -- TPAs. FK to panels(id) for parity; when a true insurer table is added,
  -- migrate this column.
  scope_insurer_id         UUID REFERENCES hospital.panels(id) ON DELETE CASCADE,
  scope_procedure_code     VARCHAR(100),
  scope_diagnosis_class    VARCHAR(100),

  active                   BOOLEAN NOT NULL DEFAULT true,
  version                  INT NOT NULL DEFAULT 1,
  effective_from           TIMESTAMP NOT NULL DEFAULT NOW(),
  effective_to             TIMESTAMP,
  created_by               UUID,
  created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_stage_requirements_key_version UNIQUE (rule_key, version),

  CONSTRAINT chk_stage_requirements_severity
    CHECK (severity IN ('blocking', 'warning', 'info')),

  -- "rule must declare at least one scope"
  CONSTRAINT chk_stage_requirements_scope_present CHECK (
    scope_global = true
    OR scope_panel_id        IS NOT NULL
    OR scope_insurer_id      IS NOT NULL
    OR scope_procedure_code  IS NOT NULL
    OR scope_diagnosis_class IS NOT NULL
  ),

  -- "rule must declare at least one expected artefact" — either a required
  -- doc category, or a required_fields JSON, or both.
  CONSTRAINT chk_stage_requirements_artefact_present CHECK (
    required_doc_category IS NOT NULL
    OR required_fields    IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_stage_requirements_target_stage
  ON hospital.stage_requirements (target_stage);
CREATE INDEX IF NOT EXISTS idx_stage_requirements_panel_stage
  ON hospital.stage_requirements (scope_panel_id, target_stage)
  WHERE scope_panel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stage_requirements_global_stage
  ON hospital.stage_requirements (scope_global, target_stage)
  WHERE scope_global = true;
CREATE INDEX IF NOT EXISTS idx_stage_requirements_active
  ON hospital.stage_requirements (active)
  WHERE active = true;

COMMENT ON TABLE hospital.stage_requirements IS
  'Configurable requirements that gate transitioning a claim into a target stage. Evaluated by RulesEngine.evaluate(). One row per (rule_key, version, scope vector).';

-- ============================================================================
-- B. Seed v1 rules — Sadbhawana / PMJAY pre-auth, query, discharge flow
-- ============================================================================
-- All seeds are system-authored (created_by = NULL). We use ON CONFLICT
-- (rule_key, version) DO NOTHING so re-running this migration against a
-- partially-seeded environment is safe.

-- pre_auth.requires.diagnosis_summary -------------------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'pre_auth.requires.diagnosis_summary',
  'preauth_submitted',
  'diagnosis_summary',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- pre_auth.requires.procedure_estimate ------------------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'pre_auth.requires.procedure_estimate',
  'preauth_submitted',
  'procedure_estimate',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- pre_auth.requires.consent -----------------------------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'pre_auth.requires.consent',
  'preauth_submitted',
  'consent',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- pre_auth.warns.oncologist_consent_if_oncology ---------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity,
  scope_global, scope_diagnosis_class
) VALUES (
  'pre_auth.warns.oncologist_consent_if_oncology',
  'preauth_submitted',
  'oncologist_consent',
  'warning',
  false,
  'oncology'
) ON CONFLICT (rule_key, version) DO NOTHING;

-- query_reply.requires.requested_doc --------------------------------------
-- v1 implementation: assert that an insurer_response (or other follow-up doc)
-- is present when responding to a query. A richer "the doc the insurer
-- *asked for* is present" check will land once query-letter extraction is in.
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'query_reply.requires.requested_doc',
  'preauth_query_responded',
  'insurer_response',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- discharge_filing.requires.discharge_slip --------------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'discharge_filing.requires.discharge_slip',
  'discharge_submitted',
  'discharge_slip',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- discharge_filing.requires.final_bill ------------------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'discharge_filing.requires.final_bill',
  'discharge_submitted',
  'final_bill',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- discharge_filing.requires.ot_notes_and_photos_if_surgical ---------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity,
  scope_global, scope_diagnosis_class
) VALUES (
  'discharge_filing.requires.ot_notes_and_photos_if_surgical',
  'discharge_submitted',
  'ot_notes_and_photos',
  'warning',
  false,
  'surgical'
) ON CONFLICT (rule_key, version) DO NOTHING;

COMMIT;
