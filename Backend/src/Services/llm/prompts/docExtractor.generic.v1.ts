/**
 * Sprint 5 / Wave 2B — Generic DocExtractor prompt (v1)
 *
 * One prompt to rule (almost) all extraction. Per-category prompts can be
 * added later for hard cases (discharge_slip multi-page tables, OT note
 * surgeon-list parsing, etc.), but v1 keeps a single template parameterised
 * by the field schema we read from hospital.document_field_schemas. Reasons:
 *
 *   1. Cost. 21 categories x N versions = a lot of cached system prompts;
 *      shipping one cache-eligible prompt and templating the user prompt
 *      means Anthropic's prompt cache stays warm across categories.
 *   2. Correctness. Adding a per-category prompt only helps if the generic
 *      one fails. We instrument extraction confidence per field — if a
 *      specific category sees chronically low confidence we know exactly
 *      which prompt to fork.
 *   3. Drift. The field schema is the canonical "what to extract" — keeping
 *      that one source of truth in the DB and reading it at call time means
 *      a schema_version bump auto-flows to the prompt with no code edit.
 *
 * Output contract (parsed against the dynamically-built Zod schema in
 * DocExtractorService):
 *   ```json
 *   {
 *     "fields":               { "<field_key>": <value>, ... },
 *     "per_field_confidence": { "<field_key>": <0-1>, ... },
 *     "confidence":           <0-1 overall>
 *   }
 *   ```
 * Required fields MUST appear in `fields`; optional fields appear when
 * found, are omitted (NOT set to null) when absent. `per_field_confidence`
 * has the same keys as `fields`. The top-level `confidence` is the model's
 * self-rated overall extraction quality — feeds the standard-tier
 * escalation threshold inside the LLM bridge.
 */

export const EXTRACTOR_PROMPT_VERSION = 'v1';

export const DOC_EXTRACTOR_GENERIC_SYSTEM_PROMPT = `You are a structured-data extraction specialist for ClaimOS, an Indian healthcare claims processing platform.

You will receive a section of a hospital claim PDF that has already been:
  (a) segmented out of its parent document by an upstream layout splitter, and
  (b) classified into a single document category by an upstream classifier.

Your job is to read the section text and extract the fields requested in the user message. The exact field schema for the category is supplied per call — fields, their types, whether they are required, and any allowed enum values. Treat that schema as the spec; do not invent fields, do not skip fields you should have extracted.

Reading the input:
- The text is OCR output. Typed-PDF text is usually clean; scanned pages may have mis-spaced tokens, dropped characters, or mis-recognised digits (0/O, 1/l, 5/S). Use surrounding context to repair obvious OCR damage when you are confident; otherwise extract the literal text and rate confidence low.
- Indian-context conventions: dates may appear as DD/MM/YYYY, DD-MM-YYYY, "12 May 2026", or with Hindi/Marathi month names — normalise ALL dates to ISO format (YYYY-MM-DD) for the output. If a date is ambiguous, prefer DD/MM/YYYY interpretation (Indian default) and rate confidence accordingly.
- Money values may be written as "Rs. 1,23,456", "INR 1,23,456.00", "₹ 1,23,456/-", or just "1,23,456". Always emit a plain non-negative number with no currency symbol, no commas, no decimal-zero padding beyond what is meaningful. If a number is followed by /- or .00 it is still a whole-rupee amount.
- Names of doctors, hospitals, panels: extract as-written, including titles ("Dr."), with whitespace collapsed.
- For enum fields: pick the exact code from the allowed values list. Do NOT invent your own labels. If no allowed value reasonably matches, omit the field (for optional) or pick the closest with low confidence (for required).
- For reference fields: emit the raw extracted string; the downstream resolver will look it up against the appropriate master_options category.
- For array fields: emit a JSON array of strings or objects as appropriate. If a section lists multiple investigations, surgeons, comorbidities, etc., return them all in order of appearance.

Confidence calibration (per field):
- 0.95+ when the value is explicitly labelled in the text and the OCR is clean.
- 0.70-0.94 when the value is clear from context but not explicitly labelled, or OCR introduces minor ambiguity.
- 0.40-0.69 when you are inferring from indirect signals or repairing OCR damage.
- Below 0.40 when you are guessing. The platform will escalate to a stronger model below 0.70 overall — return honest numbers, do not inflate.

Required vs optional fields:
- REQUIRED fields MUST appear in the "fields" object. If the section genuinely does not contain the value, set the field to an empty string (for text), 0 (for number/money), false (for boolean), or "1970-01-01" (for date), and rate its per_field_confidence at 0. Downstream code will treat zero-confidence on a required field as a missing-data warning.
- OPTIONAL fields appear in "fields" only when you found a value. Do NOT include optional fields with null/empty/zero placeholders — omit them entirely. If you omit a field, also omit it from per_field_confidence.

Output format — STRICT:
Respond with a single JSON object inside a \`\`\`json fenced code block:
\`\`\`json
{
  "fields": { ... },
  "per_field_confidence": { ... },
  "confidence": <number between 0 and 1>
}
\`\`\`
Do not output any other text outside the fenced block. Do not add top-level fields. Do not include a "reasoning" field — the per_field_confidence map IS the reasoning trail.`;

/**
 * Description of a single field for the user-prompt builder. Mirrors the
 * relevant columns of hospital.document_field_schemas so the service layer
 * can pass DB rows straight through.
 */
export interface ExtractorFieldDescriptor {
  field_key: string;
  field_label: string;
  field_type: string;
  is_required: boolean;
  enum_values?: readonly string[] | null;
  reference_category?: string | null;
}

/**
 * Build the per-call user message. Field schema goes here (NOT in the
 * system prompt) because it varies by category and we want cache hits on
 * the system block.
 *
 * `categoryHint` is the per-category extraction guide sourced from
 * `master_options.description` for the doc_category code. It carries
 * layout / label / OCR-quirk knowledge specific to that document type —
 * e.g. for `aadhaar_front` it describes that the name appears as Devanagari
 * followed by English transliteration with NO "Name:" label prefix, that
 * DOB is formatted DD/MM/YYYY, and that the 12-digit UID appears as 3
 * groups of 4 digits. Without these hints the LLM frequently returns `{}`
 * on documents whose OCR text lacks explicit field labels.
 */
export function buildDocExtractorUserPrompt(input: {
  category: string;
  fields: readonly ExtractorFieldDescriptor[];
  sectionText: string;
  pagesContext: string;
  categoryHint?: string | null;
  /**
   * Optional pre-rendered "DETECTED_FACTS" block produced by the
   * deterministic regex layer (see deterministicExtractors.ts). When
   * non-empty, gets injected right above the field list so the model
   * sees it before deciding what to extract. Empty string = render
   * nothing (no header).
   */
  deterministicFactsBlock?: string;
}): string {
  const { category, fields, sectionText, pagesContext, categoryHint, deterministicFactsBlock } = input;
  const fieldLines = fields
    .map((f) => {
      const req = f.is_required ? 'REQUIRED' : 'optional';
      const enumPart =
        f.enum_values && f.enum_values.length > 0
          ? `; allowed values: [${f.enum_values.join(', ')}]`
          : '';
      const refPart = f.reference_category
        ? `; resolves against master_options.${f.reference_category}`
        : '';
      return `  - ${f.field_key} (${f.field_type}, ${req})${enumPart}${refPart}: ${f.field_label}`;
    })
    .join('\n');

  const hintBlock =
    categoryHint && categoryHint.trim().length > 0
      ? `Category-specific guidance — read this before extracting:
${categoryHint.trim()}

`
      : '';

  const factsBlock =
    deterministicFactsBlock && deterministicFactsBlock.trim().length > 0
      ? deterministicFactsBlock
      : '';

  return `Extract structured data from this section.

Document category: ${category}

${factsBlock}${hintBlock}Fields to extract:
${fieldLines}

Section context:
${pagesContext}

Section text (OCR output, may contain artefacts):
---
${sectionText}
---

Return the JSON object as specified, with "fields", "per_field_confidence", and overall "confidence".`;
}
