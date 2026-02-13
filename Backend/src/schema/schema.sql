-- Enable UUID extension for generating IDs
SET search_path TO hospital, public;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Generic Function to automatically update 'updated_at' timestamp
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW(); -- Automatically sets updated_at to current timestamp
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255),
    username VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone CHAR(10),
    is_active BOOLEAN DEFAULT TRUE,
    role VARCHAR(255),
    last_login TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Trigger to update 'updated_at'
CREATE TRIGGER update_user_modtime BEFORE UPDATE ON "users" FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

CREATE TABLE IF NOT EXISTS user_refresh_tokens (
    user_id UUID REFERENCES "users"(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (user_id, token_hash)
);


CREATE TABLE IF NOT EXISTS hospitals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    city VARCHAR(255),
    drive_folder_id VARCHAR NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER update_hospital_modtime BEFORE UPDATE ON hospitals FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

CREATE TABLE IF NOT EXISTS panels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER update_panel_modtime BEFORE UPDATE ON panels FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

CREATE TABLE IF NOT EXISTS hospital_panels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
    panel_id UUID REFERENCES panels(id) ON DELETE CASCADE,
    whatsapp_group_id VARCHAR(255),
    sheet_id VARCHAR(255),
   sheet_name VARCHAR(255),
    drive_folder_id VARCHAR(255),
    contact CHAR(10)
);



CREATE TABLE IF NOT EXISTS hospital_assignments (
    hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
    admin_id UUID REFERENCES "users"(id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES "users"(id) ON DELETE SET NULL,
    can_view BOOLEAN DEFAULT TRUE,
    can_edit BOOLEAN DEFAULT FALSE,
    can_discharge BOOLEAN DEFAULT FALSE,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    role TEXT[], -- Array of text for multiple roles
    PRIMARY KEY (hospital_id, admin_id)
);

CREATE TABLE IF NOT EXISTS hospital_users (
    hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
    user_id UUID REFERENCES "users"(id) ON DELETE CASCADE,
    role TEXT[],
    PRIMARY KEY (hospital_id, user_id)
);




CREATE TABLE IF NOT EXISTS ipds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255),
    phone CHAR(10),
    admission_type varchar(255),
    admitted_at TIMESTAMP WITH TIME ZONE,
    discharged_at TIMESTAMP WITH TIME ZONE,
    stay JSONB, -- JSONB is preferred over JSON for indexing and speed
    hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
    drive_folder_id VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    beneficiary_id VARCHAR(255),
    panel_id UUID REFERENCES panels(id) ON DELETE SET NULL,
    hospital_panel_id UUID REFERENCES hospital_panels(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER update_ipds_modtime BEFORE UPDATE ON ipds FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

CREATE TABLE IF NOT EXISTS claims (
    ipd_id UUID REFERENCES ipds(id) ON DELETE CASCADE PRIMARY KEY,
    treatment_plan TEXT,
    latest_status TEXT,
    claim_amount DOUBLE PRECISION,
    claim_approved DOUBLE PRECISION,
    incentive DOUBLE PRECISION,
    deduction DOUBLE PRECISION,
    deduction_reason TEXT,
    claim_settled DOUBLE PRECISION,
    claim_settled_date DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER update_claims_modtime BEFORE UPDATE ON claims FOR EACH ROW EXECUTE PROCEDURE update_modified_column();


-- User Lookups
CREATE INDEX IF NOT EXISTS idx_user_email ON "users"(email);
CREATE INDEX IF NOT EXISTS idx_user_username ON "users"(username);


-- Join Optimization for Assignments
CREATE INDEX IF NOT EXISTS idx_hosp_assign_admin ON hospital_assignments(admin_id);
CREATE INDEX IF NOT EXISTS idx_hosp_assign_hospital ON hospital_assignments(hospital_id);

-- Join Optimization for Panels
CREATE INDEX IF NOT EXISTS idx_hp_hospital_id ON hospital_panels(hospital_id);
CREATE INDEX IF NOT EXISTS idx_hp_panel_id ON hospital_panels(panel_id);

-- IPD / Patient Search Optimization
CREATE INDEX IF NOT EXISTS idx_ipds_hospital_id ON ipds(hospital_id);
CREATE INDEX IF NOT EXISTS idx_ipds_panel_id ON ipds(panel_id);
CREATE INDEX IF NOT EXISTS idx_ipds_phone ON ipds(phone); -- Fast patient lookup by phone
CREATE INDEX IF NOT EXISTS idx_ipds_admitted_at ON ipds(admitted_at); -- For sorting by admission date
CREATE INDEX IF NOT EXISTS idx_ipds_is_active ON ipds(is_active); -- For filtering active patients

-- Claims Reporting
CREATE INDEX IF NOT EXISTS idx_claims_settled_date ON claims(claim_settled_date);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(latest_status);

-- IPD Documents Table 
CREATE TABLE IF NOT EXISTS ipd_doc (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ipd_id UUID REFERENCES ipds(id) ON DELETE CASCADE,  -- Patient ID
    drive_link TEXT,                                    -- Google Drive share link (backup storage)
    s3_key VARCHAR(500),                                -- S3 object key: hospital_id/panel_id/patient_id/type/timestamp_filename
    s3_link TEXT,                                       -- Full S3 HTTPS URL (not presigned)
    type VARCHAR(255),                                  -- Document category: discharge_slip, investigations, treatment, etc.
    file_name VARCHAR(500),                             -- Original filename
    file_size INTEGER,                                  -- File size in bytes
    mime_type VARCHAR(100),                             -- MIME type: image/jpeg, application/pdf, etc.
    storage_provider VARCHAR(10) DEFAULT 's3',          -- Primary storage: 's3' or 'drive'
    drive_backup_status VARCHAR(20) DEFAULT 'pending',  -- Backup status: 'pending', 'processing', 'completed', 'failed'
    drive_backup_attempts INT DEFAULT 0,                -- Number of backup retry attempts (max 3)
    drive_backup_error TEXT,                            -- Error message if backup failed
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER update_ipd_doc_modtime BEFORE UPDATE ON ipd_doc FOR EACH ROW EXECUTE PROCEDURE update_modified_column();


CREATE INDEX IF NOT EXISTS idx_ipd_doc_ipd_id ON ipd_doc(ipd_id);                                          -- Fast lookup by patient
CREATE INDEX IF NOT EXISTS idx_ipd_doc_storage_provider ON ipd_doc(storage_provider);                      -- Filter by storage type
CREATE INDEX IF NOT EXISTS idx_ipd_doc_type ON ipd_doc(type);                                              -- Filter by document type
CREATE INDEX IF NOT EXISTS idx_ipd_doc_drive_backup_status ON ipd_doc(drive_backup_status)                 -- Worker queue optimization
    WHERE drive_backup_status IN ('pending', 'failed');
