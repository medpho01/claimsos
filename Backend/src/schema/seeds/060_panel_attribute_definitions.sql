-- ==========================================================================
-- 060 — panel_attribute_definitions (per hospital x panel config catalog)
-- ==========================================================================
-- Applied by src/schema/run-seeds.cjs, which owns the transaction and records
-- this file's sha256 in hospital.seed_applications. Editing the file changes
-- that checksum, which is exactly what makes the next `npm run seed` re-apply
-- it. See seeds/README.md for the authoring rules the CI guard enforces.
--
-- This is a DECLARATIVE snapshot of the desired catalog, not a replay of
-- history: it was generated from a database that had run every migration in
-- order, so it is the union of the sources below with every later rename,
-- relabel and correction already folded in.
--
-- Historical sources (left untouched in migrations/, which production is
-- already stamped for):
--   005_add_panel_attributes_system.sql (base 36 attributes)
--   014_add_cashless_panel_attribute_definitions.sql (13 Cashless Everywhere keys)
--   022 / 023 / 026 pruned superseded keys — those deletions are already
--   reflected in this snapshot.
--
-- created_by / updated_by are deliberately omitted: they are per-environment user
-- UUIDs, not catalog data.
-- ==========================================================================

INSERT INTO hospital.panel_attribute_definitions
    (key, label, description, category, data_type, options, validation_regex,
     validation_min_length, validation_max_length, is_required, is_unique,
     default_value, sort_order, is_active) VALUES
    ('portal_url', 'Portal URL', 'Main URL for panel portal access', 'portal', 'url', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 1, true),
    ('portal_email', 'Portal Email Address', 'Email address for panel communication', 'portal', 'email', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 2, true),
    ('portal_name', 'Portal Name', 'Name/identifier of the portal system', 'portal', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 3, true),
    ('portal_notes', 'Portal Access Notes', 'Additional notes about portal access and troubleshooting', 'portal', 'textarea', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 4, true),
    ('authentication_type', 'Authentication Type', 'Type of authentication required for panel portal', 'credential', 'single_select', '{"sso": "Single Sign-On", "none": "No Auth Required", "aadhar_2fa": "Aadhar + 2FA", "certificate": "Certificate Based", "email_password": "Email & Password", "email_password_2fa": "Email & Password + 2FA"}'::jsonb, NULL, NULL, NULL, true, false, NULL, 10, true),
    ('portal_username', 'Portal Username', 'Username for portal login', 'credential', 'encrypted_text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 11, true),
    ('portal_password', 'Portal Password', 'Password for portal login (encrypted at rest)', 'credential', 'encrypted_text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 12, true),
    ('two_fa_method', '2FA Method', 'Type of two-factor authentication method', 'credential', 'single_select', '{"none": "None", "sms_otp": "SMS OTP", "email_otp": "Email OTP", "authenticator_app": "Authenticator App"}'::jsonb, NULL, NULL, NULL, false, false, NULL, 13, true),
    ('two_fa_phone', '2FA Phone Number', 'Phone number for OTP delivery', 'credential', 'phone', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 14, true),
    ('two_fa_email', '2FA Email Address', 'Email address for OTP delivery', 'credential', 'email', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 15, true),
    ('two_fa_secret', '2FA Secret Key', 'Secret key for authenticator apps (encrypted)', 'credential', 'encrypted_text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 16, true),
    ('hospital_primary_contact_name', 'Hospital Primary Contact - Name', 'Primary contact person from hospital', 'contact', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 30, true),
    ('hospital_primary_contact_designation', 'Hospital Primary Contact - Designation', 'Job title/designation', 'contact', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 31, true),
    ('hospital_primary_contact_email', 'Hospital Primary Contact - Email', 'Email address', 'contact', 'email', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 32, true),
    ('hospital_primary_contact_phone', 'Hospital Primary Contact - Phone', 'Phone number', 'contact', 'phone', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 33, true),
    ('hospital_secondary_contact_name', 'Hospital Secondary Contact - Name', 'Secondary/backup contact from hospital', 'contact', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 34, true),
    ('hospital_secondary_contact_designation', 'Hospital Secondary Contact - Designation', 'Job title/designation', 'contact', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 35, true),
    ('hospital_secondary_contact_email', 'Hospital Secondary Contact - Email', 'Email address', 'contact', 'email', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 36, true),
    ('hospital_secondary_contact_phone', 'Hospital Secondary Contact - Phone', 'Phone number', 'contact', 'phone', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 37, true),
    ('panel_primary_contact_name', 'Panel Primary Contact - Name', 'Primary contact person from panel/insurer', 'contact', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 40, true),
    ('panel_primary_contact_designation', 'Panel Primary Contact - Designation', 'Job title/designation', 'contact', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 41, true),
    ('panel_primary_contact_email', 'Panel Primary Contact - Email', 'Email address', 'contact', 'email', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 42, true),
    ('panel_primary_contact_phone', 'Panel Primary Contact - Phone', 'Phone number', 'contact', 'phone', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 43, true),
    ('panel_secondary_contact_name', 'Panel Secondary Contact - Name', 'Secondary/backup contact from panel', 'contact', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 44, true),
    ('panel_secondary_contact_designation', 'Panel Secondary Contact - Designation', 'Job title/designation', 'contact', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 45, true),
    ('panel_secondary_contact_email', 'Panel Secondary Contact - Email', 'Email address', 'contact', 'email', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 46, true),
    ('panel_secondary_contact_phone', 'Panel Secondary Contact - Phone', 'Phone number', 'contact', 'phone', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 47, true),
    ('contracts', 'Contracts', 'Contract documents with panel', 'document', 'file', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 50, true),
    ('mous', 'MOUs', 'Memorandum of Understanding documents', 'document', 'file', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 51, true),
    ('other_documents', 'Other Documents', 'Additional important documents', 'document', 'file', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 52, true),
    ('interface_id', 'Comms Interface', 'Which hospital_interfaces row handles email/portal for this insurer. When NULL, code falls back to "first email interface for this hospital" (compatibility default).', 'operational', 'single_select', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 58, true),
    ('is_empanelled', 'Empanelled with this panel', 'TRUE = hospital has a direct contract with this insurer/TPA (Network route, portal/empanelled email). FALSE = hospital is not empanelled and files via Cashless Everywhere.', 'operational', 'boolean', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 59, true),
    ('claim_submission_method', 'Claim Submission Method', 'How claims are submitted to this panel', 'operational', 'single_select', '{"api": "API", "edi": "EDI", "email": "Email", "portal": "Online Portal"}'::jsonb, NULL, NULL, NULL, false, false, NULL, 60, true),
    ('authorization_required', 'Authorization Required', 'Whether pre-authorization is required', 'operational', 'boolean', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 62, true),
    ('pre_auth_validity_days', 'Pre-Auth Validity (Days)', 'How many days pre-auth is valid', 'operational', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 63, true),
    ('bill_submission_deadline_days', 'Bill Submission Deadline (Days)', 'Days to submit bills after discharge', 'operational', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 64, true),
    ('claim_processing_sla_days', 'Claim Processing SLA (Days)', 'SLA for claim processing', 'operational', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 65, true),
    ('mou_template_id', 'MoU Template', 'Which MoU variant this panel uses (sourced from mou_templates)', 'operational', 'single_select', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 71, true),
    ('preauth_deadline_planned_hours', 'Pre-Auth Deadline - Planned (hours)', 'Hours BEFORE admission for planned cases (e.g. Medi Assist=48, Vidal=96)', 'operational', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 72, true),
    ('preauth_deadline_emergency_hours', 'Pre-Auth Deadline - Emergency (hours)', 'Hours AFTER admission for emergency cases (e.g. Medi Assist=48, Vidal=6)', 'operational', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 73, true),
    ('email_to_list', 'To Addresses', 'Comma-separated list of "to" emails for pre-auth (one or more)', 'operational', 'textarea', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 74, true),
    ('email_cc_list', 'CC Addresses', 'Comma-separated list of CC emails for pre-auth', 'operational', 'textarea', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 75, true),
    ('email_subject_template', 'Subject Template', 'Subject line template; supports {hospital_name}, {patient_name}, {policy_no}, {claim_no}', 'operational', 'text', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 76, true),
    ('sop_secondary_contacts', 'SOP Notes: Secondary Contacts', 'Regional offices, WhatsApp helplines (from SOP col 7)', 'contact', 'textarea', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 80, true),
    ('sop_step_by_step', 'SOP Notes: Step-by-Step Workflow', 'Recommended submission workflow (from SOP col 12)', 'operational', 'textarea', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 81, true),
    ('sop_watch_outs', 'SOP Notes: Critical Watch-Outs', 'Important warnings, e.g. tighter timelines (from SOP col 15)', 'operational', 'textarea', NULL::jsonb, NULL, NULL, NULL, false, false, NULL, 82, true)
ON CONFLICT (key) DO UPDATE SET
    label                 = EXCLUDED.label,
    description           = EXCLUDED.description,
    category              = EXCLUDED.category,
    data_type             = EXCLUDED.data_type,
    options               = EXCLUDED.options,
    validation_regex      = EXCLUDED.validation_regex,
    validation_min_length = EXCLUDED.validation_min_length,
    validation_max_length = EXCLUDED.validation_max_length,
    is_required           = EXCLUDED.is_required,
    is_unique             = EXCLUDED.is_unique,
    default_value         = EXCLUDED.default_value,
    sort_order            = EXCLUDED.sort_order,
    is_active             = EXCLUDED.is_active,
    updated_at            = NOW();

