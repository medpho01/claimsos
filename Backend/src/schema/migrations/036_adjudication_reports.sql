-- Migration 036: adjudication_reports table (Sprint 3, Wave 3B)
-- Date: 2026-05-18
--
-- The AdjudicationReport is the engine's structured opinion on a single
-- claim at a single target stage. Each run folds (RulesEngine result +
-- dossier snapshot + future KB/episodic matches + future ReasoningAgent
-- narrative) into a row that the cockpit reads to render "what AI thinks
-- of this case right now".
--
-- Why a table (vs caching in claim_dossiers.active_adjudication)?
--   - We need *history*. Auditors and ops want to see how the engine's
--     opinion shifted as the dossier matured (doc came in → score
--     jumped, query was raised → action flipped to request_doc, etc.).
--   - We need *cache by input hash*. Re-running adjudication for the
--     same dossier_state_hash must be a free no-op; the dossier hash
--     gates that.
--   - The blob on claim_dossiers.active_adjudication remains the
--     "latest" pointer (rendered hot), but the canonical timeline of
--     reports lives here.
--
-- claim_id semantics: hospital.ipds(id), matching migrations 030/031.
-- ON DELETE CASCADE so deleting an IPD cleans up its reports.
--
-- Versioning: rules_version + engine_version are baked into the dedup
-- key so a rules-engine version bump intentionally invalidates the
-- cache and forces a re-run on the next call.

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.adjudication_reports (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id             UUID NOT NULL
                       REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- Stage the engine evaluated the claim's readiness *for*. e.g.
  -- 'pre_auth', 'query_reply', 'enhancement', 'discharge_filing'.
  target_stage         VARCHAR(100) NOT NULL,

  -- Headline numbers ────────────────────────────────────────────────
  -- readiness_score in 0..100 (rules engine returns 0..1; the engine
  -- service scales it before insert so the column reads naturally for
  -- humans / FE).
  readiness_score      INT NOT NULL CHECK (readiness_score BETWEEN 0 AND 100),
  -- Coarse bucket derived from readiness_score for fast filtering on
  -- the dashboard ("how many claims are blocked right now?").
  readiness_bucket     VARCHAR(32) NOT NULL
                       CHECK (readiness_bucket IN ('ready', 'almost', 'blocked')),
  -- Action the cockpit should encourage. Derived from bucket + the
  -- shape of blocking_gaps/warnings/active_queries.
  recommended_action   VARCHAR(64) NOT NULL
                       CHECK (recommended_action IN (
                         'file_now', 'request_doc', 'review',
                         'wait', 'escalate_to_human'
                       )),

  -- Engine output detail ────────────────────────────────────────────
  -- RulesEngine.evaluate().blocking_gaps — each is a structured
  -- {rule_id, message, severity, ...} object the FE renders verbatim.
  blocking_gaps        JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings             JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Wave 4 (ReasoningAgent) will populate predicted_outcome with
  -- {amount, p_query, p_deduction, expected_deductions}. In v0 we
  -- leave it NULL — the FE knows to hide that card when null.
  predicted_outcome    JSONB,

  -- {rule_ids:[], pattern_ids:[], case_ids:[]} — pointers to the
  -- evidence the engine used. v0 fills rule_ids only; pattern_ids
  -- and case_ids stay empty until KB / episodic lanes land.
  citations            JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Stubbed in v0 (empty arrays). Populated by the KB-similarity
  -- and episodic-memory passes in later waves.
  kb_matches           JSONB NOT NULL DEFAULT '[]'::jsonb,
  episodic_refs        JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- ReasoningAgent's narrative — Wave 4 fills this in. NULL in v0.
  reasoning            TEXT,

  -- Cache / lineage ─────────────────────────────────────────────────
  -- sha256 of stable JSON over the dossier-shaped inputs the engine
  -- relies on. Used to short-circuit re-runs: same inputs → return
  -- the existing row instead of re-evaluating.
  dossier_state_hash   VARCHAR(64) NOT NULL,
  rules_version        VARCHAR(32) NOT NULL DEFAULT 'v1',
  engine_version       VARCHAR(32) NOT NULL DEFAULT 'v0',

  generated_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  -- 'engine' for queue-driven runs, 'manual_replay' for force=true
  -- runs initiated from the controller.
  generated_by         VARCHAR(32) DEFAULT 'engine'
);

-- "Latest report for a claim" — the cockpit's hot read path.
CREATE INDEX IF NOT EXISTS idx_ar_claim_generated
  ON hospital.adjudication_reports (claim_id, generated_at DESC);

-- Cache lookup by hashed input — must be cheap because every run
-- starts with this probe.
CREATE INDEX IF NOT EXISTS idx_ar_cache_lookup
  ON hospital.adjudication_reports (claim_id, target_stage, dossier_state_hash);

-- Dashboard "what's blocked across the floor" filter.
CREATE INDEX IF NOT EXISTS idx_ar_readiness_bucket
  ON hospital.adjudication_reports (readiness_bucket);

-- Idempotency: same (claim, stage, dossier state, rules, engine)
-- collapses to the existing row. The engine service uses
-- ON CONFLICT DO NOTHING + a follow-up SELECT to read back.
ALTER TABLE hospital.adjudication_reports
  ADD CONSTRAINT uq_ar_dedup
  UNIQUE (claim_id, target_stage, dossier_state_hash, rules_version, engine_version);

-- ─── Comments ────────────────────────────────────────────────────────────
COMMENT ON TABLE  hospital.adjudication_reports IS
  'Engine-produced opinion on a claim at a target stage: readiness score, blocking gaps, warnings, recommended action, and (future) reasoning. Cached by dossier_state_hash so identical inputs return the same row.';

COMMENT ON COLUMN hospital.adjudication_reports.claim_id IS
  'FK to hospital.ipds(id). One IPD has many adjudication runs over its lifetime — the history is the audit trail of the engine''s evolving opinion.';

COMMENT ON COLUMN hospital.adjudication_reports.readiness_score IS
  '0..100 (rules engine returns 0..1; engine service scales).';

COMMENT ON COLUMN hospital.adjudication_reports.dossier_state_hash IS
  'sha256 hex over stable JSON of the dossier fields the engine actually reads. Re-running with the same hash returns the cached row.';

COMMENT ON COLUMN hospital.adjudication_reports.predicted_outcome IS
  '{amount, p_query, p_deduction, expected_deductions} — null in v0. Wave 4 ReasoningAgent populates this.';

COMMENT ON COLUMN hospital.adjudication_reports.kb_matches IS
  'Wave 4 KB pattern matches. Empty array in v0.';

COMMENT ON COLUMN hospital.adjudication_reports.episodic_refs IS
  'Wave 4 episodic-memory case refs. Empty array in v0.';

COMMENT ON COLUMN hospital.adjudication_reports.reasoning IS
  'Wave 4 ReasoningAgent narrative. Null in v0.';

COMMIT;
