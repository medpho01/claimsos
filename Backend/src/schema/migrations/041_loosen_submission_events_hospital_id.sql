-- Migration 041: Loosen submission_events.hospital_id
--
-- Same family of fix as 034: legacy submission_events.hospital_id is NOT NULL,
-- but dispatcher-emitted intelligence events (adjudication_run,
-- section_classified, etc.) sometimes don't carry a hospital_id at the call
-- site — the engine has claim_id (an IPD id) but resolving hospital_id
-- requires a JOIN to ipds that we'd prefer to avoid on every event write.
--
-- Drop the NOT NULL. The column still gets populated for legacy submission
-- events (real outbound filings) where it's known at call-time; dispatcher-
-- emitted events leave it NULL. Reader-side code that needs hospital_id
-- resolves via ipds.

BEGIN;

ALTER TABLE hospital.submission_events
    ALTER COLUMN hospital_id DROP NOT NULL;

COMMENT ON COLUMN hospital.submission_events.hospital_id IS
'Optional. Real submission events (outbound filings) populate this; dispatcher-emitted intelligence events (Wave 1+) may leave it NULL. Resolve via JOIN to hospital.ipds when needed.';

COMMIT;
