-- Add banking/payment details fields to hospital_profile table
-- These fields store payment and bank information for hospital transactions

ALTER TABLE hospital.hospital_profile
  ADD COLUMN IF NOT EXISTS cheque_payable_name TEXT,
  ADD COLUMN IF NOT EXISTS bank_name TEXT,
  ADD COLUMN IF NOT EXISTS bank_branch TEXT,
  ADD COLUMN IF NOT EXISTS bank_address TEXT,
  ADD COLUMN IF NOT EXISTS account_type TEXT,
  ADD COLUMN IF NOT EXISTS account_number TEXT,
  ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(11),
  ADD COLUMN IF NOT EXISTS pan_name TEXT,
  ADD COLUMN IF NOT EXISTS micr_code VARCHAR(9);

-- The account_type CHECK has to live outside ADD COLUMN: when the column
-- already exists, ADD COLUMN IF NOT EXISTS skips the whole clause and an
-- inline CHECK would silently be lost on that path. Naming it also makes it
-- droppable and probeable. Guard is conrelid-scoped so an identically named
-- constraint on another relation cannot mask it.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'hospital'
       AND t.relname = 'hospital_profile'
       AND c.conname = 'hospital_profile_account_type_check'
  ) THEN
    ALTER TABLE hospital.hospital_profile
      ADD CONSTRAINT hospital_profile_account_type_check
      CHECK (account_type IN ('savings', 'current', 'nri'));
  END IF;
END $$;

-- Add comments for clarity
COMMENT ON COLUMN hospital.hospital_profile.cheque_payable_name IS 'Name to be used on cheques';
COMMENT ON COLUMN hospital.hospital_profile.bank_name IS 'Name of the bank';
COMMENT ON COLUMN hospital.hospital_profile.bank_branch IS 'Bank branch name or location';
COMMENT ON COLUMN hospital.hospital_profile.bank_address IS 'Full address of the bank branch';
COMMENT ON COLUMN hospital.hospital_profile.account_type IS 'Type of bank account: savings, current, or nri';
COMMENT ON COLUMN hospital.hospital_profile.account_number IS 'Bank account number';
COMMENT ON COLUMN hospital.hospital_profile.ifsc_code IS 'IFSC code (11 characters)';
COMMENT ON COLUMN hospital.hospital_profile.pan_name IS 'Name as it appears on PAN card';
COMMENT ON COLUMN hospital.hospital_profile.micr_code IS 'MICR code (9 characters)';
