-- =============================================================================
-- 000_genesis — the bootstrap schema every later migration depends on
--
-- THIS FILE IS THE GENESIS. It is the authoritative, executable definition of
-- the 13 core tables and update_modified_column(). Backend/src/schema/schema.sql
-- is retained ONLY as human documentation and is no longer applied by any
-- automated path — `npm run migrate:up` never reads it.
--
-- Why it exists: 001_add_s3_support.sql attaches a trigger that calls
-- update_modified_column(), and 002_core_fixed.sql FKs to hospital.hospitals /
-- hospital.ipds. Both objects were only ever created by schema.sql, which the
-- runner never executed — so `migrate:up` against an empty database died at
-- migration 001. Production's schema came from a dump and already has every
-- object below, which is why run-migrations.cjs stamps this file as
-- already-applied on any database with a non-empty ledger instead of running it.
--
-- Every statement here is idempotent (guarded CREATE / DROP+CREATE trigger
-- pairs), so executing it against a populated database would also be safe.
--
-- Mirrored from schema.sql. Do not edit one without mirroring into the other.
-- =============================================================================

-- node-pg-migrate's `--schema hospital` sets search_path to `hospital` ONLY.
-- Genesis needs `public` on the path too so uuid_generate_v4() resolves no
-- matter which schema uuid-ossp landed in. LOCAL keeps this transaction-scoped
-- rather than leaking into the whole session for every later migration.
SET LOCAL search_path TO hospital, public;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
-- pgcrypto: 010:96 needs gen_random_uuid() and 006:18 uses it BEFORE 010 runs.
-- On PG13+ gen_random_uuid() is built into pg_catalog, but declaring the
-- extension here removes the server-version dependency. WITH SCHEMA is ignored
-- when the extension already exists, so this is safe on an existing database.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- Generic function to automatically update 'updated_at' timestamps.
-- Schema-qualified: 013:54 and friends call it as hospital.update_modified_column(),
-- 001:13 calls it bare — both resolve with search_path = hospital, public.
CREATE OR REPLACE FUNCTION hospital.update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW(); -- Automatically sets updated_at to current timestamp
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TABLE IF NOT EXISTS hospital.users (
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
DROP TRIGGER IF EXISTS update_user_modtime ON hospital.users;
CREATE TRIGGER update_user_modtime BEFORE UPDATE ON hospital.users
  FOR EACH ROW EXECUTE PROCEDURE hospital.update_modified_column();

CREATE TABLE IF NOT EXISTS hospital.user_refresh_tokens (
    user_id UUID REFERENCES hospital.users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (user_id, token_hash)
);

CREATE TABLE IF NOT EXISTS hospital.hospitals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    city VARCHAR(255),
    drive_folder_id VARCHAR NOT NULL,
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_hospital_modtime ON hospital.hospitals;
CREATE TRIGGER update_hospital_modtime BEFORE UPDATE ON hospital.hospitals
  FOR EACH ROW EXECUTE PROCEDURE hospital.update_modified_column();

CREATE TABLE IF NOT EXISTS hospital.panels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_panel_modtime ON hospital.panels;
CREATE TRIGGER update_panel_modtime BEFORE UPDATE ON hospital.panels
  FOR EACH ROW EXECUTE PROCEDURE hospital.update_modified_column();

CREATE TABLE IF NOT EXISTS hospital.hospital_panels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hospital_id UUID REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
    panel_id UUID REFERENCES hospital.panels(id) ON DELETE CASCADE,
    whatsapp_group_id VARCHAR(255),
    sheet_id VARCHAR(255),
    sheet_name VARCHAR(255),
    drive_folder_id VARCHAR(255),
    contact CHAR(10)
);

CREATE TABLE IF NOT EXISTS hospital.hospital_assignments (
    hospital_id UUID REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
    admin_id UUID REFERENCES hospital.users(id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES hospital.users(id) ON DELETE SET NULL,
    can_view BOOLEAN DEFAULT TRUE,
    can_edit BOOLEAN DEFAULT FALSE,
    can_discharge BOOLEAN DEFAULT FALSE,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    role TEXT[], -- Array of text for multiple roles
    PRIMARY KEY (hospital_id, admin_id)
);

CREATE TABLE IF NOT EXISTS hospital.hospital_users (
    hospital_id UUID REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
    user_id UUID REFERENCES hospital.users(id) ON DELETE CASCADE,
    role TEXT[],
    PRIMARY KEY (hospital_id, user_id)
);

CREATE TABLE IF NOT EXISTS hospital.ipds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255),
    phone CHAR(10),
    admission_type varchar(255),
    admitted_at TIMESTAMP WITH TIME ZONE,
    discharged_at TIMESTAMP WITH TIME ZONE,
    stay JSONB, -- JSONB is preferred over JSON for indexing and speed
    hospital_id UUID REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
    drive_folder_id VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    beneficiary_id VARCHAR(255),
    panel_id UUID REFERENCES hospital.panels(id) ON DELETE SET NULL,
    hospital_panel_id UUID REFERENCES hospital.hospital_panels(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_ipds_modtime ON hospital.ipds;
CREATE TRIGGER update_ipds_modtime BEFORE UPDATE ON hospital.ipds
  FOR EACH ROW EXECUTE PROCEDURE hospital.update_modified_column();

CREATE TABLE IF NOT EXISTS hospital.claims (
    ipd_id UUID REFERENCES hospital.ipds(id) ON DELETE CASCADE PRIMARY KEY,
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

DROP TRIGGER IF EXISTS update_claims_modtime ON hospital.claims;
CREATE TRIGGER update_claims_modtime BEFORE UPDATE ON hospital.claims
  FOR EACH ROW EXECUTE PROCEDURE hospital.update_modified_column();

-- User Lookups
CREATE INDEX IF NOT EXISTS idx_user_email ON hospital.users(email);
CREATE INDEX IF NOT EXISTS idx_user_username ON hospital.users(username);

-- Join Optimization for Assignments
CREATE INDEX IF NOT EXISTS idx_hosp_assign_admin ON hospital.hospital_assignments(admin_id);
CREATE INDEX IF NOT EXISTS idx_hosp_assign_hospital ON hospital.hospital_assignments(hospital_id);

-- Join Optimization for Panels
CREATE INDEX IF NOT EXISTS idx_hp_hospital_id ON hospital.hospital_panels(hospital_id);
CREATE INDEX IF NOT EXISTS idx_hp_panel_id ON hospital.hospital_panels(panel_id);

-- IPD / Patient Search Optimization
CREATE INDEX IF NOT EXISTS idx_ipds_hospital_id ON hospital.ipds(hospital_id);
CREATE INDEX IF NOT EXISTS idx_ipds_panel_id ON hospital.ipds(panel_id);
CREATE INDEX IF NOT EXISTS idx_ipds_phone ON hospital.ipds(phone); -- Fast patient lookup by phone
CREATE INDEX IF NOT EXISTS idx_ipds_admitted_at ON hospital.ipds(admitted_at); -- For sorting by admission date
CREATE INDEX IF NOT EXISTS idx_ipds_is_active ON hospital.ipds(is_active); -- For filtering active patients
CREATE INDEX IF NOT EXISTS idx_ipds_panel_status ON hospital.ipds (hospital_id, panel_id, is_active, discharged_at); -- for fetching patients of a panel fastly

-- Claims Reporting
CREATE INDEX IF NOT EXISTS idx_claims_settled_date ON hospital.claims(claim_settled_date);
CREATE INDEX IF NOT EXISTS idx_claims_status ON hospital.claims(latest_status);

-- IPD Documents Table
CREATE TABLE IF NOT EXISTS hospital.ipd_doc (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ipd_id UUID REFERENCES hospital.ipds(id) ON DELETE CASCADE,  -- Patient ID
    drive_link TEXT,                                    -- Google Drive share link (backup storage)
    s3_key VARCHAR(500),                                -- S3 object key: hospital_id/panel_id/patient_id/type/timestamp_filename
    s3_link TEXT,                                       -- Full S3 HTTPS URL (not presigned)
    type VARCHAR(255),                                  -- Document category: discharge_slip, investigations, treatment, etc.
    summary TEXT,                                       -- Medical summary for the document
    file_name VARCHAR(500),                             -- Original filename
    file_size INTEGER,                                  -- File size in bytes
    mime_type VARCHAR(100),                             -- MIME type: image/jpeg, application/pdf, etc.
    storage_provider VARCHAR(10) DEFAULT 's3',          -- Primary storage: 's3' or 'drive'
    drive_backup_status VARCHAR(20) DEFAULT 'pending',  -- Backup status: 'pending', 'processing', 'completed', 'failed'
    drive_backup_attempts INT DEFAULT 0,                -- Number of backup retry attempts (max 3)
    drive_backup_error TEXT,
    doc_description TEXT,
    doc_metadata JSON,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_ipd_doc_modtime ON hospital.ipd_doc;
CREATE TRIGGER update_ipd_doc_modtime BEFORE UPDATE ON hospital.ipd_doc
  FOR EACH ROW EXECUTE PROCEDURE hospital.update_modified_column();

CREATE INDEX IF NOT EXISTS idx_ipd_doc_ipd_id ON hospital.ipd_doc(ipd_id);                                          -- Fast lookup by patient
CREATE INDEX IF NOT EXISTS idx_ipd_doc_storage_provider ON hospital.ipd_doc(storage_provider);                      -- Filter by storage type
CREATE INDEX IF NOT EXISTS idx_ipd_doc_type ON hospital.ipd_doc(type);                                              -- Filter by document type
CREATE INDEX IF NOT EXISTS idx_ipd_doc_drive_backup_status ON hospital.ipd_doc(drive_backup_status)                 -- Worker queue optimization
    WHERE drive_backup_status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS hospital.doctors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hospital_id UUID REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255),
    age INT,
    speciality VARCHAR(255),
    phone VARCHAR(255),
    years_of_exp int,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hospital.doctor_doc (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    doctor_id UUID REFERENCES hospital.doctors(id) ON DELETE CASCADE,
    drive_link TEXT,
    name VARCHAR(255),
    s3_key VARCHAR(500),
    s3_link TEXT,
    file_name VARCHAR(500),
    file_size INTEGER,
    mime_type VARCHAR(100),
    storage_provider VARCHAR(10) DEFAULT 's3',
    drive_backup_status VARCHAR(20) DEFAULT 'pending',
    drive_backup_attempts INT DEFAULT 0,
    drive_backup_error TEXT,
    summary TEXT,
    doc_description TEXT,
    doc_metadata JSON,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hospital.hospital_doc (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hospital_id UUID REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
    panel_id UUID REFERENCES hospital.panels(id) ON DELETE CASCADE,
    type VARCHAR(255),
    drive_link TEXT,
    name VARCHAR(255),
    s3_key VARCHAR(500),
    s3_link TEXT,
    file_name VARCHAR(500),
    file_size INTEGER,
    mime_type VARCHAR(100),
    storage_provider VARCHAR(10) DEFAULT 's3',
    drive_backup_status VARCHAR(20) DEFAULT 'pending',
    drive_backup_attempts INT DEFAULT 0,
    drive_backup_error TEXT,
    summary TEXT,
    doc_description TEXT,
    doc_metadata JSON,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
