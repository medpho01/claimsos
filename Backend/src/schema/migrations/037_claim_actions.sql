-- Migration 037: Claim Actions (Sprint 3, Wave 3C — Action Engine)
-- Date: 2026-05-18
--
-- The Action Engine consumes AdjudicationReports produced by the Adjudication
-- Engine (Wave 3B) and turns "recommended_action + blocking_gaps" into
-- concrete, dispatchable units of work (Kratika's inbox + WhatsApp pings to
-- panel groups). Each unit is a row in hospital.claim_actions.
--
-- Why one table for both WhatsApp and in-app:
--
--   * The lifecycle is identical — pending → dispatched → acked/declined.
--     Splitting by transport (claim_actions_whatsapp + claim_actions_inapp)
--     would duplicate state machinery; the dispatcher branches on
--     `target_kind` at delivery time and writes back to the same row.
--
--   * The FE's "Action Queue" (Kratika's inbox) needs a single list view
--     across transports — "show me everything pending for this user" — and
--     a UNION on two tables would lose query planner sympathy on the
--     status filter.
--
--   * Idempotency. Re-running adjudication for the same claim mustn't spam
--     the panel group with the same "missing discharge summary" message.
--     The partial UNIQUE (claim_id, idempotency_key) lets the engine compute
--     a deterministic key (hash of claim + kind + target + gap) and use
--     ON CONFLICT DO NOTHING to swallow duplicates cheaply.
--
-- One transaction; all DDL is idempotent (IF NOT EXISTS).

BEGIN;

-- ============================================================================
-- A. hospital.claim_actions
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.claim_actions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Canonical claim grain: hospital.ipds.id. ON DELETE CASCADE because if
  -- the claim is hard-deleted, its outstanding actions are no longer
  -- meaningful (in practice we soft-delete claims, but the FK matters for
  -- test fixtures + future cleanup tooling).
  claim_id             UUID NOT NULL
                       REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- 'request_doc' | 'notify_ops' | 'approval_request' | 'follow_up_sla'.
  -- VARCHAR rather than enum so adding kinds in future migrations is a
  -- one-line change.
  kind                 VARCHAR(64) NOT NULL,

  -- Routing — how to deliver this action.
  --   'whatsapp_group' → target_value = whatsapp group id (UltraMsg chat id)
  --   'whatsapp_user'  → target_value = E.164 phone number
  --   'in_app_user'    → target_value = user id (also written to target_user_id)
  --   'in_app_role'    → target_value = role name ('ops_head', 'approver', ...)
  target_kind          VARCHAR(32) NOT NULL,
  target_value         VARCHAR(255) NOT NULL,

  -- Denormalised pointer to the user when target_kind = 'in_app_user'.
  -- Lets us index "pending actions for user X" cheaply. NULL for the
  -- WhatsApp / role variants. NOT a FK — users live in a different schema
  -- and the FK churn isn't worth the referential strictness here.
  target_user_id       UUID,

  -- Free-form payload: { title, summary, deep_link, ...kind-specific }.
  -- The dispatcher renders this into the WhatsApp body / in-app card.
  payload              JSONB NOT NULL,

  -- Lifecycle. 'pending' = inserted, not yet dispatched.
  --            'dispatched' = delivered (WhatsApp sent / in-app row written).
  --            'acked' = user acknowledged / approved.
  --            'declined' = user rejected with a reason.
  --            'expired' = SLA passed without a response.
  --            'failed' = dispatch hit a terminal error after retries.
  status               VARCHAR(32) NOT NULL DEFAULT 'pending',

  -- Who decided this action should exist. 'adjudication_engine' = system,
  -- 'manual' = a human created it through the future UI. source_report_id
  -- points at the AdjudicationReport when source = 'adjudication_engine'.
  source               VARCHAR(64) NOT NULL,
  source_report_id     UUID,

  -- Dedup key — computed by the engine as
  --   sha256(claim_id + kind + target_value + gap_or_warning_id).
  -- NULL allowed for manually-authored actions (no dedup needed).
  -- The partial UNIQUE index below enforces uniqueness only when set.
  idempotency_key      VARCHAR(128),

  -- Dispatch / ack bookkeeping. Nullable until the relevant transition.
  dispatched_at        TIMESTAMP,
  acked_at             TIMESTAMP,
  acked_by             UUID,
  ack_response         JSONB,
  declined_at          TIMESTAMP,
  declined_by          UUID,
  decline_reason       TEXT,
  dispatch_error       TEXT,

  created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_claim_actions_kind
    CHECK (kind IN ('request_doc','notify_ops','approval_request','follow_up_sla')),
  CONSTRAINT chk_claim_actions_target_kind
    CHECK (target_kind IN ('whatsapp_group','whatsapp_user','in_app_user','in_app_role')),
  CONSTRAINT chk_claim_actions_status
    CHECK (status IN ('pending','dispatched','acked','declined','expired','failed'))
);

-- ---- Indexes --------------------------------------------------------------
-- Drive the three hot reads:
--   1. "All actions for this claim" — claim detail / dossier rollup.
--   2. "All pending actions of a given kind" — engine retry sweeps.
--   3. "My inbox" — Kratika's action queue for the logged-in user.

CREATE INDEX IF NOT EXISTS idx_claim_actions_claim
  ON hospital.claim_actions (claim_id);

CREATE INDEX IF NOT EXISTS idx_claim_actions_status_kind
  ON hospital.claim_actions (status, kind);

CREATE INDEX IF NOT EXISTS idx_claim_actions_pending_user
  ON hospital.claim_actions (target_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_claim_actions_user_recent
  ON hospital.claim_actions (target_user_id, created_at DESC);

-- Partial UNIQUE for idempotency: same (claim, key) cannot be inserted
-- twice. Re-runs of adjudication that produce the same recommendation
-- collapse silently via ON CONFLICT DO NOTHING in the engine.
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_actions_claim_idempotency
  ON hospital.claim_actions (claim_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON TABLE hospital.claim_actions IS
  'Concrete units of work produced by the Action Engine. One row per (claim, recommendation, target). Lifecycle: pending → dispatched → acked|declined|expired|failed.';

COMMIT;
