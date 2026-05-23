/**
 * Wave 12 — Bundle classifier output schema.
 *
 * The bundle classifier replaces the (docSegmenter + per-section
 * docClassifier) chain with a single Sonnet call that processes a whole
 * PDF and emits both the section boundaries AND each section's category
 * in one shot. This Zod schema defines the contract the LLM must honour.
 *
 * Validation philosophy: STRICT on the structural shape (sections must
 * be a non-empty array, page numbers must be positive integers, category
 * must be a string from the candidate list — validated downstream by the
 * service against master_options); TOLERANT on free-text reasoning
 * (truncated to 500 chars at parse time so a noisy LLM doesn't bloat the
 * payload).
 *
 * The bundle classifier is the segmenter and the classifier rolled into
 * one. So the output combines what those two services produced
 * separately:
 *   - boundary_confidence (segmenter): how sure are we this is one
 *     logical document?
 *   - classification_confidence (classifier): how sure of the category?
 *
 * Downstream `persistBundle` writes the boundary_confidence into the
 * existing classification_confidence column for backwards compatibility
 * with the read paths that already exist (they all read
 * classification_confidence), then overlays the category-level
 * confidence on the same column. This is consistent with the migration
 * 032 comment that classification_confidence holds the boundary score
 * until the classifier overwrites it.
 */

import { z } from 'zod';

/** A single section as emitted by the bundle classifier. */
export const BundleSectionSchema = z.object({
  page_start: z.number().int().min(1),
  page_end: z.number().int().min(1),
  /**
   * One of the candidate doc_category codes. The LLM may emit
   * something off-list — the service layer rejects those with
   * LlmSchemaValidationError so we don't poison document_sections.
   */
  category: z.string().min(1),
  /**
   * 0..1 confidence in the boundary decision (is this one logical
   * document?). Distinct from classification_confidence.
   */
  boundary_confidence: z.number().min(0).max(1),
  /**
   * 0..1 confidence in the chosen category. Sub-0.7 triggers manual-
   * review heuristics downstream (banner shown to ops, KB-hint pickup).
   */
  classification_confidence: z.number().min(0).max(1),
  /**
   * Short reasoning string — what evidence drove the boundary + category.
   * Truncated to 500 chars in the preprocess to avoid runaway tokens.
   */
  reasoning: z.preprocess(
    (v) => (typeof v === 'string' ? v.slice(0, 500) : ''),
    z.string().optional(),
  ),
});

export type BundleSection = z.infer<typeof BundleSectionSchema>;

/** Full bundle-classifier response payload. */
export const BundleClassifierOutputSchema = z.object({
  /**
   * Sections in page-order, NON-overlapping (validated at the service
   * layer; this schema only enforces non-empty + per-section shape).
   * page_end >= page_start is enforced via .refine().
   */
  sections: z
    .array(BundleSectionSchema)
    .min(1, 'bundle classifier must produce at least one section')
    .refine(
      (arr) => arr.every((s) => s.page_end >= s.page_start),
      'every section must have page_end >= page_start',
    ),
  /**
   * Optional one-line summary of what the document bundle contains as a
   * whole. Useful for audit + dossier projection.
   */
  document_summary: z.preprocess(
    (v) => (typeof v === 'string' ? v.slice(0, 500) : ''),
    z.string().optional(),
  ),
});

export type BundleClassifierOutput = z.infer<typeof BundleClassifierOutputSchema>;
