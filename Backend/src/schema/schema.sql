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
    role VARCHAR(50) NOT NULL, -- 'admin', 'hospital'
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP,
    folder_id VARCHAR(255) UNIQUE, -- Google Drive folder ID for the hospital
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
    admitted_at TIMESTAMP DEFAULT NOW(),
    discharged_at TIMESTAMP DEFAULT NOW(),
    folder_id VARCHAR(255), -- Google Drive folder ID for patient's images
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS hospital.user_refresh_tokens(
    user_id UUID REFERENCES users(id) NOT NULL,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP,
    created_at TIMESTAMP
);


