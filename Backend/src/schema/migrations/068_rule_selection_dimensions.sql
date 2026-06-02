-- =============================================================================
-- 068 — adjudication rule-set selection dimensions + rule kind/min_confidence
--       (2026-06-02, M3)
--
-- Extends the Wave-8 rule tables so a rule set can be selected by the full
-- claim context {scheme, route, stage, case_type} (today only insurer x
-- treatment x specialty), and so individual rules carry a pluggable evaluator
-- `kind` + an abstention threshold `min_confidence` (FROZEN_CONTRACTS OD4).
--
-- Additive + forward-only + idempotent. No CHECK on `kind` (new kinds stay
-- migration-free per OD4). Manual rollback:
--   ALTER TABLE hospital.insurer_rule_sets
--     DROP COLUMN IF EXISTS applicable_schemes, DROP COLUMN IF EXISTS applicable_routes,
--     DROP COLUMN IF EXISTS applicable_stages,  DROP COLUMN IF EXISTS applicable_case_types;
--   ALTER TABLE hospital.insurance_rules
--     DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS min_confidence;
-- =============================================================================

BEGIN;

ALTER TABLE hospital.insurer_rule_sets
  ADD COLUMN IF NOT EXISTS applicable_schemes    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS applicable_routes     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS applicable_stages     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS applicable_case_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Empty array = wildcard (matches any value of that dimension) — see
-- Services/rules/selection.ts. Non-empty = the set this rule set applies to.

ALTER TABLE hospital.insurance_rules
  ADD COLUMN IF NOT EXISTS kind           VARCHAR(64),
  ADD COLUMN IF NOT EXISTS min_confidence NUMERIC(4,3);

COMMENT ON COLUMN hospital.insurance_rules.kind IS
  'Evaluator kind dispatched by Services/rules (DOCUMENT_PRESENCE/REQUIRED_FIELDS/FUZZY_NAME/TEMPORAL_WINDOW/...). NULL = legacy validation_logic path.';

COMMIT;
