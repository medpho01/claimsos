-- ============================================================================
-- CLAIMSOS PRODUCTION MIGRATION - NEW TABLES & COLUMNS
-- Date: April 27, 2026
-- Purpose: Create all new tables and columns for Hospital Profile, Attributes,
--          Panels, Doctors, and Verification systems
-- Status: READY FOR PRODUCTION
-- ============================================================================

-- Run with: PGPASSWORD="your_password" psql -U postgres -h prod-db-host -d claimsos -f this_file.sql

BEGIN;

-- ============================================================================
-- SCHEMA CREATION
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS hospital;

-- ============================================================================
-- 1. HOSPITAL PROFILE TABLES
-- ============================================================================

-- 1.1 Attribute Definitions Catalog
CREATE TABLE IF NOT EXISTS hospital.attribute_definitions (
  key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  data_type TEXT NOT NULL,
  unit TEXT,
  requires_document BOOLEAN DEFAULT FALSE,
  has_expiry BOOLEAN DEFAULT FALSE,
  expected_issuing_authority TEXT,
  can_verify_by_image BOOLEAN DEFAULT FALSE,
  image_guidance TEXT,
  is_mandatory_basic BOOLEAN DEFAULT FALSE,
  is_mandatory_empanelment BOOLEAN DEFAULT FALSE,
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attr_def_category ON hospital.attribute_definitions(category);
CREATE INDEX IF NOT EXISTS idx_attr_def_active ON hospital.attribute_definitions(is_active);

-- 1.2 Hospital Profile
CREATE TABLE IF NOT EXISTS hospital.hospital_profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL UNIQUE REFERENCES hospital.hospitals(id) ON DELETE CASCADE,

  legal_name TEXT,
  rohini_id TEXT,
  hfr_id TEXT,
  pan_number TEXT,
  gst_number TEXT,
  website TEXT,
  email TEXT,
  phone TEXT,
  established_year INT,

  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  district TEXT,
  state TEXT,
  pincode TEXT,
  latitude DECIMAL(9, 6),
  longitude DECIMAL(9, 6),

  hospital_type TEXT,
  specialties TEXT[] DEFAULT '{}',
  broad_specialties TEXT[] DEFAULT '{}',
  super_specialties TEXT[] DEFAULT '{}',

  beds JSONB DEFAULT '{}',
  icu_beds JSONB DEFAULT '{}',
  ot_emergency JSONB DEFAULT '{}',
  in_house_facilities JSONB DEFAULT '{}',
  equipment JSONB DEFAULT '{}',
  services JSONB DEFAULT '{}',
  lab_capabilities JSONB DEFAULT '{}',
  room_rents JSONB DEFAULT '{}',
  staff_counts JSONB DEFAULT '{}',
  compliance_checklist JSONB DEFAULT '{}',
  bank_details JSONB DEFAULT '{}',

  verification_level TEXT DEFAULT 'none',
  verification_status TEXT DEFAULT 'not_submitted',
  verification_notes TEXT,
  verified_by UUID REFERENCES hospital.users(id),
  verified_at TIMESTAMPTZ,

  public_slug TEXT UNIQUE,
  is_public_profile_enabled BOOLEAN DEFAULT FALSE,
  public_profile_sections JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hospital_profile_hospital_id ON hospital.hospital_profile(hospital_id);
CREATE INDEX IF NOT EXISTS idx_hospital_profile_public_slug ON hospital.hospital_profile(public_slug);

-- 1.3 Hospital Documents
CREATE TABLE IF NOT EXISTS hospital.hospital_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,

  document_category TEXT NOT NULL,
  document_type TEXT NOT NULL,
  attribute_key TEXT REFERENCES hospital.attribute_definitions(key),

  document_name TEXT NOT NULL,
  s3_key TEXT,
  s3_bucket TEXT,
  file_name TEXT,
  file_size_bytes BIGINT,
  mime_type TEXT,

  is_primary BOOLEAN DEFAULT TRUE,
  expiry_date DATE,
  is_public BOOLEAN DEFAULT FALSE,

  notes TEXT,
  uploaded_by UUID REFERENCES hospital.users(id),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hosp_docs_hospital ON hospital.hospital_documents(hospital_id);
CREATE INDEX IF NOT EXISTS idx_hosp_docs_category ON hospital.hospital_documents(hospital_id, document_category);
CREATE INDEX IF NOT EXISTS idx_hosp_docs_attribute ON hospital.hospital_documents(attribute_key);

-- 1.4 Hospital Attributes
CREATE TABLE IF NOT EXISTS hospital.hospital_attributes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  attribute_key TEXT NOT NULL REFERENCES hospital.attribute_definitions(key),

  value_boolean BOOLEAN,
  value_integer INTEGER,
  value_text TEXT,
  value_date DATE,

  expires_at DATE,
  certificate_number TEXT,
  issuing_authority TEXT,
  issued_at DATE,

  verification_status TEXT DEFAULT 'unverified',
  verification_method TEXT,
  verified_by UUID REFERENCES hospital.users(id),
  verified_at TIMESTAMPTZ,
  verification_notes TEXT,

  last_updated_by UUID REFERENCES hospital.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (hospital_id, attribute_key)
);

CREATE INDEX IF NOT EXISTS idx_hosp_attrs_hospital ON hospital.hospital_attributes(hospital_id);
CREATE INDEX IF NOT EXISTS idx_hosp_attrs_key ON hospital.hospital_attributes(attribute_key);
CREATE INDEX IF NOT EXISTS idx_hosp_attrs_status ON hospital.hospital_attributes(verification_status);

-- 1.5 Hospital Attribute Documents (Junction Table)
CREATE TABLE IF NOT EXISTS hospital.hospital_attribute_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_attribute_id UUID NOT NULL REFERENCES hospital.hospital_attributes(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES hospital.hospital_documents(id) ON DELETE CASCADE,

  is_primary BOOLEAN DEFAULT FALSE,
  document_type VARCHAR(100),
  added_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(hospital_attribute_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_hosp_attr_docs ON hospital.hospital_attribute_documents(hospital_attribute_id);

-- ============================================================================
-- 2. PANEL ATTRIBUTE SYSTEM
-- ============================================================================

-- 2.1 Panel Attribute Definitions
CREATE TABLE IF NOT EXISTS hospital.panel_attribute_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  key VARCHAR(100) NOT NULL UNIQUE,
  label VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT,

  data_type VARCHAR(50) NOT NULL,
  is_required BOOLEAN DEFAULT false,
  has_expiry BOOLEAN DEFAULT false,
  requires_document BOOLEAN DEFAULT false,

  sort_order INT DEFAULT 999,
  category_sort_order INT DEFAULT 999,
  is_active BOOLEAN DEFAULT true,

  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_panel_attr_def_category ON hospital.panel_attribute_definitions(category);
CREATE INDEX IF NOT EXISTS idx_panel_attr_def_active ON hospital.panel_attribute_definitions(is_active);

-- 2.2 Panel Attributes
CREATE TABLE IF NOT EXISTS hospital.panel_attributes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  hospital_panel_id UUID NOT NULL REFERENCES hospital.hospital_panels(id) ON DELETE CASCADE,
  attribute_key VARCHAR(100) NOT NULL,

  value_text TEXT,
  value_date DATE,
  value_boolean BOOLEAN,
  value_integer INTEGER,

  verification_status VARCHAR(50) DEFAULT 'unverified',
  verification_method VARCHAR(50),
  verified_by UUID,
  verified_at TIMESTAMP,
  verification_notes TEXT,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(hospital_panel_id, attribute_key)
);

CREATE INDEX IF NOT EXISTS idx_panel_attr_panel ON hospital.panel_attributes(hospital_panel_id);
CREATE INDEX IF NOT EXISTS idx_panel_attr_key ON hospital.panel_attributes(attribute_key);

-- 2.3 Panel Attribute Documents (Junction Table)
CREATE TABLE IF NOT EXISTS hospital.panel_attribute_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_attribute_id UUID NOT NULL REFERENCES hospital.panel_attributes(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES hospital.hospital_documents(id) ON DELETE CASCADE,

  is_primary BOOLEAN DEFAULT FALSE,
  document_type VARCHAR(100),
  added_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(panel_attribute_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_panel_attr_docs ON hospital.panel_attribute_documents(panel_attribute_id);

-- ============================================================================
-- 3. DOCTOR CONFIGURATION SYSTEM
-- ============================================================================

-- 3.1 Doctors (Independent Doctor Registry)
CREATE TABLE IF NOT EXISTS hospital.doctors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(20),
  profile_photo_url TEXT,

  nmc_registration_number VARCHAR(100),
  state_registration_number VARCHAR(100),
  primary_specialization VARCHAR(255),
  secondary_specializations TEXT[] DEFAULT '{}',

  registration_status VARCHAR(50) DEFAULT 'active',
  registration_method VARCHAR(50),
  verified_by UUID,
  verified_at TIMESTAMP,

  is_public_profile_enabled BOOLEAN DEFAULT false,

  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_verified_by FOREIGN KEY (verified_by) REFERENCES hospital.users(id) ON DELETE SET NULL,
  CONSTRAINT fk_created_by FOREIGN KEY (created_by) REFERENCES hospital.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_doctor_email ON hospital.doctors(email);
CREATE INDEX idx_doctor_nmc ON hospital.doctors(nmc_registration_number);
CREATE INDEX idx_doctor_status ON hospital.doctors(registration_status);

-- 3.2 Doctor Attribute Definitions
CREATE TABLE IF NOT EXISTS hospital.doctor_attribute_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  key VARCHAR(100) NOT NULL UNIQUE,
  label VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT,

  data_type VARCHAR(50) NOT NULL,
  is_required BOOLEAN DEFAULT false,
  has_expiry BOOLEAN DEFAULT false,
  requires_document BOOLEAN DEFAULT false,
  can_verify_by_document BOOLEAN DEFAULT true,

  sort_order INT DEFAULT 999,
  category_sort_order INT DEFAULT 999,
  is_active BOOLEAN DEFAULT true,

  requires_validator_verification BOOLEAN DEFAULT false,
  auto_verifiable BOOLEAN DEFAULT false,
  verification_url_pattern TEXT,

  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_doctor_attr_def_category ON hospital.doctor_attribute_definitions(category);
CREATE INDEX idx_doctor_attr_def_active ON hospital.doctor_attribute_definitions(is_active);

-- 3.3 Doctor Attributes
CREATE TABLE IF NOT EXISTS hospital.doctor_attributes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  doctor_id UUID NOT NULL REFERENCES hospital.doctors(id) ON DELETE CASCADE,
  attribute_key VARCHAR(100) NOT NULL,

  value_text TEXT,
  value_date DATE,
  value_boolean BOOLEAN,

  certificate_number VARCHAR(255),
  issuing_authority VARCHAR(255),
  issued_at DATE,
  expires_at DATE,

  verification_status VARCHAR(50) DEFAULT 'unverified',
  verification_method VARCHAR(50),
  verified_by UUID,
  verified_at TIMESTAMP,
  verification_notes TEXT,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(doctor_id, attribute_key)
);

CREATE INDEX idx_doctor_attributes_doctor ON hospital.doctor_attributes(doctor_id);
CREATE INDEX idx_doctor_attributes_status ON hospital.doctor_attributes(verification_status);

-- 3.4 Doctor Attribute Documents (Junction Table)
CREATE TABLE IF NOT EXISTS hospital.doctor_attribute_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  doctor_attribute_id UUID NOT NULL REFERENCES hospital.doctor_attributes(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES hospital.hospital_documents(id) ON DELETE CASCADE,

  is_primary BOOLEAN DEFAULT FALSE,
  document_type VARCHAR(100),
  added_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(doctor_attribute_id, document_id)
);

CREATE INDEX idx_doctor_attr_docs ON hospital.doctor_attribute_documents(doctor_attribute_id);

-- 3.5 Hospital-Doctor Relationship
CREATE TABLE IF NOT EXISTS hospital.hospital_doctors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  doctor_id UUID NOT NULL REFERENCES hospital.doctors(id) ON DELETE CASCADE,

  employment_type VARCHAR(50) NOT NULL,
  department VARCHAR(255),
  specialization VARCHAR(255),
  designation VARCHAR(255),

  start_date DATE,
  end_date DATE,
  status VARCHAR(50) DEFAULT 'active',

  employee_id VARCHAR(100),
  notes TEXT,
  hospital_phone VARCHAR(20),
  hospital_email VARCHAR(255),

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(hospital_id, doctor_id)
);

CREATE INDEX idx_hospital_doctors_hospital ON hospital.hospital_doctors(hospital_id);
CREATE INDEX idx_hospital_doctors_doctor ON hospital.hospital_doctors(doctor_id);
CREATE INDEX idx_hospital_doctors_status ON hospital.hospital_doctors(status);

-- 3.6 Hospital-Doctor Attribute Overrides (Optional)
CREATE TABLE IF NOT EXISTS hospital.hospital_doctor_attributes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  hospital_doctor_id UUID NOT NULL REFERENCES hospital.hospital_doctors(id) ON DELETE CASCADE,
  doctor_attribute_id UUID NOT NULL REFERENCES hospital.doctor_attributes(id) ON DELETE CASCADE,

  override_value_text TEXT,
  override_value_date DATE,
  override_value_boolean BOOLEAN,

  hospital_verification_status VARCHAR(50),
  hospital_verified_by UUID,
  hospital_verified_at TIMESTAMP,
  hospital_notes TEXT,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(hospital_doctor_id, doctor_attribute_id)
);

CREATE INDEX idx_hospital_doctor_attrs ON hospital.hospital_doctor_attributes(hospital_doctor_id);

-- ============================================================================
-- 4. PUBLIC SHARING & VERIFICATION SYSTEM
-- ============================================================================

-- 4.1 Public Share Tokens
CREATE TABLE IF NOT EXISTS hospital.public_share_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),

  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID NOT NULL,

  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMP,
  max_views INT,
  view_count INT DEFAULT 0,
  last_viewed_at TIMESTAMP,

  visible_sections JSONB DEFAULT '{}',

  created_by UUID REFERENCES hospital.users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_public_share_tokens_token ON hospital.public_share_tokens(token);
CREATE INDEX idx_public_share_tokens_resource ON hospital.public_share_tokens(resource_type, resource_id);

-- 4.2 Verification Evidence
CREATE TABLE IF NOT EXISTS hospital.verification_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  attribute_id UUID,
  doctor_attribute_id UUID,

  evidence_type VARCHAR(100) NOT NULL,
  evidence_data JSONB NOT NULL,

  verified_by UUID REFERENCES hospital.users(id),
  confidence_level INT,

  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_verification_evidence_attr ON hospital.verification_evidence(attribute_id);
CREATE INDEX idx_verification_evidence_doctor_attr ON hospital.verification_evidence(doctor_attribute_id);

-- ============================================================================
-- 5. MASTER OPTIONS (Dropdowns, Enums)
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.master_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  category VARCHAR(100) NOT NULL,
  key VARCHAR(100) NOT NULL,
  value VARCHAR(255) NOT NULL,
  label VARCHAR(255),

  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(category, key)
);

CREATE INDEX idx_master_options_category ON hospital.master_options(category);
CREATE INDEX idx_master_options_active ON hospital.master_options(is_active);

-- ============================================================================
-- 6. HOSPITAL EXTENSIONS (NEW COLUMNS)
-- ============================================================================

-- Add new columns to existing hospitals table (if they don't exist)
ALTER TABLE hospital.hospitals
ADD COLUMN IF NOT EXISTS city VARCHAR(255),
ADD COLUMN IF NOT EXISTS pincode VARCHAR(20),
ADD COLUMN IF NOT EXISTS hospital_type VARCHAR(100),
ADD COLUMN IF NOT EXISTS registration_number VARCHAR(100),
ADD COLUMN IF NOT EXISTS established_year INT;

-- Add new columns to hospital_panels (if they don't exist)
ALTER TABLE hospital.hospital_panels
ADD COLUMN IF NOT EXISTS category VARCHAR(255),
ADD COLUMN IF NOT EXISTS insurance_provider VARCHAR(255),
ADD COLUMN IF NOT EXISTS network_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active',
ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- ============================================================================
-- 7. FINAL VALIDATION
-- ============================================================================

-- Check that all critical tables exist
SELECT 'Hospital Profile System' as system, COUNT(*) as table_count
FROM information_schema.tables
WHERE table_schema = 'hospital'
AND table_name IN ('hospital_profile', 'hospital_documents', 'hospital_attributes',
                   'hospital_attribute_documents', 'attribute_definitions')
UNION ALL
SELECT 'Panel System', COUNT(*)
FROM information_schema.tables
WHERE table_schema = 'hospital'
AND table_name IN ('panel_attributes', 'panel_attribute_definitions', 'panel_attribute_documents')
UNION ALL
SELECT 'Doctor System', COUNT(*)
FROM information_schema.tables
WHERE table_schema = 'hospital'
AND table_name IN ('doctors', 'doctor_attributes', 'doctor_attribute_definitions',
                   'doctor_attribute_documents', 'hospital_doctors', 'hospital_doctor_attributes')
UNION ALL
SELECT 'Verification System', COUNT(*)
FROM information_schema.tables
WHERE table_schema = 'hospital'
AND table_name IN ('public_share_tokens', 'verification_evidence', 'master_options');

COMMIT;

-- ============================================================================
-- SUCCESS MESSAGE
-- ============================================================================
-- If you see this, all tables have been created successfully!
-- Next steps: Run seed data migrations for attribute definitions and master options
-- ============================================================================
