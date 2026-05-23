-- Migration 014: Add panel_attribute_definitions for Cashless Everywhere
-- Date: 2026-05-16
-- Description:
--   Adds 13 new attribute definitions to the existing panel_attribute_definitions
--   catalog. These are the keys that store the SOP-derived configuration per
--   (hospital × panel) — the existing 36 attributes already cover most needs;
--   these 13 fill the CE-specific gaps.
--
--   Two groups:
--     A) 10 per-TPA attributes (stored on each hospital × TPA panel row)
--     B) 3 hospital-wide Gmail OAuth attributes (stored on the
--        hospital × Cashless-Everywhere-system-panel row)
--
--   The split is logical only — the schema doesn't enforce which panel a key
--   can be set on. The UI restricts where each attribute is editable.

BEGIN;

-- ============================================================================
-- A. Per-TPA Cashless Everywhere config attributes (10)
-- ============================================================================

INSERT INTO hospital.panel_attribute_definitions
  (key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES

-- Form + MoU choices (rendered as dropdowns sourced from preauth_form_templates / mou_templates)
('preauth_form_template_id',
 'Pre-Auth Form Template',
 'Which pre-auth PDF template this panel requires (sourced from preauth_form_templates)',
 'operational', 'single_select', false, true, 70),

('mou_template_id',
 'MoU Template',
 'Which MoU variant this panel uses (sourced from mou_templates)',
 'operational', 'single_select', false, true, 71),

-- Deadlines in HOURS (SOP gives hours; existing pre_auth_validity_days is in days)
('preauth_deadline_planned_hours',
 'Pre-Auth Deadline - Planned (hours)',
 'Hours BEFORE admission for planned cases (e.g. Medi Assist=48, Vidal=96)',
 'operational', 'text', false, true, 72),

('preauth_deadline_emergency_hours',
 'Pre-Auth Deadline - Emergency (hours)',
 'Hours AFTER admission for emergency cases (e.g. Medi Assist=48, Vidal=6)',
 'operational', 'text', false, true, 73),

-- Cashless Everywhere email composition
('cashless_email_to_list',
 'Cashless Pre-Auth: To Addresses',
 'Comma-separated list of "to" emails for pre-auth (one or more)',
 'operational', 'textarea', false, true, 74),

('cashless_email_cc_list',
 'Cashless Pre-Auth: CC Addresses',
 'Comma-separated list of CC emails for pre-auth',
 'operational', 'textarea', false, true, 75),

('cashless_subject_template',
 'Cashless Pre-Auth: Subject Template',
 'Subject line template; supports {hospital_name}, {patient_name}, {policy_no}, {claim_no}',
 'operational', 'text', false, true, 76),

-- SOP knowledge fields (hospital reads these; not used by submission logic)
('sop_secondary_contacts',
 'SOP Notes: Secondary Contacts',
 'Regional offices, WhatsApp helplines (from SOP col 7)',
 'contact', 'textarea', false, true, 80),

('sop_step_by_step',
 'SOP Notes: Step-by-Step Workflow',
 'Recommended submission workflow (from SOP col 12)',
 'operational', 'textarea', false, true, 81),

('sop_watch_outs',
 'SOP Notes: Critical Watch-Outs',
 'Important warnings, e.g. tighter timelines (from SOP col 15)',
 'operational', 'textarea', false, true, 82)

ON CONFLICT (key) DO NOTHING;


-- ============================================================================
-- B. Hospital-wide Gmail OAuth attributes (3)
--    Stored on (hospital × CE-system-panel) row.
-- ============================================================================

INSERT INTO hospital.panel_attribute_definitions
  (key, label, description, category, data_type, is_required, is_active, sort_order)
VALUES

('cashless_gmail_address',
 'Cashless Gmail Address',
 'Hospital''s Gmail account used for sending pre-auth emails to all TPAs. Set once per hospital on the Cashless Everywhere system panel.',
 'credential', 'email', false, true, 90),

('cashless_gmail_oauth_payload',
 'Cashless Gmail OAuth Payload',
 'Encrypted JSON: { access_token, refresh_token, expires_at, scopes }. Managed by the OAuth flow, not editable directly.',
 'credential', 'encrypted_text', false, true, 91),

('cashless_gmail_watch_state',
 'Cashless Gmail Watch State',
 'JSON: { history_id, watch_expires_at, last_verified_at, status }. Managed by the Pub/Sub watch renewal cron.',
 'credential', 'json', false, true, 92)

ON CONFLICT (key) DO NOTHING;


COMMIT;
