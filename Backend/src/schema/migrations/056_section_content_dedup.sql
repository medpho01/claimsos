-- ============================================================================
-- Section-level CONTENT dedup — page-content fingerprinting across documents.
-- ============================================================================
-- Builds on migration 055 (file-level sha256 dedup of whole uploads).
-- This migration adds dedup at the LOGICAL-DOCUMENT level inside a claim:
-- the same Aadhar card embedded as pages 1-2 of PDF2, pages 1-2 of PDF3,
-- and uploaded as a standalone image all collapse to ONE canonical
-- section. Extraction then runs once instead of three times.
--
-- Mechanism (v1):
--   1. After bundle classification, each section gets `content_text_hash`
--      = sha256 of the normalized concatenated OCR text across all
--      pages in the section's range. Two sections with identical
--      normalized text are exact dedup matches.
--   2. SectionDedupService picks a canonical per text-hash group (best
--      avg OCR confidence; tiebreaker: earliest created_at) and stamps
--      every non-canonical row with dedup_of = canonical_id.
--   3. The extractor skips dedup_of NOT NULL rows (no LLM call).
--   4. After the canonical extracts, its extracted_fields are projected
--      onto every dedup row so the FE sees data on every section.
--   5. The harmoniser groups by canonical and lists source documents
--      as lineage on each supporting_documents entry.
--
-- v2 will add perceptual-hash columns for near-duplicate image-only
-- sections (X-rays, scar photos). Not in this migration to keep the
-- diff small and let the text-hash path prove itself first.

BEGIN;

-- ─── Text-content fingerprint ────────────────────────────────────────────
-- 64-char hex of sha256 over the section's normalized OCR text.
-- Normalisation rules (applied in code, not the DB):
--   - lowercase
--   - drop characters not in [a-z0-9 \n]
--   - collapse runs of whitespace to single space
--   - drop blank lines, but KEEP line order (sorting would falsely
--     dedup documents that share keywords but differ in structure)
-- NULL until the bundle classifier (or a backfill job) populates it.
ALTER TABLE hospital.document_sections
  ADD COLUMN IF NOT EXISTS content_text_hash CHAR(64);

-- ─── Canonical pointer ───────────────────────────────────────────────────
-- NULL on canonical sections, set to the canonical's id on duplicates.
-- ON DELETE SET NULL so deleting a canonical doesn't cascade-delete
-- the rest — they revert to standalone (and would re-dedup on the next
-- claim-level dedup run).
ALTER TABLE hospital.document_sections
  ADD COLUMN IF NOT EXISTS dedup_of UUID
    REFERENCES hospital.document_sections(id) ON DELETE SET NULL;

-- How the dedup decision was made. Free-text for forward compatibility
-- with v2 perceptual-hash methods:
--   'text_exact'    — content_text_hash matched exactly (v1)
--   'phash_near'    — perceptual hash within Hamming threshold (v2)
--   'manual'        — reviewer-marked duplicate
ALTER TABLE hospital.document_sections
  ADD COLUMN IF NOT EXISTS dedup_method VARCHAR(20);

-- 0..1. 1.000 for exact-text matches; lower for perceptual matches once v2 ships.
ALTER TABLE hospital.document_sections
  ADD COLUMN IF NOT EXISTS dedup_confidence NUMERIC(4,3);

-- ─── Indexes ─────────────────────────────────────────────────────────────
-- The grouping query in SectionDedupService is:
--   SELECT array_agg(id) FROM document_sections
--    WHERE claim_id = $1 AND content_text_hash IS NOT NULL
--    GROUP BY content_text_hash HAVING count(*) > 1
-- Partial because the column is NULL for the back-catalog.
CREATE INDEX IF NOT EXISTS idx_doc_sections_claim_text_hash
  ON hospital.document_sections (claim_id, content_text_hash)
  WHERE content_text_hash IS NOT NULL;

-- Reverse lookup: "give me all duplicates of canonical X" — used by
-- the extractor's projection step and the harmoniser's lineage builder.
CREATE INDEX IF NOT EXISTS idx_doc_sections_dedup_of
  ON hospital.document_sections (dedup_of)
  WHERE dedup_of IS NOT NULL;

COMMIT;
