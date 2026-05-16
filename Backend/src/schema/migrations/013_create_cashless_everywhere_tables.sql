-- Migration 013: Cashless Everywhere - core tables
-- Date: 2026-05-16
-- Description:
--   Creates the 5 net-new tables for the Cashless Everywhere email interface:
--     1. preauth_form_templates   (the 42 PDFs from SOP Sheet 3)
--     2. mou_templates            (the 11 MoU type metadata from SOP Sheet 4)
--     3. preauth_submissions      (channel-agnostic submission lifecycle)
--     4. emails_outbound          (sent mail with Gmail threading)
--     5. emails_inbound           (received mail with thread matching)
--
--   panel_default_attributes is in migration 015 (after attribute defs land).
--   Hospital-wide Gmail OAuth is stored as panel_attributes on the CE system
--   panel row, not in a dedicated table.
--
--   See docs/v2/CASHLESS_EMAIL_DATA_MODEL.md for design rationale.

BEGIN;

-- ============================================================================
-- 1. preauth_form_templates — the 42 pre-auth PDF templates
-- ============================================================================
CREATE TABLE IF NOT EXISTS hospital.preauth_form_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name VARCHAR(255) NOT NULL,                       -- "Medi Assist Pre-Auth Form"
  code VARCHAR(50) NOT NULL UNIQUE,                 -- 'MEDI_ASSIST_PREAUTH'

  -- Storage
  source_url TEXT,                                   -- original SOP URL (krbusinesssolutions.in)
  s3_key TEXT,                                       -- our S3 copy; nullable until ingest completes
  file_size_bytes BIGINT,
  page_count INT,

  -- AcroForm metadata
  is_acroform BOOLEAN,                               -- determined at PDF ingest
  field_map JSONB DEFAULT '{}'::jsonb,               -- pdf_field_name → claim/patient data path

  -- Lifecycle
  is_active BOOLEAN DEFAULT TRUE,
  notes TEXT,                                        -- "Key Differences from Standard" from SOP
  version VARCHAR(20),

  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES hospital.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_preauth_form_code ON hospital.preauth_form_templates(code);
CREATE INDEX IF NOT EXISTS idx_preauth_form_active ON hospital.preauth_form_templates(is_active);

CREATE TRIGGER update_preauth_form_templates_modtime
  BEFORE UPDATE ON hospital.preauth_form_templates
  FOR EACH ROW EXECUTE PROCEDURE update_modified_column();


-- ============================================================================
-- 2. mou_templates — the 11 MoU type metadata
-- ============================================================================
CREATE TABLE IF NOT EXISTS hospital.mou_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name VARCHAR(255) NOT NULL,                       -- "Letter of Consent (MOST DETAILED)"
  code VARCHAR(50) NOT NULL UNIQUE,                 -- 'LOC_DETAILED'
  applies_to_label VARCHAR(255),                    -- SOP Insurer/TPA column (free-text reference)

  -- Metadata from SOP Sheet 4
  validity_text TEXT,                                -- "Per agreement (negotiable)"
  key_clauses TEXT,
  rate_terms TEXT,
  audit_rights TEXT,
  submission_deadline TEXT,                         -- "15 days from discharge"
  payment_timeline TEXT,                            -- "30 days from complete docs"
  risk_level VARCHAR(20),                            -- 'LOW' | 'LOW-MEDIUM' | 'MEDIUM' | 'HIGH'
  risk_notes TEXT,
  source_template_url TEXT,                         -- if SOP links to actual template doc
  s3_key TEXT,                                       -- optional: blank template binary

  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mou_templates_code ON hospital.mou_templates(code);
CREATE INDEX IF NOT EXISTS idx_mou_templates_active ON hospital.mou_templates(is_active);

CREATE TRIGGER update_mou_templates_modtime
  BEFORE UPDATE ON hospital.mou_templates
  FOR EACH ROW EXECUTE PROCEDURE update_modified_column();


-- ============================================================================
-- 3. emails_outbound — sent emails (created BEFORE preauth_submissions
--    because of FK ordering; preauth_submissions.email_outbound_id refs this)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hospital.emails_outbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,

  -- Backlinks (nullable — could be a non-claim email later)
  ipd_id UUID REFERENCES hospital.ipds(id) ON DELETE SET NULL,
  hospital_panel_id UUID REFERENCES hospital.hospital_panels(id) ON DELETE SET NULL,
  preauth_submission_id UUID,                       -- FK added after preauth_submissions exists

  -- Routing
  to_addresses TEXT[] NOT NULL,
  cc_addresses TEXT[] DEFAULT '{}',
  from_address VARCHAR(255) NOT NULL,                -- hospital's Gmail address
  reply_to VARCHAR(255),

  -- Content
  subject TEXT NOT NULL,
  body_text TEXT,
  body_html TEXT,
  attachments JSONB DEFAULT '[]'::jsonb,
  -- Shape: [{ filename, s3_key, mime_type, size_bytes, document_id?: uuid }]

  -- Gmail threading
  gmail_message_id VARCHAR(255),                    -- Message-Id header value, captured after send
  gmail_thread_id VARCHAR(255),
  in_reply_to VARCHAR(255),
  references_header TEXT,

  -- Send status
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  -- 'queued' | 'sending' | 'sent' | 'bounced' | 'failed'
  failure_reason TEXT,
  attempts INT NOT NULL DEFAULT 0,

  -- Timing
  queued_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMP WITH TIME ZONE,

  -- Idempotency
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,

  composed_by VARCHAR(100),                         -- 'user:<uuid>' | 'system:composer:v1'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_eo_gmail_message_id ON hospital.emails_outbound(gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eo_thread ON hospital.emails_outbound(gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_eo_ipd ON hospital.emails_outbound(ipd_id);
CREATE INDEX IF NOT EXISTS idx_eo_hospital_status ON hospital.emails_outbound(hospital_id, status);
CREATE INDEX IF NOT EXISTS idx_eo_queued ON hospital.emails_outbound(status) WHERE status = 'queued';

CREATE TRIGGER update_emails_outbound_modtime
  BEFORE UPDATE ON hospital.emails_outbound
  FOR EACH ROW EXECUTE PROCEDURE update_modified_column();


-- ============================================================================
-- 4. preauth_submissions — channel-agnostic submission lifecycle
--    (one row per submission ATTEMPT — resubmissions get new rows linked
--     via resubmission_of_id)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hospital.preauth_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Linkage
  ipd_id UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  hospital_panel_id UUID NOT NULL REFERENCES hospital.hospital_panels(id),
  -- ↑ The key. ALL operational config is read via hospital_panel_id →
  -- panel_attributes. Channel-agnostic: email today, portal tomorrow.

  -- Channel (determined at submission time from panel_attributes.claim_submission_method)
  submitted_via VARCHAR(20) NOT NULL,                -- 'email' | 'portal' | 'edi' | 'api'

  -- What went out
  preauth_form_template_id UUID REFERENCES hospital.preauth_form_templates(id),
  filled_pdf_s3_key TEXT,
  doc_bundle JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Shape: [{ document_id, role, file_name }]

  -- Channel-specific linkage (nullable per channel)
  email_outbound_id UUID REFERENCES hospital.emails_outbound(id),
  -- portal_session_id UUID,  -- placeholder for future RPA channel; add when needed

  -- Status (channel-agnostic)
  status VARCHAR(30) NOT NULL DEFAULT 'drafted',
  -- 'drafted' | 'sent' | 'delivered' | 'acknowledged' | 'queried' | 'approved' | 'rejected' | 'failed'

  -- External identifiers captured from insurer
  external_claim_id VARCHAR(100),
  external_ccn VARCHAR(100),                         -- Cashless Claim Number (some insurers)

  -- Timeline
  drafted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMP WITH TIME ZONE,
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  preauth_deadline_at TIMESTAMP WITH TIME ZONE,     -- computed from panel_attributes + admission_type

  -- Resubmission chain
  attempt_number INT NOT NULL DEFAULT 1,
  resubmission_of_id UUID REFERENCES hospital.preauth_submissions(id),

  submitted_by UUID REFERENCES hospital.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ps_ipd ON hospital.preauth_submissions(ipd_id);
CREATE INDEX IF NOT EXISTS idx_ps_external ON hospital.preauth_submissions(external_claim_id) WHERE external_claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ps_status_deadline ON hospital.preauth_submissions(status, preauth_deadline_at);
CREATE INDEX IF NOT EXISTS idx_ps_hospital_panel ON hospital.preauth_submissions(hospital_panel_id);

CREATE TRIGGER update_preauth_submissions_modtime
  BEFORE UPDATE ON hospital.preauth_submissions
  FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

-- Now add the back-reference FK on emails_outbound (deferred from above)
ALTER TABLE hospital.emails_outbound
  ADD CONSTRAINT fk_emails_outbound_preauth_submission
  FOREIGN KEY (preauth_submission_id) REFERENCES hospital.preauth_submissions(id) ON DELETE SET NULL;


-- ============================================================================
-- 5. emails_inbound — received emails with thread matching
-- ============================================================================
CREATE TABLE IF NOT EXISTS hospital.emails_inbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,

  -- Raw email identifiers
  gmail_message_id VARCHAR(255) NOT NULL UNIQUE,
  gmail_thread_id VARCHAR(255),
  in_reply_to VARCHAR(255),
  references_header TEXT,

  -- Envelope
  from_address VARCHAR(255) NOT NULL,
  to_addresses TEXT[] DEFAULT '{}',
  cc_addresses TEXT[] DEFAULT '{}',
  subject TEXT,

  -- Content
  body_text TEXT,
  body_html TEXT,
  raw_email_s3_key TEXT,                             -- full RFC822 source archived to S3
  attachments JSONB DEFAULT '[]'::jsonb,

  received_at TIMESTAMP WITH TIME ZONE NOT NULL,

  -- Resolution (filled by matcher)
  hospital_panel_id UUID REFERENCES hospital.hospital_panels(id),
  matched_ipd_id UUID REFERENCES hospital.ipds(id),
  matched_submission_id UUID REFERENCES hospital.preauth_submissions(id),
  match_method VARCHAR(50),
  -- 'thread' | 'claim_no_regex' | 'patient_name_fuzzy' | 'manual' | 'unmatched'

  -- Classification (Phase 2 LLM layer; for now everything is 'received')
  classification VARCHAR(30) DEFAULT 'received',
  -- 'received' | 'ack' | 'query' | 'approval' | 'rejection' | 'settlement' | 'other'
  parsed_payload JSONB,

  -- Operational
  needs_ops_review BOOLEAN DEFAULT FALSE,
  processed_at TIMESTAMP WITH TIME ZONE,
  processing_error TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ei_in_reply_to ON hospital.emails_inbound(in_reply_to) WHERE in_reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ei_thread ON hospital.emails_inbound(gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ei_matched_ipd ON hospital.emails_inbound(matched_ipd_id);
CREATE INDEX IF NOT EXISTS idx_ei_unmatched ON hospital.emails_inbound(hospital_id, received_at) WHERE matched_ipd_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_ei_from ON hospital.emails_inbound(from_address);

CREATE TRIGGER update_emails_inbound_modtime
  BEFORE UPDATE ON hospital.emails_inbound
  FOR EACH ROW EXECUTE PROCEDURE update_modified_column();


COMMIT;
