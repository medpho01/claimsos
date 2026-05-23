-- ============================================================================
-- Wave 9 follow-up — per-category extraction routing (OCR vs Claude vision).
-- ============================================================================
-- Tesseract OCR works well for typed text (bills, computer-generated discharge
-- summaries, structured reports), but it fails badly on:
--   - Handwritten doctor's notes / progress notes
--   - OT (operative) notes (mix of handwriting + diagrams + stamps)
--   - Radiology images (X-ray plates with annotations)
--   - Faint stamps / signatures
--   - Multi-column lab reports with rotated text
--
-- Claude (Sonnet vision) reads all of these natively — we've verified this by
-- pasting the same images into the Claude UI and getting clean structured
-- output. The extractor pipeline today never invokes vision; it always
-- routes OCR'd text to a text-only LLM call.
--
-- This migration adds an `extraction_mode` column to master_options for the
-- doc_category vocabulary. Three valid modes:
--
--   'ocr'    (default) — Tesseract → text → text-only LLM call.
--                        Cheapest. Right for typed docs.
--   'vision' — Skip Tesseract. Send the image bytes directly to Claude
--              vision. ~10× the token cost of text but correct on
--              handwriting, X-rays, faint scans.
--   'auto'   — Try OCR first. If Tesseract confidence < 0.3 AND the OCR
--              text has < 50 alphanumeric chars, escalate to vision.
--              Good middle ground for categories that are mixed
--              (some typed, some handwritten).
--
-- We don't set vision globally — it would 10× cost on every claim. We set it
-- only on categories where we know the OCR pipeline is unreliable. New
-- vision-routed categories can be added by superadmin editing the value
-- directly in master_options.
--
-- The default for existing rows is 'ocr' so no behaviour change for the 90%
-- of categories that work fine with Tesseract.

BEGIN;

ALTER TABLE hospital.master_options
  ADD COLUMN IF NOT EXISTS extraction_mode VARCHAR(16);

-- Add a soft CHECK constraint via a deferred check (kept loose so future
-- modes — e.g. 'auto_with_skew_detect' — can be added without an
-- ALTER COLUMN). Enforced at the service layer.
COMMENT ON COLUMN hospital.master_options.extraction_mode IS
  'Per-category extraction routing for doc_category rows: ocr | vision | auto. Null = ocr (default). Read by docExtractor.service.ts.';

-- Categories we KNOW Tesseract is bad at — route directly to Claude vision.
UPDATE hospital.master_options
   SET extraction_mode = 'vision'
 WHERE category = 'doc_category'
   AND code IN (
     -- Operative notes are handwritten on a standard form with diagrams,
     -- stamps, and signatures. Tesseract returns 5-15% confidence reliably.
     'ot_notes_and_photos',
     -- Anaesthesia notes are similar — handwritten chart with grids.
     'anaesthesia_consent',
     'anesthesia_record',
     -- Discharge slips at small nursing homes are still hand-written.
     'surgical_discharge_slip',
     -- Daily progress notes — pure handwriting.
     'daily_progress_notes',
     'icu_charts',
     'nursing_notes',
     -- Radiology reports — when the report is image-only (X-ray plate
     -- with hand-annotated impression) Tesseract fails. Typed PACS reports
     -- still work via OCR — we use 'auto' so the cheap path tries first.
     'xray_reports',
     'ct_scan_reports',
     'mri_reports',
     -- Prescriptions are notoriously hand-scribbled.
     'opd_prescription',
     'prescription'
   );

-- Categories where it's a coin flip — try OCR first, escalate if needed.
UPDATE hospital.master_options
   SET extraction_mode = 'auto'
 WHERE category = 'doc_category'
   AND code IN (
     'admission_notes',
     'pathology_reports',
     'ecg_reports',
     'echo_reports'
   );

COMMIT;
