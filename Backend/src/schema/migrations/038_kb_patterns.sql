-- Migration 038: Knowledge-Base Patterns (Sprint 3, Wave 4A — KB Pattern Miner + Matcher)
-- Date: 2026-05-18
--
-- The Knowledge Base is the system's structured library of learned regularities
-- mined from closed claims. Each row in `hospital.kb_patterns` is a candidate
-- or live pattern that — when its `condition` matches a new claim's dossier —
-- emits a `prediction` (insurer query likely, deduction likely, expected
-- approval ratio, etc.) the ReasoningAgent (Wave 4C) can cite alongside the
-- rule-engine output.
--
-- Why a relational table (not a vector store):
--
--   * Patterns are STRUCTURED predicates over the dossier shape — not free-
--     text snippets. A vector store gives us approximate similarity but loses
--     the property we actually need: "for THIS panel × procedure_class, when
--     doc X is missing, query rate is 0.78 (n=42)". We mine those numbers in
--     SQL and want indexed JSONB matching to surface them.
--
--   * Auditability. A human reviewer (Kratika) needs to read the matched
--     pattern, see the evidence_claim_ids it was mined from, and either
--     promote it to 'live' or demote it. That's a row, not a vector.
--
--   * Cheap re-mining. A nightly cron re-runs the v0 SQL strategies and
--     ON CONFLICT-bumps `evidence_count` + `last_seen_at` for patterns we
--     re-discover. The unique signature column makes that O(1).
--
-- One transaction; all DDL idempotent (IF NOT EXISTS / ADD CONSTRAINT
-- IF NOT EXISTS).

BEGIN;

-- ============================================================================
-- A. hospital.kb_patterns
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.kb_patterns (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References master_options.code where category = 'kb_pattern_type'.
  -- VARCHAR (not FK) because master_options is a soft vocabulary table and
  -- the rest of the codebase references it by code-string, not by row id.
  pattern_type         VARCHAR(64) NOT NULL,

  -- Short human-readable name. The miner generates a deterministic title
  -- from the strategy (e.g. "Sadbhawana: missing implant_invoice → query 78%").
  title                VARCHAR(255) NOT NULL,
  description          TEXT,

  -- Scope narrows where the pattern applies. Shape:
  --   { global?:bool, panel_id?, insurer_id?, procedure_code?,
  --     diagnosis_class?, hospital_id? }
  -- A pattern with global=true matches every claim. Others use JSONB
  -- containment against the candidate claim's scope-vector at match time.
  scope                JSONB NOT NULL,

  -- The matchable predicate. Shape:
  --   { kind: 'doc_missing' | 'doc_present' | 'amount_in_range'
  --       | 'past_outcome_seq' | 'stage_dwell' | ..., params: {...} }
  -- The matcher service interprets `kind` and dispatches to a typed handler.
  -- Unknown kinds are skipped (warning logged) so a newer matcher version
  -- can ignore patterns produced by a future miner without crashing.
  condition            JSONB NOT NULL,

  -- The prediction emitted when condition matches. Shape:
  --   { kind: 'query_likely' | 'deduction_likely' | 'approval_likely'
  --       | 'amount_cut_pct' | ..., params, point_estimate?, distribution? }
  -- ReasoningAgent (Wave 4C) blends these into its narrative; cockpit may
  -- render the point_estimate inline.
  prediction           JSONB NOT NULL,

  -- Mined confidence, 0..1. For v0 SQL miners this is the support rate
  -- (e.g. fraction of matching closed claims where the predicted outcome
  -- occurred). LLM-mined patterns (later) populate this themselves.
  confidence           NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),

  -- How many closed claims back this pattern up. Re-mining bumps this.
  evidence_count       INT NOT NULL DEFAULT 0,

  -- A bounded list (capped at ~50 by the miner) of supporting claim ids so a
  -- reviewer can spot-check why this pattern was raised. Not the full set —
  -- evidence_count is the canonical population size.
  evidence_claim_ids   UUID[] NOT NULL DEFAULT '{}',

  -- Mining lineage. last_seen_at is bumped on every re-mining that
  -- re-discovers the row; mined_at is set once at insert.
  mined_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Lifecycle:
  --   candidate — freshly mined, waiting for a human review
  --   live      — promoted by a reviewer; eligible for matching
  --   demoted   — explicitly disabled by a reviewer
  --   archived  — superseded / no longer reproducible
  status               VARCHAR(32) NOT NULL DEFAULT 'candidate'
                       CHECK (status IN ('candidate','live','demoted','archived')),

  -- Review trail. Not FK to users — users live in a different schema and we
  -- don't want the cascade churn.
  reviewed_by          UUID,
  reviewed_at          TIMESTAMP,
  promotion_reason     TEXT,
  demotion_reason      TEXT,

  -- Version of the miner that produced this row. Bump when the SQL strategy
  -- changes meaningfully so older rows can be retired.
  miner_version        VARCHAR(32) NOT NULL DEFAULT 'v0',
  -- Reserved for LLM-mined patterns (later sprints). NULL for SQL v0.
  prompt_version       VARCHAR(32),

  -- Dedup signature. Generated column (md5 over the stable identity of a
  -- pattern: type + scope + condition). The UNIQUE index on this column is
  -- the target of ON CONFLICT in the miner — re-discovering the same pattern
  -- bumps evidence_count, doesn't insert a new row.
  pattern_signature    TEXT
    GENERATED ALWAYS AS (
      md5(
        pattern_type ||
        '|' || COALESCE(scope::text, '') ||
        '|' || COALESCE(condition::text, '')
      )
    ) STORED
);

-- ---- Indexes --------------------------------------------------------------
-- Hot reads: matcher loads all live patterns, scoped by master_options.code,
-- intersected with the candidate claim's scope.

CREATE INDEX IF NOT EXISTS idx_kb_patterns_type
  ON hospital.kb_patterns (pattern_type);

CREATE INDEX IF NOT EXISTS idx_kb_patterns_status
  ON hospital.kb_patterns (status);

CREATE INDEX IF NOT EXISTS idx_kb_patterns_type_status
  ON hospital.kb_patterns (pattern_type, status);

-- JSONB containment lookups: matcher does `scope @> '{"panel_id":...}'`,
-- miner does `condition @> '{"kind":...}'`.
CREATE INDEX IF NOT EXISTS idx_kb_patterns_scope_gin
  ON hospital.kb_patterns USING gin (scope);

CREATE INDEX IF NOT EXISTS idx_kb_patterns_condition_gin
  ON hospital.kb_patterns USING gin (condition);

-- Unique on the generated signature: same (type, scope, condition) →
-- one row. Miner uses ON CONFLICT (pattern_signature) DO UPDATE to bump
-- evidence_count + last_seen_at.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_patterns_signature
  ON hospital.kb_patterns (pattern_signature);

COMMENT ON TABLE hospital.kb_patterns IS
  'Knowledge-Base patterns mined from closed claims. condition JSONB is the matcher predicate; prediction JSONB is the emitted forecast. Lifecycle: candidate → live (after human review) → demoted/archived.';

COMMENT ON COLUMN hospital.kb_patterns.pattern_signature IS
  'Generated md5 over (pattern_type, scope, condition). Drives the unique index that lets the miner ON CONFLICT-bump existing patterns without duplicating.';

COMMENT ON COLUMN hospital.kb_patterns.evidence_claim_ids IS
  'Sample of supporting claim ids (capped ~50 by the miner). evidence_count is the canonical population — this array is for spot-checking only.';

-- ============================================================================
-- B. hospital.kb_pattern_matches
-- ============================================================================
-- Append-only log of "this pattern fired on that claim at this moment".
-- Used by:
--   * The eval harness (Wave 5) to compute pattern precision once claims
--     close: actual_outcome filled in, prediction_correct computed.
--   * The cockpit pattern-card to show "we've matched 14 prior claims with
--     this exact pattern, 11 of them were eventually queried" provenance.

CREATE TABLE IF NOT EXISTS hospital.kb_pattern_matches (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  pattern_id               UUID NOT NULL
                           REFERENCES hospital.kb_patterns(id) ON DELETE CASCADE,

  -- Canonical claim grain: hospital.ipds(id).
  claim_id                 UUID NOT NULL
                           REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- The adjudication run whose ReasoningAgent surfaced this match (Wave 4C
  -- writes this). NULL when a pattern is matched outside an adjudication
  -- (e.g. background eval sweep). ON DELETE SET NULL — losing the report
  -- shouldn't lose the match-feedback row.
  adjudication_report_id   UUID
                           REFERENCES hospital.adjudication_reports(id)
                           ON DELETE SET NULL,

  matched_at               TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Populated by the kb-pattern-feedback worker when the parent claim
  -- transitions to a terminal closure_outcome. Shape mirrors the
  -- prediction's `kind`, e.g. { query_raised: true, deduction_pct: 0.18 }.
  actual_outcome           JSONB,

  -- Boolean verdict: did `prediction` agree with `actual_outcome`? The
  -- feedback worker derives this from the prediction kind. NULL while the
  -- claim is still open.
  prediction_correct       BOOLEAN,

  -- When the feedback row was filled in (claim closed). NULL while open.
  resolved_at              TIMESTAMP
);

-- ---- Indexes --------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_kb_pattern_matches_claim
  ON hospital.kb_pattern_matches (claim_id);

CREATE INDEX IF NOT EXISTS idx_kb_pattern_matches_pattern
  ON hospital.kb_pattern_matches (pattern_id);

-- Partial index over unresolved rows — the feedback worker scans this on
-- every claim_closed event. Most matches resolve eventually so the partial
-- predicate keeps the index small.
CREATE INDEX IF NOT EXISTS idx_kb_pattern_matches_unresolved
  ON hospital.kb_pattern_matches (claim_id)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE hospital.kb_pattern_matches IS
  'Log of every (pattern, claim) firing. Filled in at firing time; actual_outcome + prediction_correct populated by the kb-pattern-feedback worker once the claim closes. Drives precision/recall metrics.';

COMMIT;
