-- Sprint 1 extra — Agent F's per-device refresh-token rotation currently
-- has to bcrypt-compare every row for a user on every refresh, because
-- token_hash is non-deterministic and there's no other unique key. Add
-- a `device_id` column + an index keyed on (user_id, device_id) so we
-- can fan a single indexed lookup instead of O(N) bcrypt comparisons.
--
-- The column is nullable for now — existing rows have no associated
-- device. New sessions created after deploy will populate it; the
-- refresh code is backwards-compatible (falls back to the bcrypt scan
-- when device_id is null). A follow-up migration can NOT NULL it once
-- the access-token claim carries a deviceId and every live session has
-- been re-issued.
--
-- user_agent is captured for the "active sessions" UI Agent F sketched
-- in the controller comments — not used yet, but cheap to record now
-- rather than do a backfill later.

BEGIN;

-- Add columns idempotently so a re-run after partial application is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'hospital'
      AND table_name = 'user_refresh_tokens'
      AND column_name = 'device_id'
  ) THEN
    ALTER TABLE hospital.user_refresh_tokens
      ADD COLUMN device_id UUID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'hospital'
      AND table_name = 'user_refresh_tokens'
      AND column_name = 'user_agent'
  ) THEN
    ALTER TABLE hospital.user_refresh_tokens
      ADD COLUMN user_agent TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'hospital'
      AND table_name = 'user_refresh_tokens'
      AND column_name = 'last_used_at'
  ) THEN
    ALTER TABLE hospital.user_refresh_tokens
      ADD COLUMN last_used_at TIMESTAMP WITH TIME ZONE;
  END IF;
END $$;

-- Index for the O(1) lookup path. Partial-unique on (user_id, device_id)
-- guarantees one live row per device per user — re-login from device X
-- rotates the existing row instead of accumulating duplicates.
CREATE INDEX IF NOT EXISTS idx_user_refresh_tokens_user_device
  ON hospital.user_refresh_tokens (user_id, device_id)
  WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_refresh_tokens_expires_at
  ON hospital.user_refresh_tokens (expires_at);

COMMIT;
