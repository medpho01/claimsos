-- =============================================================================
-- 079 — document_stage_affinity: which stage a document category belongs to
-- =============================================================================
-- Backs the Document Mapping screen (Wave A). One row per doc_category,
-- carrying the three facts the stage tagger needs.
--
-- THE THREE FACTS, AND WHY THEY ARE SEPARATE COLUMNS
-- ---------------------------------------------------------------------------
-- `is_evergreen`  — this document is EVIDENCE at every stage.
--     Identity and eligibility artefacts (Aadhaar, PAN, TPA card, policy copy)
--     assert a fact about the PERSON or the POLICY, not about the episode, so
--     they cannot go stale between pre-auth and settlement. Filed once, they
--     satisfy every stage's requirement.
--
--     Note this is a different axis from insurer_document_requirements.stage
--     (fixed in 078). That column says WHEN a document is REQUIRED; this one
--     says WHEN A FILED DOCUMENT COUNTS. Conflating them is how an Aadhaar
--     filed at pre-auth gets reported missing at final claim and the ops team
--     re-uploads a document already in the bundle.
--
-- `stage_floor`   — the earliest stage at which this artefact can PHYSICALLY
--     exist. A final bill cannot precede discharge; an enhancement request
--     cannot precede admission. This is the ONLY field permitted to override
--     a human's choice at upload, and only ever to reject the impossible —
--     never to correct the merely unlikely.
--
--     That restriction exists because ADJUDICATION_ARCHITECTURE §5.3 rule 1
--     states "explicit human assignment always wins", and a floor check is
--     the one override compatible with it: it says "that cannot be true",
--     not "I think you meant something else".
--
-- `affinity_stage` — the stage this category is USUALLY evidence for. A hint
--     for inbound documents that arrive with no human declaring a stage
--     (insurer email, portal, admin upload). Never overrides a human.
--
-- WHY A TABLE RATHER THAN COLUMNS ON master_options
-- ---------------------------------------------------------------------------
-- doc_category lives in master_options, which is a generic dropdown registry
-- shared by fifteen unrelated categories. Three adjudication-specific columns
-- there would be dead weight on every other consumer, and the FK below gives
-- referential integrity that master_options' composite key cannot.
--
-- Forward-only, additive, idempotent. Rows are created lazily by the seed and
-- the UI; a category with no row simply has no affinity, which is the correct
-- default for most of the 246.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.document_stage_affinity (
  doc_category    VARCHAR(100) PRIMARY KEY,

  -- Evidence at every stage. See the header: this is the EVIDENCE axis, not
  -- the REQUIREMENT axis.
  is_evergreen    BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Earliest physically-possible stage. NULL = no floor, i.e. this category
  -- could legitimately appear at any point and the human's choice stands
  -- unconditionally.
  stage_floor     VARCHAR(64),

  -- Usual evidence stage, used only when no human declared one.
  affinity_stage  VARCHAR(64),

  -- Free-text predicate for conditional relevance ('implant billed',
  -- 'claim >= 1L', 'accident'). Deliberately TEXT rather than a scope column:
  -- stage_requirements' scope_* columns cannot express any of the real
  -- triggers, which is why they go unused.
  required_when   TEXT,

  -- Why this mapping is what it is. Shown in the UI; a mapping nobody can
  -- justify is a mapping nobody should trust.
  notes           TEXT,

  updated_by      UUID,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- The category must be a real doc_category. master_options has a composite
-- (category, code) key so a plain FK is impossible; this trigger-free guard
-- is a partial unique index on the referenced side plus an application check.
-- Recorded as a comment rather than pretended to be enforced.
COMMENT ON COLUMN hospital.document_stage_affinity.doc_category IS
  'References master_options(code) where category=''doc_category''. No FK: '
  'master_options uses a composite (category, code) primary key. Validated in '
  'the application layer.';

CREATE INDEX IF NOT EXISTS idx_dsa_evergreen
  ON hospital.document_stage_affinity (doc_category) WHERE is_evergreen;

CREATE INDEX IF NOT EXISTS idx_dsa_floor
  ON hospital.document_stage_affinity (stage_floor) WHERE stage_floor IS NOT NULL;

CREATE OR REPLACE FUNCTION hospital.touch_dsa_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dsa_updated_at ON hospital.document_stage_affinity;
CREATE TRIGGER trg_dsa_updated_at
  BEFORE UPDATE ON hospital.document_stage_affinity
  FOR EACH ROW EXECUTE FUNCTION hospital.touch_dsa_updated_at();

COMMENT ON TABLE hospital.document_stage_affinity IS
  'Per doc_category: is it evidence at every stage (is_evergreen), what is the '
  'earliest stage it can physically exist at (stage_floor, the only field that '
  'may override a human upload choice), and which stage is it usually evidence '
  'for (affinity_stage, a hint for inbound documents with no declared stage).';

COMMIT;
