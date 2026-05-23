-- Migration 024: IPD lifecycle stage
-- Date: 2026-05-17
-- Description:
--   Adds a `stage` column on hospital.ipds that tracks where the patient/claim
--   is in its lifecycle (Draft → Pre-auth → Admitted → Discharge → Claim).
--
--   The set of valid values is curated in hospital.master_options under
--   category='ipd_stage' so superadmins can add/rename stages without code
--   changes. The column itself is a free-text VARCHAR(40) (no FK / CHECK) —
--   trust the master_options catalog as source of truth.
--
--   New IPDs default to 'Draft'. Existing rows stay NULL (no automated
--   backfill — ops manually sets each as they touch them).

BEGIN;

-- 1) Column on ipds
ALTER TABLE hospital.ipds
  ADD COLUMN IF NOT EXISTS stage VARCHAR(40);

COMMENT ON COLUMN hospital.ipds.stage IS
  'Current lifecycle stage. Values curated in master_options(category=ipd_stage).';

CREATE INDEX IF NOT EXISTS idx_ipds_stage ON hospital.ipds (stage);

-- 2) Seed master_options with the 19 stage values
INSERT INTO hospital.master_options (category, code, label, description, sort_order, is_active) VALUES
  ('ipd_stage', 'draft',                          'Draft',                            'Initial state — patient added, no insurer interaction yet', 10,  TRUE),
  ('ipd_stage', 'preauth_submitted',              'Pre-auth Submitted',               'Pre-auth email sent to insurer',                          20,  TRUE),
  ('ipd_stage', 'preauth_queried',                'Pre-auth Queried',                 'Insurer raised a query on the pre-auth',                  30,  TRUE),
  ('ipd_stage', 'preauth_query_responded',        'Pre-auth Query Responded',         'Hospital responded to insurer query',                     40,  TRUE),
  ('ipd_stage', 'preauth_approved',               'Pre-auth Approved',                'Insurer approved the pre-auth',                           50,  TRUE),
  ('ipd_stage', 'admitted',                       'Admitted',                         'Patient admitted post pre-auth approval',                 60,  TRUE),
  ('ipd_stage', 'enhancements_submitted',         'Enhancements Submitted',           'Enhancement request sent (extra days / coverage)',        70,  TRUE),
  ('ipd_stage', 'enhancements_queried',           'Enhancements Queried',             'Insurer queried the enhancement request',                 80,  TRUE),
  ('ipd_stage', 'enhancements_query_responded',   'Enhancements Query Responded',     'Hospital responded to enhancement query',                 90,  TRUE),
  ('ipd_stage', 'discharge_draft',                'Discharge Draft',                  'Discharge being prepared',                                100, TRUE),
  ('ipd_stage', 'discharge_submitted',            'Discharge Submitted',              'Discharge intimation sent to insurer',                    110, TRUE),
  ('ipd_stage', 'discharge_queried',              'Discharge Queried',                'Insurer queried the discharge submission',                120, TRUE),
  ('ipd_stage', 'discharge_query_responded',      'Discharge Query Responded',        'Hospital responded to discharge query',                   130, TRUE),
  ('ipd_stage', 'discharge_approved',             'Discharge Approved',               'Insurer approved discharge',                              140, TRUE),
  ('ipd_stage', 'discharged',                     'Discharged',                       'Patient discharged',                                      150, TRUE),
  ('ipd_stage', 'claim_filed',                    'Claim Filed',                      'Final claim submitted to insurer',                        160, TRUE),
  ('ipd_stage', 'claim_queried',                  'Claim Queried',                    'Insurer queried the final claim',                         170, TRUE),
  ('ipd_stage', 'claim_query_responded',          'Claim Query Responded',            'Hospital responded to final-claim query',                 180, TRUE),
  ('ipd_stage', 'claim_approved',                 'Claim Approved',                   'Insurer approved/settled the final claim',                190, TRUE)
ON CONFLICT (category, code) DO NOTHING;

COMMIT;
