-- =============================================================================
-- 081 — per-panel adjudication config + the non-payables catalog  (2026-09-14)
-- =============================================================================
-- Wave C. Two tables, both of which exist because the domain refuses to be a
-- constant.
--
-- A. panel_adjudication_config — every deadline is per-panel.
-- ---------------------------------------------------------------------------
-- Researching four TPAs' published hospital documents produced FOUR different
-- answers for the claim-file submission window, and two of them contradict
-- themselves inside their own documents:
--
--   MDIndia      30 days (contract cl. 7.5) vs 2 days (the IRDAI Schedule A
--                it appended to the same contract)
--   Good Health  7 days (network pre-auth form) vs 15 days (non-network MOU)
--   Vidal        7 days
--   Raksha       7 days
--
-- A hospital reading MDIndia's contract cannot tell which binds. So there is
-- no global constant to be had, and any code that hard-codes one is wrong for
-- most panels. These are MOU terms, not public data — they come from the
-- hospital's own empanelment agreements.
--
-- `terminology_aliases` exists for a specific, verified landmine: VIDAL CALLS
-- THE DISCHARGE DECISION "THE ENHANCEMENT". Everyone else means a mid-stay
-- top-up by that word. Without a per-panel alias map, Vidal claims mis-file
-- systematically and the cause is close to undiscoverable.
--
-- `proportionate_exempt_heads` is the claw-back lever. Room rent breaches
-- scale the associated medical expenses, but pharmacy, implants and
-- diagnostics are NOT supposed to scale — and TPAs routinely apply the ratio
-- to everything unless challenged. Which heads are exempt could not be pinned
-- to a primary IRDAI source, so it is per-panel configuration rather than a
-- constant asserted as fact.
--
-- B. non_payable_items — the IRDAI four lists.
-- ---------------------------------------------------------------------------
-- Counted directly from IRDAI/HLT/REG/CIR/176/09/2019 Annexure-I: List I 68,
-- List II 37, List III 23, List IV 18 = 146 items. NOT the 199 that is widely
-- repeated online; that figure traces to the superseded 2016 circular and
-- could not be found in any current primary source.
--
-- `aliases` is the load-bearing column. Billing systems write "GLOVES",
-- "SURGICAL GLOVES" and "GLOVE PAIR STERILE" for one catalogued item, so a
-- literal match finds almost nothing. Aliases are learned from real bills
-- rather than guessed, which is why the screen surfaces unmatched bill lines.
--
-- `list_number` carries the commercial weight: for a NETWORK CASHLESS claim,
-- para 2 of the circular requires insurers to make "shall not be billed to
-- the policyholders" part of the SLA with network providers. So a List
-- II/III/IV line on the bill is not merely a deduction — it is the hospital
-- breaching its own empanelment agreement.
--
-- Forward-only, additive, idempotent.
-- =============================================================================

BEGIN;

-- ── A. Per-panel adjudication config ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.panel_adjudication_config (
  panel_id                    UUID PRIMARY KEY
                              REFERENCES hospital.panels(id) ON DELETE CASCADE,

  -- Deadlines, in hours or days as the domain states them. NULL = not known
  -- for this panel, which must read as "unknown" and never as "no limit":
  -- the application treats NULL as "do not evaluate the timeliness rule"
  -- rather than silently passing it.
  preauth_decision_hours      NUMERIC(6,2),
  enhancement_decision_hours  NUMERIC(6,2),
  final_auth_decision_hours   NUMERIC(6,2),
  claim_file_days             INT,
  query_reply_days            INT,

  -- MDIndia: an enhancement not answered in 24h is DEEMED DENIED. That is a
  -- silent forfeiture, so it is modelled explicitly rather than left as prose
  -- in a PDF nobody reads.
  enhancement_silence_is_denial BOOLEAN NOT NULL DEFAULT FALSE,

  -- Canonical term -> what THIS panel calls it. See the Vidal note above.
  terminology_aliases         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Bill heads this panel does NOT scale on a room-rent breach.
  proportionate_exempt_heads  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Which non-payable lists this panel enforces, plus panel-specific additions.
  non_payable_lists           TEXT[] NOT NULL DEFAULT ARRAY['I','II','III','IV']::TEXT[],

  -- Where the numbers came from. A deadline nobody can source is a deadline
  -- nobody should enforce against a hospital.
  source_note                 TEXT,

  updated_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN hospital.panel_adjudication_config.claim_file_days IS
  'Days from discharge to file the claim. NULL means UNKNOWN for this panel, '
  'not unlimited — the timeliness rule is skipped rather than passed. Verified '
  'range across four TPAs: 2 to 30 days, with two self-contradicting.';

CREATE OR REPLACE FUNCTION hospital.touch_panel_adj_cfg_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_panel_adj_cfg_updated_at ON hospital.panel_adjudication_config;
CREATE TRIGGER trg_panel_adj_cfg_updated_at
  BEFORE UPDATE ON hospital.panel_adjudication_config
  FOR EACH ROW EXECUTE FUNCTION hospital.touch_panel_adj_cfg_updated_at();

-- ── B. Non-payables catalog ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.non_payable_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The item name as the circular writes it.
  item_name     VARCHAR(255) NOT NULL,

  -- 'I' optional cover · 'II' subsumed into room charges · 'III' subsumed into
  -- procedure charges · 'IV' subsumed into treatment costs.
  list_number   VARCHAR(4)   NOT NULL,

  -- Billing descriptions seen in the wild that mean this item. Learned from
  -- real bills — see the header.
  aliases       TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Panel-specific additions beyond the IRDAI lists.
  panel_id      UUID REFERENCES hospital.panels(id) ON DELETE CASCADE,

  notes         TEXT,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_npi_list CHECK (list_number IN ('I','II','III','IV','PANEL'))
);

-- A global item (panel_id NULL) is unique by name; a panel addition may repeat
-- a name the global catalog already has, which is why the key includes panel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_npi_global
  ON hospital.non_payable_items (lower(item_name))
  WHERE panel_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_npi_list ON hospital.non_payable_items (list_number) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_npi_panel ON hospital.non_payable_items (panel_id) WHERE panel_id IS NOT NULL;

COMMENT ON TABLE hospital.non_payable_items IS
  'IRDAI/HLT/REG/CIR/176/09/2019 Annexure-I, 146 items across four lists (NOT '
  'the widely-quoted 199, which traces to the superseded 2016 circular). For a '
  'network cashless claim a List II/III/IV line on the bill is an SLA breach, '
  'not just a deduction.';

COMMIT;
