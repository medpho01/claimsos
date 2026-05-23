-- Migration 027: submission_events audit log + interface_id panel attribute
-- Date: 2026-05-17
--
-- A2 — submission_events: append-only log of every state transition on an
--      insurance_submission (drafted → queued → sending → sent | failed),
--      plus stage changes on the parent IPD. Replaces "reconstruct from app
--      logs" with a queryable history. Powers the audit-trail UI (P6).
--
-- A5 — interface_id panel attribute: links a (hospital × insurer) to which
--      hospital_interfaces row carries its email. Today the code picks "first
--      email interface for this hospital" implicitly — fine while there's only
--      one. The moment IHX portal lands or a hospital has two Gmails, this
--      attribute becomes the authoritative routing.
--
-- A7 (code-only): stage-aware notification titles read patient.stage —
--      no schema needed.

BEGIN;

-- ─── A2: submission_events ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.submission_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurance_submission_id  UUID NOT NULL REFERENCES hospital.insurance_submissions(id) ON DELETE CASCADE,
  ipd_id                   UUID REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  hospital_id              UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  -- High-level event kind. Open enum, controlled by app code:
  --   'drafted' | 'queued' | 'sending' | 'sent' | 'failed' | 'replayed'
  --   'stage_changed' | 'inbound_matched' | 'inbound_unmatched'
  --   'notification_sent' | 'notification_failed'
  event_type               VARCHAR(40) NOT NULL,
  -- Free-form payload — event-kind specific:
  --   'stage_changed':       { from, to, by }
  --   'sent':                { gmail_message_id, gmail_thread_id, sent_at }
  --   'failed':              { failure_reason, attempts }
  --   'inbound_matched':     { inbound_id, match_method, confidence }
  --   'notification_sent':   { whatsapp_group_id }
  payload                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Who or what triggered it (user UUID, 'system', 'worker', etc.)
  actor                    VARCHAR(64),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_se_submission ON hospital.submission_events (insurance_submission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_se_ipd        ON hospital.submission_events (ipd_id, created_at);
CREATE INDEX IF NOT EXISTS idx_se_type       ON hospital.submission_events (event_type, created_at);

COMMENT ON TABLE hospital.submission_events IS 'Append-only audit log of every lifecycle event on an insurance_submission. Source of truth for "what happened when, by whom?" — feeds the patient-detail audit trail UI.';

-- ─── A5: interface_id panel attribute ─────────────────────────────────────
-- New panel_attribute_definition with data_type='single_select'. Options are
-- resolved at FE/BE read time against hospital.hospital_interfaces — the
-- meta-system doesn't enforce FKs to non-master tables, that's app-level.
INSERT INTO hospital.panel_attribute_definitions
  (key, label, data_type, category, is_required, sort_order, description)
VALUES (
  'interface_id',
  'Comms Interface',
  'single_select',
  'operational',
  FALSE,
  58, -- before is_empanelled (sort_order 59) so it groups with routing config
  'Which hospital_interfaces row handles email/portal for this insurer. When NULL, code falls back to "first email interface for this hospital" (compatibility default).'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
