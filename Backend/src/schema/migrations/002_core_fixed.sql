-- Hospital Profile Schema - Fixed for finclarity_prod
BEGIN;

-- 1. CREATE attribute_definitions (catalog of all possible attributes)
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

-- 2. CREATE hospital_profile
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

-- 3. CREATE hospital_documents
CREATE TABLE IF NOT EXISTS hospital.hospital_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  
  document_category TEXT NOT NULL,
  document_type TEXT NOT NULL,
  attribute_key TEXT REFERENCES hospital.attribute_definitions(key),
  panel_empanelment_id UUID,
  
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

-- 4. CREATE hospital_attributes
CREATE TABLE IF NOT EXISTS hospital.hospital_attributes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  attribute_key TEXT NOT NULL REFERENCES hospital.attribute_definitions(key),
  
  value_boolean BOOLEAN,
  value_integer INTEGER,
  value_text TEXT,
  value_date DATE,
  
  document_id UUID REFERENCES hospital.hospital_documents(id),
  
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

-- 5. CREATE document_extractions
CREATE TABLE IF NOT EXISTS hospital.document_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL UNIQUE REFERENCES hospital.hospital_documents(id) ON DELETE CASCADE,
  
  extraction_source TEXT NOT NULL,
  extraction_template TEXT,
  extraction_prompt TEXT,
  
  raw_extracted_data JSONB DEFAULT '{}',
  structured_data JSONB DEFAULT '{}',
  confidence_score DECIMAL(4, 3),
  
  extraction_status TEXT DEFAULT 'pending',
  failure_reason TEXT,
  
  applied_to_hospital BOOLEAN DEFAULT FALSE,
  applied_at TIMESTAMPTZ,
  applied_by UUID REFERENCES hospital.users(id),
  
  reviewed BOOLEAN DEFAULT FALSE,
  reviewed_by UUID REFERENCES hospital.users(id),
  reviewed_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_extractions_status ON hospital.document_extractions(extraction_status);

-- 6. CREATE verification_evidence
CREATE TABLE IF NOT EXISTS hospital.verification_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  attribute_id UUID NOT NULL REFERENCES hospital.hospital_attributes(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES hospital.hospital_documents(id),
  
  evidence_type TEXT NOT NULL,
  caption TEXT,
  
  uploaded_by UUID REFERENCES hospital.users(id),
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  
  reviewed_by UUID REFERENCES hospital.users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  review_status TEXT DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_verif_evidence_attribute ON hospital.verification_evidence(attribute_id);

-- 7. CREATE hospital_key_contacts
CREATE TABLE IF NOT EXISTS hospital.hospital_key_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  
  contact_type TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_hosp_contacts_hospital ON hospital.hospital_key_contacts(hospital_id);

-- 8. CREATE panel_empanelments
CREATE TABLE IF NOT EXISTS hospital.panel_empanelments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_panel_id UUID NOT NULL UNIQUE REFERENCES hospital.hospital_panels(id) ON DELETE CASCADE,
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id),
  panel_id UUID NOT NULL REFERENCES hospital.panels(id),
  
  empanelment_start_date DATE,
  empanelment_end_date DATE,
  empanelment_status TEXT DEFAULT 'active',
  empanelment_type TEXT DEFAULT 'cashless',
  provider_id TEXT,
  network_type TEXT,
  
  hospital_poc_name TEXT,
  hospital_poc_designation TEXT,
  hospital_poc_email TEXT,
  hospital_poc_phone TEXT,
  
  insurer_poc_name TEXT,
  insurer_poc_email TEXT,
  insurer_poc_phone TEXT,
  insurer_poc_region TEXT,
  
  rm_name TEXT,
  rm_email TEXT,
  rm_phone TEXT,
  
  portal_name TEXT,
  portal_url TEXT,
  portal_username TEXT,
  portal_password_enc TEXT,
  auth_mechanism TEXT DEFAULT 'password_only',
  two_fa_enabled BOOLEAN DEFAULT FALSE,
  two_fa_type TEXT DEFAULT 'none',
  two_fa_contact_type TEXT,
  two_fa_contact_name TEXT,
  two_fa_contact_phone TEXT,
  two_fa_contact_email TEXT,
  portal_notes TEXT,
  
  contract_effective_date DATE,
  contract_expiry_date DATE,
  contract_package_rates JSONB DEFAULT '{}',
  contract_room_rents JSONB DEFAULT '{}',
  contract_exclusions JSONB DEFAULT '[]',
  contract_payment_terms TEXT,
  
  empanelment_notes TEXT,
  internal_tags TEXT[] DEFAULT '{}',
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_panel_empanelments_hospital ON hospital.panel_empanelments(hospital_id);
CREATE INDEX IF NOT EXISTS idx_panel_empanelments_status ON hospital.panel_empanelments(empanelment_status);

-- 9. CREATE panel_documents
CREATE TABLE IF NOT EXISTS hospital.panel_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_empanelment_id UUID NOT NULL REFERENCES hospital.panel_empanelments(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES hospital.hospital_documents(id),
  
  doc_type TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  effective_date DATE,
  expiry_date DATE,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_panel_docs_empanelment ON hospital.panel_documents(panel_empanelment_id);

-- 10. CREATE public_share_tokens
CREATE TABLE IF NOT EXISTS hospital.public_share_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  
  resource_type TEXT NOT NULL,
  resource_id UUID NOT NULL,
  
  created_by UUID REFERENCES hospital.users(id),
  is_active BOOLEAN DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  max_views INT,
  view_count INT DEFAULT 0,
  visible_sections JSONB DEFAULT '{}',
  last_viewed_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_token ON hospital.public_share_tokens(token);

COMMIT;
