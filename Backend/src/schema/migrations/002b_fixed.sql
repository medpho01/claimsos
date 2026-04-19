BEGIN;

ALTER TABLE hospital.hospitals
  ALTER COLUMN drive_folder_id DROP NOT NULL;

ALTER TABLE hospital.hospitals
  ADD COLUMN IF NOT EXISTS is_cashless_everywhere_active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS cashless_everywhere_enrollment_date DATE DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS cashless_everywhere_status VARCHAR(50) DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_hospitals_ce_active ON hospital.hospitals(is_cashless_everywhere_active);

COMMIT;
