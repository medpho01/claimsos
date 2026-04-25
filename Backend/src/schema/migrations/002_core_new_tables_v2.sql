-- Migration 002 (v2): Hospital Profile — Scalable Attribute Architecture
-- Replaces: 002_hospital_profile.sql (v1 design)
-- Changes from v1:
--   - Removes JSONB blobs from hospital_profile (beds, equipment, compliance_checklist, etc.)
--   - Removes hospital_certifications (merged into hospital_attributes with category='accreditation')
--   - Adds attribute_definitions catalog table
--   - Adds hospital_attributes typed store
--   - Adds hospital_documents (unified doc store replacing hospital_doc extensions)
--   - Adds document_extractions (machine-readable extraction pipeline)
--   - Adds verification_evidence (image/doc evidence per attribute)
--   - Keeps: hospital_key_contacts, panel_empanelments, panel_documents, public_share_tokens

BEGIN;

-- ============================================================
-- 1. attribute_definitions — Catalog of all possible hospital attributes
--    Admin-managed. Zero migrations needed to add new attribute types.
-- ============================================================

CREATE TABLE IF NOT EXISTS attribute_definitions (
  key TEXT PRIMARY KEY,
  -- Format: category.subcategory.name
  -- e.g., 'compliance_cert.fire_noc', 'infrastructure.ramp', 'beds.general_ward'

  category TEXT NOT NULL CHECK (category IN (
    'accreditation',       -- NABH, JCI, CGHS, NABL, State Govt registration
    'compliance_cert',     -- Fire NOC, Biomedical Waste, PCPNDT, Clinical Est. License
    'compliance_policy',   -- Internal policies (Infection Control, HIMS, Coding practices)
    'infrastructure',      -- Physical: ramp, lift, generator, parking, CSSD, etc.
    'beds',                -- Bed counts by type
    'icu',                 -- ICU bed counts
    'ot',                  -- OT / Emergency counts
    'equipment',           -- Medical equipment counts
    'in_house',            -- Blood bank, ambulance, pharmacy, O2 supply
    'lab',                 -- Lab capabilities
    'service',             -- Specialty service capabilities
    'staffing',            -- Doctor/nurse counts
    'room_rent'            -- Room rent rates
  )),

  label TEXT NOT NULL,                   -- Human-readable name, e.g., "Fire NOC"
  description TEXT,                      -- Optional help text
  data_type TEXT NOT NULL CHECK (data_type IN (
    'boolean',   -- Yes/No
    'integer',   -- Count or rate
    'text',      -- Free text
    'date',      -- Date value
    'document'   -- The attribute value IS a document (cert-type attributes)
  )),
  unit TEXT,                             -- 'count', 'INR/day', 'sqft' — for integer types

  -- Document requirements
  requires_document BOOLEAN DEFAULT FALSE,  -- Must upload a document to set this attribute
  has_expiry BOOLEAN DEFAULT FALSE,         -- Does this attribute expire (cert expiry date)?
  expected_issuing_authority TEXT,          -- e.g., 'NABH', 'Bhopal Fire Dept'

  -- Image verification
  can_verify_by_image BOOLEAN DEFAULT FALSE,
  image_guidance TEXT,                      -- Instructions: what photo to upload

  -- For empanelment completeness scoring
  is_mandatory_basic BOOLEAN DEFAULT FALSE,     -- Required for basic verification badge
  is_mandatory_empanelment BOOLEAN DEFAULT FALSE, -- Required before empanelment is active

  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attr_def_category ON attribute_definitions(category);
CREATE INDEX idx_attr_def_active ON attribute_definitions(is_active);


-- ============================================================
-- 2. hospital_profile — Stable identity and address data ONLY
--    All extensible operational data lives in hospital_attributes
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

  -- Type and specialties (stable, low-cardinality)
  hospital_type TEXT CHECK (hospital_type IN (
    'single_specialty', 'multi_specialty', 'nursing_home', 'day_care_center'
  )),
  specialties TEXT[] DEFAULT '{}',
  broad_specialties TEXT[] DEFAULT '{}',
  super_specialties TEXT[] DEFAULT '{}',

  -- Banking (sensitive — encrypted JSONB at app layer, not in attribute store)
  bank_details JSONB DEFAULT '{}',

  -- Verification badge
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
-- 3. hospital_documents — Unified document store for all hospital files
--    Replaces hospital_doc (for hospital-level docs) and is referenced
--    by panel_documents, hospital_attributes, and verification_evidence
-- ============================================================

CREATE TABLE IF NOT EXISTS hospital_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,

  -- Classification
  document_category TEXT NOT NULL CHECK (document_category IN (
    'accreditation',    -- NABH, JCI certificates
    'compliance',       -- Fire NOC, Biomedical Waste cert
    'panel',            -- Contracts, MoUs (linked to panel_empanelments)
    'infrastructure',   -- Photos of ramps, generators, lifts
    'legal',            -- PAN card, GST cert, Trade license
    'photo',            -- Hospital exterior/interior photos
    'logo',             -- Hospital logo
    'brochure',         -- Marketing materials
    'general'           -- Catch-all
  )),
  document_type TEXT NOT NULL,  -- More specific: 'noc', 'contract', 'mou', 'certificate', 'photo', 'id_proof', etc.

  -- Optional: link to the attribute this document evidences
  attribute_key TEXT REFERENCES attribute_definitions(key),

  -- Optional: link to panel empanelment (for panel-specific docs)
  panel_empanelment_id UUID,  -- FK added after panel_empanelments is created

  document_name TEXT NOT NULL,

  -- S3 storage
  s3_key TEXT,
  s3_bucket TEXT,
  file_name TEXT,
  file_size_bytes BIGINT,
  mime_type TEXT,

  is_primary BOOLEAN DEFAULT TRUE,   -- Is this the current/active version?
  expiry_date DATE,                  -- For cert documents: when this cert expires
  is_public BOOLEAN DEFAULT FALSE,   -- Can be returned in public profile API?

  notes TEXT,
  uploaded_by UUID REFERENCES users(id),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_hosp_docs_hospital ON hospital_documents(hospital_id);
CREATE INDEX idx_hosp_docs_category ON hospital_documents(hospital_id, document_category);
CREATE INDEX idx_hosp_docs_attribute ON hospital_documents(attribute_key)
  WHERE attribute_key IS NOT NULL;
CREATE INDEX idx_hosp_docs_expiry ON hospital_documents(expiry_date)
  WHERE expiry_date IS NOT NULL AND is_primary = TRUE;


-- ============================================================
-- 4. hospital_attributes — Typed attribute store per hospital
--    All extensible data: beds, equipment, compliance, certs, etc.
-- ============================================================

CREATE TABLE IF NOT EXISTS hospital_attributes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  attribute_key TEXT NOT NULL REFERENCES attribute_definitions(key),

  -- Typed value columns (only one will be set based on attribute_definitions.data_type)
  value_boolean BOOLEAN,
  value_integer INTEGER,
  value_text TEXT,
  value_date DATE,

  -- For document-type attributes (the cert IS the value)
  document_id UUID REFERENCES hospital_documents(id),

  -- Certificate-specific fields (populated for compliance_cert and accreditation categories)
  expires_at DATE,
  certificate_number TEXT,
  issuing_authority TEXT,
  issued_at DATE,

  -- Verification
  verification_status TEXT CHECK (verification_status IN (
    'unverified',         -- No evidence submitted
    'pending_review',     -- Evidence uploaded, awaiting admin review
    'verified_by_doc',    -- Verified via a document
    'verified_by_image',  -- Verified via a photo
    'verified_manual',    -- Admin manually confirmed
    'automated_verified', -- System-verified (e.g., Rohini API lookup)
    'expired',            -- Certificate past expiry date
    'rejected'            -- Admin rejected the submitted evidence
  )) DEFAULT 'unverified',
  verification_method TEXT CHECK (verification_method IN (
    'document', 'image', 'manual', 'automated'
  )),
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  verification_notes TEXT,

  last_updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (hospital_id, attribute_key)
);

CREATE INDEX idx_hosp_attrs_hospital ON hospital_attributes(hospital_id);
CREATE INDEX idx_hosp_attrs_key ON hospital_attributes(attribute_key);
CREATE INDEX idx_hosp_attrs_category ON hospital_attributes(hospital_id, attribute_key)
  WHERE verification_status = 'unverified';
CREATE INDEX idx_hosp_attrs_expiry ON hospital_attributes(expires_at)
  WHERE expires_at IS NOT NULL AND verification_status NOT IN ('expired', 'rejected');
CREATE INDEX idx_hosp_attrs_pending ON hospital_attributes(verification_status)
  WHERE verification_status = 'pending_review';


-- ============================================================
-- 5. document_extractions — Machine-readable extraction results
--    Stores AI/OCR output for any uploaded document
-- ============================================================

CREATE TABLE IF NOT EXISTS document_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES hospital_documents(id) ON DELETE CASCADE,

  extraction_source TEXT NOT NULL CHECK (extraction_source IN (
    'manual',         -- Admin manually entered fields
    'claude_ai',      -- Claude API extraction
    'aws_textract',   -- AWS Textract OCR
    'google_vision'   -- Google Vision OCR
  )),
  extraction_template TEXT,          -- Template/prompt key used
  extraction_prompt TEXT,            -- Full prompt used (for auditing)

  raw_extracted_data JSONB DEFAULT '{}',    -- Unprocessed engine output
  structured_data JSONB DEFAULT '{}',       -- Cleaned, validated fields
  confidence_score DECIMAL(4, 3),           -- 0.000 to 1.000

  extraction_status TEXT CHECK (extraction_status IN (
    'pending', 'processing', 'completed', 'failed', 'skipped'
  )) DEFAULT 'pending',
  failure_reason TEXT,

  -- Once reviewed, fields can be applied to hospital_attributes
  applied_to_hospital BOOLEAN DEFAULT FALSE,
  applied_at TIMESTAMPTZ,
  applied_by UUID REFERENCES users(id),

  reviewed BOOLEAN DEFAULT FALSE,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_doc_extractions_document ON document_extractions(document_id);
CREATE INDEX idx_doc_extractions_status ON document_extractions(extraction_status);
CREATE INDEX idx_doc_extractions_pending_review ON document_extractions(reviewed)
  WHERE reviewed = FALSE AND extraction_status = 'completed';


-- ============================================================
-- 6. verification_evidence — Images/docs supporting an attribute
--    Many-to-one: multiple evidence items can support one attribute
-- ============================================================

CREATE TABLE IF NOT EXISTS verification_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  attribute_id UUID NOT NULL REFERENCES hospital_attributes(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES hospital_documents(id),

  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'photo',                  -- Photo of physical infrastructure
    'document',               -- Certificate or document
    'manual_confirmation'     -- Admin confirmed without a document
  )),
  caption TEXT,               -- Optional description of what the evidence shows

  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),

  -- Admin review of this evidence item
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  review_status TEXT CHECK (review_status IN (
    'pending', 'accepted', 'rejected'
  )) DEFAULT 'pending'
);

CREATE INDEX idx_verif_evidence_attribute ON verification_evidence(attribute_id);
CREATE INDEX idx_verif_evidence_hospital ON verification_evidence(hospital_id);
CREATE INDEX idx_verif_evidence_pending ON verification_evidence(review_status)
  WHERE review_status = 'pending';


-- ============================================================
-- 7. hospital_key_contacts — Institution head, finance, TPA, etc.
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
  is_public BOOLEAN DEFAULT FALSE,
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_hosp_contacts_hospital ON hospital_key_contacts(hospital_id);
CREATE INDEX idx_hosp_contacts_type ON hospital_key_contacts(hospital_id, contact_type);


-- ============================================================
-- 8. panel_empanelments — Enriched hospital-panel relationship
-- ============================================================

CREATE TABLE IF NOT EXISTS panel_empanelments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_panel_id UUID NOT NULL REFERENCES hospital_panels(id) ON DELETE CASCADE,
  hospital_id UUID NOT NULL REFERENCES hospitals(id),
  panel_id UUID NOT NULL REFERENCES panels(id),

  empanelment_start_date DATE,
  empanelment_end_date DATE,
  empanelment_status TEXT CHECK (empanelment_status IN (
    'active', 'expired', 'suspended', 'pending_renewal', 'terminated'
  )) DEFAULT 'active',
  empanelment_type TEXT CHECK (empanelment_type IN (
    'cashless', 'reimbursement', 'both'
  )) DEFAULT 'cashless',
  provider_id TEXT,
  network_type TEXT,

  -- Hospital POC
  hospital_poc_name TEXT,
  hospital_poc_designation TEXT,
  hospital_poc_email TEXT,
  hospital_poc_phone TEXT,

  -- Insurer POC
  insurer_poc_name TEXT,
  insurer_poc_email TEXT,
  insurer_poc_phone TEXT,
  insurer_poc_region TEXT,

  -- Relationship Manager
  rm_name TEXT,
  rm_email TEXT,
  rm_phone TEXT,

  -- Portal access
  portal_name TEXT,
  portal_url TEXT,
  portal_username TEXT,
  portal_password_enc TEXT,  -- AES-256-GCM encrypted: iv:tag:ciphertext (hex)
  auth_mechanism TEXT CHECK (auth_mechanism IN (
    'password_only', 'otp', 'password_and_otp', 'sso', 'certificate', 'none'
  )) DEFAULT 'password_only',
  two_fa_enabled BOOLEAN DEFAULT FALSE,
  two_fa_type TEXT CHECK (two_fa_type IN ('sms_otp', 'email_otp', 'totp_app', 'none')) DEFAULT 'none',
  two_fa_contact_type TEXT CHECK (two_fa_contact_type IN (
    'hospital_poc', 'finance_head', 'institution_head', 'custom'
  )),
  two_fa_contact_name TEXT,
  two_fa_contact_phone TEXT,
  two_fa_contact_email TEXT,
  portal_notes TEXT,

  -- Extracted contract fields (from most recent active contract doc)
  contract_effective_date DATE,
  contract_expiry_date DATE,
  contract_package_rates JSONB DEFAULT '{}',
  contract_room_rents JSONB DEFAULT '{}',
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

-- Add FK from hospital_documents to panel_empanelments (now that the table exists)
ALTER TABLE hospital_documents
  ADD CONSTRAINT fk_hospital_documents_empanelment
  FOREIGN KEY (panel_empanelment_id)
  REFERENCES panel_empanelments(id)
  ON DELETE SET NULL;


-- ============================================================
-- 9. panel_documents — Links panel empanelments to hospital_documents
-- ============================================================

CREATE TABLE IF NOT EXISTS panel_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_empanelment_id UUID NOT NULL REFERENCES panel_empanelments(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES hospital_documents(id),

  doc_type TEXT NOT NULL CHECK (doc_type IN (
    'contract', 'mou', 'rate_card', 'empanelment_letter',
    'network_agreement', 'addendum', 'other'
  )),
  is_active BOOLEAN DEFAULT TRUE,   -- Most recent active = current contract
  effective_date DATE,
  expiry_date DATE,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_panel_docs_empanelment ON panel_documents(panel_empanelment_id);
CREATE INDEX idx_panel_docs_active ON panel_documents(panel_empanelment_id, is_active);


-- ============================================================
-- 10. public_share_tokens — Shareable links
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
  expires_at TIMESTAMPTZ,
  max_views INT,
  view_count INT DEFAULT 0,
  visible_sections JSONB DEFAULT '{}',
  last_viewed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_share_tokens_token ON public_share_tokens(token);
CREATE INDEX idx_share_tokens_resource ON public_share_tokens(resource_type, resource_id);
CREATE INDEX idx_share_tokens_active ON public_share_tokens(is_active, expires_at);

COMMIT;
