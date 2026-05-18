-- Migration 034: Loosen submission_events.insurance_submission_id
--
-- Background
-- ----------
-- Migration 027 created hospital.submission_events with
--     insurance_submission_id UUID NOT NULL REFERENCES hospital.insurance_submissions(id) ON DELETE CASCADE
-- back when each event corresponded 1:1 to a submission (filing).
--
-- Wave 1 reframed the canonical "claim" grain to hospital.ipds(id) (one
-- patient admission, accumulating state across many submissions). Wave 1A's
-- eventDispatcher therefore writes the IPD id into BOTH the new claim_id
-- column (added in 030) AND the legacy insurance_submission_id column for
-- backward compatibility with the NOT NULL constraint.
--
-- Problem: that write violates the FK to insurance_submissions(id) — an IPD
-- id has no row there. Every dispatcher-emitted event (ai_draft_created,
-- doc_segmented, section_classified, section_extracted, stage_transitioned,
-- query_raised, query_resolved, claim_action_*, adjudication_run, etc.)
-- would fail at INSERT time.
--
-- This migration removes both constraints (FK + NOT NULL). The column
-- remains for backward compatibility with legacy writers (real submission
-- events still populate it with a valid insurance_submission id), but
-- dispatcher-emitted events can now safely leave it as the IPD id or NULL.
--
-- A future migration may rename the column to a generic claim_object_id
-- and drop it entirely once all readers move to using claim_id (the IPD id)
-- as their primary join key.

BEGIN;

-- Drop the FK constraint. Pg auto-named it
-- submission_events_insurance_submission_id_fkey. Use IF EXISTS so re-runs
-- are safe.
ALTER TABLE hospital.submission_events
    DROP CONSTRAINT IF EXISTS submission_events_insurance_submission_id_fkey;

-- Loosen NOT NULL so dispatcher-emitted events can write NULL when no
-- specific insurance_submission is in play (e.g. doc_uploaded events
-- attached to an IPD before any filing exists).
ALTER TABLE hospital.submission_events
    ALTER COLUMN insurance_submission_id DROP NOT NULL;

-- Update the column comment to document the new semantics.
COMMENT ON COLUMN hospital.submission_events.insurance_submission_id IS
'Legacy column. Was: required FK to insurance_submissions(id). Now: nullable, no FK. Real submission-event writers (drafting/queueing/sending a filing) continue to populate this with a real insurance_submission id; dispatcher-emitted events (Wave 1+) populate claim_id (an IPD id) instead. To be deprecated in favour of claim_id once all readers migrate.';

COMMIT;
