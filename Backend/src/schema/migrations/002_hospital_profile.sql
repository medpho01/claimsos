-- Migration 002: Hospital Profile Management
-- Description: Creates structured hospital profile, certifications, key contacts,
--              panel empanelments, panel documents, and public share token tables.
-- Run after: 001_add_s3_support.sql
-- Rollback: 002_hospital_profile_rollback.sql

BEGIN;

-- ============================================================
-- 1. hospital_profile — Structured profile (replaces hospitals.details JSONB)
-- ============================================================

CREATE TABLE IF NOT EXISTS hospital_profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,

  -- Identity
  legal_name TEXT,
  rohini_id TEXT,
  hfr_id TEXT,
  pan_number TEXT,
  gst_number TEXT,
  website TEXT,
  email TEXT,
  phone TEXT,
  established_year INT,

  -- Address
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  district TEXT,
  state TEXT,
  pincode TEXT,
  latitude DECIMAL(9, 6),
  longitude DECIMAL(9, 6),
  google_maps_url TEXT,

  -- Hospital type & specialties
  hospital_type TEXT CHECK (hospital_type IN (
    'single_specialty', 'multi_specialty', 'nursing_home', 'day_care_center'
  )),
  specialties TEXT[] DEFAULT '{}',
  broad_specialties TEXT[] DEFAULT '{}',
  super_specialties TEXT[] DEFAULT '{}',

  -- Infrastructure counts (structured JSONB per category)
  beds JSONB DEFAULT '{}',
  -- { general_ward, sharing, private, deluxe, burns }

  icu_beds JSONB DEFAULT '{}',
  -- { micu, iccu, nicu, picu, neuro_icu, sicu }

  ot_emergency JSONB DEFAULT '{}',
  -- { emergency_room, trauma, minor_ot, major_ot, cath_lab }

  in_house_facilities JSONB DEFAULT '{}',
  -- { blood_bank, ambulance, pharmacy, defibrillator, o2_supply }

  -- Equipment (equipment_name -> count)
  equipment JSONB DEFAULT '{}',

  -- Services per specialty (specialty -> capability flags)
  services JSONB DEFAULT '{}',

  -- Lab capabilities (lab_type -> boolean)
  lab_capabilities JSONB DEFAULT '{}',

  -- Room rents per room type (room_type -> rate_per_day)
  room_rents JSONB DEFAULT '{}',

  -- Staff counts
  staff_counts JSONB DEFAULT '{}',
  -- { resident_doctors, specialists, visiting, nursing, paramedical }

  -- Compliance checklist (item -> boolean)
  compliance_checklist JSONB DEFAULT '{}',

  -- Banking details (encrypted at application layer before storage)
  bank_details JSONB DEFAULT '{}',
  -- { cheque_name, bank_name, branch, address, account_number, ifsc, account_type, pan_name, pan_number, micr }

  -- Verification / Badge
  verification_level TEXT CHECK (verification_level IN (
    'none', 'basic', 'standard', 'premium', 'finclarity_verified'
  )) DEFAULT 'none',
  verification_status TEXT CHECK (verification_status IN (
    'not_submitted', 'pending', 'in_review', 'verified', 'revoked'
  )) DEFAULT 'not_submitted',
  verification_notes TEXT,
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,

  -- Public profile
  public_slug TEXT UNIQUE,
  is_public_profile_enabled BOOLEAN DEFAULT FALSE,
  public_profile_sections JSONB DEFAULT '{}',
  -- { identity: true, beds: false, contacts: false, certifications: true, panels: false }

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (hospital_id)
);

CREATE INDEX idx_hospital_profile_hospital_id ON hospital_profile(hospital_id);
CREATE INDEX idx_hospital_profile_public_slug ON hospital_profile(public_slug)
  WHERE public_slug IS NOT NULL;
CREATE INDEX idx_hospital_profile_verification ON hospital_profile(verification_status, verification_level);
CREATE INDEX idx_hospital_profile_specialties ON hospital_profile USING GIN(specialties);


-- ============================================================
-- 2. hospital_certifications — Accreditations & registrations
-- ============================================================

CREATE TABLE IF NOT EXISTS hospital_certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,

  cert_type TEXT NOT NULL CHECK (cert_type IN (
    'state_govt', 'cghs', 'min_of_health', 'jci', 'nabh', 'nabl', 'iso', 'other'
  )),
  cert_name TEXT,
  issuing_body TEXT,
  certificate_number TEXT,
  issue_date DATE,
  expiry_date DATE,
  document_id UUID,  -- references hospital_doc(id) — not FK to allow flexibility

  is_active BOOLEAN DEFAULT TRUE,
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_hospital_certs_hospital_id ON hospital_certifications(hospital_id);
CREATE INDEX idx_hospital_certs_expiry ON hospital_certifications(expiry_date)
  WHERE is_active = TRUE;
CREATE INDEX idx_hospital_certs_type ON hospital_certifications(cert_type);


-- ============================================================
-- 3. hospital_key_contacts — Institution head, finance head, TPA, etc.
-- ============================================================

CREATE TABLE IF NOT EXISTS hospital_key_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,

  contact_type TEXT NOT NULL CHECK (contact_type IN (
    'institution_head', 'finance_head', 'tpa_contact', 'it_contact',
    'medical_superintendent', 'billing_manager', 'ceo', 'other'
  )),
  name TEXT NOT NULL,
  designation TEXT,
  email TEXT,
  phone TEXT,
  alternate_phone TEXT,
  is_primary BOOLEAN DEFAULT FALSE,
  is_public BOOLEAN DEFAULT FALSE,   -- Show on public profile?
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_hospital_contacts_hospital_id ON hospital_key_contacts(hospital_id);
CREATE INDEX idx_hospital_contacts_type ON hospital_key_contacts(hospital_id, contact_type);


-- ============================================================
-- 4. panel_empanelments — Enriched hospital-panel relationship
-- ============================================================

CREATE TABLE IF NOT EXISTS panel_empanelments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_panel_id UUID NOT NULL REFERENCES hospital_panels(id) ON DELETE CASCADE,
  hospital_id UUID NOT NULL REFERENCES hospitals(id),
  panel_id UUID NOT NULL REFERENCES panels(id),

  -- Empanelment metadata
  empanelment_start_date DATE,
  empanelment_end_date DATE,
  empanelment_status TEXT CHECK (empanelment_status IN (
    'active', 'expired', 'suspended', 'pending_renewal', 'terminated'
  )) DEFAULT 'active',
  empanelment_type TEXT CHECK (empanelment_type IN (
    'cashless', 'reimbursement', 'both'
  )) DEFAULT 'cashless',
  provider_id TEXT,              -- Hospital's provider/network ID in this panel's system
  network_type TEXT,             -- e.g., "Preferred Provider", "Standard Network"

  -- Hospital POC for this panel relationship
  hospital_poc_name TEXT,
  hospital_poc_designation TEXT,
  hospital_poc_email TEXT,
  hospital_poc_phone TEXT,

  -- Insurance company POC
  insurer_poc_name TEXT,
  insurer_poc_email TEXT,
  insurer_poc_phone TEXT,
  insurer_poc_region TEXT,

  -- Relationship Manager
  rm_name TEXT,
  rm_email TEXT,
  rm_phone TEXT,

  -- Portal access configuration
  portal_name TEXT,
  portal_url TEXT,
  portal_username TEXT,
  portal_password_enc TEXT,      -- AES-256-GCM encrypted: iv:tag:ciphertext (hex)
  auth_mechanism TEXT CHECK (auth_mechanism IN (
    'password_only', 'otp', 'password_and_otp', 'sso', 'certificate', 'none'
  )) DEFAULT 'password_only',
  two_fa_enabled BOOLEAN DEFAULT FALSE,
  two_fa_type TEXT CHECK (two_fa_type IN (
    'sms_otp', 'email_otp', 'totp_app', 'none'
  )) DEFAULT 'none',
  two_fa_contact_type TEXT CHECK (two_fa_contact_type IN (
    'hospital_poc', 'finance_head', 'institution_head', 'custom'
  )),
  two_fa_contact_name TEXT,
  two_fa_contact_phone TEXT,
  two_fa_contact_email TEXT,
  portal_notes TEXT,

  -- Extracted/entered contract key fields (from most recent active contract doc)
  contract_effective_date DATE,
  contract_expiry_date DATE,
  contract_package_rates JSONB DEFAULT '{}',
  -- { "CABG": 120000, "Hip Replacement": 180000, ... }
  contract_room_rents JSONB DEFAULT '{}',
  -- { "general_ward": 2000, "icu": 8000, ... }
  contract_exclusions JSONB DEFAULT '[]',
  contract_payment_terms TEXT,
  contract_pre_auth_validity TEXT,
  contract_query_resolution_tat TEXT,
  contract_settlement_tat TEXT,

  empanelment_notes TEXT,
  internal_tags TEXT[] DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (hospital_panel_id)
);

CREATE INDEX idx_panel_empanelments_hospital ON panel_empanelments(hospital_id);
CREATE INDEX idx_panel_empanelments_panel ON panel_empanelments(panel_id);
CREATE INDEX idx_panel_empanelments_status ON panel_empanelments(empanelment_status);
CREATE INDEX idx_panel_empanelments_expiry ON panel_empanelments(empanelment_end_date)
  WHERE empanelment_status = 'active';


-- ============================================================
-- 5. panel_documents — Contracts, MoUs, rate cards per empanelment
-- ============================================================

CREATE TABLE IF NOT EXISTS panel_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_empanelment_id UUID NOT NULL REFERENCES panel_empanelments(id) ON DELETE CASCADE,
  hospital_id UUID NOT NULL REFERENCES hospitals(id),
  panel_id UUID NOT NULL REFERENCES panels(id),

  doc_type TEXT NOT NULL CHECK (doc_type IN (
    'contract', 'mou', 'rate_card', 'empanelment_letter',
    'network_agreement', 'addendum', 'other'
  )),
  doc_name TEXT NOT NULL,

  -- S3 storage
  s3_key TEXT,
  s3_bucket TEXT,
  file_name TEXT,
  file_size_bytes BIGINT,
  mime_type TEXT,

  is_active BOOLEAN DEFAULT TRUE,
  effective_date DATE,
  expiry_date DATE,

  -- Extraction
  extraction_status TEXT CHECK (extraction_status IN (
    'pending', 'processing', 'completed', 'failed', 'not_applicable'
  )) DEFAULT 'not_applicable',
  extracted_fields JSONB DEFAULT '{}',
  extraction_reviewed BOOLEAN DEFAULT FALSE,
  extraction_reviewed_by UUID REFERENCES users(id),
  extraction_reviewed_at TIMESTAMPTZ,

  uploaded_by UUID REFERENCES users(id),
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_panel_docs_empanelment ON panel_documents(panel_empanelment_id);
CREATE INDEX idx_panel_docs_hospital ON panel_documents(hospital_id);
CREATE INDEX idx_panel_docs_type ON panel_documents(doc_type);
CREATE INDEX idx_panel_docs_active ON panel_documents(panel_empanelment_id, is_active, doc_type);


-- ============================================================
-- 6. public_share_tokens — Shareable links for profiles and patient data
-- ============================================================

CREATE TABLE IF NOT EXISTS public_share_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),

  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'hospital_profile', 'patient_summary', 'ipd_discharge_summary'
  )),
  resource_id UUID NOT NULL,

  created_by UUID REFERENCES users(id),
  is_active BOOLEAN DEFAULT TRUE,
  expires_at TIMESTAMPTZ,        -- NULL = permanent link
  max_views INT,                 -- NULL = unlimited
  view_count INT DEFAULT 0,

  visible_sections JSONB DEFAULT '{}',
  last_viewed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_share_tokens_token ON public_share_tokens(token);
CREATE INDEX idx_share_tokens_resource ON public_share_tokens(resource_type, resource_id);
CREATE INDEX idx_share_tokens_active ON public_share_tokens(is_active, expires_at);

COMMIT;
