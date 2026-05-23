-- Migration: Create Doctor Configuration & Management System
-- Date: 2026-04-23
-- Purpose: Support flexible doctor configuration with attributes, independent doctor registry,
--          and hospital-doctor relationships

-- ============================================================================
-- 1. Create doctors table (Independent Doctor Registry)
-- ============================================================================
CREATE TABLE hospital.doctors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Personal Information
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(20),
  profile_photo_url TEXT,                 -- S3 URL to profile photo

  -- Professional Information
  nmc_registration_number VARCHAR(100),   -- National Medical Council
  state_registration_number VARCHAR(100), -- State medical council
  primary_specialization VARCHAR(255),    -- e.g., "Cardiology", "Pediatrics"
  secondary_specializations TEXT[] DEFAULT '{}', -- Array of specializations

  -- Registration & Status
  registration_status VARCHAR(50) DEFAULT 'active',
  -- 'active', 'inactive', 'suspended', 'pending_verification'
  registration_method VARCHAR(50),        -- 'self_registered', 'admin_created'
  verified_by UUID,                       -- Admin who verified if needed
  verified_at TIMESTAMP,

  -- Profile Visibility
  is_public_profile_enabled BOOLEAN DEFAULT false, -- Can be viewed publicly

  -- Audit Trail
  created_by UUID,                        -- Self or admin
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_verified_by FOREIGN KEY (verified_by) REFERENCES hospital.users(id) ON DELETE SET NULL,
  CONSTRAINT fk_created_by FOREIGN KEY (created_by) REFERENCES hospital.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_doctor_email ON hospital.doctors(email);
CREATE INDEX idx_doctor_nmc ON hospital.doctors(nmc_registration_number);
CREATE INDEX idx_doctor_status ON hospital.doctors(registration_status);
CREATE INDEX idx_doctor_created_by ON hospital.doctors(created_by);

-- ============================================================================
-- 2. Create doctor_attribute_definitions table (Catalog)
-- ============================================================================
CREATE TABLE hospital.doctor_attribute_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Attribute Metadata
  key VARCHAR(100) NOT NULL UNIQUE,       -- e.g., 'license.medical_council'
  label VARCHAR(255) NOT NULL,            -- Display label
  category VARCHAR(100) NOT NULL,         -- 'qualifications', 'licenses', 'registrations', 'compliance', 'experience'
  description TEXT,

  -- Data Type & Storage
  data_type VARCHAR(50) NOT NULL,         -- 'text', 'date', 'boolean', 'document', 'textarea'

  -- Requirements & Validation
  is_required BOOLEAN DEFAULT false,      -- Must be filled
  has_expiry BOOLEAN DEFAULT false,       -- Can have expiry date
  requires_document BOOLEAN DEFAULT false,-- Must have document attachment
  can_verify_by_document BOOLEAN DEFAULT true, -- Can be verified by doc

  -- Display & Organization
  sort_order INT DEFAULT 999,
  category_sort_order INT DEFAULT 999,    -- Order within category
  is_active BOOLEAN DEFAULT true,

  -- Verification Settings
  requires_validator_verification BOOLEAN DEFAULT false, -- Needs on-site check
  auto_verifiable BOOLEAN DEFAULT false,  -- Can be verified online (e.g., NMC lookup)
  verification_url_pattern TEXT,          -- Pattern for online verification

  -- Audit
  created_by UUID NOT NULL,
  updated_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_created_by FOREIGN KEY (created_by) REFERENCES hospital.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_updated_by FOREIGN KEY (updated_by) REFERENCES hospital.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_doctor_attr_def_category ON hospital.doctor_attribute_definitions(category);
CREATE INDEX idx_doctor_attr_def_active ON hospital.doctor_attribute_definitions(is_active);
CREATE INDEX idx_doctor_attr_def_key ON hospital.doctor_attribute_definitions(key);

-- ============================================================================
-- 3. Create doctor_attributes table (Doctor's Attribute Values)
-- ============================================================================
CREATE TABLE hospital.doctor_attributes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  doctor_id UUID NOT NULL,
  attribute_key VARCHAR(100) NOT NULL,

  -- Polymorphic Value Storage
  value_text TEXT,
  value_date DATE,
  value_boolean BOOLEAN,

  -- Certificate/License Metadata
  certificate_number VARCHAR(255),
  issuing_authority VARCHAR(255),
  issued_at DATE,
  expires_at DATE,

  -- Verification
  verification_status VARCHAR(50) DEFAULT 'unverified',
  -- 'unverified', 'pending_review', 'verified_by_doc', 'verified_by_image',
  -- 'verified_by_online', 'verified_manual', 'auto_verified', 'expired', 'rejected'
  verification_method VARCHAR(50),        -- 'document', 'image', 'online_lookup', 'manual', 'automated'
  verified_by UUID,
  verified_at TIMESTAMP,
  verification_notes TEXT,

  -- Audit
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_doctor FOREIGN KEY (doctor_id) REFERENCES hospital.doctors(id) ON DELETE CASCADE,
  CONSTRAINT fk_verified_by FOREIGN KEY (verified_by) REFERENCES hospital.users(id) ON DELETE SET NULL,
  UNIQUE(doctor_id, attribute_key)
);

CREATE INDEX idx_doctor_attributes_doctor ON hospital.doctor_attributes(doctor_id);
CREATE INDEX idx_doctor_attributes_status ON hospital.doctor_attributes(verification_status);
CREATE INDEX idx_doctor_attributes_expiry ON hospital.doctor_attributes(expires_at);

-- ============================================================================
-- 4. Create doctor_attribute_documents table (Junction Table)
-- ============================================================================
CREATE TABLE hospital.doctor_attribute_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  doctor_attribute_id UUID NOT NULL,
  document_id UUID NOT NULL,

  is_primary BOOLEAN DEFAULT false,       -- Primary document for this attribute
  document_type VARCHAR(100),             -- 'certificate', 'license', 'registration', 'proof'
  added_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_doctor_attribute FOREIGN KEY (doctor_attribute_id) REFERENCES hospital.doctor_attributes(id) ON DELETE CASCADE,
  CONSTRAINT fk_document FOREIGN KEY (document_id) REFERENCES doctor_doc(id) ON DELETE CASCADE,
  UNIQUE(doctor_attribute_id, document_id)
);

CREATE INDEX idx_doctor_attr_docs_attribute ON hospital.doctor_attribute_documents(doctor_attribute_id);
CREATE INDEX idx_doctor_attr_docs_document ON hospital.doctor_attribute_documents(document_id);

-- ============================================================================
-- 5. Create hospital_doctors table (Doctor-Hospital Junction)
-- ============================================================================
CREATE TABLE hospital.hospital_doctors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  hospital_id UUID NOT NULL,
  doctor_id UUID NOT NULL,

  -- Relationship Details
  employment_type VARCHAR(50) NOT NULL,  -- 'resident', 'visiting', 'consultant', 'associate', 'empanelled'
  department VARCHAR(255),               -- e.g., "Cardiology", "Pediatrics"
  specialization VARCHAR(255),           -- Doctor's specialization at this hospital
  designation VARCHAR(255),              -- e.g., "Senior Consultant", "Junior Resident"

  -- Status & Dates
  start_date DATE,
  end_date DATE,
  status VARCHAR(50) DEFAULT 'active',   -- 'active', 'inactive', 'on_leave', 'terminated'

  -- Hospital-Specific Details
  employee_id VARCHAR(100),              -- Hospital's internal employee ID
  notes TEXT,

  -- Contact at Hospital
  hospital_phone VARCHAR(20),            -- Hospital extension/phone
  hospital_email VARCHAR(255),           -- Hospital email if different

  -- Audit
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_hospital FOREIGN KEY (hospital_id) REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  CONSTRAINT fk_doctor FOREIGN KEY (doctor_id) REFERENCES hospital.doctors(id) ON DELETE CASCADE,
  UNIQUE(hospital_id, doctor_id)
);

CREATE INDEX idx_hospital_doctors_hospital ON hospital.hospital_doctors(hospital_id);
CREATE INDEX idx_hospital_doctors_doctor ON hospital.hospital_doctors(doctor_id);
CREATE INDEX idx_hospital_doctors_status ON hospital.hospital_doctors(status);

-- ============================================================================
-- 6. Create hospital_doctor_attributes table (Hospital-Specific Overrides)
-- ============================================================================
CREATE TABLE hospital.hospital_doctor_attributes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  hospital_doctor_id UUID NOT NULL,
  doctor_attribute_id UUID NOT NULL,

  -- Override Values (if different from global doctor attribute)
  override_value_text TEXT,
  override_value_date DATE,
  override_value_boolean BOOLEAN,

  -- Hospital-Specific Verification
  hospital_verification_status VARCHAR(50),
  hospital_verified_by UUID,
  hospital_verified_at TIMESTAMP,
  hospital_notes TEXT,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_hospital_doctor FOREIGN KEY (hospital_doctor_id) REFERENCES hospital.hospital_doctors(id) ON DELETE CASCADE,
  CONSTRAINT fk_doctor_attribute FOREIGN KEY (doctor_attribute_id) REFERENCES hospital.doctor_attributes(id) ON DELETE CASCADE,
  CONSTRAINT fk_hospital_verified_by FOREIGN KEY (hospital_verified_by) REFERENCES hospital.users(id) ON DELETE SET NULL,
  UNIQUE(hospital_doctor_id, doctor_attribute_id)
);

CREATE INDEX idx_hospital_doctor_attrs ON hospital.hospital_doctor_attributes(hospital_doctor_id);
CREATE INDEX idx_hospital_doctor_attrs_attr ON hospital.hospital_doctor_attributes(doctor_attribute_id);

-- ============================================================================
-- 7. Seed doctor_attribute_definitions
-- ============================================================================

-- Qualifications Category
INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'qualification.md', 'Medical Degree (MD/MBBS)', 'qualifications', 'text', true, false, true, 10, 10, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'qualification.specialist', 'Specialist Qualification (MS/MD)', 'qualifications', 'text', false, false, true, 20, 10, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'qualification.super_specialist', 'Super Specialist Qualification (MCh/DM)', 'qualifications', 'text', false, false, true, 30, 10, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'qualification.fellowship', 'Fellowship/DNB/Diploma', 'qualifications', 'text', false, false, true, 40, 10, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'qualification.additional_certifications', 'Additional Certifications', 'qualifications', 'textarea', false, false, true, 50, 10, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

-- Licenses Category
INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'license.nmc_registration', 'NMC Registration Number', 'licenses', 'text', true, true, true, 10, 20, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'license.state_registration', 'State Medical Council Registration', 'licenses', 'text', true, true, true, 20, 20, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

-- Registrations Category
INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'registration.permanent_nmc', 'Permanent NMC Registration', 'registrations', 'boolean', false, false, false, 10, 30, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'registration.pcc_record', 'Police Clearance Certificate on Record', 'registrations', 'boolean', false, false, false, 20, 30, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

-- Compliance Category
INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'compliance.malpractice_insurance', 'Malpractice Insurance', 'compliance', 'document', false, true, true, 10, 40, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'compliance.covid_vaccinated', 'COVID-19 Vaccination Status', 'compliance', 'boolean', false, false, true, 20, 40, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'compliance.aadhaar_verified', 'Aadhar Verified', 'compliance', 'boolean', false, false, false, 30, 40, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

-- Experience Category
INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'experience.years_practicing', 'Years of Clinical Practice', 'experience', 'text', false, false, false, 10, 50, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'experience.publications', 'Number of Publications', 'experience', 'text', false, false, false, 20, 50, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

INSERT INTO hospital.doctor_attribute_definitions
(key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, category_sort_order, created_by)
SELECT 'experience.conferences_presented', 'Conferences Presented At', 'experience', 'text', false, false, false, 30, 50, id FROM hospital.users WHERE role = 'superadmin' LIMIT 1;

-- ============================================================================
-- 8. Create doctor_share_tokens table (Public Profile Sharing)
-- ============================================================================
CREATE TABLE hospital.doctor_share_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  token VARCHAR(64) NOT NULL UNIQUE,       -- Random 32-byte hex string
  doctor_id UUID NOT NULL,

  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMP,                     -- Optional expiration
  max_views INT,                            -- Optional view limit
  view_count INT DEFAULT 0,                -- Current view count
  last_viewed_at TIMESTAMP,                -- Last access time

  created_by UUID NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_doctor FOREIGN KEY (doctor_id) REFERENCES hospital.doctors(id) ON DELETE CASCADE,
  CONSTRAINT fk_created_by FOREIGN KEY (created_by) REFERENCES hospital.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_doctor_share_tokens_token ON hospital.doctor_share_tokens(token);
CREATE INDEX idx_doctor_share_tokens_doctor ON hospital.doctor_share_tokens(doctor_id);
CREATE INDEX idx_doctor_share_tokens_active ON hospital.doctor_share_tokens(is_active);
