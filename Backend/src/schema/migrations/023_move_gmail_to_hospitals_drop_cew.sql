-- Migration 023: Create hospital.hospital_interfaces, move Gmail state into it,
-- drop the CASHLESS_EVERYWHERE pseudo-panel.
-- Date: 2026-05-17
-- Description:
--   "CASHLESS_EVERYWHERE" was a fake panel that existed only to host hospital-level
--   Gmail OAuth state via panel_attributes. It was semantically wrong (a filing
--   route, not an insurer) and didn't scale — every new interface (IHX portal,
--   MediAssist portal, etc.) would have needed its own fake panel.
--
--   New model: `hospital_interfaces` is a first-class entity, one row per
--   (hospital × communication channel). Each row holds kind-specific config
--   in JSONB plus an encrypted secrets blob for OAuth tokens / portal creds.
--
--   Multiple interfaces per hospital are natively supported. Adding IHX or
--   MediAssist portal later = INSERT one row, no schema change.
--
--   Steps:
--     1) Create hospital_interfaces table.
--     2) For each hospital with existing Gmail state on a (× CEW) hospital_panels
--        row, insert one row into hospital_interfaces (kind='email').
--     3) Delete panel_attributes rows on CEW hospital_panels.
--     4) Delete CEW hospital_panels rows.
--     5) Delete the CEW row from panels.
--     6) Delete the now-orphaned panel_attribute_definitions for
--        cashless_gmail_address / cashless_gmail_oauth_payload /
--        cashless_gmail_watch_state.
--
--   Reversibility: encrypted OAuth tokens migrate intact (same AES-GCM ENC_KEY).
--   If anything goes wrong, hospital admin reconnects Gmail via the existing
--   Insurance Interfaces page.

BEGIN;

-- ─── 1) Create hospital_interfaces ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.hospital_interfaces (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id         UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  kind                VARCHAR(20) NOT NULL CHECK (kind IN ('email', 'portal')),
  name                VARCHAR(100) NOT NULL,
  status              VARCHAR(30) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'disconnected', 'token_expired', 'error', 'pending')),
  -- Kind-specific non-secret state. Email example:
  --   {gmail_address, history_id, last_polled_at_ms, poll_status}
  -- Portal example (future):
  --   {base_url, username, two_fa_method, ...}
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- AES-256-GCM-encrypted secrets blob — OAuth tokens for email, password +
  -- 2FA seed for portal. Encrypted with same ENC_KEY as everywhere else.
  secrets_encrypted   TEXT,
  last_polled_at      TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hospital_id, name)
);

CREATE INDEX IF NOT EXISTS idx_hi_hospital_kind
  ON hospital.hospital_interfaces (hospital_id, kind);

-- updated_at trigger
DROP TRIGGER IF EXISTS hospital_interfaces_set_updated_at ON hospital.hospital_interfaces;
CREATE TRIGGER hospital_interfaces_set_updated_at
  BEFORE UPDATE ON hospital.hospital_interfaces
  FOR EACH ROW EXECUTE FUNCTION hospital.update_modified_column();

COMMENT ON TABLE  hospital.hospital_interfaces IS 'Communication channels (email mailboxes, insurer portals) a hospital uses. One row per (hospital × interface).';
COMMENT ON COLUMN hospital.hospital_interfaces.kind   IS 'Discriminator: email (Gmail/IMAP) or portal (web).';
COMMENT ON COLUMN hospital.hospital_interfaces.name   IS 'Human-readable label, e.g. "Primary CEW Gmail", "IHX Portal".';
COMMENT ON COLUMN hospital.hospital_interfaces.config IS 'Kind-specific non-secret state (gmail_address, history_id, etc.).';
COMMENT ON COLUMN hospital.hospital_interfaces.secrets_encrypted IS 'AES-256-GCM ciphertext: OAuth tokens or portal passwords.';

-- ─── 2) Migrate existing Gmail state from (× CEW) panel_attributes ────────
-- Build one row per (hospital, attribute_key) and pivot into hospital_interfaces.
INSERT INTO hospital.hospital_interfaces
  (hospital_id, kind, name, status, config, secrets_encrypted, last_polled_at, last_error)
SELECT
  hp.hospital_id,
  'email'::varchar AS kind,
  'Primary CEW Gmail'::varchar AS name,
  -- Map legacy GmailWatchState enum to the new interface-level status enum.
  -- Legacy: valid | expired | revoked | error | unknown
  -- New:    active | token_expired | disconnected | error | pending
  CASE COALESCE(ws.value_json ->> 'status', 'unknown')
    WHEN 'valid'   THEN 'active'
    WHEN 'expired' THEN 'token_expired'
    WHEN 'revoked' THEN 'disconnected'
    WHEN 'error'   THEN 'error'
    ELSE                'pending'
  END AS status,
  jsonb_strip_nulls(
    jsonb_build_object(
      'gmail_address',   addr.value_text,
      'history_id',      ws.value_json ->> 'history_id',
      'poll_status',     ws.value_json ->> 'status',
      'last_error',      ws.value_json ->> 'last_error'
    )
  ) AS config,
  oauth.value_encrypted AS secrets_encrypted,
  CASE
    WHEN (ws.value_json ->> 'last_verified_at') ~ '^[0-9]+$'
    THEN to_timestamp((ws.value_json ->> 'last_verified_at')::bigint / 1000.0)
    ELSE NULL
  END AS last_polled_at,
  ws.value_json ->> 'last_error' AS last_error
FROM hospital.hospital_panels hp
JOIN hospital.panels pn ON pn.id = hp.panel_id
LEFT JOIN hospital.panel_attributes addr
       ON addr.hospital_panel_id = hp.id AND addr.attribute_key = 'cashless_gmail_address'
LEFT JOIN hospital.panel_attributes oauth
       ON oauth.hospital_panel_id = hp.id AND oauth.attribute_key = 'cashless_gmail_oauth_payload'
LEFT JOIN hospital.panel_attributes ws
       ON ws.hospital_panel_id = hp.id AND ws.attribute_key = 'cashless_gmail_watch_state'
WHERE pn.code = 'CASHLESS_EVERYWHERE'
  -- Skip hospitals that never connected (would create an empty interface row)
  AND (addr.value_text IS NOT NULL OR oauth.value_encrypted IS NOT NULL)
ON CONFLICT (hospital_id, name) DO NOTHING;

-- ─── 3) Delete panel_attributes on CEW hospital_panels ────────────────────
DELETE FROM hospital.panel_attributes pa
  USING hospital.hospital_panels hp
        JOIN hospital.panels pn ON pn.id = hp.panel_id
 WHERE pa.hospital_panel_id = hp.id
   AND pn.code = 'CASHLESS_EVERYWHERE';

-- ─── 4) Delete CEW hospital_panels rows ────────────────────────────────────
DELETE FROM hospital.hospital_panels hp
 USING hospital.panels pn
 WHERE pn.id = hp.panel_id
   AND pn.code = 'CASHLESS_EVERYWHERE';

-- ─── 5) Delete the CEW row from panels ────────────────────────────────────
DELETE FROM hospital.panels WHERE code = 'CASHLESS_EVERYWHERE';

-- ─── 6) Delete now-orphaned panel_attribute_definitions ───────────────────
DELETE FROM hospital.panel_attribute_definitions
 WHERE key IN ('cashless_gmail_address', 'cashless_gmail_oauth_payload', 'cashless_gmail_watch_state');

COMMIT;
