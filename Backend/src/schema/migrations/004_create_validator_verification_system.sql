-- Migration: Create Validator & Verification System Tables
-- Date: 2026-04-22
-- Purpose: Implement Medical Facility Validator workflow for on-site attribute verification

-- ============================================================================
-- 1. Validator Profiles Table
-- ============================================================================
CREATE TABLE validator_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  id_type VARCHAR(50) NOT NULL, -- 'aadhar', 'pan', 'driver_license', 'passport'
  id_number VARCHAR(100) NOT NULL,
  id_document_url TEXT, -- S3 URL to uploaded ID document
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(255) NOT NULL,

  -- Geographic & Specialization Coverage
  coverage_states TEXT[] DEFAULT '{}', -- ['Maharashtra', 'Gujarat', 'Karnataka']
  coverage_cities TEXT[] DEFAULT '{}', -- ['Mumbai', 'Bangalore', 'etc']
  specialization_categories TEXT[] DEFAULT '{}', -- ['cardiology', 'neurology', 'general']

  -- Status & Verification
  verification_status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'suspended'
  verification_notes TEXT,
  verified_by UUID, -- Admin who verified
  verified_at TIMESTAMP,

  -- Performance & Activity
  total_visits INT DEFAULT 0,
  completed_visits INT DEFAULT 0,
  pending_reviews INT DEFAULT 0,
  average_rating DECIMAL(3, 2),

  -- Account Management
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_validator_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_verified_by_admin FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(user_id),
  UNIQUE(id_type, id_number)
);

CREATE INDEX idx_validator_status ON validator_profiles(verification_status);
CREATE INDEX idx_validator_active ON validator_profiles(is_active);
CREATE INDEX idx_validator_coverage_states ON validator_profiles USING GIN(coverage_states);

-- ============================================================================
-- 2. Verification Visits Table (Visit-centric workflow)
-- ============================================================================
CREATE TABLE verification_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References
  hospital_id UUID NOT NULL,
  validator_id UUID NOT NULL,

  -- Visit Details
  visit_status VARCHAR(50) NOT NULL DEFAULT 'scheduled', -- 'scheduled', 'in_progress', 'completed', 'cancelled'
  scheduled_date DATE NOT NULL,
  scheduled_time TIME,
  actual_start_time TIMESTAMP,
  actual_end_time TIMESTAMP,

  -- Visit Metadata
  visit_notes TEXT, -- General notes about the visit
  location_verified BOOLEAN DEFAULT false, -- Validator confirmed hospital location
  validator_selfie_url TEXT, -- S3 URL to validator's selfie at hospital

  -- Quality Indicators
  documents_reviewed INT DEFAULT 0, -- Count of documents reviewed during visit
  photo_count INT DEFAULT 0, -- Count of photos taken during visit
  verification_coverage VARCHAR(50) DEFAULT 'partial', -- 'partial', 'complete'

  -- Status & Review
  admin_review_status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'approved', 'needs_revision', 'rejected'
  admin_notes TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMP,

  -- Audit
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_hospital FOREIGN KEY (hospital_id) REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  CONSTRAINT fk_validator FOREIGN KEY (validator_id) REFERENCES validator_profiles(id) ON DELETE CASCADE,
  CONSTRAINT fk_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_visit_hospital ON verification_visits(hospital_id);
CREATE INDEX idx_visit_validator ON verification_visits(validator_id);
CREATE INDEX idx_visit_status ON verification_visits(visit_status);
CREATE INDEX idx_visit_review_status ON verification_visits(admin_review_status);
CREATE INDEX idx_visit_scheduled_date ON verification_visits(scheduled_date);

-- ============================================================================
-- 3. Attribute Verifications Table (Per-visit, per-attribute records)
-- ============================================================================
CREATE TABLE attribute_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References
  visit_id UUID NOT NULL,
  hospital_attribute_id UUID NOT NULL,
  attribute_key VARCHAR(100) NOT NULL,

  -- Verification Result
  verification_result VARCHAR(50) NOT NULL, -- 'verified', 'partially_verified', 'not_verified', 'inconclusive'
  confidence_level INT CHECK (confidence_level >= 0 AND confidence_level <= 100), -- 0-100%

  -- Evidence
  document_ids UUID[] DEFAULT '{}', -- IDs of reviewed hospital documents
  photo_urls TEXT[] DEFAULT '{}', -- S3 URLs to verification photos

  -- Verification Details
  attribute_value_found VARCHAR(255), -- What was found at hospital
  attribute_value_claimed VARCHAR(255), -- What hospital claimed in database
  discrepancy_notes TEXT, -- If values don't match

  -- Validator Assessment
  is_equipment_operational BOOLEAN, -- For equipment attributes
  facility_condition_notes TEXT, -- General condition of facility

  -- Status & Review
  admin_review_status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'approved', 'needs_revision', 'rejected'
  admin_notes TEXT,

  -- Audit
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_visit FOREIGN KEY (visit_id) REFERENCES verification_visits(id) ON DELETE CASCADE,
  CONSTRAINT fk_hospital_attribute FOREIGN KEY (hospital_attribute_id) REFERENCES hospital.hospital_attributes(id) ON DELETE CASCADE
);

CREATE INDEX idx_attribute_verification_visit ON attribute_verifications(visit_id);
CREATE INDEX idx_attribute_verification_attr ON attribute_verifications(hospital_attribute_id);
CREATE INDEX idx_attribute_verification_result ON attribute_verifications(verification_result);
CREATE INDEX idx_attribute_verification_review ON attribute_verifications(admin_review_status);

-- ============================================================================
-- 4. Verification Notes Table (Structured metadata for notes)
-- ============================================================================
CREATE TABLE verification_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References
  attribute_verification_id UUID NOT NULL,
  visit_id UUID NOT NULL,

  -- Note Content
  note_type VARCHAR(50) NOT NULL, -- 'observation', 'discrepancy', 'concern', 'positive_finding', 'equipment_status', 'facility_condition'
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,

  -- Structured Data (JSON for flexibility)
  metadata JSONB DEFAULT '{}', -- Can include any structured data: {
                                -- "category": "safety", "severity": "high",
                                -- "resolution_required": true, "equipment_serial": "ABC123",
                                -- "condition_rating": 8/10, etc
                                -- }

  -- Photo Evidence
  photo_url TEXT, -- S3 URL to associated photo

  -- Created By
  created_by UUID NOT NULL, -- Validator who created this note

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_attr_verification_note FOREIGN KEY (attribute_verification_id) REFERENCES attribute_verifications(id) ON DELETE CASCADE,
  CONSTRAINT fk_visit_note FOREIGN KEY (visit_id) REFERENCES verification_visits(id) ON DELETE CASCADE,
  CONSTRAINT fk_created_by_note FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX idx_note_verification ON verification_notes(attribute_verification_id);
CREATE INDEX idx_note_visit ON verification_notes(visit_id);
CREATE INDEX idx_note_type ON verification_notes(note_type);
CREATE INDEX idx_note_created_by ON verification_notes(created_by);

-- ============================================================================
-- 5. Verification Audit Log Table (Immutable audit trail)
-- ============================================================================
CREATE TABLE verification_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Action Details
  action VARCHAR(100) NOT NULL, -- 'visit_scheduled', 'visit_started', 'attribute_verified', 'visit_completed', 'admin_review_started', 'admin_approved', 'admin_rejected'
  action_type VARCHAR(50) NOT NULL, -- 'create', 'update', 'review', 'approve', 'reject', 'escalate'

  -- Entity References
  visit_id UUID,
  attribute_verification_id UUID,
  hospital_id UUID,
  validator_id UUID,

  -- Change Details
  old_value JSONB, -- Previous value
  new_value JSONB, -- New value
  changes_summary TEXT, -- Human-readable summary

  -- Actor Information
  performed_by UUID NOT NULL, -- User who performed action (validator, admin, system)
  actor_role VARCHAR(50) NOT NULL, -- 'validator', 'admin', 'system', 'hospital_admin'

  -- Timestamps & Location
  performed_at TIMESTAMP DEFAULT NOW(),
  ip_address INET,
  user_agent TEXT,

  -- Notes
  reason TEXT, -- Why was this action taken (for rejections, etc)

  CONSTRAINT fk_audit_visit FOREIGN KEY (visit_id) REFERENCES verification_visits(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_attr_verification FOREIGN KEY (attribute_verification_id) REFERENCES attribute_verifications(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_hospital FOREIGN KEY (hospital_id) REFERENCES hospital.hospitals(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_validator FOREIGN KEY (validator_id) REFERENCES validator_profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_performed_by FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_visit ON verification_audit_log(visit_id);
CREATE INDEX idx_audit_attribute_verification ON verification_audit_log(attribute_verification_id);
CREATE INDEX idx_audit_hospital ON verification_audit_log(hospital_id);
CREATE INDEX idx_audit_validator ON verification_audit_log(validator_id);
CREATE INDEX idx_audit_action ON verification_audit_log(action);
CREATE INDEX idx_audit_performed_by ON verification_audit_log(performed_by);
CREATE INDEX idx_audit_timestamp ON verification_audit_log(performed_at DESC);

-- ============================================================================
-- 6. Verification Guidelines Table (Admin-managed best practices)
-- ============================================================================
CREATE TABLE verification_guidelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Guideline Metadata
  attribute_key VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,

  -- Verification Steps
  verification_steps JSONB NOT NULL, -- Array of step objects:
                                     -- [{ "step_number": 1, "instruction": "Check...", "required_evidence": "photo" }]

  -- Evidence Requirements
  required_evidence TEXT[] DEFAULT '{}', -- ['photo', 'document', 'selfie', 'equipment_check']
  photo_count_minimum INT DEFAULT 1,

  -- Quality Standards
  quality_checklist TEXT[], -- Items to verify
  common_discrepancies TEXT[], -- Common issues to watch for
  red_flags TEXT[], -- Things that indicate fraud/issues

  -- Category & Organization
  category VARCHAR(100),
  priority INT DEFAULT 999, -- For sorting

  -- Status
  is_active BOOLEAN DEFAULT true,
  version INT DEFAULT 1,
  created_by UUID NOT NULL,
  updated_by UUID,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT fk_guideline_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_guideline_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(attribute_key, version)
);

CREATE INDEX idx_guideline_attribute ON verification_guidelines(attribute_key);
CREATE INDEX idx_guideline_active ON verification_guidelines(is_active);
CREATE INDEX idx_guideline_category ON verification_guidelines(category);

-- ============================================================================
-- 7. Add Verification Status Column to hospital_attributes
-- ============================================================================
-- Note: This column may already exist; run only if needed
-- ALTER TABLE hospital.hospital_attributes
-- ADD COLUMN IF NOT EXISTS verification_status VARCHAR(50) DEFAULT 'unverified';

-- ============================================================================
-- Seed Sample Data
-- ============================================================================

-- Sample Verification Guidelines for a common attribute
INSERT INTO verification_guidelines (
  attribute_key,
  title,
  description,
  verification_steps,
  required_evidence,
  photo_count_minimum,
  quality_checklist,
  common_discrepancies,
  red_flags,
  category,
  priority,
  created_by
)
SELECT
  'accreditation_jci' as attribute_key,
  'JCI Accreditation Verification' as title,
  'Verify JCI accreditation status and validity of certificate' as description,
  jsonb_build_array(
    jsonb_build_object('step_number', 1, 'instruction', 'Request hospital to show JCI certificate', 'required_evidence', 'document'),
    jsonb_build_object('step_number', 2, 'instruction', 'Check certificate date and expiry', 'required_evidence', 'photo'),
    jsonb_build_object('step_number', 3, 'instruction', 'Verify hospital name matches on certificate', 'required_evidence', 'observation'),
    jsonb_build_object('step_number', 4, 'instruction', 'Check JCI website for verification', 'required_evidence', 'reference')
  ) as verification_steps,
  ARRAY['document', 'photo'] as required_evidence,
  2 as photo_count_minimum,
  ARRAY['Certificate visible', 'Date not expired', 'Hospital name matches', 'Accrediting body matches'] as quality_checklist,
  ARRAY['Certificate expired', 'Name mismatch', 'Wrong accrediting body'] as common_discrepancies,
  ARRAY['Counterfeit certificate', 'Wrong hospital name on certificate', 'Impossible dates'] as red_flags,
  'accreditation' as category,
  10 as priority,
  (SELECT id FROM users WHERE role = 'superadmin' LIMIT 1)
WHERE EXISTS (SELECT 1 FROM users WHERE role = 'superadmin');

COMMIT;
