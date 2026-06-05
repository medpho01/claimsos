-- 073: Inbound email authentication results (SPF/DKIM/DMARC)
--
-- Gmail's inbound MTAs stamp an `Authentication-Results` header with the
-- SPF/DKIM/DMARC verdicts. We persist the parsed verdicts so the matcher can
-- refuse to AUTO-TRUST a high-confidence match (e.g. a forged VERP plus-address
-- token) when the sender failed authentication — the message is still linked
-- but flagged needs_ops_review instead of silently writing the attachment into
-- a patient chart + notifying ops.
ALTER TABLE hospital.emails_inbound
  ADD COLUMN IF NOT EXISTS auth_results jsonb;

COMMENT ON COLUMN hospital.emails_inbound.auth_results IS
  'Parsed Authentication-Results: { spf, dkim, dmarc, authenticated:boolean, raw }. NULL for pre-073 rows.';
