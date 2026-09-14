-- =============================================================================
-- 078 — requirement stage scope: an explicit 'ALL', and no hard-coded taxonomy
-- =============================================================================
-- Two defects in `insurer_document_requirements.stage`, both of which would
-- silently corrupt every rule authored through the new superadmin screens.
--
-- DEFECT 1 — 074 destroyed the "applies to every stage" semantic.
-- ---------------------------------------------------------------------------
-- 074:34-38 set `DEFAULT 'FINAL_CLAIM'` and backfilled every NULL, so that a
-- UNIQUE key over (rule_set_id, document_type, stage) would work — a UNIQUE
-- constraint treats NULLs as distinct, which makes such a key meaningless.
-- That was the right call for the key and the wrong one for the column: it
-- left no way to say "this document is required at EVERY stage", and any rule
-- authored without an explicit stage now silently scopes itself to the final
-- claim alone.
--
-- Identity and eligibility evidence (Aadhaar, PAN, TPA card, policy copy) is
-- demanded at pre-auth AND again at settlement — Vidal's settlement checklist
-- literally re-asks for "ID proof - submitted during Preliminary Pre-auth
-- process". Without a working all-stages scope, those rules can only be
-- written per stage, and forgetting one is invisible.
--
-- Fix: an explicit `'ALL'` sentinel. NOT a return to NULL — the UNIQUE key
-- still needs a concrete value, and 074's reasoning there stands.
--
-- No data is recovered because none was lost: 074's own note records that
-- every row seeded by 044 supplied a non-null stage, so the backfill changed
-- nothing. Verified before writing this: the seed carries explicit
-- 'PRE_AUTH'/'FINAL_CLAIM' on every row.
--
-- DEFECT 2 — the CHECK constraint hard-codes a taxonomy that is now editable.
-- ---------------------------------------------------------------------------
-- 044:117 pins `stage IN ('PRE_AUTH','ENHANCEMENT','FINAL_CLAIM',
-- 'QUERY_RESPONSE')`. Migration 077 made the lifecycle superadmin-configurable,
-- so the moment someone adds a stage through the UI, every requirement insert
-- referencing it fails — from a constraint they cannot see and did not know
-- existed.
--
-- It was also already wrong: it accepts four SCREAMING_SNAKE values while
-- `ipds.stage` holds nineteen lowercase ones. Those two vocabularies could
-- never join.
--
-- Fix: drop the CHECK. Validation moves to the application, which can read
-- hospital.claim_stages. A foreign key would be the stronger guarantee but
-- cannot express the 'ALL' sentinel, and adding an 'ALL' row to claim_stages
-- to satisfy it would put a non-stage in the upload dropdown.
--
-- Forward-only, additive, idempotent.
-- =============================================================================

BEGIN;

-- ── Defect 2: retire the hard-coded taxonomy ────────────────────────────────
-- Discovered by NAME here because that is what 044 declared it as; the
-- definition-scoped search used in 076 is unnecessary for a constraint this
-- codebase created itself and never renamed.
ALTER TABLE hospital.insurer_document_requirements
  DROP CONSTRAINT IF EXISTS chk_idr_stage;

-- ── Defect 1: 'ALL' becomes the default scope ───────────────────────────────
-- A requirement written without an explicit stage now applies EVERYWHERE
-- rather than to the final claim alone. That is deliberately the noisy
-- direction: an over-scoped requirement shows up as a document asked for too
-- often, which a reviewer notices and reports. An under-scoped one silently
-- stops being checked at the stages it was omitted from, and nobody finds out
-- until a claim is deducted.
ALTER TABLE hospital.insurer_document_requirements
  ALTER COLUMN stage SET DEFAULT 'ALL';

COMMENT ON COLUMN hospital.insurer_document_requirements.stage IS
  'Stage code this requirement applies at, or the sentinel ''ALL'' for every '
  'stage. References hospital.claim_stages(code) by convention — no FK, '
  'because ''ALL'' is not a stage. Validated in the application layer. NULL is '
  'not used: the UNIQUE key over (rule_set_id, document_type, stage) would '
  'treat NULLs as distinct and stop de-duplicating (see 074).';

-- ── Defect 1b: the same column on stage_requirements ────────────────────────
-- 035's `target_stage` has the same hard-coded-vocabulary problem but no CHECK
-- constraint to drop, so it needs only the comment to point a future reader at
-- the registry.
COMMENT ON COLUMN hospital.stage_requirements.target_stage IS
  'Stage code this requirement gates entry to. References '
  'hospital.claim_stages(code) by convention (no FK — the column predates the '
  'registry and holds legacy migration-024 spellings on existing rows).';

COMMIT;
