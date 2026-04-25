-- Add banking/payment details fields to hospital_profile table
-- These fields store payment and bank information for hospital transactions

ALTER TABLE hospital.hospital_profile ADD COLUMN cheque_payable_name TEXT;
ALTER TABLE hospital.hospital_profile ADD COLUMN bank_name TEXT;
ALTER TABLE hospital.hospital_profile ADD COLUMN bank_branch TEXT;
ALTER TABLE hospital.hospital_profile ADD COLUMN bank_address TEXT;
ALTER TABLE hospital.hospital_profile ADD COLUMN account_type TEXT CHECK (account_type IN ('savings', 'current', 'nri'));
ALTER TABLE hospital.hospital_profile ADD COLUMN account_number TEXT;
ALTER TABLE hospital.hospital_profile ADD COLUMN ifsc_code VARCHAR(11);
ALTER TABLE hospital.hospital_profile ADD COLUMN pan_name TEXT;
ALTER TABLE hospital.hospital_profile ADD COLUMN micr_code VARCHAR(9);

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
