-- ============================================
-- USERS TABLE
-- Stores hospital administrators and their accounts
-- ============================================
CREATE TABLE IF NOT EXISTS hospital.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE,
    username VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    phone VARCHAR(20),
    role VARCHAR(50) NOT NULL, -- 'superadmin', 'admin', 'hospital'
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP,
    folder_id VARCHAR(255) UNIQUE, -- Google Drive folder ID for the hospital
    hospital_group_id VARCHAR(255) DEFAULT NULL,
    sheet_id VARCHAR(255) DEFAULT NULL, -- Google Sheets spreadsheet ID
    sheet_name VARCHAR(255) DEFAULT NULL, -- Google Sheets sheet name
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- PATIENTS TABLE
-- Stores patient information linked to hospitals
-- ============================================
CREATE TABLE IF NOT EXISTS hospital.patients(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    phone VARCHAR(20),
    hospital_id UUID REFERENCES users(id) NOT NULL,
    admission_type VARCHAR(30), -- conservative, surgical
    admitted_at TIMESTAMP DEFAULT NOW(),
    discharged_at TIMESTAMP DEFAULT NULL,
    folder_id VARCHAR(255), -- Google Drive folder ID for patient's images
    pmjay_case_number VARCHAR(100), -- PMJAY Case Number 
    scheme VARCHAR(100), -- Scheme 
    treatment_procedure TEXT, -- Treatment/Procedure details
    latest_status VARCHAR(255), -- Latest claim status
    claim_amount DECIMAL(12, 2), -- Claim amount in INR
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS hospital.user_refresh_tokens(
    user_id UUID REFERENCES users(id) NOT NULL,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP,
    created_at TIMESTAMP
);

-- ============================================
-- HOSPITAL ASSIGNMENTS TABLE
-- Tracks which hospital users are assigned to which admin users
-- ============================================
CREATE TABLE IF NOT EXISTS hospital.hospital_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES hospital.users(id) ON DELETE CASCADE NOT NULL,
    hospital_id UUID REFERENCES hospital.users(id) ON DELETE CASCADE NOT NULL,
    assigned_by UUID REFERENCES hospital.users(id) ON DELETE SET NULL,
    can_view BOOLEAN DEFAULT true,
    can_edit BOOLEAN DEFAULT true,
    can_discharge BOOLEAN DEFAULT true,
    assigned_at TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT true,
    UNIQUE(admin_id, hospital_id)
);

CREATE INDEX idx_hospital_assignments_admin ON hospital.hospital_assignments(admin_id);
CREATE INDEX idx_hospital_assignments_hospital ON hospital.hospital_assignments(hospital_id);
CREATE INDEX idx_hospital_assignments_assigned_by ON hospital.hospital_assignments(assigned_by);


-- ============================================
-- AUDIT LOGS TABLE
-- -- ============================================
CREATE TABLE IF NOT EXISTS hospital.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES hospital.users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50),
    entity_id VARCHAR(255),
    details JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_user_id ON hospital.audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON hospital.audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON hospital.audit_logs(created_at);

