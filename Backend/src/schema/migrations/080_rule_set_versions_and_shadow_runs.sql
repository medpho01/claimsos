-- =============================================================================
-- 080 — rule set versions + shadow runs  (2026-09-14)
-- =============================================================================
-- Wave B makes the rule engine superadmin-editable. Two tables make that safe.
--
-- WHY THIS IS NEEDED AT ALL
-- ---------------------------------------------------------------------------
-- Until now a rule change was a deploy: reviewed, versioned by git, revertible.
-- Through a form it becomes one click, live on every claim, with no diff and
-- nothing to roll back to. A rule that wrongly blocks is not a cosmetic bug —
-- it holds claims a hospital needed to file, and the 3-hour discharge
-- authorisation clock does not pause while someone works out why.
--
-- So authoring gets the two things the deploy pipeline used to provide for
-- free: a version history you can diff and revert, and a dry run against real
-- claims before anything goes live.
--
-- A. insurer_rule_set_versions — an immutable snapshot per promotion.
--    The whole pack (set + rules + document requirements + financial limits +
--    LOS benchmarks) is frozen as JSONB rather than modelled relationally.
--    Deliberate: a version must reproduce EXACTLY what was live at a moment,
--    including rows since deleted and columns since added. Foreign keys to
--    live tables would let a version silently change when the present does,
--    which is the one thing an audit snapshot must never do.
--
-- B. rule_set_shadow_runs — a dry run's result.
--    Records which draft ran, over which cohort, and what it produced, so the
--    promotion gate can require evidence rather than a promise. `passed`
--    records only that the run COMPLETED; whether the numbers are acceptable
--    is a human judgement, and encoding it here would invite someone to game
--    a threshold.
--
-- Forward-only, additive, idempotent.
-- =============================================================================

BEGIN;

-- ── A. Version snapshots ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.insurer_rule_set_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The business key, NOT a FK to insurer_rule_sets.id. A version must survive
  -- the deletion of the set it came from — that is precisely when you most
  -- need to read it.
  rule_set_id     VARCHAR(128) NOT NULL,

  version         VARCHAR(32)  NOT NULL,

  -- The complete frozen pack. See the header for why this is JSONB.
  snapshot        JSONB        NOT NULL,

  -- What changed and why. `change_note` is required by the application, not by
  -- the column: an existing row imported without one must not block the
  -- migration.
  change_note     TEXT,
  changed_by      UUID,

  -- The shadow run that justified this promotion, when there was one.
  shadow_run_id   UUID,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (rule_set_id, version)
);

CREATE INDEX IF NOT EXISTS idx_irsv_set
  ON hospital.insurer_rule_set_versions (rule_set_id, created_at DESC);

COMMENT ON TABLE hospital.insurer_rule_set_versions IS
  'Immutable snapshot of a rule pack at promotion. JSONB rather than relational '
  'so a version reproduces exactly what was live, including rows since deleted.';

-- ── B. Shadow runs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.rule_set_shadow_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id       VARCHAR(128) NOT NULL,

  -- Which draft was tested. Stored alongside the id because the draft keeps
  -- being edited afterwards, and a run must say what it actually ran.
  tested_version    VARCHAR(32),

  -- The cohort: {from, to, insurer_code, hospital_id, limit}. Free-shaped
  -- because the selector will grow and a rigid schema would need a migration
  -- every time someone wants to slice differently.
  cohort            JSONB        NOT NULL,

  claims_evaluated  INT          NOT NULL DEFAULT 0,

  -- Aggregates the promotion decision is actually made on:
  --   readiness_distribution — histogram of scores
  --   rule_fire_rates        — ruleId -> how often it fired
  --   delta_vs_live          — what changes if this is promoted
  results           JSONB        NOT NULL DEFAULT '{}'::jsonb,

  -- Completion, NOT approval. Whether the numbers are good is a human call.
  passed            BOOLEAN      NOT NULL DEFAULT FALSE,
  error             TEXT,

  run_by            UUID,
  started_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rssr_set
  ON hospital.rule_set_shadow_runs (rule_set_id, started_at DESC);

-- The promotion gate asks "has this set been shadow-run successfully?" on every
-- promote, so it gets its own partial index rather than filtering the lot.
CREATE INDEX IF NOT EXISTS idx_rssr_passed
  ON hospital.rule_set_shadow_runs (rule_set_id, finished_at DESC)
  WHERE passed;

COMMENT ON COLUMN hospital.rule_set_shadow_runs.passed IS
  'The run COMPLETED without error. Not a verdict on the numbers — that is a '
  'human judgement, and encoding a threshold here would invite gaming it.';

-- ── C. Authoring provenance on the rule set ─────────────────────────────────
ALTER TABLE hospital.insurer_rule_sets
  ADD COLUMN IF NOT EXISTS updated_by          UUID,
  ADD COLUMN IF NOT EXISTS last_shadow_run_id  UUID,
  ADD COLUMN IF NOT EXISTS cloned_from         VARCHAR(128);

COMMENT ON COLUMN hospital.insurer_rule_sets.last_shadow_run_id IS
  'Most recent successful shadow run. The promotion gate requires this to be '
  'set and to postdate the last edit.';

COMMIT;
