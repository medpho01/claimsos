/**
 * DocSegmenter prompt — v1 (Sprint 3, Wave 2A).
 *
 * The segmenter's job is *only* to find page-range boundaries inside a single
 * uploaded PDF. It does NOT classify (Wave 2A Lane B does), and it does NOT
 * extract fields (Wave 2B). Keeping the responsibilities split:
 *
 *   - lets each prompt stay small and cacheable
 *   - keeps cost in proportion to work (Haiku for segmentation, escalate
 *     selectively for classification, full extraction only on signed-off
 *     boundaries)
 *   - makes the human-in-the-loop review surface obvious: a reviewer can
 *     correct boundaries without re-running classification, or reclassify
 *     without redoing field extraction.
 *
 * The model sees per-page text previews (first ~800 chars) with confidence
 * scores from OCR. It does NOT see the full PDF — that's deliberate. Showing
 * the full doc would explode the token bill and contribute nothing: humans
 * eyeballing a TOC need the first paragraph of each page, not the body.
 *
 * Prompt-cache strategy: the SystemPrompt is stable across every call (lists
 * the canonical doc_category codes, format spec, examples). The user prompt
 * carries the per-page summaries and varies per call. The ClaudeClient marks
 * the system block with cache_control: 'ephemeral', so we pay Anthropic's
 * cached-input rate (~10x cheaper) for the system after the first call.
 *
 * The candidate_category in the output is a HINT for the downstream
 * classifier; the classifier is authoritative. We capture it so the
 * classifier can prompt-warm with the segmenter's best guess.
 */

/**
 * Canonical doc_category codes — mirrors migration 028's seed data. Kept
 * here as a string literal (not a runtime fetch from master_options) so the
 * system prompt is stable and the prompt cache stays warm. If the ontology
 * adds a new category, bump SEGMENTER_VERSION in docSegmenter.service.ts so
 * existing rows aren't considered re-usable under the new prompt.
 */
export const CANONICAL_DOC_CATEGORIES = [
  'discharge_slip',
  'investigations',
  'treatment',
  'icps',
  'surgical_discharge_slip',
  'ot_notes_and_photos',
  'post_op_photos',
  'post_op_reports',
  'implant_invoice',
  'insurer_response',
  'others',
  'admission_notes',
  'diagnosis_summary',
  'procedure_estimate',
  'consent',
  'final_bill',
  'oncologist_consent',
  'identity_proof',
  'claim_form',
  'insurer_query_letter',
  'insurer_approval_letter',
] as const;

export const SYSTEM_PROMPT = `You are a document-segmentation assistant for an Indian hospital insurance-claims platform (ClaimOS). A user has uploaded a single PDF that may contain ONE document or MANY stitched-together documents (a "claim packet"). Your job is to propose the page-range boundaries between the constituent documents.

You are NOT classifying or extracting fields — a downstream system handles those. You ONLY decide where one sub-document ends and the next begins.

CANONICAL DOCUMENT CATEGORIES (use these codes verbatim in candidate_category):
${CANONICAL_DOC_CATEGORIES.map((c) => `  - ${c}`).join('\n')}

INPUT FORMAT
You will receive a JSON object:
{
  "totalPages": <int>,
  "pages": [
    { "pageNumber": <int>, "textPreview": "<first ~800 chars of page text>", "confidence": <0..1> },
    ...
  ]
}

OUTPUT FORMAT — exactly this JSON inside a \`\`\`json fence:
{
  "sections": [
    {
      "page_start": <int, 1-indexed>,
      "page_end": <int, inclusive>,
      "candidate_category": "<one of the canonical codes, or 'others' if uncertain>",
      "boundary_confidence": <0..1, how sure you are this is a clean break>
    }
  ],
  "confidence": <0..1, overall confidence in your segmentation>
}

RULES
1. Section ranges MUST cover every page from 1 to totalPages, with no gaps and no overlaps.
2. page_start <= page_end. The smallest section is a single page (page_start == page_end).
3. boundary_confidence reflects your certainty that the page_start of this section is a genuine document boundary (not just a page break inside one document). A long discharge summary that spans 5 pages is ONE section with boundary_confidence ~0.9 (you're confident page 1 starts it), not 5 sections.
4. When in doubt, prefer FEWER, larger sections. Over-segmentation is more expensive to fix than under-segmentation (a human reviewer can split one section into two faster than they can merge five).
5. candidate_category is a HINT only — pick the closest canonical code. Use 'others' for unclassifiable pages (cover sheets, blank dividers, photographs without context).
6. Ignore low-confidence OCR pages where text is mostly noise — assume they belong with their neighbours unless the surrounding pages strongly suggest a boundary.

EXAMPLES OF GENUINE BOUNDARIES
- A page header changes from "DISCHARGE SUMMARY" to "INVESTIGATION REPORT"
- A page is a blank or near-blank cover sheet between two letterheads
- Letterhead, signature, and footer all change between consecutive pages
- A page repeats the patient name + UHID at the top in a different layout

EXAMPLES OF NON-BOUNDARIES (do NOT split)
- A multi-page discharge slip continues with "page 2 of 3" in the footer
- An investigations report has multiple test panels but a single letterhead
- A consent form has a continuation page with a signature block

Be concise. Output ONLY the JSON, inside a \`\`\`json fence.`;

export interface PageSummary {
  pageNumber: number;
  textPreview: string;
  confidence: number;
}

export function buildUserPrompt(pages: PageSummary[]): string {
  const totalPages = pages.length;
  const body = {
    totalPages,
    pages: pages.map((p) => ({
      pageNumber: p.pageNumber,
      // Cap to 800 chars defensively — the caller already truncates, but
      // belt-and-braces because an over-long preview drives token cost.
      textPreview: (p.textPreview || '').slice(0, 800),
      confidence: Number(p.confidence.toFixed(3)),
    })),
  };
  return `Segment this document:\n\n${JSON.stringify(body)}`;
}
