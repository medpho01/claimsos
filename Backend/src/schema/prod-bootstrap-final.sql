-- ═══════════════════════════════════════════════════════════════════════
--  PROD BOOTSTRAP — FINAL  (2026-05-23)
--
--  Idempotent script that brings the prod RDS schema into alignment
--  with the code in main, without touching existing data.
--
--  WHAT THIS DOES (safe operations only):
--    1. Creates missing functions (update_modified_column + touch triggers)
--    2. Creates pgvector extension if available (for case_embeddings)
--    3. Creates all missing intelligence-layer tables (IF NOT EXISTS)
--    4. Adds missing columns (nullable, IF NOT EXISTS) to existing tables
--    5. Adds the doc_category_groups view
--    6. Marks all 65 original migrations as applied so future migrate:up
--       only picks up #066+
--
--  WHAT THIS DELIBERATELY DOES NOT DO (would risk data loss / failure):
--    • DROP COLUMN — prod has data in master_options.key, value,
--      panel_empanelments.empanelment_date/status, panel_attributes.*
--    • ALTER OWNER — local-only owner names won't exist on RDS
--    • SET NOT NULL on populated columns — would fail on existing NULLs
--    • Type changes that might reject existing values
--
--  HOW TO RUN:
--    Option A (pgAdmin): paste the entire file, execute. Each statement
--      auto-commits. Failures don't abort the rest. Note any errors and
--      paste back to me.
--    Option B (psql from a postgres:16-alpine container):
--      docker run --rm \
--        --env-file ~/hospital_app/Backend/.env \
--        -v ~/hospital_app/Backend/src/schema:/sql \
--        postgres:16-alpine sh -c '
--          PGPASSWORD=$POSTGRES_PASSWORD PGSSLMODE=no-verify psql \
--            --host=$POSTGRES_HOST --port=$POSTGRES_PORT \
--            --username=$POSTGRES_USER --dbname=$POSTGRES_DB \
--            -v ON_ERROR_STOP=0 \
--            -f /sql/prod-bootstrap-final.sql 2>&1 | tail -60
--        '
--
--  Restart backend after: docker compose restart backend worker
-- ═══════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════
--  SECTION 1 — Helper functions
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hospital.update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hospital.claim_ai_runs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hospital.doc_phase_ledger_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════
--  SECTION 2 — pgvector extension (optional)
--  Required only for case_embeddings (episodic memory feature).
--  If this fails on your RDS plan, comment it out and the case_embeddings
--  table block at the bottom will be skipped via the DO $$ guard.
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;


-- ═══════════════════════════════════════════════════════════════════════
--  SECTION 3 — Standalone tables (no FKs to other new tables)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hospital.audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES hospital.users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     JSONB,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action     ON hospital.audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON hospital.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity     ON hospital.audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id    ON hospital.audit_logs (user_id);


CREATE TABLE IF NOT EXISTS hospital.llm_cost_log (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id               UUID REFERENCES hospital.ipds(id) ON DELETE SET NULL,
  hospital_id            UUID REFERENCES hospital.hospitals(id) ON DELETE SET NULL,
  task                   VARCHAR(64) NOT NULL,
  provider               VARCHAR(32) NOT NULL,
  model                  VARCHAR(64) NOT NULL,
  prompt_version         VARCHAR(32) NOT NULL,
  tokens_input_uncached  INTEGER NOT NULL DEFAULT 0,
  tokens_input_cached    INTEGER NOT NULL DEFAULT 0,
  tokens_output          INTEGER NOT NULL DEFAULT 0,
  latency_ms             INTEGER NOT NULL DEFAULT 0,
  cost_inr               NUMERIC(10,4) NOT NULL DEFAULT 0,
  succeeded              BOOLEAN NOT NULL DEFAULT TRUE,
  error_message          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_llm_cost_claim         ON hospital.llm_cost_log (claim_id, created_at)    WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_cost_hospital_time ON hospital.llm_cost_log (hospital_id, created_at DESC) WHERE hospital_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_cost_task_time     ON hospital.llm_cost_log (task, created_at DESC);


CREATE TABLE IF NOT EXISTS hospital.hospital_cost_caps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  daily_cap_inr   NUMERIC(12,2) NOT NULL,
  monthly_cap_inr NUMERIC(12,2) NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hcc_hospital_effective ON hospital.hospital_cost_caps (hospital_id, effective_from DESC);


CREATE TABLE IF NOT EXISTS hospital.cost_alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id   UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  alert_kind    VARCHAR(40) NOT NULL,
  threshold_inr NUMERIC(12,2) NOT NULL,
  current_inr   NUMERIC(12,2) NOT NULL,
  fired_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cost_alerts_hospital_kind ON hospital.cost_alerts (hospital_id, alert_kind, fired_at DESC);


CREATE TABLE IF NOT EXISTS hospital.concept_aliases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_category VARCHAR(50) NOT NULL,
  concept_code     VARCHAR(100) NOT NULL,
  alias            TEXT NOT NULL,
  alias_source     VARCHAR(50),
  confidence       NUMERIC(3,2) DEFAULT 1.0,
  created_at       TIMESTAMP DEFAULT NOW(),
  CONSTRAINT concept_aliases_concept_category_alias_key UNIQUE (concept_category, alias)
);
CREATE INDEX IF NOT EXISTS idx_concept_aliases_concept ON hospital.concept_aliases (concept_category, concept_code);
CREATE INDEX IF NOT EXISTS idx_concept_aliases_lower   ON hospital.concept_aliases (LOWER(alias));


CREATE TABLE IF NOT EXISTS hospital.document_field_schemas (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_category         VARCHAR(100) NOT NULL,
  field_key            VARCHAR(100) NOT NULL,
  field_label          VARCHAR(255) NOT NULL,
  field_type           VARCHAR(50)  NOT NULL,
  is_required          BOOLEAN DEFAULT FALSE,
  enum_values          JSONB,
  reference_category   VARCHAR(50),
  extraction_priority  INTEGER DEFAULT 999,
  schema_version       INTEGER DEFAULT 1,
  created_at           TIMESTAMP DEFAULT NOW(),
  CONSTRAINT document_field_schemas_doc_category_field_key_schema_versio_key
    UNIQUE (doc_category, field_key, schema_version)
);
CREATE INDEX IF NOT EXISTS idx_dfs_doc_category ON hospital.document_field_schemas (doc_category, schema_version);


CREATE TABLE IF NOT EXISTS hospital.mou_templates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(255) NOT NULL,
  code                VARCHAR(100) NOT NULL UNIQUE,
  applies_to_label    VARCHAR(255),
  validity_text       TEXT,
  key_clauses         TEXT,
  rate_terms          TEXT,
  audit_rights        TEXT,
  submission_deadline TEXT,
  payment_timeline    TEXT,
  risk_level          VARCHAR(20),
  risk_notes          TEXT,
  source_template_url TEXT,
  s3_key              TEXT,
  is_active           BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mou_templates_active ON hospital.mou_templates (is_active);
CREATE INDEX IF NOT EXISTS idx_mou_templates_code   ON hospital.mou_templates (code);


CREATE TABLE IF NOT EXISTS hospital.preauth_form_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255) NOT NULL,
  code            VARCHAR(50)  NOT NULL UNIQUE,
  source_url      TEXT,
  s3_key          TEXT,
  file_size_bytes BIGINT,
  page_count      INTEGER,
  is_acroform     BOOLEAN,
  field_map       JSONB DEFAULT '{}'::jsonb,
  is_active       BOOLEAN DEFAULT TRUE,
  notes           TEXT,
  version         VARCHAR(20),
  created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  created_by      UUID REFERENCES hospital.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_preauth_form_active ON hospital.preauth_form_templates (is_active);
CREATE INDEX IF NOT EXISTS idx_preauth_form_code   ON hospital.preauth_form_templates (code);


CREATE TABLE IF NOT EXISTS hospital.document_format_library (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id            UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  doc_category           VARCHAR(100),
  format_label           TEXT NOT NULL,
  representative_phash   TEXT NOT NULL,
  sample_section_ids     UUID[] DEFAULT '{}',
  field_positions        JSONB,
  occurrence_count       INTEGER DEFAULT 0,
  last_seen              TIMESTAMPTZ DEFAULT NOW(),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT document_format_library_hospital_id_representative_phash_key
    UNIQUE (hospital_id, representative_phash)
);
CREATE INDEX IF NOT EXISTS idx_dfl_hospital_cat ON hospital.document_format_library (hospital_id, doc_category);
CREATE INDEX IF NOT EXISTS idx_dfl_phash        ON hospital.document_format_library (representative_phash);


CREATE TABLE IF NOT EXISTS hospital.hospital_format_profiles (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id              UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  doc_category             VARCHAR(100) NOT NULL,
  field_name               VARCHAR(100) NOT NULL,
  extraction_hint          TEXT NOT NULL,
  example_quote            TEXT,
  example_value            TEXT,
  source_correction_count  INTEGER DEFAULT 0,
  confidence               NUMERIC(4,3) DEFAULT 0.5,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT hospital_format_profiles_hospital_id_doc_category_field_nam_key
    UNIQUE (hospital_id, doc_category, field_name)
);
CREATE INDEX IF NOT EXISTS idx_hfp_hospital_cat ON hospital.hospital_format_profiles (hospital_id, doc_category);


CREATE TABLE IF NOT EXISTS hospital.hospital_interfaces (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id         UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  kind                VARCHAR(20)  NOT NULL CHECK (kind IN ('email','portal')),
  name                VARCHAR(100) NOT NULL,
  status              VARCHAR(30)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','disconnected','token_expired','error','pending')),
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  secrets_encrypted   TEXT,
  last_polled_at      TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hospital_interfaces_hospital_id_name_key UNIQUE (hospital_id, name)
);
CREATE INDEX IF NOT EXISTS idx_hi_hospital_kind ON hospital.hospital_interfaces (hospital_id, kind);

DROP TRIGGER IF EXISTS hospital_interfaces_set_updated_at ON hospital.hospital_interfaces;
CREATE TRIGGER hospital_interfaces_set_updated_at
  BEFORE UPDATE ON hospital.hospital_interfaces
  FOR EACH ROW EXECUTE FUNCTION hospital.update_modified_column();


-- ═══════════════════════════════════════════════════════════════════════
--  SECTION 4 — Email & insurance submission tables
--  (circular FK: insurance_submissions ↔ emails_outbound. Create both
--  without the cross-FK, add it at the end.)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hospital.emails_inbound (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id           UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  gmail_message_id      VARCHAR(255) NOT NULL UNIQUE,
  gmail_thread_id       VARCHAR(255),
  in_reply_to           VARCHAR(255),
  references_header     TEXT,
  from_address          VARCHAR(255) NOT NULL,
  to_addresses          TEXT[] DEFAULT '{}',
  cc_addresses          TEXT[] DEFAULT '{}',
  subject               TEXT,
  body_text             TEXT,
  body_html             TEXT,
  raw_email_s3_key      TEXT,
  attachments           JSONB DEFAULT '[]'::jsonb,
  received_at           TIMESTAMPTZ NOT NULL,
  hospital_panel_id     UUID REFERENCES hospital.hospital_panels(id),
  matched_ipd_id        UUID REFERENCES hospital.ipds(id),
  matched_submission_id UUID,
  match_method          VARCHAR(50),
  classification        VARCHAR(30) DEFAULT 'received',
  parsed_payload        JSONB,
  needs_ops_review      BOOLEAN DEFAULT FALSE,
  processed_at          TIMESTAMPTZ,
  processing_error      TEXT,
  created_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ei_from         ON hospital.emails_inbound (from_address);
CREATE INDEX IF NOT EXISTS idx_ei_in_reply_to  ON hospital.emails_inbound (in_reply_to) WHERE in_reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ei_matched_ipd  ON hospital.emails_inbound (matched_ipd_id);
CREATE INDEX IF NOT EXISTS idx_ei_thread       ON hospital.emails_inbound (gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ei_unmatched    ON hospital.emails_inbound (hospital_id, received_at) WHERE matched_ipd_id IS NULL;

DROP TRIGGER IF EXISTS update_emails_inbound_modtime ON hospital.emails_inbound;
CREATE TRIGGER update_emails_inbound_modtime
  BEFORE UPDATE ON hospital.emails_inbound
  FOR EACH ROW EXECUTE FUNCTION hospital.update_modified_column();


CREATE TABLE IF NOT EXISTS hospital.emails_outbound (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id             UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  ipd_id                  UUID REFERENCES hospital.ipds(id) ON DELETE SET NULL,
  hospital_panel_id       UUID REFERENCES hospital.hospital_panels(id) ON DELETE SET NULL,
  insurance_submission_id UUID,   -- FK added below after insurance_submissions exists
  to_addresses            TEXT[] NOT NULL,
  cc_addresses            TEXT[] DEFAULT '{}',
  from_address            VARCHAR(255) NOT NULL,
  reply_to                VARCHAR(255),
  subject                 TEXT NOT NULL,
  body_text               TEXT,
  body_html               TEXT,
  attachments             JSONB DEFAULT '[]'::jsonb,
  gmail_message_id        VARCHAR(255),
  gmail_thread_id         VARCHAR(255),
  in_reply_to             VARCHAR(255),
  references_header       TEXT,
  status                  VARCHAR(30) NOT NULL DEFAULT 'queued',
  failure_reason          TEXT,
  attempts                INTEGER NOT NULL DEFAULT 0,
  queued_at               TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  sent_at                 TIMESTAMPTZ,
  idempotency_key         VARCHAR(255) NOT NULL UNIQUE,
  composed_by             VARCHAR(100),
  created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_eo_gmail_message_id ON hospital.emails_outbound (gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eo_hospital_status  ON hospital.emails_outbound (hospital_id, status);
CREATE INDEX IF NOT EXISTS idx_eo_ipd              ON hospital.emails_outbound (ipd_id);
CREATE INDEX IF NOT EXISTS idx_eo_queued           ON hospital.emails_outbound (status) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_eo_thread           ON hospital.emails_outbound (gmail_thread_id);

DROP TRIGGER IF EXISTS update_emails_outbound_modtime ON hospital.emails_outbound;
CREATE TRIGGER update_emails_outbound_modtime
  BEFORE UPDATE ON hospital.emails_outbound
  FOR EACH ROW EXECUTE FUNCTION hospital.update_modified_column();


CREATE TABLE IF NOT EXISTS hospital.insurance_submissions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ipd_id                UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  hospital_id           UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  hospital_panel_id     UUID NOT NULL REFERENCES hospital.hospital_panels(id),
  submitted_via         VARCHAR(20) NOT NULL,
  filled_pdf_s3_key     TEXT,
  doc_bundle            JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_outbound_id     UUID REFERENCES hospital.emails_outbound(id),
  status                VARCHAR(30) NOT NULL DEFAULT 'drafted',
  external_claim_id     VARCHAR(100),
  external_ccn          VARCHAR(100),
  drafted_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  sent_at               TIMESTAMPTZ,
  acknowledged_at       TIMESTAMPTZ,
  preauth_deadline_at   TIMESTAMPTZ,
  attempt_number        INTEGER NOT NULL DEFAULT 1,
  resubmission_of_id    UUID REFERENCES hospital.insurance_submissions(id),
  submitted_by          UUID REFERENCES hospital.users(id),
  created_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  idempotency_key       UUID
);
CREATE INDEX IF NOT EXISTS idx_is_external        ON hospital.insurance_submissions (external_claim_id) WHERE external_claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_is_hospital_panel  ON hospital.insurance_submissions (hospital_panel_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_is_idempotency_key ON hospital.insurance_submissions (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_is_ipd             ON hospital.insurance_submissions (ipd_id);
CREATE INDEX IF NOT EXISTS idx_is_status_deadline ON hospital.insurance_submissions (status, preauth_deadline_at);

DROP TRIGGER IF EXISTS update_preauth_submissions_modtime ON hospital.insurance_submissions;
CREATE TRIGGER update_preauth_submissions_modtime
  BEFORE UPDATE ON hospital.insurance_submissions
  FOR EACH ROW EXECUTE FUNCTION hospital.update_modified_column();


-- Now close the circular FK: emails_outbound.insurance_submission_id → insurance_submissions(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_emails_outbound_insurance_submission'
      AND conrelid = 'hospital.emails_outbound'::regclass
  ) THEN
    ALTER TABLE hospital.emails_outbound
      ADD CONSTRAINT fk_emails_outbound_insurance_submission
      FOREIGN KEY (insurance_submission_id)
      REFERENCES hospital.insurance_submissions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- And emails_inbound.matched_submission_id → insurance_submissions(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'emails_inbound_matched_submission_id_fkey'
      AND conrelid = 'hospital.emails_inbound'::regclass
  ) THEN
    ALTER TABLE hospital.emails_inbound
      ADD CONSTRAINT emails_inbound_matched_submission_id_fkey
      FOREIGN KEY (matched_submission_id)
      REFERENCES hospital.insurance_submissions(id);
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
--  SECTION 5 — Intelligence-layer tables
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hospital.submission_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurance_submission_id  UUID,
  ipd_id                   UUID REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  hospital_id              UUID REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  event_type               VARCHAR(40) NOT NULL,
  payload                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor                    VARCHAR(64),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind                     VARCHAR(64) NOT NULL DEFAULT 'unknown',
  correlation_id           UUID,
  claim_id                 UUID REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  idempotency_key          VARCHAR(128)
);
CREATE INDEX IF NOT EXISTS idx_se_claim_created      ON hospital.submission_events (claim_id, created_at DESC) WHERE claim_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_se_claim_idem_unique
  ON hospital.submission_events (claim_id, idempotency_key)
  WHERE claim_id IS NOT NULL AND idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_se_correlation        ON hospital.submission_events (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_se_ipd                ON hospital.submission_events (ipd_id, created_at);
CREATE INDEX IF NOT EXISTS idx_se_kind_created       ON hospital.submission_events (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_se_submission         ON hospital.submission_events (insurance_submission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_se_type               ON hospital.submission_events (event_type, created_at);


CREATE TABLE IF NOT EXISTS hospital.claim_dossiers (
  claim_id                 UUID PRIMARY KEY REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  last_event_id            UUID,
  last_event_at            TIMESTAMPTZ,
  version                  INTEGER NOT NULL DEFAULT 0,
  current_stage            VARCHAR(100),
  current_panel_id         UUID,
  current_insurer_id       UUID,
  patient_summary          JSONB,
  amounts                  JSONB,
  doc_sections_by_category JSONB,
  doc_sufficiency_per_stage JSONB,
  events_summary           JSONB,
  inbound_emails           JSONB,
  outbound_submissions     JSONB,
  active_queries           JSONB,
  pending_actions          JSONB,
  active_adjudication      JSONB,
  ai_drafts_pending        JSONB,
  matched_kb_patterns      UUID[],
  case_embedding_state     VARCHAR(32),
  closed_at                TIMESTAMPTZ,
  closure_outcome          VARCHAR(64),
  retrospective_summary    JSONB,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cd_closed_at           ON hospital.claim_dossiers (closed_at);
CREATE INDEX IF NOT EXISTS idx_cd_current_panel       ON hospital.claim_dossiers (current_panel_id);
CREATE INDEX IF NOT EXISTS idx_cd_current_stage       ON hospital.claim_dossiers (current_stage);
CREATE INDEX IF NOT EXISTS idx_cd_matched_kb_patterns ON hospital.claim_dossiers USING GIN (matched_kb_patterns);


CREATE TABLE IF NOT EXISTS hospital.claim_ai_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        UUID NOT NULL,
  triggered_by    UUID,
  triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','succeeded','partial','failed','superseded')),
  phase           TEXT
                  CHECK (phase IS NULL OR phase IN ('quality','orient','dedup','classify','extract','harmonise','done')),
  total_docs      INTEGER NOT NULL DEFAULT 0,
  docs_completed  INTEGER NOT NULL DEFAULT 0,
  docs_failed     INTEGER NOT NULL DEFAULT 0,
  cost_inr        NUMERIC(10,4),
  finished_at     TIMESTAMPTZ,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claim_ai_runs_active           ON hospital.claim_ai_runs (claim_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS idx_claim_ai_runs_claim_triggered  ON hospital.claim_ai_runs (claim_id, triggered_at DESC);

DROP TRIGGER IF EXISTS trg_claim_ai_runs_touch_updated_at ON hospital.claim_ai_runs;
CREATE TRIGGER trg_claim_ai_runs_touch_updated_at
  BEFORE UPDATE ON hospital.claim_ai_runs
  FOR EACH ROW EXECUTE FUNCTION hospital.claim_ai_runs_touch_updated_at();


CREATE TABLE IF NOT EXISTS hospital.doc_phase_ledger (
  doc_id       UUID NOT NULL,
  run_id       UUID NOT NULL REFERENCES hospital.claim_ai_runs(id) ON DELETE CASCADE,
  phase        TEXT NOT NULL CHECK (phase IN ('ingest','classify','dedup','extract','harmonise')),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','skipped','failed')),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  evidence     JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (doc_id, run_id, phase)
);
CREATE INDEX IF NOT EXISTS idx_doc_phase_ledger_doc     ON hospital.doc_phase_ledger (doc_id, run_id);
CREATE INDEX IF NOT EXISTS idx_doc_phase_ledger_run     ON hospital.doc_phase_ledger (run_id, phase);
CREATE INDEX IF NOT EXISTS idx_doc_phase_ledger_running ON hospital.doc_phase_ledger (started_at) WHERE status = 'running';

DROP TRIGGER IF EXISTS trg_doc_phase_ledger_touch_updated_at ON hospital.doc_phase_ledger;
CREATE TRIGGER trg_doc_phase_ledger_touch_updated_at
  BEFORE UPDATE ON hospital.doc_phase_ledger
  FOR EACH ROW EXECUTE FUNCTION hospital.doc_phase_ledger_touch_updated_at();


CREATE TABLE IF NOT EXISTS hospital.claim_harmonised_episodes (
  claim_id          UUID PRIMARY KEY REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  episode           JSONB NOT NULL,
  schema_version    VARCHAR(64) NOT NULL DEFAULT 'claimsos.canonical.medical_episode.v2',
  prompt_version    VARCHAR(32) NOT NULL DEFAULT 'harmoniser.v1',
  confidence        NUMERIC(4,3),
  provenance        JSONB,
  dossier_state_hash VARCHAR(64) NOT NULL,
  cost_inr          NUMERIC(10,4),
  tokens_used       INTEGER,
  llm_provider      VARCHAR(64),
  llm_model         VARCHAR(128),
  generated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  last_corrected_at TIMESTAMP,
  status            VARCHAR(32) NOT NULL DEFAULT 'fresh'
                    CHECK (status IN ('fresh','stale','pending','failed','partial','corrected')),
  error_message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_claim_harmonised_episodes_generated_at ON hospital.claim_harmonised_episodes (generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_claim_harmonised_episodes_status       ON hospital.claim_harmonised_episodes (status);


CREATE TABLE IF NOT EXISTS hospital.harmonisation_corrections (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id             UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  json_path            TEXT NOT NULL,
  ai_value             JSONB,
  human_value          JSONB NOT NULL,
  corrected_by         UUID,
  reason               TEXT,
  corrected_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  applied_to_episode   BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_harmonisation_corrections_claim ON hospital.harmonisation_corrections (claim_id, corrected_at DESC);


CREATE TABLE IF NOT EXISTS hospital.ai_corrections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  surface         VARCHAR(64) NOT NULL CHECK (surface IN ('document_category','extraction_field','harmonised_field','rule_override','ai_draft_field','audit_call_wrong')),
  claim_id        UUID REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  target_id       VARCHAR(128),
  target_kind     VARCHAR(64),
  ai_value        JSONB,
  human_value     JSONB NOT NULL,
  reason          TEXT,
  corrected_by    UUID NOT NULL,
  corrected_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  applied_to_kb   BOOLEAN NOT NULL DEFAULT FALSE,
  mined_pattern_id UUID
);
CREATE INDEX IF NOT EXISTS idx_ai_corrections_claim         ON hospital.ai_corrections (claim_id);
CREATE INDEX IF NOT EXISTS idx_ai_corrections_surface       ON hospital.ai_corrections (surface);
CREATE INDEX IF NOT EXISTS idx_ai_corrections_surface_kind  ON hospital.ai_corrections (surface, target_kind);
CREATE INDEX IF NOT EXISTS idx_ai_corrections_unmined       ON hospital.ai_corrections (corrected_at DESC) WHERE applied_to_kb = FALSE;


CREATE TABLE IF NOT EXISTS hospital.email_intelligence_drafts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_email_id      UUID NOT NULL REFERENCES hospital.emails_inbound(id) ON DELETE CASCADE,
  claim_id              UUID REFERENCES hospital.ipds(id) ON DELETE SET NULL,
  category              VARCHAR(64) NOT NULL,
  classifier_confidence NUMERIC(4,3),
  extracted_payload     JSONB,
  llm_provider          VARCHAR(64),
  llm_model             VARCHAR(128),
  prompt_version        VARCHAR(32) NOT NULL,
  tokens_used           INTEGER,
  latency_ms            INTEGER,
  cost_inr              NUMERIC(10,4),
  status                VARCHAR(32) NOT NULL DEFAULT 'pending_review',
  raw_response          TEXT,
  reviewed_by           UUID,
  reviewed_at           TIMESTAMPTZ,
  applied_at            TIMESTAMPTZ,
  rejection_reason      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eid_claim          ON hospital.email_intelligence_drafts (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eid_claim_status   ON hospital.email_intelligence_drafts (claim_id, status, created_at DESC) WHERE claim_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_eid_email_prompt_unique ON hospital.email_intelligence_drafts (inbound_email_id, prompt_version);
CREATE INDEX IF NOT EXISTS idx_eid_inbound_email  ON hospital.email_intelligence_drafts (inbound_email_id);
CREATE INDEX IF NOT EXISTS idx_eid_status         ON hospital.email_intelligence_drafts (status, created_at DESC);


CREATE TABLE IF NOT EXISTS hospital.email_intelligence_corrections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id      UUID NOT NULL REFERENCES hospital.email_intelligence_drafts(id) ON DELETE CASCADE,
  field_path    VARCHAR(255) NOT NULL,
  ai_value      JSONB,
  human_value   JSONB,
  corrected_by  UUID NOT NULL,
  corrected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eic_draft ON hospital.email_intelligence_corrections (draft_id);


CREATE TABLE IF NOT EXISTS hospital.stage_requirements (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key                 VARCHAR(128) NOT NULL,
  target_stage             VARCHAR(100) NOT NULL,
  required_doc_category    VARCHAR(100),
  required_fields          JSONB,
  severity                 VARCHAR(16) NOT NULL CHECK (severity IN ('blocking','warning','info')),
  scope_global             BOOLEAN NOT NULL DEFAULT FALSE,
  scope_panel_id           UUID REFERENCES hospital.panels(id) ON DELETE CASCADE,
  scope_insurer_id         UUID REFERENCES hospital.panels(id) ON DELETE CASCADE,
  scope_procedure_code     VARCHAR(100),
  scope_diagnosis_class    VARCHAR(100),
  active                   BOOLEAN NOT NULL DEFAULT TRUE,
  version                  INTEGER NOT NULL DEFAULT 1,
  effective_from           TIMESTAMP NOT NULL DEFAULT NOW(),
  effective_to             TIMESTAMP,
  created_by               UUID,
  created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_stage_requirements_key_version UNIQUE (rule_key, version),
  CONSTRAINT chk_stage_requirements_artefact_present CHECK (required_doc_category IS NOT NULL OR required_fields IS NOT NULL),
  CONSTRAINT chk_stage_requirements_scope_present
    CHECK (scope_global = TRUE OR scope_panel_id IS NOT NULL OR scope_insurer_id IS NOT NULL
           OR scope_procedure_code IS NOT NULL OR scope_diagnosis_class IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_stage_requirements_active        ON hospital.stage_requirements (active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_stage_requirements_global_stage  ON hospital.stage_requirements (scope_global, target_stage) WHERE scope_global = TRUE;
CREATE INDEX IF NOT EXISTS idx_stage_requirements_panel_stage   ON hospital.stage_requirements (scope_panel_id, target_stage) WHERE scope_panel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stage_requirements_target_stage  ON hospital.stage_requirements (target_stage);


CREATE TABLE IF NOT EXISTS hospital.stage_transitions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id               UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  before_stage           VARCHAR(100),
  after_stage            VARCHAR(100) NOT NULL,
  triggered_by           VARCHAR(64) NOT NULL,
  triggering_event_id    UUID REFERENCES hospital.submission_events(id) ON DELETE SET NULL,
  context_doc_section_ids UUID[],
  unresolved_query_ids   UUID[],
  was_reversal           BOOLEAN NOT NULL DEFAULT FALSE,
  reasoning              TEXT,
  actor_user_id          UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_st_claim_created  ON hospital.stage_transitions (claim_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_st_claim_id       ON hospital.stage_transitions (claim_id);
CREATE INDEX IF NOT EXISTS idx_st_triggered_by   ON hospital.stage_transitions (triggered_by, created_at DESC);


CREATE TABLE IF NOT EXISTS hospital.kb_patterns (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type             VARCHAR(64) NOT NULL,
  title                    VARCHAR(255) NOT NULL,
  description              TEXT,
  scope                    JSONB NOT NULL,
  condition                JSONB NOT NULL,
  prediction               JSONB NOT NULL,
  confidence               NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_count           INTEGER NOT NULL DEFAULT 0,
  evidence_claim_ids       UUID[] NOT NULL DEFAULT '{}',
  mined_at                 TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  status                   VARCHAR(32) NOT NULL DEFAULT 'candidate'
                           CHECK (status IN ('candidate','live','demoted','archived')),
  reviewed_by              UUID,
  reviewed_at              TIMESTAMP,
  promotion_reason         TEXT,
  demotion_reason          TEXT,
  miner_version            VARCHAR(32) NOT NULL DEFAULT 'v0',
  prompt_version           VARCHAR(32),
  pattern_signature        TEXT GENERATED ALWAYS AS
    (md5(pattern_type::text || '|' || COALESCE(scope::text, '') || '|' || COALESCE(condition::text, ''))) STORED,
  evidence_correction_ids  UUID[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_kb_patterns_condition_gin ON hospital.kb_patterns USING GIN (condition);
CREATE INDEX IF NOT EXISTS idx_kb_patterns_scope_gin     ON hospital.kb_patterns USING GIN (scope);
CREATE INDEX IF NOT EXISTS idx_kb_patterns_status        ON hospital.kb_patterns (status);
CREATE INDEX IF NOT EXISTS idx_kb_patterns_type          ON hospital.kb_patterns (pattern_type);
CREATE INDEX IF NOT EXISTS idx_kb_patterns_type_status   ON hospital.kb_patterns (pattern_type, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_patterns_signature ON hospital.kb_patterns (pattern_signature);


CREATE TABLE IF NOT EXISTS hospital.adjudication_reports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id            UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  target_stage        VARCHAR(100) NOT NULL,
  readiness_score     INTEGER NOT NULL CHECK (readiness_score >= 0 AND readiness_score <= 100),
  readiness_bucket    VARCHAR(32)  NOT NULL CHECK (readiness_bucket IN ('ready','almost','blocked')),
  recommended_action  VARCHAR(64)  NOT NULL CHECK (recommended_action IN ('file_now','request_doc','review','wait','escalate_to_human')),
  blocking_gaps       JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings            JSONB NOT NULL DEFAULT '[]'::jsonb,
  predicted_outcome   JSONB,
  citations           JSONB NOT NULL DEFAULT '{}'::jsonb,
  kb_matches          JSONB NOT NULL DEFAULT '[]'::jsonb,
  episodic_refs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasoning           TEXT,
  dossier_state_hash  VARCHAR(64)  NOT NULL,
  rules_version       VARCHAR(32)  NOT NULL DEFAULT 'v1',
  engine_version      VARCHAR(32)  NOT NULL DEFAULT 'v0',
  generated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  generated_by        VARCHAR(32) DEFAULT 'engine',
  CONSTRAINT uq_ar_dedup UNIQUE (claim_id, target_stage, dossier_state_hash, rules_version, engine_version)
);
CREATE INDEX IF NOT EXISTS idx_ar_cache_lookup        ON hospital.adjudication_reports (claim_id, target_stage, dossier_state_hash);
CREATE INDEX IF NOT EXISTS idx_ar_claim_generated     ON hospital.adjudication_reports (claim_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ar_readiness_bucket    ON hospital.adjudication_reports (readiness_bucket);


CREATE TABLE IF NOT EXISTS hospital.adjudication_eval (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id                 UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  adjudication_report_id   UUID NOT NULL REFERENCES hospital.adjudication_reports(id) ON DELETE CASCADE,
  target_stage             VARCHAR(100) NOT NULL,
  prediction               JSONB NOT NULL,
  actual_outcome           JSONB,
  prediction_error         JSONB,
  rules_version            VARCHAR(32) NOT NULL,
  engine_version           VARCHAR(32) NOT NULL,
  prompts_versions         JSONB NOT NULL,
  kb_pattern_ids           UUID[] NOT NULL DEFAULT '{}',
  episodic_case_ids        UUID[] NOT NULL DEFAULT '{}',
  reasoning_cost_inr       NUMERIC(10,4),
  total_claim_cost_inr     NUMERIC(10,4),
  recorded_at              TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at              TIMESTAMP,
  CONSTRAINT uq_eval_report UNIQUE (adjudication_report_id)
);
CREATE INDEX IF NOT EXISTS idx_eval_claim         ON hospital.adjudication_eval (claim_id);
CREATE INDEX IF NOT EXISTS idx_eval_recorded_at   ON hospital.adjudication_eval (recorded_at);
CREATE INDEX IF NOT EXISTS idx_eval_target_stage  ON hospital.adjudication_eval (target_stage);
CREATE INDEX IF NOT EXISTS idx_eval_unresolved    ON hospital.adjudication_eval (claim_id, target_stage) WHERE resolved_at IS NULL;


CREATE TABLE IF NOT EXISTS hospital.kb_pattern_matches (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id               UUID NOT NULL REFERENCES hospital.kb_patterns(id) ON DELETE CASCADE,
  claim_id                 UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  adjudication_report_id   UUID REFERENCES hospital.adjudication_reports(id) ON DELETE SET NULL,
  matched_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  actual_outcome           JSONB,
  prediction_correct       BOOLEAN,
  resolved_at              TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kb_pattern_matches_claim       ON hospital.kb_pattern_matches (claim_id);
CREATE INDEX IF NOT EXISTS idx_kb_pattern_matches_pattern     ON hospital.kb_pattern_matches (pattern_id);
CREATE INDEX IF NOT EXISTS idx_kb_pattern_matches_unresolved  ON hospital.kb_pattern_matches (claim_id) WHERE resolved_at IS NULL;


CREATE TABLE IF NOT EXISTS hospital.insurer_rule_sets (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id            VARCHAR(128) NOT NULL UNIQUE,
  rule_set_name          VARCHAR(255) NOT NULL,
  version                VARCHAR(32)  NOT NULL DEFAULT '1.0',
  effective_from         DATE,
  effective_till         DATE,
  insurer_code           VARCHAR(64),
  applicable_treatments  TEXT[] NOT NULL DEFAULT '{}',
  applicable_specialties TEXT[] NOT NULL DEFAULT '{}',
  status                 VARCHAR(32) NOT NULL DEFAULT 'live' CHECK (status IN ('draft','live','deprecated')),
  created_by             UUID,
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_irs_insurer_code ON hospital.insurer_rule_sets (insurer_code);
CREATE INDEX IF NOT EXISTS idx_irs_status       ON hospital.insurer_rule_sets (status);


CREATE TABLE IF NOT EXISTS hospital.insurance_rules (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id                 UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  rule_id                     VARCHAR(64) NOT NULL,
  rule_name                   VARCHAR(255) NOT NULL,
  rule_description            TEXT,
  category                    VARCHAR(64) NOT NULL CHECK (category IN ('POLICY_ELIGIBILITY','DOCUMENT_COMPLETENESS','CLINICAL_APPROPRIATENESS','FINANCIAL_LIMITS','PROCEDURAL_COMPLIANCE','TEMPORAL_VALIDITY')),
  severity                    VARCHAR(16) NOT NULL CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW','INFO')),
  impact                      VARCHAR(32) NOT NULL CHECK (impact IN ('CLAIM_REJECTION','DEDUCTION','QUERY','WARNING','INFO')),
  enabled                     BOOLEAN NOT NULL DEFAULT TRUE,
  mandatory                   BOOLEAN NOT NULL DEFAULT FALSE,
  validation_logic            JSONB NOT NULL,
  failure_message             TEXT,
  remediation_guidance        TEXT,
  required_documents          TEXT[] NOT NULL DEFAULT '{}',
  estimated_deduction_amount  NUMERIC(12,2),
  query_template              TEXT,
  order_index                 INTEGER NOT NULL DEFAULT 999,
  created_at                  TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_insurance_rules_set_rule UNIQUE (rule_set_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_ir_enabled ON hospital.insurance_rules (rule_set_id, enabled) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_ir_set     ON hospital.insurance_rules (rule_set_id);


CREATE TABLE IF NOT EXISTS hospital.insurer_document_requirements (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id            UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  document_type          VARCHAR(64) NOT NULL,
  required_when          TEXT,
  mandatory              BOOLEAN NOT NULL DEFAULT TRUE,
  stage                  VARCHAR(32) CHECK (stage IS NULL OR stage IN ('PRE_AUTH','ENHANCEMENT','FINAL_CLAIM','QUERY_RESPONSE')),
  quality_requirements   JSONB
);
CREATE INDEX IF NOT EXISTS idx_idr_set ON hospital.insurer_document_requirements (rule_set_id);


CREATE TABLE IF NOT EXISTS hospital.insurer_financial_limits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id  UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  limit_kind   VARCHAR(64) NOT NULL,
  config       JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ifl_set ON hospital.insurer_financial_limits (rule_set_id);


CREATE TABLE IF NOT EXISTS hospital.insurer_los_benchmarks (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id                     UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  procedure_code                  VARCHAR(128),
  procedure_name                  VARCHAR(255),
  expected_los_days               NUMERIC,
  expected_icu_days               NUMERIC,
  tolerance_days                  NUMERIC,
  justification_required_beyond   NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_ilb_proc ON hospital.insurer_los_benchmarks (rule_set_id, procedure_code);
CREATE INDEX IF NOT EXISTS idx_ilb_set  ON hospital.insurer_los_benchmarks (rule_set_id);


CREATE TABLE IF NOT EXISTS hospital.claim_rule_evaluations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id            UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  rule_set_id         UUID NOT NULL,
  rule_id             VARCHAR(64) NOT NULL,
  status              VARCHAR(16) NOT NULL CHECK (status IN ('PASS','FAIL','SKIP','ERROR')),
  severity            VARCHAR(16) NOT NULL,
  impact              VARCHAR(32) NOT NULL,
  evidence            JSONB,
  message             TEXT,
  deduction_estimate  NUMERIC(12,2),
  evaluated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_cre_claim_set_rule UNIQUE (claim_id, rule_set_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_cre_claim         ON hospital.claim_rule_evaluations (claim_id);
CREATE INDEX IF NOT EXISTS idx_cre_claim_status  ON hospital.claim_rule_evaluations (claim_id, status);
CREATE INDEX IF NOT EXISTS idx_cre_rule_set      ON hospital.claim_rule_evaluations (rule_set_id);


CREATE TABLE IF NOT EXISTS hospital.rule_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  rule_set_id     UUID NOT NULL,
  rule_id         VARCHAR(64) NOT NULL,
  action          VARCHAR(32) NOT NULL CHECK (action IN ('mark_passed','mark_skipped','accept_deduction')),
  reason          TEXT NOT NULL,
  overridden_by   UUID NOT NULL,
  overridden_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ro_claim       ON hospital.rule_overrides (claim_id);
CREATE INDEX IF NOT EXISTS idx_ro_claim_rule  ON hospital.rule_overrides (claim_id, rule_set_id, rule_id);


CREATE TABLE IF NOT EXISTS hospital.claim_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  kind            VARCHAR(64) NOT NULL CHECK (kind IN ('request_doc','notify_ops','approval_request','follow_up_sla')),
  target_kind     VARCHAR(32) NOT NULL CHECK (target_kind IN ('whatsapp_group','whatsapp_user','in_app_user','in_app_role')),
  target_value    VARCHAR(255) NOT NULL,
  target_user_id  UUID,
  payload         JSONB NOT NULL,
  status          VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched','acked','declined','expired','failed')),
  source          VARCHAR(64) NOT NULL,
  source_report_id UUID,
  idempotency_key VARCHAR(128),
  dispatched_at   TIMESTAMP,
  acked_at        TIMESTAMP,
  acked_by        UUID,
  ack_response    JSONB,
  declined_at     TIMESTAMP,
  declined_by     UUID,
  decline_reason  TEXT,
  dispatch_error  TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claim_actions_claim          ON hospital.claim_actions (claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_actions_pending_user   ON hospital.claim_actions (target_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_claim_actions_status_kind    ON hospital.claim_actions (status, kind);
CREATE INDEX IF NOT EXISTS idx_claim_actions_user_recent    ON hospital.claim_actions (target_user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_actions_claim_idempotency
  ON hospital.claim_actions (claim_id, idempotency_key) WHERE idempotency_key IS NOT NULL;


CREATE TABLE IF NOT EXISTS hospital.extraction_corrections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  hospital_id     UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('section_extracted_field','harmonised_episode_field','canonical_patient','foreign_document_flag','id_conflict')),
  section_id      UUID REFERENCES hospital.document_sections(id) ON DELETE SET NULL,
  field_path      TEXT NOT NULL,
  ai_value        JSONB,
  corrected_value JSONB,
  reason          TEXT,
  reviewer_id     UUID,
  reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at   TIMESTAMPTZ,
  superseded_by   UUID
);
CREATE INDEX IF NOT EXISTS idx_extr_corrections_claim          ON hospital.extraction_corrections (claim_id);
CREATE INDEX IF NOT EXISTS idx_extr_corrections_hospital_field ON hospital.extraction_corrections (hospital_id, field_path);
CREATE INDEX IF NOT EXISTS idx_extr_corrections_recent         ON hospital.extraction_corrections (reviewed_at DESC) WHERE superseded_at IS NULL;


CREATE TABLE IF NOT EXISTS hospital.panel_default_attributes (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id                      UUID NOT NULL REFERENCES hospital.panels(id) ON DELETE CASCADE,
  panel_attribute_definition_id UUID NOT NULL REFERENCES hospital.panel_attribute_definitions(id) ON DELETE CASCADE,
  default_value_text            TEXT,
  default_value_boolean         BOOLEAN,
  default_value_date            DATE,
  default_value_json            JSONB,
  source                        VARCHAR(50) NOT NULL DEFAULT 'sop_seed',
  sop_version                   VARCHAR(20),
  seed_notes                    TEXT,
  seeded_at                     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  created_at                    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at                    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT panel_default_attributes_panel_id_panel_attribute_definitio_key
    UNIQUE (panel_id, panel_attribute_definition_id)
);
CREATE INDEX IF NOT EXISTS idx_pda_definition ON hospital.panel_default_attributes (panel_attribute_definition_id);
CREATE INDEX IF NOT EXISTS idx_pda_panel      ON hospital.panel_default_attributes (panel_id);

DROP TRIGGER IF EXISTS update_panel_default_attributes_modtime ON hospital.panel_default_attributes;
CREATE TRIGGER update_panel_default_attributes_modtime
  BEFORE UPDATE ON hospital.panel_default_attributes
  FOR EACH ROW EXECUTE FUNCTION hospital.update_modified_column();


-- ═══════════════════════════════════════════════════════════════════════
--  SECTION 6 — case_embeddings (depends on pgvector)
--  Wrapped in a DO block so it skips silently if pgvector isn't installed.
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS hospital.case_embeddings (
      claim_id           UUID PRIMARY KEY REFERENCES hospital.ipds(id) ON DELETE CASCADE,
      embedding          vector(1024) NOT NULL,
      embedding_model    VARCHAR(64) NOT NULL DEFAULT 'voyage-3',
      embedding_version  VARCHAR(32) NOT NULL DEFAULT 'v0',
      source_summary     TEXT NOT NULL,
      source_state_hash  VARCHAR(64) NOT NULL,
      metadata           JSONB,
      embedded_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      status             VARCHAR(32) NOT NULL DEFAULT 'fresh'
                         CHECK (status IN ('fresh','stale','pending','failed'))
    );
    CREATE INDEX IF NOT EXISTS idx_case_embed_metadata ON hospital.case_embeddings USING GIN (metadata);
    CREATE INDEX IF NOT EXISTS idx_case_embed_status   ON hospital.case_embeddings (status);
    -- ivfflat may not exist either; ignore-failure on the vector index
    BEGIN
      CREATE INDEX IF NOT EXISTS idx_case_embed_vec ON hospital.case_embeddings
        USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped ivfflat index (op class not available)';
    END;
  ELSE
    RAISE NOTICE 'Skipping case_embeddings — pgvector extension not installed';
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
--  SECTION 7 — ADD COLUMN IF NOT EXISTS on existing tables
--  All additive, all nullable, idempotent. No data loss possible.
-- ═══════════════════════════════════════════════════════════════════════

-- user_refresh_tokens — device-id rotation (login fix)
ALTER TABLE hospital.user_refresh_tokens ADD COLUMN IF NOT EXISTS device_id    UUID;
ALTER TABLE hospital.user_refresh_tokens ADD COLUMN IF NOT EXISTS user_agent   TEXT;
ALTER TABLE hospital.user_refresh_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_user_refresh_tokens_user_device  ON hospital.user_refresh_tokens (user_id, device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_refresh_tokens_expires_at   ON hospital.user_refresh_tokens (expires_at);

-- panels: code column for stable identifiers
ALTER TABLE hospital.panels ADD COLUMN IF NOT EXISTS code VARCHAR(50);

-- panel_empanelments: add panel_id + lots of new columns (all nullable)
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS panel_id                    UUID;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS empanelment_start_date      DATE;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS empanelment_end_date        DATE;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS empanelment_status          TEXT DEFAULT 'active';
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS empanelment_type            TEXT DEFAULT 'cashless';
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS provider_id                 TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS network_type                TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS hospital_poc_name           TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS hospital_poc_designation    TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS hospital_poc_email          TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS hospital_poc_phone          TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS insurer_poc_name            TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS insurer_poc_email           TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS insurer_poc_phone           TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS insurer_poc_region          TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS rm_name                     TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS rm_email                    TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS rm_phone                    TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS portal_name                 TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS portal_url                  TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS portal_username             TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS portal_password_enc         TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS auth_mechanism              TEXT DEFAULT 'password_only';
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS two_fa_enabled              BOOLEAN DEFAULT FALSE;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS two_fa_type                 TEXT DEFAULT 'none';
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS two_fa_contact_type         TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS two_fa_contact_name         TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS two_fa_contact_phone        TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS two_fa_contact_email        TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS portal_notes                TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS contract_effective_date     DATE;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS contract_expiry_date        DATE;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS contract_package_rates      JSONB DEFAULT '{}'::jsonb;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS contract_room_rents         JSONB DEFAULT '{}'::jsonb;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS contract_exclusions         JSONB DEFAULT '[]'::jsonb;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS contract_payment_terms      TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS empanelment_notes           TEXT;
ALTER TABLE hospital.panel_empanelments ADD COLUMN IF NOT EXISTS internal_tags               TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_panel_empanelments_hospital ON hospital.panel_empanelments (hospital_id);
CREATE INDEX IF NOT EXISTS idx_panel_empanelments_status   ON hospital.panel_empanelments (empanelment_status);

-- master_options: extraction routing + grouping
ALTER TABLE hospital.master_options ADD COLUMN IF NOT EXISTS extraction_mode VARCHAR(16);
ALTER TABLE hospital.master_options ADD COLUMN IF NOT EXISTS group_code      VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_master_options_code        ON hospital.master_options (category, code);
CREATE INDEX IF NOT EXISTS idx_master_options_group_code  ON hospital.master_options (category, group_code);
CREATE INDEX IF NOT EXISTS idx_master_options_active      ON hospital.master_options (category, is_active);

-- document_sections: phash & dedup additions (table created earlier in bootstrap)
ALTER TABLE hospital.document_sections ADD COLUMN IF NOT EXISTS phash_computed_at    TIMESTAMP;
ALTER TABLE hospital.document_sections ADD COLUMN IF NOT EXISTS content_phash_array  TEXT[];
ALTER TABLE hospital.document_sections ADD COLUMN IF NOT EXISTS content_dhash_array  TEXT[];
CREATE INDEX IF NOT EXISTS idx_doc_sections_phash_gin     ON hospital.document_sections USING GIN (content_phash_array) WHERE content_phash_array IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doc_sections_phash_pending ON hospital.document_sections (claim_id) WHERE content_phash_array IS NULL;
CREATE INDEX IF NOT EXISTS idx_doc_sections_dedup_of      ON hospital.document_sections (dedup_of) WHERE dedup_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doc_sections_claim_text_hash ON hospital.document_sections (claim_id, content_text_hash) WHERE content_text_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_sections_claim_category ON hospital.document_sections (claim_id, category) WHERE claim_id IS NOT NULL AND category IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════
--  SECTION 8 — doc_category_groups view (helper for FE)
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW hospital.doc_category_groups AS
SELECT g.code        AS group_code,
       g.label       AS group_label,
       g.sort_order  AS group_sort_order,
       c.code        AS doc_category_code,
       c.label       AS doc_category_label,
       c.sort_order  AS doc_category_sort_order,
       c.is_active   AS doc_category_is_active
FROM hospital.master_options c
LEFT JOIN hospital.master_options g
  ON g.category = 'doc_category_group' AND g.code = c.group_code
WHERE c.category = 'doc_category';


-- ═══════════════════════════════════════════════════════════════════════
--  SECTION 9 — Mark all 65 original migrations as applied in pgmigrations
--  After this, `npm run migrate:up` is a no-op. New migrations land at #066+.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS hospital.pgmigrations (
  id     SERIAL PRIMARY KEY,
  name   VARCHAR(255) NOT NULL,
  run_on TIMESTAMP    NOT NULL
);

INSERT INTO hospital.pgmigrations (name, run_on) VALUES
  ('001_add_s3_support',                            NOW()),
  ('002_core_fixed',                                NOW()),
  ('002_core_new_tables_v2',                        NOW()),
  ('002_hospital_profile',                          NOW()),
  ('002b_fixed',                                    NOW()),
  ('002b_hospital_table_updates',                   NOW()),
  ('002c_attribute_definitions_seed',               NOW()),
  ('002c_fixed',                                    NOW()),
  ('003_add_banking_fields',                        NOW()),
  ('003_fixed',                                     NOW()),
  ('003_migrate_hospital_details',                  NOW()),
  ('003b_cashless_everywhere_seed',                 NOW()),
  ('003b_fixed',                                    NOW()),
  ('004_add_attribute_documents_junction',          NOW()),
  ('004_create_validator_verification_system',      NOW()),
  ('005_add_panel_attributes_system',               NOW()),
  ('005_create_doctor_configuration_system',        NOW()),
  ('006_create_master_options_table',               NOW()),
  ('010_consolidate_constraints_and_audit_logs',    NOW()),
  ('011_user_refresh_tokens_device_id',             NOW()),
  ('012_add_panel_code_column',                     NOW()),
  ('013_create_cashless_everywhere_tables',         NOW()),
  ('014_add_cashless_panel_attribute_definitions',  NOW()),
  ('015_create_panel_default_attributes',           NOW()),
  ('016_seed_sop_data',                             NOW()),
  ('017_add_claim_filing_route_to_ipds',            NOW()),
  ('018_fix_ipd_doc_column_names',                  NOW()),
  ('019_default_unset_filing_route_to_network',     NOW()),
  ('020_add_is_empanelled',                         NOW()),
  ('021_rename_preauth_to_insurance_submissions',   NOW()),
  ('022_drop_preauth_form_template_id',             NOW()),
  ('023_move_gmail_to_hospitals_drop_cew',          NOW()),
  ('024_add_ipd_stage',                             NOW()),
  ('025_add_idempotency_key_to_insurance_submissions', NOW()),
  ('026_cleanup_email_attr_naming_and_legacy_status', NOW()),
  ('027_submission_events_and_interface_id',        NOW()),
  ('028_ontology_foundations',                      NOW()),
  ('029_llm_cost_accounting',                       NOW()),
  ('030_event_schema_extensions',                   NOW()),
  ('031_claim_dossiers',                            NOW()),
  ('032_document_sections',                         NOW()),
  ('033_email_intelligence',                        NOW()),
  ('034_loosen_submission_events_insurance_submission_id', NOW()),
  ('035_stage_requirements',                        NOW()),
  ('036_adjudication_reports',                      NOW()),
  ('037_claim_actions',                             NOW()),
  ('038_kb_patterns',                               NOW()),
  ('039_episodic_memory',                           NOW()),
  ('040_adjudication_eval',                         NOW()),
  ('041_loosen_submission_events_hospital_id',      NOW()),
  ('042_doc_taxonomy_expansion',                    NOW()),
  ('043_claim_harmonised_episodes',                 NOW()),
  ('044_insurer_rule_sets',                         NOW()),
  ('045_ai_corrections',                            NOW()),
  ('046_document_section_corrections_notes',        NOW()),
  ('047_doc_category_additions',                    NOW()),
  ('048_field_schemas_for_kyc_and_reports',         NOW()),
  ('049_doc_category_extraction_hints',             NOW()),
  ('050_doc_category_extraction_mode',              NOW()),
  ('051_field_schemas_for_clinical_categories',     NOW()),
  ('052_vision_routing_for_handwritten_categories', NOW()),
  ('053_field_schemas_for_missing_categories',      NOW()),
  ('054_field_schemas_round_2',                     NOW()),
  ('055_dedup_layer',                               NOW()),
  ('056_section_content_dedup',                     NOW()),
  ('057_file_level_dedup',                          NOW()),
  ('058_section_phash_arrays',                      NOW()),
  ('059_aadhaar_taxonomy_and_pmjay_categories',     NOW()),
  ('060_claim_ai_runs',                             NOW()),
  ('061_doc_phase_ledger',                          NOW()),
  ('062_failed_category_marker',                    NOW()),
  ('063_missing_clinical_schemas',                  NOW()),
  ('064_extraction_corrections',                    NOW()),
  ('065_hospital_format_profiles',                  NOW())
ON CONFLICT DO NOTHING;


-- Done. Restart the backend container after this finishes:
--   docker compose restart backend worker
