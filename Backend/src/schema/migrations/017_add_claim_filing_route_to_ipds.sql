-- Migration 017: claim_filing_route on ipds
-- Date: 2026-05-17
-- Description:
--   Adds `claim_filing_route` to ipds. This is the *route* by which the
--   claim is submitted to the insurer — orthogonal to which insurer pays.
--
--   Values:
--     'cashless_everywhere' — hospital is NOT empanelled with this insurer;
--                              file via email through Cashless Everywhere scheme
--     'network'             — hospital IS empanelled; file via insurer's portal
--                              (RPA — coming soon)
--
--   Backfill: leaves existing rows NULL so callers can detect "unset" and
--   prompt the user. One exception: the Agar Noori test IPD is set to
--   'cashless_everywhere' for the live email send test.

BEGIN;

ALTER TABLE hospital.ipds
  ADD COLUMN IF NOT EXISTS claim_filing_route VARCHAR(40);

-- Add CHECK constraint as a separate step so the ALTER is idempotent
-- even if the column already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ipds_claim_filing_route_check'
  ) THEN
    ALTER TABLE hospital.ipds
      ADD CONSTRAINT ipds_claim_filing_route_check
      CHECK (claim_filing_route IS NULL
             OR claim_filing_route IN ('cashless_everywhere', 'network'));
  END IF;
END $$;

-- Backfill: any IPD on the CE system panel or on a panel whose
-- claim_submission_method is 'email' is presumed to be cashless_everywhere.
-- Otherwise leave NULL so the hospital admin sets it explicitly.
UPDATE hospital.ipds i
   SET claim_filing_route = 'cashless_everywhere'
  FROM hospital.hospital_panels hp
  JOIN hospital.panel_attributes pa
    ON pa.hospital_panel_id = hp.id
   AND pa.attribute_key = 'claim_submission_method'
   AND pa.value_text = 'email'
 WHERE i.hospital_panel_id = hp.id
   AND i.claim_filing_route IS NULL;

CREATE INDEX IF NOT EXISTS idx_ipds_filing_route
  ON hospital.ipds (claim_filing_route);

COMMIT;
