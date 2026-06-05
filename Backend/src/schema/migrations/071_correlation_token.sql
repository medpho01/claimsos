-- Migration 071: VERP correlation token on IPDs
-- Date: 2026-06-03
-- Description:
--   Adds `ipds.correlation_token` — a short, opaque, per-claim code used for
--   Reply-To plus-addressing (VERP). Outbound insurer emails set
--     Reply-To: <gmail-local>+<correlation_token>@<gmail-domain>
--   so that when the insurer replies — in ANY thread, with ANY subject — the
--   reply lands at our inbox with the token in the To/Delivered-To header.
--   The inbound matcher parses it back to the IPD (~0.97 confidence).
--
--   Opaque (not the raw IPD uuid) so we don't leak internal ids into insurer
--   inboxes and can rotate if needed. Minted lazily on first outbound.

BEGIN;

ALTER TABLE hospital.ipds
  ADD COLUMN IF NOT EXISTS correlation_token text;

-- Unique so a parsed token resolves to exactly one claim. Partial index so
-- the many NULLs (pre-token claims) don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS ipds_correlation_token_key
  ON hospital.ipds (correlation_token)
  WHERE correlation_token IS NOT NULL;

COMMIT;
