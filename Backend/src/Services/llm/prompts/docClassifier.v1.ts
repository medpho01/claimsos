/**
 * Sprint 5 / Wave 2B — DocClassifier prompts (v1)
 *
 * The classifier is invoked once per `document_sections` row produced by the
 * segmenter (Wave 2A). It receives:
 *   - the OCR text for the section's page range (truncated to ~3k tokens),
 *   - light page-context (how many pages, where in the parent doc it sits),
 *   - the closed list of 21 doc_category codes from master_options,
 * and must return exactly one code with a self-rated confidence.
 *
 * The system prompt is intentionally long, stable, and pure prose: that's the
 * shape Anthropic's prompt cache rewards — same bytes across calls means we
 * pay cached-input rates from call 2 onwards. The user prompt holds the
 * per-call payload (section text + candidate list) and is never cached.
 *
 * Output contract (parsed by LlmClient.classify, not LlmClient.extract):
 *   ```json
 *   { "category": "<code>", "confidence": 0.0-1.0, "reasoning": "<one sentence>" }
 *   ```
 * `category` MUST be one of the supplied candidate codes; anything else
 * triggers LlmSchemaValidationError. `confidence` < 0.7 triggers the
 * standard-tier escalation (Haiku → Sonnet) inside the bridge.
 *
 * Prompt-versioning rule: any meaningful change to either string here
 * bumps the file suffix (.v1 → .v2). The old prompt stays on disk so the
 * llm_cost_log lineage is still readable when we A/B compare versions.
 */

export const CLASSIFIER_PROMPT_VERSION = 'v2';

/**
 * Persona / task framing. Cache-eligible — keep this string byte-stable
 * across calls. Any per-call variation belongs in the user prompt.
 */
export const DOC_CLASSIFIER_SYSTEM_PROMPT = `You are a document-classification specialist for ClaimOS, an Indian healthcare claims processing platform.

You will receive a SECTION of a hospital claim PDF — typically 1-10 pages — that has already been segmented out by an upstream layout splitter. Your job is to assign that section to exactly one canonical document category from the closed list supplied in the user message.

How to read the section:
- The text is the output of an OCR pass (typed text where available, Tesseract on scans). It may contain layout artefacts, mis-spaced words, OCR errors, and rotated tables flattened to plain text. Treat low-quality text as evidence, not as a reason to refuse.
- Indian hospital paperwork uses a mix of English, Hindi/Marathi/Tamil/etc. in proper nouns, and clinical abbreviations (ICP, OT, TPA, IPD, CGHS, etc.). The text you see is overwhelmingly English with occasional non-Latin tokens — do not let those throw you.
- Documents often contain hospital letterheads, patient blocks, signature panels, and stamp impressions that survived OCR as noisy glyphs. Skip past them when forming your judgement.

About multi-document bundles (IMPORTANT):
- Indian hospital claims very often arrive as a SINGLE scanned PDF that actually concatenates several distinct documents — e.g., OPD prescription on page 1, surgery consent on pages 2-3, investigations on page 4, discharge summary on page 5. The upstream segmenter has already split the PDF into one section per logical document, so the slice you receive should correspond to exactly one document type. But because that segmentation is text-boundary based, neighbouring documents that share clinical vocabulary (consent forms vs. OT notes, investigation reports vs. lab requisitions, OPD slips vs. admission notes) are the most common confusion pairs.
- When the user prompt supplies "Bundle context" (page-range of this section + categories already assigned to sibling sections), use it: a consent form sandwiched between two other consent forms is most likely a consent form continuation; an investigation immediately after a discharge slip is unusual and should lower confidence.
- Do NOT assume "page 1 is always X". A claim's first page is often an OPD prescription, the cover sheet of a discharge summary, a TPA approval letter, an identity document, or a cashless claim form — it depends entirely on what the hospital chose to scan first.

How to choose a category:
- Pick the SINGLE category that best describes what this section IS as a document type, not what it discusses. A discharge summary mentioning an OT procedure is still 'discharge_slip', not 'ot_notes_and_photos'.
- Prefer the most specific category. 'others' is a last resort for sections that genuinely do not match any other code; do not use 'others' just because confidence is low.
- For investigations: lab reports, radiology reports, ECG strips, pathology slips → 'investigations'.
- For surgery-specific documents: intraoperative notes, OT register page, anaesthesia chart → 'ot_notes_and_photos'.
- For insurer-issued letters: query letters, approval letters, deficiency notes → 'insurer_query_letter' or 'insurer_approval_letter' as appropriate; the generic 'insurer_response' is for content that is clearly insurer-issued but does not fit the more specific letter codes.

Confidence calibration:
- 0.95+ when the text contains a strong category signal (a heading like "DISCHARGE SUMMARY", or a structured field set unique to that category).
- 0.70-0.94 when the inference is solid but signals are partial (e.g. only the body text matches the category, no explicit heading).
- 0.40-0.69 when you are guessing from weak signals. Below 0.7 the platform will re-run this call on a stronger model — return a candid number; do not inflate.
- Below 0.40 only if the text is essentially unreadable. Pick the most likely category anyway; downstream code handles the manual-review path.

Output format — STRICT:
Respond with a single JSON object inside a \`\`\`json fenced code block:
\`\`\`json
{
  "category": "<exact code from the candidate list>",
  "confidence": <number between 0 and 1>,
  "reasoning": "<one short sentence explaining the choice>"
}
\`\`\`
Do not output any other text outside the fenced block. Do not add fields. The "category" value MUST appear verbatim in the candidate list — case-sensitive, no synonyms, no labels.`;

/** A single (previous → corrected) hint mined from human corrections. */
export interface CategoryConfusionHint {
  previous_category: string;
  corrected_category: string;
  sample_size: number;
}

/**
 * A sibling section of the same parent document, surfaced to the classifier
 * as bundle context. Categories that haven't been classified yet are omitted
 * by the caller (we pass nothing rather than a "pending" label so the model
 * doesn't try to reason about a placeholder).
 */
export interface BundleSiblingHint {
  page_start: number;
  page_end: number;
  category: string;
  /** 0..1 — caller may down-weight low-confidence siblings to avoid feedback loops. */
  confidence?: number;
}

/** Total layout of the parent document this section came from. */
export interface BundleContext {
  /** This section's own page range — duplicated here for the model's convenience. */
  this_page_start: number;
  this_page_end: number;
  /** Total page count of the parent PDF, e.g. 12 in a 12-page bundle. */
  parent_total_pages: number;
  /** All OTHER sections of the same parent doc, ordered by page_start. */
  siblings: readonly BundleSiblingHint[];
}

/**
 * Build the per-call user message. Keep this short — the system prompt is
 * cached, this is what we pay full input rate on per call.
 *
 * @param sectionText  OCR text for the section, already truncated by caller.
 * @param pagesContext Short "where in the parent doc" hint, e.g.
 *                     "Section spans pages 7-12 of a 24-page parent document."
 * @param candidateCategories The doc_category codes from master_options.
 * @param categoryHints Optional — KB-derived "we got it wrong N times" hints.
 *                     When supplied, rendered as an explicit bias block so the
 *                     model treats the corrected category as the strong prior
 *                     for content that previously fell into `previous_category`.
 *                     Stays out of the system prompt so it doesn't poison the
 *                     prompt cache (hints change as humans correct).
 * @param bundleContext Optional — when the parent doc is a multi-document
 *                     bundle, surface the siblings already classified so the
 *                     model can reason about transitions ("consent → consent →
 *                     consent" is more plausible than "consent → OT → consent").
 */
export function buildDocClassifierUserPrompt(input: {
  sectionText: string;
  pagesContext: string;
  candidateCategories: readonly string[];
  categoryHints?: readonly CategoryConfusionHint[];
  bundleContext?: BundleContext | null;
}): string {
  const {
    sectionText,
    pagesContext,
    candidateCategories,
    categoryHints,
    bundleContext,
  } = input;
  const list = candidateCategories.map((c) => `  - ${c}`).join('\n');

  // Hints block — only rendered when we actually have approved patterns,
  // and capped so the prompt doesn't balloon if the corpus grows large.
  // We frame each hint with the sample size so the model can weight strong
  // vs weak signals without us hard-coding a threshold here.
  let hintsBlock = '';
  if (categoryHints && categoryHints.length > 0) {
    const top = [...categoryHints]
      .sort((a, b) => b.sample_size - a.sample_size)
      .slice(0, 12);
    const lines = top.map(
      (h) =>
        `  - When content reads as "${h.previous_category}", reviewers re-classified it to "${h.corrected_category}" in ${h.sample_size} prior claim${h.sample_size === 1 ? '' : 's'}.`,
    );
    hintsBlock = `Knowledge-base hints from prior human corrections — bias toward the corrected category when the content fits the same pattern:
${lines.join('\n')}

`;
  }

  // Bundle context block — only rendered when the parent doc has more than
  // one section AND at least one sibling has already been classified. For
  // brand-new bundles where no sibling is classified yet, this section is
  // the first to be classified and there's nothing useful to surface.
  let bundleBlock = '';
  if (
    bundleContext &&
    bundleContext.siblings.length > 0 &&
    bundleContext.parent_total_pages > (bundleContext.this_page_end - bundleContext.this_page_start + 1)
  ) {
    const siblingLines = bundleContext.siblings
      .slice()
      .sort((a, b) => a.page_start - b.page_start)
      .map((s) => {
        const range = s.page_start === s.page_end ? `p.${s.page_start}` : `p.${s.page_start}-${s.page_end}`;
        const conf = typeof s.confidence === 'number' ? ` (conf ${s.confidence.toFixed(2)})` : '';
        return `  - ${range}: ${s.category}${conf}`;
      });
    bundleBlock = `Bundle context — this section is part of a ${bundleContext.parent_total_pages}-page parent PDF that contains multiple documents. The OTHER sections of the same parent have already been classified as follows:
${siblingLines.join('\n')}

Use this layout to disambiguate. The section you must classify spans p.${bundleContext.this_page_start}${
      bundleContext.this_page_start === bundleContext.this_page_end
        ? ''
        : `-${bundleContext.this_page_end}`
    } of the parent.

`;
  }

  return `Classify the following section into exactly one of these categories:

${list}

${hintsBlock}${bundleBlock}Section context:
${pagesContext}

Section text (OCR output, may contain artefacts):
---
${sectionText}
---

Return the JSON object as specified.`;
}
