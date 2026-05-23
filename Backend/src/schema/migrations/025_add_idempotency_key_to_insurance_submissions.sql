-- Migration 025: idempotency_key on insurance_submissions
-- Date: 2026-05-17
-- Description:
--   Adds an idempotency_key column to insurance_submissions so the
--   /insurance/send endpoint can safely handle:
--     - Double-click on the Send button
--     - Browser/network retry that re-fires the POST after the first
--       call already succeeded
--     - Out-of-order retries from a flaky proxy
--
--   The key is generated client-side (UUID per compose-modal-open) and
--   sent in the request body. Backend checks for an existing row with
--   the same key first; if present, returns it without creating duplicates.
--
--   Existing rows have NULL — backward compatible. The UNIQUE constraint
--   ignores NULLs, so legacy rows aren't affected.

BEGIN;

ALTER TABLE hospital.insurance_submissions
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

-- Unique only over non-NULL values (Postgres treats NULLs as distinct in
-- unique indexes by default — exactly what we want for backward compat).
CREATE UNIQUE INDEX IF NOT EXISTS idx_is_idempotency_key
  ON hospital.insurance_submissions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN hospital.insurance_submissions.idempotency_key IS
  'Client-generated UUID per compose-modal-open. Prevents double-send when the same /insurance/send POST fires twice (UI double-click, network retry).';

COMMIT;
