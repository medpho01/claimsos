# Cashless Everywhere Email Interface — Data Model (rev 3, final)

**Status:** Final design, reflecting the existing codebase
**Supersedes:** prior drafts of this file. The earlier versions invented
parallel tables (`insurer_entities`, `hospital_entity_configurations`,
`hospital_notification_channels`) which the existing schema already
covers.

**Design principle (locked):** *Email is just a channel.* The submission
lifecycle, contact storage, credentials, notifications — none of it
should be email-specific. When portal/RPA panels arrive later, they
plug into the **same** tables by setting `claim_submission_method =
'portal'` instead of `'email'`. **No new design required for RPA.**

---

## 1. What's already in the codebase (and we use as-is)

After reading the existing schema + migrations, here's the foundation:

| Already exists | What it does | We use it for |
|---|---|---|
| `panels` (with `panel_type`, `is_system_panel`) | Master TPA/insurer registry | Seed the 49 SOP entities here |
| `hospital_panels` | Per-hospital × panel relationship; has `whatsapp_group_id`, `sheet_id`, `drive_folder_id`, `contact` | The "is this hospital configured for this TPA" answer |
| `hospital_panels.whatsapp_group_id` | UltraMsg group ID per hospital × panel | **This is the answer to "where do revert notifications go"** |
| `panel_attribute_definitions` (36 attrs seeded) | Catalog of attribute keys per panel relationship: `claim_submission_email`, `panel_primary_contact_email`, `portal_url`, `portal_username` (encrypted), `mous` (file), `claim_submission_method` (email/portal/edi/api), `pre_auth_validity_days`, `bill_submission_deadline_days`, etc. | The runtime contact + interface config per (hospital × panel) |
| `panel_attributes` | Polymorphic value storage per (hospital_panel × definition) | Where the actual email addresses, deadlines, credentials live |
| `panel_attribute_documents` | Junction to `hospital_documents` | MoU + form attachments |
| `hospital_documents` | Hospital-level doc storage (S3) | Reused for MoUs and uploaded forms |
| `ce_opted_in` on `hospitals` | Hospital-level CE master flag | Hospital admin toggles platform-wide |
| `pdfkit` in `Backend/package.json` | PDF generation library | Used for the filled pre-auth PDF |
| `ultraMsg.service.ts` with `sendMessage(to, body)` | WhatsApp dispatch via UltraMsg | Used for revert notifications |
| `notificationBuffer.service.ts` | Existing notification debouncing | Reused for claim alerts |

**This is the meta-finding:** the existing platform already has 80% of
what Cashless Everywhere email needs. The new work is small and
additive.

---

## 2. What's net-new (the actual scope)

Five tables and ~8 new attribute definition rows. That's the whole
change to the data model.

### 2.1 Net-new tables

1. **`preauth_form_templates`** — the 42 PDFs from SOP Sheet 3 + their AcroForm field maps
2. **`mou_templates`** — the 11 MoU type metadata from SOP Sheet 4
3. **`preauth_submissions`** — one row per submission attempt; **channel-agnostic** (email today, portal tomorrow)
4. **`emails_outbound`** + **`emails_inbound`** — Gmail outbound/inbound with threading
5. **`hospital_gmail_credentials`** — encrypted OAuth tokens (hospital-wide, not per-panel)

Plus optionally:
6. **`panel_default_attributes`** — SOP-derived defaults per panel; used only to pre-fill `panel_attributes` when a hospital enables a panel for the first time.

### 2.2 Net-new `panel_attribute_definitions` rows

The existing 36 seeded attributes cover almost everything except a few
SOP-specific items. We add these as new rows in
`panel_attribute_definitions` (no schema change, just INSERTs):

```sql
INSERT INTO hospital.panel_attribute_definitions
  (key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES
  -- Pre-auth form choice
  ('preauth_form_template_id', 'Pre-Auth Form Template',
   'Which pre-auth PDF template this panel requires',
   'operational', 'single_select', false, true, 70),

  -- MoU choice
  ('mou_template_id', 'MoU Template',
   'Which MoU variant this panel uses', 'operational', 'single_select',
   false, true, 71),

  -- Deadlines in HOURS (existing ones are days — SOP gives hours)
  ('preauth_deadline_planned_hours', 'Pre-Auth Deadline - Planned (hours)',
   'Hours BEFORE admission for planned cases', 'operational', 'text',
   false, true, 72),
  ('preauth_deadline_emergency_hours', 'Pre-Auth Deadline - Emergency (hours)',
   'Hours AFTER admission for emergency cases', 'operational', 'text',
   false, true, 73),

  -- Cashless Everywhere email composition
  ('cashless_email_to_list', 'Cashless Pre-Auth: To Addresses',
   'List of "to" emails for pre-auth (one or more)', 'operational',
   'textarea', false, true, 74),
  ('cashless_email_cc_list', 'Cashless Pre-Auth: CC Addresses',
   'CC list for pre-auth emails', 'operational', 'textarea', false,
   true, 75),
  ('cashless_subject_template', 'Cashless Pre-Auth: Subject Template',
   'Subject line template, e.g. "PRE-AUTH | {hospital_name} | {patient_name}"',
   'operational', 'text', false, true, 76),

  -- SOP knowledge fields (hospital can read; not used for submission logic)
  ('sop_secondary_contacts', 'SOP Notes: Secondary Contacts',
   'Regional offices, WhatsApp helplines (from SOP col 7)',
   'contact', 'textarea', false, true, 80),
  ('sop_step_by_step', 'SOP Notes: Step-by-Step',
   'Recommended submission workflow (from SOP col 12)',
   'operational', 'textarea', false, true, 81),
  ('sop_watch_outs', 'SOP Notes: Critical Watch-Outs',
   'Important warnings (from SOP col 15)',
   'operational', 'textarea', false, true, 82);
```

A few notes on these:
- We don't add a new `category`. Everything fits under existing
  `operational` or `contact` categories.
- `preauth_form_template_id` is `single_select` — but at runtime the
  options are populated from `preauth_form_templates` table, not the
  definition's `options` JSON. The FE renders this differently.
- The existing `claim_submission_email` covers single primary email.
  We add `cashless_email_to_list` (textarea, parsed as comma-separated)
  for multi-recipient cases like Paramount with two emails. **Both
  exist; the application reads whichever is populated, prefers the
  list.**

That's the panel-attribute side. ~10 new INSERTs in a single migration.

---

## 3. The five net-new tables (schemas)

### 3.1 `preauth_form_templates` — the 42 PDFs

```sql
CREATE TABLE hospital.preauth_form_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name VARCHAR(255) NOT NULL,                    -- "Medi Assist Pre-Auth Form"
  code VARCHAR(50) UNIQUE NOT NULL,              -- 'MEDI_ASSIST_PREAUTH'

  -- Storage
  source_url TEXT,                               -- original krbusinesssolutions.in URL
  s3_key TEXT NOT NULL,                          -- our S3 copy
  file_size_bytes BIGINT,
  page_count INT,

  -- AcroForm metadata
  is_acroform BOOLEAN,                           -- determined at ingest
  field_map JSONB DEFAULT '{}'::jsonb,           -- pdf_field_name → claim/patient path; populated by analyst

  -- Lifecycle
  is_active BOOLEAN DEFAULT true,
  notes TEXT,                                    -- SOP "Key Differences from Standard"
  version VARCHAR(20),

  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES hospital.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_preauth_form_active ON hospital.preauth_form_templates(is_active);
```

Platform-level. Same form template used by all hospitals that route to
the same panel.

### 3.2 `mou_templates` — the 11 MoU types

```sql
CREATE TABLE hospital.mou_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name VARCHAR(255) NOT NULL,                    -- "Letter of Consent (MOST DETAILED)"
  code VARCHAR(50) UNIQUE NOT NULL,              -- 'LOC_DETAILED'
  applies_to_label VARCHAR(255),                 -- SOP Insurer/TPA col (for reference)

  validity_text TEXT,
  key_clauses TEXT,
  rate_terms TEXT,
  audit_rights TEXT,
  submission_deadline TEXT,
  payment_timeline TEXT,
  risk_level VARCHAR(20),                        -- 'LOW' | 'LOW-MEDIUM' | 'MEDIUM' | 'HIGH'
  risk_notes TEXT,
  source_template_url TEXT,                      -- if SOP links to the actual template
  s3_key TEXT,                                   -- optional: blank MoU template binary

  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

Platform-level metadata. When a hospital signs an MoU, the *signed*
copy is stored against `panel_attributes.mous` (the existing `file`
type attribute) — no new column needed.

### 3.3 `preauth_submissions` — channel-agnostic submission lifecycle

```sql
CREATE TABLE hospital.preauth_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Linkage
  ipd_id UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  hospital_panel_id UUID NOT NULL REFERENCES hospital.hospital_panels(id),
  -- ↑ This is the key. ALL config is read via hospital_panel_id → panel_attributes.
  -- Channel-agnostic: email today, portal tomorrow.

  -- Channel (determined at submission time from panel_attributes.claim_submission_method)
  submitted_via VARCHAR(20) NOT NULL,            -- 'email' | 'portal' | 'edi' | 'api'

  -- What went out
  preauth_form_template_id UUID REFERENCES hospital.preauth_form_templates(id),
  filled_pdf_s3_key TEXT,
  doc_bundle JSONB NOT NULL,                     -- [{ document_id, role }]

  -- Channel-specific linkage (nullable per channel)
  email_outbound_id UUID,                        -- FK populated for email channel
  portal_session_id UUID,                        -- placeholder for future RPA channel

  -- Status (channel-agnostic)
  status VARCHAR(30) NOT NULL DEFAULT 'drafted',
  -- 'drafted' | 'sent' | 'delivered' | 'acknowledged' | 'queried' | 'approved' | 'rejected' | 'failed'

  -- External identifiers captured from insurer
  external_claim_id VARCHAR(100),
  external_ccn VARCHAR(100),

  -- Timeline
  drafted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMP WITH TIME ZONE,
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  preauth_deadline_at TIMESTAMP WITH TIME ZONE,  -- computed from panel_attributes + admission_type

  -- Resubmission chain
  attempt_number INT DEFAULT 1,
  resubmission_of_id UUID REFERENCES hospital.preauth_submissions(id),

  submitted_by UUID REFERENCES hospital.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ps_ipd ON hospital.preauth_submissions(ipd_id);
CREATE INDEX idx_ps_external ON hospital.preauth_submissions(external_claim_id)
  WHERE external_claim_id IS NOT NULL;
CREATE INDEX idx_ps_status_deadline ON hospital.preauth_submissions(status, preauth_deadline_at);
CREATE INDEX idx_ps_hospital_panel ON hospital.preauth_submissions(hospital_panel_id);
```

**Key design choice:** This table has zero email-specific columns.
Email-specific data lives in `emails_outbound`, linked via
`email_outbound_id`. When portal RPA arrives, it gets its own
`portal_sessions` table linked via `portal_session_id`. The
`preauth_submissions` schema doesn't change.

### 3.4 `emails_outbound` + `emails_inbound`

```sql
CREATE TABLE hospital.emails_outbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL,

  -- Backlink (nullable — could be a non-claim email)
  ipd_id UUID REFERENCES hospital.ipds(id),
  preauth_submission_id UUID REFERENCES hospital.preauth_submissions(id),
  hospital_panel_id UUID REFERENCES hospital.hospital_panels(id),

  -- Routing
  to_addresses TEXT[] NOT NULL,
  cc_addresses TEXT[] DEFAULT '{}',
  from_address VARCHAR(255) NOT NULL,            -- hospital's Gmail
  reply_to VARCHAR(255),

  -- Content
  subject TEXT NOT NULL,
  body_text TEXT,
  body_html TEXT,
  attachments JSONB DEFAULT '[]'::jsonb,         -- [{ filename, s3_key, mime_type, size_bytes }]

  -- Gmail threading
  gmail_message_id VARCHAR(255),
  gmail_thread_id VARCHAR(255),
  in_reply_to VARCHAR(255),
  references_header TEXT,

  -- Send status
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  -- 'queued' | 'sending' | 'sent' | 'bounced' | 'failed'
  failure_reason TEXT,

  queued_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMP WITH TIME ZONE,
  idempotency_key VARCHAR(255) UNIQUE NOT NULL,

  composed_by VARCHAR(100),                      -- 'user:<uuid>' | 'system:composer:v1'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_eo_gmail_msg ON hospital.emails_outbound(gmail_message_id)
  WHERE gmail_message_id IS NOT NULL;
CREATE INDEX idx_eo_thread ON hospital.emails_outbound(gmail_thread_id);
CREATE INDEX idx_eo_ipd ON hospital.emails_outbound(ipd_id);

CREATE TABLE hospital.emails_inbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL,

  gmail_message_id VARCHAR(255) UNIQUE NOT NULL,
  gmail_thread_id VARCHAR(255),
  in_reply_to VARCHAR(255),
  references_header TEXT,

  from_address VARCHAR(255) NOT NULL,
  to_addresses TEXT[] DEFAULT '{}',
  cc_addresses TEXT[] DEFAULT '{}',
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  raw_email_s3_key TEXT,                         -- full RFC822 source
  attachments JSONB DEFAULT '[]'::jsonb,

  received_at TIMESTAMP WITH TIME ZONE NOT NULL,

  -- Resolution
  hospital_panel_id UUID REFERENCES hospital.hospital_panels(id),  -- resolved by from_address match
  matched_ipd_id UUID REFERENCES hospital.ipds(id),
  matched_submission_id UUID REFERENCES hospital.preauth_submissions(id),
  match_method VARCHAR(50),
  -- 'thread' | 'claim_no_regex' | 'patient_name_fuzzy' | 'manual' | 'unmatched'

  -- Classification (Phase 2 parser; for now everything is 'received')
  classification VARCHAR(30) DEFAULT 'received',
  -- 'received' | 'ack' | 'query' | 'approval' | 'rejection' | 'settlement' | 'other'
  parsed_payload JSONB,

  needs_ops_review BOOLEAN DEFAULT false,
  processed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ei_in_reply_to ON hospital.emails_inbound(in_reply_to)
  WHERE in_reply_to IS NOT NULL;
CREATE INDEX idx_ei_matched ON hospital.emails_inbound(matched_ipd_id);
CREATE INDEX idx_ei_unmatched ON hospital.emails_inbound(hospital_id, received_at)
  WHERE matched_ipd_id IS NULL;
```

### 3.5 `hospital_gmail_credentials` — Gmail OAuth, hospital-wide

Hospital-wide because one Gmail account serves all TPAs. Encrypted via
envelope encryption against KMS.

```sql
CREATE TABLE hospital.hospital_gmail_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL UNIQUE REFERENCES hospital.hospitals(id) ON DELETE CASCADE,

  gmail_address VARCHAR(255) NOT NULL,
  granted_scopes TEXT[] DEFAULT '{}',

  -- Envelope-encrypted OAuth payload (access_token + refresh_token + expires_at)
  encrypted_payload BYTEA NOT NULL,
  kms_key_arn TEXT NOT NULL,
  dek_ciphertext BYTEA NOT NULL,

  -- Health
  token_expires_at TIMESTAMP WITH TIME ZONE,
  last_verified_at TIMESTAMP WITH TIME ZONE,
  last_verification_status VARCHAR(20),          -- 'valid' | 'expired' | 'revoked' | 'error'
  last_verification_error TEXT,

  -- Pub/Sub watch (for inbound)
  gmail_watch_history_id VARCHAR(255),
  gmail_watch_expires_at TIMESTAMP WITH TIME ZONE,

  -- Lifecycle
  granted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  granted_by UUID REFERENCES hospital.users(id),
  revoked_at TIMESTAMP WITH TIME ZONE,
  revoked_reason TEXT
);
```

One row per hospital, used for all panels' email I/O.

### 3.6 Optional: `panel_default_attributes` — SOP-seeded defaults

When a hospital first enables a panel, we want to pre-fill the
operational attributes (emails, deadlines, form choice) from the SOP.
This needs a per-panel reference.

```sql
CREATE TABLE hospital.panel_default_attributes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id UUID NOT NULL REFERENCES hospital.panels(id) ON DELETE CASCADE,
  panel_attribute_definition_id UUID NOT NULL REFERENCES hospital.panel_attribute_definitions(id) ON DELETE CASCADE,

  -- Polymorphic default value (matches panel_attributes column shape)
  default_value_text TEXT,
  default_value_boolean BOOLEAN,
  default_value_date DATE,
  default_value_json JSONB,

  -- Provenance
  source VARCHAR(50) DEFAULT 'sop_seed',         -- 'sop_seed' | 'manual'
  sop_version VARCHAR(20),
  seeded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (panel_id, panel_attribute_definition_id)
);

CREATE INDEX idx_pda_panel ON hospital.panel_default_attributes(panel_id);
```

Used only when creating a new `hospital_panels` row. Application
logic: on insert, iterate panel_default_attributes for the panel_id,
INSERT corresponding panel_attributes rows. Hospital can edit any of
them afterwards.

**Or skip this table** and write a seed script that directly populates
panel_attributes for all existing hospital_panels rows when the SOP
seed runs. Simpler but less flexible for adding new hospitals later.
Recommendation: build the table — it's small (~500 rows) and saves
re-running the seed every time a hospital onboards a new panel.

---

## 4. The four required behaviours, mapped to existing + new schema

### 4.1 "Is Cashless Everywhere live for this hospital?"

Two checks, both deterministic SQL using **only existing tables plus
the new `hospital_gmail_credentials`**:

```typescript
async function isCeLive(hospitalId: string, panelId?: string) {
  const result = await pool.query(`
    SELECT
      h.ce_opted_in,
      EXISTS (
        SELECT 1 FROM hospital_gmail_credentials gc
        WHERE gc.hospital_id = h.id
          AND gc.last_verification_status = 'valid'
          AND gc.revoked_at IS NULL
      ) AS has_valid_gmail,
      ${panelId ? `
      EXISTS (
        SELECT 1 FROM hospital_panels hp
        JOIN panel_attributes pa_method ON pa_method.hospital_panel_id = hp.id
        JOIN panel_attribute_definitions pad_method
          ON pad_method.id = pa_method.panel_attribute_definition_id
          AND pad_method.key = 'claim_submission_method'
        WHERE hp.hospital_id = h.id
          AND hp.panel_id = $2
          AND pa_method.value_text = 'email'
      ) AS panel_uses_email,
      EXISTS (
        SELECT 1 FROM hospital_panels hp
        JOIN panel_attributes pa_email ON pa_email.hospital_panel_id = hp.id
        JOIN panel_attribute_definitions pad_email
          ON pad_email.id = pa_email.panel_attribute_definition_id
          AND pad_email.key IN ('claim_submission_email', 'cashless_email_to_list')
        WHERE hp.hospital_id = h.id
          AND hp.panel_id = $2
          AND pa_email.value_text IS NOT NULL
          AND pa_email.value_text <> ''
      ) AS panel_has_email_configured
      ` : 'TRUE AS panel_uses_email, TRUE AS panel_has_email_configured'}
    FROM hospitals h
    WHERE h.id = $1
  `, panelId ? [hospitalId, panelId] : [hospitalId]);

  // CE is live when:
  //  - Hospital has opted in to CE
  //  - Hospital has a valid Gmail OAuth credential
  //  - (If panel specified) the panel is configured for email + has the email address set
}
```

The hospital workspace UI uses this to show "CE: live / setup needed"
with the specific missing piece linked to its config screen.

### 4.2 "Store insurer contact + interface details per hospital"

**Already solved by `panel_attributes` + `panel_attribute_definitions`.**
The hospital admin's settings UI for a panel shows the existing 36
attributes plus the new ~8 we add. Each attribute is per (hospital ×
panel), exactly as required.

Pre-fill flow when hospital enables a panel:
1. INSERT `hospital_panels` row (existing flow).
2. App-level hook reads `panel_default_attributes` for this `panel_id`.
3. For each default, INSERT `panel_attributes` with the SOP value.
4. Hospital admin opens the panel config screen and edits anything
   they want to change.

### 4.3 "Bundle docs + send pre-auth"

Hospital ops opens an IPD record → clicks "Send Pre-Auth" → the flow:

```
1. Look up panel for this IPD (ipds.panel_id or ipds.hospital_panel_id)
2. Read panel_attributes for this hospital_panel:
   - claim_submission_method (must be 'email' for this path)
   - cashless_email_to_list (parse to TEXT[])
   - cashless_email_cc_list
   - cashless_subject_template
   - preauth_form_template_id
   - preauth_deadline_planned_hours / preauth_deadline_emergency_hours
3. Read preauth_form_templates row for the chosen template
4. Fill the PDF (using pdfkit's AcroForm support) from patient + claim data
5. Save filled PDF to S3 + register as a hospital_documents row
6. Validate doc bundle is non-empty
7. Within ONE transaction:
   a. INSERT preauth_submissions (status='drafted', submitted_via='email')
   b. INSERT emails_outbound (status='queued')
   c. UPDATE preauth_submissions.email_outbound_id
8. Outbox worker picks up emails_outbound:
   a. Decrypt hospital_gmail_credentials via KMS
   b. Refresh OAuth token if expired
   c. Send via Gmail API
   d. Capture gmail_message_id, gmail_thread_id
   e. UPDATE emails_outbound.status='sent', sent_at=now
   f. UPDATE preauth_submissions.status='sent', sent_at=now
9. UI now shows the IPD with "Pre-Auth Submitted" badge + email in timeline
```

**Channel-agnostic point:** step 2 reads `claim_submission_method`. If
the value is `'portal'` instead of `'email'`, the same `preauth_submissions`
INSERT happens — only the downstream worker differs (portal RPA worker
instead of Gmail send). **The submission lifecycle stays the same.**

### 4.4 "Insurer revert → notification on hospital group + claim"

Gmail Pub/Sub push fires the inbound flow:

```
1. /webhooks/gmail/:hospital_id receives Pub/Sub push
2. Worker fetches the full message via Gmail API
3. INSERT emails_inbound (raw fields, classification='received')
4. Match-to-claim resolver:
   a. Lookup by from_address against panel_attributes.claim_submission_email
      AND emails_outbound.to_addresses to identify the hospital_panel
   b. If in_reply_to present: find emails_outbound.gmail_message_id →
      get preauth_submission_id → get ipd_id
   c. If no thread match: regex for claim number in subject/body
   d. If still no match: flag needs_ops_review=true
5. UPDATE emails_inbound with matched_ipd_id, matched_submission_id, match_method
6. Notification dispatch:
   a. SELECT hp.whatsapp_group_id FROM hospital_panels hp
      WHERE id = (matched submission's hospital_panel_id)
   b. If whatsapp_group_id present:
      ultraMsg.sendMessage(whatsapp_group_id,
        `🔔 Pre-Auth Revert | Claim ${claim_no} | ${from_address}
         Subject: ${subject}
         Action required: Open claim to review and respond.`)
   c. INSERT into existing notification system for in-app alert
7. IPD's UI updates: timeline shows new inbound, "Action Required" pill,
   notification badge increments
```

**`hospital_panels.whatsapp_group_id` already exists** and is already
used for hospital ops notifications throughout the codebase (uploads,
discharge, etc.). We just wire one more event into it.

The classification (ack / query / approval / rejection) is a Phase 2
parser layer. For now, **every revert generates a notification** —
hospital ops opens the claim, reads the email, takes action.

---

## 5. The crucial design property: RPA-readiness

The user asked: *"Email is used as an interface … there won't be new
design requirement for panel RPAs, that we will design further."*

The design holds this. When portal RPA arrives:

| What changes for RPA | What stays the same |
|---|---|
| New `portal_sessions` table (RPA job lifecycle, screenshots, evidence) | `preauth_submissions` schema (just `submitted_via='portal'`) |
| New worker: `portal-submit-worker` parallel to email outbox worker | `panel_attributes` config shape (already has `portal_url`, `portal_username`, `portal_password` encrypted, `two_fa_method`, etc.) |
| New status capture mechanism (screenshots vs threading) | Notification dispatch (`hospital_panels.whatsapp_group_id` works for portal reverts too) |
| Maybe new captcha service integration | Pre-auth form rendering (filled PDF still goes via portal upload) |

The point: **the data model and the user-facing flow are identical
across channels.** Hospital ops doesn't know whether the system sent
via email or portal — they see "Pre-Auth Submitted" and a timeline.
When a revert lands, they see a notification and an action item.
Channel is implementation detail.

This is the reason `preauth_submissions` has `submitted_via` as a
column, links to email/portal via separate FKs (one populated at a
time), and exposes a channel-agnostic status enum.

---

## 6. SOP ingestion plan (concrete steps)

### Step 1 — Seed `panels` (49 rows from SOP Sheet 1)

```sql
-- Add a panel for each SOP entity (idempotent by name or code)
INSERT INTO panels (id, name, panel_type, is_system_panel)
VALUES
  (gen_random_uuid(), 'Medi Assist', 'tpa', false),
  (gen_random_uuid(), 'Paramount Health Services', 'tpa', false),
  (gen_random_uuid(), 'Vidal Health', 'tpa', false),
  ... -- 49 total
ON CONFLICT (name) DO NOTHING;
```

(If `panels.name` is not unique, we add a unique constraint as part of
this migration or use a stable code. The existing `panels` table has
neither `code` nor a uniqueness constraint on `name` — easy fix: add a
`code` column.)

### Step 2 — Seed `preauth_form_templates` (42 PDFs from SOP Sheet 3)

For each row:
1. Download PDF from SOP URL (one-time during seed; krbusinesssolutions.in
   URLs).
2. Upload to S3 under `preauth-forms/{code}.pdf`.
3. Probe AcroForm fields using pdfkit / pdf-lib (one library call).
4. INSERT `preauth_form_templates` with `s3_key`, `is_acroform`,
   `field_map = {}`.

Field maps are populated later by an analyst — ~30 min per AcroForm
PDF, ~1 hour per image-based PDF. **One form is enough to pilot
(Medi Assist).** Rest follow.

### Step 3 — Seed `mou_templates` (11 rows from SOP Sheet 4)

Simple INSERTs. No binaries unless the SOP links to actual template
files.

### Step 4 — Seed `panel_default_attributes` (the SOP defaults per panel)

For each panel (49 rows × ~10 attributes each = ~490 INSERTs):

```sql
INSERT INTO panel_default_attributes
  (panel_id, panel_attribute_definition_id, default_value_text, source, sop_version)
SELECT
  (SELECT id FROM panels WHERE code = 'MEDI_ASSIST'),
  (SELECT id FROM panel_attribute_definitions WHERE key = 'claim_submission_email'),
  'cashlesseverywhere@mediassist.in',
  'sop_seed',
  '2026-05';
-- ... etc for each (panel × attribute key) from the SOP file
```

This is generated by a script reading the SOP Excel directly. Output:
one SQL migration file with all INSERTs.

### Step 5 — Backfill `panel_attributes` for existing hospital_panels

For every existing `hospital_panels` row, copy from
`panel_default_attributes` if a matching `panel_attributes` row doesn't
already exist. One-time operation, idempotent.

### Step 6 — Hospital admin reviews + edits

Each hospital admin opens *Settings → Panels → Medi Assist* and sees
the pre-filled config. They can edit if their relationship differs
(e.g. negotiated different deadline, regional contact override).

---

## 7. The migration files (final list)

```
018_create_preauth_form_templates.sql       (~50 lines)
019_create_mou_templates.sql                (~40 lines)
020_create_panel_default_attributes.sql     (~30 lines)
021_add_panel_attribute_definitions_for_ce.sql  (~10 INSERTs, ~30 lines)
022_seed_sop_panels.sql                     (~49 INSERTs, generated)
023_seed_sop_preauth_forms.sql              (~42 INSERTs, generated)
024_seed_sop_mou_templates.sql              (~11 INSERTs, generated)
025_seed_sop_panel_defaults.sql             (~490 INSERTs, generated)
026_create_preauth_submissions.sql          (~60 lines)
027_create_emails_outbound.sql              (~60 lines)
028_create_emails_inbound.sql               (~70 lines)
029_create_hospital_gmail_credentials.sql   (~50 lines)
```

Twelve files. Migrations 022-025 are generated by a small script from
the SOP Excel — the script is part of the codebase so re-seeding for
SOP refreshes is reproducible.

---

## 8. What's confirmed / still open

### Confirmed (per user input)

- ✅ Contact details live at hospital-panel level (via `panel_attributes`)
- ✅ WhatsApp group ID already lives on `hospital_panels.whatsapp_group_id`
- ✅ MoU + contracts already storable via existing `panel_attributes` (file type)
- ✅ PDF library: `pdfkit` already in package.json
- ✅ Email-as-channel design must not preclude future RPA panels — design holds

### Still open

1. **`panels` uniqueness key** — currently no unique constraint on `name`.
   Recommendation: add a `code VARCHAR(50) UNIQUE` column so SOP re-seeds
   are idempotent (Medi Assist → `MEDI_ASSIST`). One-line ALTER.
2. **Hospital-wide Gmail OAuth vs per-panel** — design assumes hospital-wide
   (one Gmail for all TPAs). Confirm.
3. **Existing inbound parser?** — the codebase has Gmail OAuth for *outbound*
   document sharing. Does it also have a Pub/Sub inbound webhook? If not,
   that's net-new infra (one Cloud Run endpoint + Gmail watch setup per
   hospital).
4. **Notification format** — the proposed WhatsApp message is generic.
   Want to customise? The same `panel_attributes` system can store a
   per-hospital notification template if needed.

---

## 9. The "entity code" question

You asked what I meant by entity code curation. Clarifying:

The SOP has entity names like "Medi Assist" — but names are not stable
identifiers for code. We need short, stable, all-caps codes used in:
- Migration files referencing specific panels (`SELECT id FROM panels
  WHERE code = 'MEDI_ASSIST'`)
- Application config (e.g. "if panel.code === 'MEDI_ASSIST' run this
  special flow")
- Logs and metrics

If the existing `panels` table has no `code` column yet, we add one
(`ALTER TABLE panels ADD COLUMN code VARCHAR(50) UNIQUE`), generate
codes mechanically from names (`Medi Assist → MEDI_ASSIST`, `MD India →
MD_INDIA`, `Vidal Health → VIDAL_HEALTH`), and back-fill once.

It's literally one ALTER + 49 UPDATEs. 30 minutes to curate the list
of codes; lifetime saving in identifier stability.

---

## 10. Effort to first real pre-auth out

| Track | Owner | Effort |
|---|---|---|
| Migrations 018-021 (form/mou/defaults tables + new attribute defs) | 1 BE | 2 days |
| SOP seed script (generates migrations 022-025) | 1 BE | 3 days |
| Migrations 026-029 (submissions, emails, gmail creds) | 1 BE | 2 days |
| Add `code` column to `panels`, backfill | 1 BE | 0.5 day |
| Pre-auth PDF AcroForm fill for Medi Assist | 1 BE + analyst | 2 days |
| Panel config UI updates (just new attribute keys; existing UI handles them) | 1 FE | 1 day |
| Gmail OAuth onboarding flow (if not already present) | 1 BE | 3 days |
| Outbox worker for `emails_outbound` | 1 BE | 2 days |
| Pub/Sub inbound webhook + match-to-claim | 1 BE | 3 days |
| Notification on revert → WhatsApp via existing UltraMsg | 1 BE | 1 day |
| First end-to-end pilot test | All | 1 day |
| **Total** | 1 BE + 1 FE + 1 analyst | **~3 weeks** |

Faster than the prior estimate because we're not building parallel
tables — just slotting into `panels` / `hospital_panels` /
`panel_attributes` with a few additions and seed data.

---

## 11. The summary in one paragraph

The existing platform's `panels` / `hospital_panels` /
`panel_attribute_definitions` / `panel_attributes` system is the right
substrate for storing Cashless Everywhere config — we don't build a
parallel set of tables. We seed the 49 SOP entities into `panels`, add
~8 new attribute definitions for CE-specific fields (form choice, MoU
choice, deadlines in hours, multi-recipient email lists), seed SOP
defaults via `panel_default_attributes`, and add four runtime tables
(`preauth_submissions`, `emails_outbound`, `emails_inbound`,
`hospital_gmail_credentials`) plus two reference tables
(`preauth_form_templates`, `mou_templates`). WhatsApp notifications
ride on the existing `hospital_panels.whatsapp_group_id` + UltraMsg
integration. The `preauth_submissions` lifecycle is channel-agnostic —
when portal RPA arrives, it's the same row with `submitted_via='portal'`
and a different worker downstream. No re-architecture needed.
