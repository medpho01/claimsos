-- Migration: Add Panel Attributes System (Flexible Attribute Management)
-- Date: 2026-04-19
-- Description:
--   Implements flexible panel attribute system following the hospital attributes pattern
--   Three new tables:
--   1. panel_attribute_definitions - metadata (what attributes are available)
--   2. panel_attributes - values (actual data for each hospital-panel)
--   3. panel_attribute_documents - documents linked to attributes
--
--   NOTE: Existing panel_empanelments table retained for backward compatibility
--   New code uses flexible panel_attributes system
--   Gradual migration path for existing data

BEGIN;

-- ============================================================================
-- TABLE 1: panel_attribute_definitions (METADATA)
-- ============================================================================
-- Defines what attributes are available for panel relationships
-- Similar to hospital.attribute_definitions

CREATE TABLE IF NOT EXISTS hospital.panel_attribute_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Attribute Identity
    key VARCHAR(255) NOT NULL UNIQUE,
    label VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),  -- 'portal', 'credential', 'contact', 'document', 'operational'

    -- Data Type & Validation
    data_type VARCHAR(50) NOT NULL CHECK (data_type IN (
        'text',
        'textarea',
        'email',
        'phone',
        'url',
        'date',
        'boolean',
        'single_select',
        'multi_select',
        'file',
        'json',
        'encrypted_text'
    )),

    -- For select types
    options JSONB,
    validation_regex VARCHAR(500),
    validation_min_length INT,
    validation_max_length INT,

    -- Metadata
    is_required BOOLEAN DEFAULT FALSE,
    is_unique BOOLEAN DEFAULT FALSE,
    default_value TEXT,
    sort_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,

    -- Audit
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES hospital.users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES hospital.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_panel_attr_def_key ON hospital.panel_attribute_definitions(key);
CREATE INDEX IF NOT EXISTS idx_panel_attr_def_category ON hospital.panel_attribute_definitions(category);
CREATE INDEX IF NOT EXISTS idx_panel_attr_def_active ON hospital.panel_attribute_definitions(is_active);

-- ============================================================================
-- TABLE 2: panel_attributes (VALUES)
-- ============================================================================
-- Stores actual attribute values for each hospital-panel relationship
-- References hospital_panels (the primary relationship table)
-- One row per attribute per hospital-panel pair

CREATE TABLE IF NOT EXISTS hospital.panel_attributes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Reference to Primary Relationship
    hospital_panel_id UUID NOT NULL REFERENCES hospital.hospital_panels(id) ON DELETE CASCADE,

    -- Reference to Definition
    panel_attribute_definition_id UUID NOT NULL REFERENCES hospital.panel_attribute_definitions(id) ON DELETE RESTRICT,

    -- Denormalized for Query Performance
    hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
    panel_id UUID NOT NULL REFERENCES hospital.panels(id) ON DELETE CASCADE,
    attribute_key VARCHAR(255) NOT NULL,

    -- Attribute Values (Multiple columns for different types)
    value_text TEXT,
    value_boolean BOOLEAN,
    value_date DATE,
    value_json JSONB,
    value_encrypted TEXT,

    -- Document Reference (for file type attributes)
    document_id UUID REFERENCES hospital.hospital_documents(id) ON DELETE SET NULL,

    -- Status & Validation
    is_valid BOOLEAN DEFAULT TRUE,
    validation_errors TEXT,
    last_validated_at TIMESTAMP WITH TIME ZONE,

    -- Audit Trail
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES hospital.users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES hospital.users(id) ON DELETE SET NULL,

    -- Constraints
    UNIQUE (hospital_panel_id, panel_attribute_definition_id),
    CONSTRAINT valid_value CHECK (panel_attribute_definition_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_panel_attr_hospital_panel ON hospital.panel_attributes(hospital_panel_id);
CREATE INDEX IF NOT EXISTS idx_panel_attr_key ON hospital.panel_attributes(attribute_key);
CREATE INDEX IF NOT EXISTS idx_panel_attr_definition ON hospital.panel_attributes(panel_attribute_definition_id);
CREATE INDEX IF NOT EXISTS idx_panel_attr_hospital ON hospital.panel_attributes(hospital_id);
CREATE INDEX IF NOT EXISTS idx_panel_attr_panel ON hospital.panel_attributes(panel_id);

-- ============================================================================
-- TABLE 3: panel_attribute_documents (JUNCTION)
-- ============================================================================
-- Manages documents linked to panel attributes
-- Follows the same pattern as hospital_attribute_documents
-- Supports multiple documents per attribute, versioning, and expiry tracking

CREATE TABLE IF NOT EXISTS hospital.panel_attribute_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relationships
    panel_attribute_id UUID NOT NULL REFERENCES hospital.panel_attributes(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES hospital.hospital_documents(id) ON DELETE CASCADE,

    -- Metadata for Document Versions
    version VARCHAR(50),  -- e.g., "1.0", "2.0", "v3.1"

    -- Document Lifecycle Dates
    effective_date DATE,
    expiry_date DATE,

    -- Primary Document Indicator
    is_primary BOOLEAN DEFAULT FALSE,  -- Which document is the "active" one

    -- Audit
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    UNIQUE (panel_attribute_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_panel_attr_docs_attribute ON hospital.panel_attribute_documents(panel_attribute_id);
CREATE INDEX IF NOT EXISTS idx_panel_attr_docs_document ON hospital.panel_attribute_documents(document_id);
CREATE INDEX IF NOT EXISTS idx_panel_attr_docs_expiry ON hospital.panel_attribute_documents(expiry_date);

-- ============================================================================
-- SEED DATA: Panel Attribute Definitions (36 total)
-- ============================================================================

-- Portal & Access Configuration (4)
INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES
('portal_url', 'Portal URL', 'Main URL for panel portal access', 'portal', 'url', false, true, 1),
('portal_email', 'Portal Email Address', 'Email address for panel communication', 'portal', 'email', false, true, 2),
('portal_name', 'Portal Name', 'Name/identifier of the portal system', 'portal', 'text', false, true, 3),
('portal_notes', 'Portal Access Notes', 'Additional notes about portal access and troubleshooting', 'portal', 'textarea', false, true, 4);

-- Authentication Type (1)
INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order, options)
VALUES
('authentication_type', 'Authentication Type', 'Type of authentication required for panel portal', 'credential', 'single_select', true, true, 10,
 '{"email_password":"Email & Password","aadhar_2fa":"Aadhar + 2FA","email_password_2fa":"Email & Password + 2FA","sso":"Single Sign-On","certificate":"Certificate Based","none":"No Auth Required"}');

-- Portal Credentials - Encrypted (2)
INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES
('portal_username', 'Portal Username', 'Username for portal login', 'credential', 'encrypted_text', false, true, 11),
('portal_password', 'Portal Password', 'Password for portal login (encrypted at rest)', 'credential', 'encrypted_text', false, true, 12);

-- 2FA Configuration (4)
INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order, options)
VALUES
('two_fa_method', '2FA Method', 'Type of two-factor authentication method', 'credential', 'single_select', false, true, 13,
 '{"none":"None","sms_otp":"SMS OTP","email_otp":"Email OTP","authenticator_app":"Authenticator App"}');

INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES
('two_fa_phone', '2FA Phone Number', 'Phone number for OTP delivery', 'credential', 'phone', false, true, 14),
('two_fa_email', '2FA Email Address', 'Email address for OTP delivery', 'credential', 'email', false, true, 15),
('two_fa_secret', '2FA Secret Key', 'Secret key for authenticator apps (encrypted)', 'credential', 'encrypted_text', false, true, 16);

-- Hospital Primary Contact (4)
INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES
('hospital_primary_contact_name', 'Hospital Primary Contact - Name', 'Primary contact person from hospital', 'contact', 'text', false, true, 30),
('hospital_primary_contact_designation', 'Hospital Primary Contact - Designation', 'Job title/designation', 'contact', 'text', false, true, 31),
('hospital_primary_contact_email', 'Hospital Primary Contact - Email', 'Email address', 'contact', 'email', false, true, 32),
('hospital_primary_contact_phone', 'Hospital Primary Contact - Phone', 'Phone number', 'contact', 'phone', false, true, 33);

-- Hospital Secondary Contact (4)
INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES
('hospital_secondary_contact_name', 'Hospital Secondary Contact - Name', 'Secondary/backup contact from hospital', 'contact', 'text', false, true, 34),
('hospital_secondary_contact_designation', 'Hospital Secondary Contact - Designation', 'Job title/designation', 'contact', 'text', false, true, 35),
('hospital_secondary_contact_email', 'Hospital Secondary Contact - Email', 'Email address', 'contact', 'email', false, true, 36),
('hospital_secondary_contact_phone', 'Hospital Secondary Contact - Phone', 'Phone number', 'contact', 'phone', false, true, 37);

-- Panel Primary Contact (4)
INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES
('panel_primary_contact_name', 'Panel Primary Contact - Name', 'Primary contact person from panel/insurer', 'contact', 'text', false, true, 40),
('panel_primary_contact_designation', 'Panel Primary Contact - Designation', 'Job title/designation', 'contact', 'text', false, true, 41),
('panel_primary_contact_email', 'Panel Primary Contact - Email', 'Email address', 'contact', 'email', false, true, 42),
('panel_primary_contact_phone', 'Panel Primary Contact - Phone', 'Phone number', 'contact', 'phone', false, true, 43);

-- Panel Secondary Contact (4)
INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES
('panel_secondary_contact_name', 'Panel Secondary Contact - Name', 'Secondary/backup contact from panel', 'contact', 'text', false, true, 44),
('panel_secondary_contact_designation', 'Panel Secondary Contact - Designation', 'Job title/designation', 'contact', 'text', false, true, 45),
('panel_secondary_contact_email', 'Panel Secondary Contact - Email', 'Email address', 'contact', 'email', false, true, 46),
('panel_secondary_contact_phone', 'Panel Secondary Contact - Phone', 'Phone number', 'contact', 'phone', false, true, 47);

-- Document Configuration (3)
INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES
('contracts', 'Contracts', 'Contract documents with panel', 'document', 'file', false, true, 50),
('mous', 'MOUs', 'Memorandum of Understanding documents', 'document', 'file', false, true, 51),
('other_documents', 'Other Documents', 'Additional important documents', 'document', 'file', false, true, 52);

-- Operational Attributes (6)
INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order, options)
VALUES
('claim_submission_method', 'Claim Submission Method', 'How claims are submitted to this panel', 'operational', 'single_select', false, true, 60,
 '{"email":"Email","portal":"Online Portal","edi":"EDI","api":"API"}');

INSERT INTO hospital.panel_attribute_definitions
(key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES
('claim_submission_email', 'Claim Submission Email', 'Email address for submitting claims', 'operational', 'email', false, true, 61),
('authorization_required', 'Authorization Required', 'Whether pre-authorization is required', 'operational', 'boolean', false, true, 62),
('pre_auth_validity_days', 'Pre-Auth Validity (Days)', 'How many days pre-auth is valid', 'operational', 'text', false, true, 63),
('bill_submission_deadline_days', 'Bill Submission Deadline (Days)', 'Days to submit bills after discharge', 'operational', 'text', false, true, 64),
('claim_processing_sla_days', 'Claim Processing SLA (Days)', 'SLA for claim processing', 'operational', 'text', false, true, 65);

COMMIT;
