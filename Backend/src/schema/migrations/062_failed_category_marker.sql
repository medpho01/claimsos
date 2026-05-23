-- ============================================================================
-- 062 — `__failed__` doc_category marker for classifier-lane silent drops.
-- ============================================================================
-- Step H7 of the May 20, 2026 smoke-test follow-up (companion to H5 + H12).
--
-- Background:
--   The smoke test on 30 patients found 8 patients where the bundle classifier
--   silently dropped documents — Vahid alone lost ~30% of his 23-doc bundle
--   with NO error rows in document_sections, NO __failed__ markers anywhere,
--   and (after the migration 061 ledger) only a "running" phase row stuck
--   forever. Operators had zero visibility into what was skipped or why.
--
--   The bundle classifier was throwing on OCR failures / LLM schema-validation
--   errors / persist failures and relying on Bull's retry-then-exhaust path
--   to leave a trail. After Bull exhausted the 3 attempts the ledger row
--   flipped to 'failed' — but no row was ever written to document_sections,
--   so the FE's Documents tab simply lost the doc.
--
-- Design:
--   We introduce a sentinel category code `__failed__` that the classifier
--   writes as a per-doc marker row when every recovery path is exhausted.
--   The double-underscore prefix is intentional:
--     1. It sorts to the top in any alpha-listing (so ops eyeballs catch it).
--     2. It can never collide with a real doc-type code (Postgres identifier
--        conventions disallow leading double-underscores in the wild).
--     3. Downstream consumers (docExtractor, harmoniser) treat it as a
--        no-op signal — there's no field_schema for __failed__, so the
--        extractor's existing "no schema → extraction_skipped" path applies
--        without code change. The classifier-lane queue ALSO explicitly
--        skips enqueueing the extractor for __failed__ sections (belt-and-
--        braces in case a downstream consumer evolves to handle it).
--
--   The row carries the failure reason in extracted_fields as a JSON object
--   (status='failed', so it's filterable in the FE's "Review Required"
--   panel alongside quality-gate skips from migration 061).
--
-- Forward / backward compat:
--   - All existing rows are untouched; this is purely an additive seed.
--   - The constraint on (category, code) in master_options means re-running
--     this migration is idempotent (ON CONFLICT DO UPDATE).
--   - The group_code 'audit_intelligence_metadata' mirrors where the
--     classification_metadata + ocr_confidence_scores sentinel codes live
--     (added in migration 042). __failed__ belongs in the same bucket — it's
--     a meta-marker, not a user-facing document type.

BEGIN;

-- The sentinel is stored with is_active=false so the bundle classifier's
-- loadCandidateCategories (which filters is_active=true) does NOT include
-- it in the LLM candidate list. We still want the row present so:
--   1. FE master-options lookup ("category=__failed__ → label=Classification
--      Failed") works for the failed-marker row's display.
--   2. Future code that iterates the full taxonomy (analytics, audit) can
--      see the sentinel exists.
--   3. Bulk JOINs against master_options for label resolution don't drop
--      __failed__ rows.
--
-- KNOWN GAP: the legacy per-section docClassifier service (docClassifier.
-- service.ts) currently loads candidate categories WITHOUT filtering
-- is_active. That's a pre-existing bug independent of this migration —
-- legacy code can already be tricked into emitting any inactive code. The
-- bundle classifier (the workhorse) is the only correct consumer here;
-- a follow-up should align docClassifier's query with the is_active gate.
INSERT INTO hospital.master_options (category, code, label, sort_order, group_code, is_active)
VALUES
    ('doc_category', '__failed__', 'Classification Failed', 15999, 'audit_intelligence_metadata', false)
ON CONFLICT (category, code) DO UPDATE
    SET label = EXCLUDED.label,
        group_code = EXCLUDED.group_code,
        sort_order = EXCLUDED.sort_order,
        is_active = false;

-- The existing CHECK on document_sections.status only allowed
-- ('auto','reviewed','corrected'). For H7 we need a fourth value
-- 'failed' so the marker row can carry a distinct status that the FE
-- can filter on (status='failed') without scanning extracted_fields.
-- Drop the old constraint and add the widened one in the same tx; the
-- table-level lock is brief because we never UPDATE existing rows.
ALTER TABLE hospital.document_sections
    DROP CONSTRAINT IF EXISTS chk_document_sections_status;
ALTER TABLE hospital.document_sections
    ADD  CONSTRAINT chk_document_sections_status
    CHECK (status IN ('auto', 'reviewed', 'corrected', 'failed'));

COMMIT;
