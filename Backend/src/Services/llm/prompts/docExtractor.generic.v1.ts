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
 *     "confidence":           <0-1 overall>,
 *     "line_items":           [ { "row_index": 0, "particulars": "...", ... } ],
 *     "line_items_confidence": <0-1>
 *   }
 *   ```
 * Required fields MUST appear in `fields`; optional fields appear when
 * found, are omitted (NOT set to null) when absent. `per_field_confidence`
 * has the same keys as `fields`. The top-level `confidence` is the model's
 * self-rated overall extraction quality — feeds the standard-tier
 * escalation threshold inside the LLM bridge.
 *
 * `line_items` / `line_items_confidence` are OPTIONAL and only requested
 * for categories that carry an itemised table (see LINE_ITEM_CATEGORIES in
 * extractor/lineItems.ts). Their row shape is owned by LineItemSchema, NOT
 * re-declared here — this module only renders the prose contract via
 * buildLineItemsPromptBlock().
 *
 * v2 (2026-09-13, vision-first engine): the primary input is now IMAGES,
 * not OCR text. A wide/landscape page arrives as a downscaled OVERVIEW
 * plus FULL-RESOLUTION OVERLAPPING HORIZONTAL SLICES of that same page
 * (see extractor/imageTiler.ts — the fix for the money column being
 * row-shifted onto the wrong line item). The system prompt gained a
 * "Reading images" section so the model merges slices by row key instead
 * of treating them as separate documents, and the user prompt gained the
 * `tilingContext` + `requestLineItems` slots.
 *
 * v2 axis fix (2026-09-14): the "Reading images" section is now BUILT PER
 * CALL from the axis the tiler actually used, instead of being a constant
 * that hard-codes column strips.
 *
 * The tiler measures both axes and picks the better one: a wide landscape
 * bill is cut into VERTICAL column strips (axis 'x'), a dense A4 portrait
 * page into HORIZONTAL row bands (axis 'y'). Those two merge rules are
 * OPPOSITES:
 *
 *   x — every slice shows the SAME rows; join a row's CELLS across slices.
 *   y — every band shows DIFFERENT, CONSECUTIVE rows; CONCATENATE the bands
 *       and de-duplicate only the overlap, by row key.
 *
 * The constant shipped the 'x' rule unconditionally, so on every tiled
 * PORTRAIT page the system prompt asserted "the same rows appear in every
 * image" while the user turn (describeTiling, injected as `tilingContext`)
 * correctly described consecutive row bands. The two halves of one prompt
 * contradicted each other. A measured counterfactual showed today's model
 * resolves the contradiction in favour of the user turn, so this is a
 * CONTRACT-CORRECTNESS fix and NOT an expected accuracy change — but a
 * prompt that argues with itself is not a guarantee of anything.
 *
 * buildDocExtractorSystemPrompt(['x']) is BYTE-IDENTICAL to the constant as
 * it was shipped; DOC_EXTRACTOR_GENERIC_SYSTEM_PROMPT is retained as exactly
 * that build, and docExtractorSystemPrompt.test.ts pins it.
 */

import { buildLineItemsPromptBlock } from '../../extractor/index.js';
import type { VisionTileAxis } from '../../extractor/visionRead.js';

export type { VisionTileAxis };

export const EXTRACTOR_PROMPT_VERSION = 'v2';

// ─── The system prompt, in axis-selectable pieces ───────────────────────

/** Everything above the "Reading images" section. Axis-independent. */
const PROMPT_HEAD = `You are a structured-data extraction specialist for ClaimOS, an Indian healthcare claims processing platform.

You will receive a section of a hospital claim PDF that has already been:
  (a) segmented out of its parent document by an upstream layout splitter, and
  (b) classified into a single document category by an upstream classifier.

Your job is to read the section text and extract the fields requested in the user message. The exact field schema for the category is supplied per call — fields, their types, whether they are required, and any allowed enum values. Treat that schema as the spec; do not invent fields, do not skip fields you should have extracted.`;

/** Opening of the "Reading images" section — true whichever way a page was cut. */
const IMAGES_INTRO_LINES: readonly string[] = [
  'Reading images — THE IMAGES ARE THE SOURCE OF TRUTH:',
  '- When several images accompany one section they are NOT different documents. They are views of the SAME page(s).',
  '- The FIRST image may be a DOWNSCALED OVERVIEW of the whole page. Use it ONLY for header, footer and grand-total fields, and to understand the page layout. It is deliberately low-resolution — never read an individual table cell off it.',
];

/**
 * The rule that holds on BOTH axes, and the reason this whole section
 * exists. Always last in the section.
 */
const IMAGES_NO_SHIFT_LINE =
  '- NEVER shift a value from one row onto another. When a money column looks misaligned with the particulars column, re-anchor on the row key and re-read — a misaligned amount is the single most damaging error you can make here.';

/**
 * axis 'x' — VERTICAL cuts, so every slice repeats the same rows and the
 * merge is across columns. Byte-for-byte the wording that was shipped as the
 * constant and that measured 100.00% on the landscape fixture. Do not reflow.
 */
const IMAGES_X_LINES: readonly string[] = [
  "- The remaining images are FULL-RESOLUTION OVERLAPPING HORIZONTAL SLICES of that SAME wide page, ordered LEFT TO RIGHT. Each slice overlaps its neighbour by roughly 16% of its width, so a band of columns appears in two adjacent slices.",
  "- Reconstruct each table row by matching the ROW KEY — the serial number, or failing that the first column's text — ACROSS slices, then read that row's cells from whichever slice shows them most clearly.",
  '- A row that appears in two adjacent slices is ONE row. Output it EXACTLY ONCE.',
  '- Never invent a row that is not visible. Never drop a row that is. The number of rows you emit must equal the number of rows physically printed in the table.',
  '- If a cell is cut off at a slice boundary, read it from the NEIGHBOURING slice rather than guessing.',
];

/**
 * axis 'y' — HORIZONTAL cuts, so each band carries DIFFERENT rows and the
 * merge is a concatenation. Deliberately free of "ACROSS slices", "the same
 * rows" and "left to right": a model told those things about a set of row
 * bands either repeats the overlap down the whole table or throws away every
 * band after the first.
 */
const IMAGES_Y_LINES: readonly string[] = [
  '- The remaining images are FULL-RESOLUTION OVERLAPPING FULL-WIDTH BANDS of that SAME tall page, ordered TOP TO BOTTOM. Each band overlaps its neighbour by roughly 16% of its height, so a few rows appear in two adjacent bands.',
  '- The cuts are HORIZONTAL, so each band is the FULL WIDTH of the page and shows a DIFFERENT, CONSECUTIVE block of rows. Band 2 continues where band 1 stopped. No band repeats the whole table, and the Nth row of one band is NOT the Nth row of another.',
  '- Read the bands in the order given and CONCATENATE their rows, top to bottom, into one continuous table. The page has as many rows as all the bands together, not as many as any one band.',
  '- Only the FIRST band shows the column headers. Every later band has the SAME columns in the SAME left-to-right order, so apply that header layout to the later bands even though their headers are not reprinted.',
  "- De-duplicate ONLY the overlap between adjacent bands, and do it by ROW KEY — the serial number, or failing that the first column's text — never by position, and never by re-counting rows against the first band.",
  '- A row that appears in two adjacent bands is ONE row. Output it EXACTLY ONCE.',
  '- Never invent a row that is not visible. Never drop a row that is — a row that appears in only one band is still a row.',
  '- If a row is sliced through at a band boundary, read it from the NEIGHBOURING band where it is whole rather than guessing.',
];

/**
 * No tiles at all — one whole image per page, or no image at all (the
 * OCR-text-only path). Says nothing about slices that were never sent: an
 * unconditional merge rule invites the model to hunt for a second view of the
 * page and to "de-duplicate" rows that were only ever printed once.
 */
const IMAGES_UNTILED_LINES: readonly string[] = [
  'Reading images — THE IMAGES ARE THE SOURCE OF TRUTH:',
  '- Any image attached to this section is a COMPLETE page, not a slice of one. There is nothing to merge and nothing to de-duplicate: read each page in full, in the order given.',
  '- Read every printed table row EXACTLY ONCE, in printed order. Never invent a row that is not visible. Never drop a row that is.',
];

/**
 * Build the "Reading images" section for the axes the tiler actually used.
 *
 * - `[]`    → no merge rule at all.
 * - `['x']` → column-strip rule. BYTE-IDENTICAL to the certified constant.
 * - `['y']` → row-band rule (the inverse instruction).
 * - both    → both rules, each labelled, for a mixed-orientation section.
 */
function buildImagesSection(axes: readonly VisionTileAxis[]): string {
  const hasX = axes.includes('x');
  const hasY = axes.includes('y');

  if (!hasX && !hasY) {
    return [...IMAGES_UNTILED_LINES, IMAGES_NO_SHIFT_LINE].join('\n');
  }
  if (hasX && !hasY) {
    return [...IMAGES_INTRO_LINES, ...IMAGES_X_LINES, IMAGES_NO_SHIFT_LINE].join('\n');
  }
  if (hasY && !hasX) {
    return [...IMAGES_INTRO_LINES, ...IMAGES_Y_LINES, IMAGES_NO_SHIFT_LINE].join('\n');
  }
  // Mixed section: some pages were cut into columns, others into rows. State
  // both rules under explicit labels rather than picking one — the user turn
  // (describeTiling) says which page was cut which way.
  return [
    ...IMAGES_INTRO_LINES,
    '- When a page is cut into VERTICAL slices:',
    ...IMAGES_X_LINES,
    '- When a page is cut into HORIZONTAL bands:',
    ...IMAGES_Y_LINES,
    '- The text sent with the images says which page was cut which way.',
    IMAGES_NO_SHIFT_LINE,
  ].join('\n');
}

/** Everything below the "Reading images" section. Axis-independent. */
const PROMPT_TAIL = `Reading the input:
- The input is primarily the attached IMAGES. Any "Section text" block is OCR output supplied as a SECONDARY HINT ONLY — it may be absent, truncated, or simply wrong (it comes from an engine that mangles wide tables and handwriting). When the image and the OCR text disagree, THE IMAGE WINS.
- Where OCR text is the only input, treat it as follows: typed-PDF text is usually clean; scanned pages may have mis-spaced tokens, dropped characters, or mis-recognised digits (0/O, 1/l, 5/S). Use surrounding context to repair obvious OCR damage when you are confident; otherwise extract the literal text and rate confidence low.
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
Do not output any other text outside the fenced block. Do not include a "reasoning" field — the per_field_confidence map IS the reasoning trail.

The ONLY additional top-level keys ever permitted are "line_items" and "line_items_confidence", and ONLY when the user message explicitly asks for them (it then spells out the exact row shape):
\`\`\`json
{
  "fields": { ... },
  "per_field_confidence": { ... },
  "confidence": <number between 0 and 1>,
  "line_items": [ { "row_index": 0, "particulars": "...", "qty": 1, "rate": 450, "payable": 450 } ],
  "line_items_confidence": <number between 0 and 1>
}
\`\`\`
When line_items are NOT requested, do not emit them. Never add any other top-level field.`;

/**
 * Build the extraction system prompt for the axes the tiler actually used on
 * this call. `axes` comes from `prepareVisionInput(...).tileAxes`.
 *
 * The service MUST pass the measured axes rather than reaching for
 * DOC_EXTRACTOR_GENERIC_SYSTEM_PROMPT: passing the x-only constant on a
 * portrait page is precisely the self-contradicting prompt this builder
 * exists to stop.
 */
export function buildDocExtractorSystemPrompt(
  axes: readonly VisionTileAxis[] = [],
): string {
  return `${PROMPT_HEAD}\n\n${buildImagesSection(axes)}\n\n${PROMPT_TAIL}`;
}

/**
 * The column-strip prompt, i.e. buildDocExtractorSystemPrompt(['x']).
 * BYTE-IDENTICAL to the constant this module shipped before the axis fix, and
 * therefore to the prompt behind the certified landscape measurement.
 *
 * Kept exported so the pin test can assert it and so an older caller keeps
 * compiling — but the runtime path builds from the measured axes instead.
 */
export const DOC_EXTRACTOR_GENERIC_SYSTEM_PROMPT = buildDocExtractorSystemPrompt(['x']);

/**
 * Cost-log / replay prompt version for a given set of axes.
 *
 * The 'x' path keeps the bare `v2` label because its prompt text has not moved
 * a byte; the other three are genuinely different text and say so. Lumping
 * them together would make an A/B over llm_cost_log.prompt_version compare
 * nothing. Every value fits llm_cost_log.prompt_version VARCHAR(32).
 */
export function docExtractorPromptVersion(
  axes: readonly VisionTileAxis[] = [],
): string {
  const hasX = axes.includes('x');
  const hasY = axes.includes('y');
  if (hasX && hasY) return `${EXTRACTOR_PROMPT_VERSION}-xy`;
  if (hasY) return `${EXTRACTOR_PROMPT_VERSION}-y`;
  if (hasX) return EXTRACTOR_PROMPT_VERSION;
  return `${EXTRACTOR_PROMPT_VERSION}-notiles`;
}

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
  /**
   * Output of describeTiling() from extractor/imageTiler.ts — one
   * paragraph naming exactly which images were attached (overview vs
   * full-resolution overlapping slices, how many, and the overlap). The
   * system prompt teaches the MERGE RULE generically; this slot tells the
   * model what it is actually looking at on THIS call. Rendered inside
   * the "Section context" block, above the field list.
   */
  tilingContext?: string;
  /**
   * When true, append buildLineItemsPromptBlock(category) — the prose
   * contract for the itemised-table rows. Driven by
   * isLineItemCategory(category) in the service, so a category with no
   * table never pays the extra tokens.
   */
  requestLineItems?: boolean;
  /**
   * The axes the tiler actually used, from
   * `prepareVisionInput(...).tileAxes`. Threaded through to
   * buildLineItemsPromptBlock, whose rule 3 is itself a merge rule and was
   * hard-coded to column strips. Leaving it unset renders the "nothing to
   * merge" wording, which is the safe default for a text-only call.
   */
  tileAxes?: readonly VisionTileAxis[];
}): string {
  const {
    category,
    fields,
    sectionText,
    pagesContext,
    categoryHint,
    deterministicFactsBlock,
    tilingContext,
    requestLineItems,
    tileAxes,
  } = input;
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

  // Tiling context goes in the SAME block as pagesContext (rather than a
  // block of its own) so the model reads "what this section is" and "what
  // images you are looking at" as one statement about the input.
  const contextBlock =
    tilingContext && tilingContext.trim().length > 0
      ? `${pagesContext}\n\n${tilingContext.trim()}`
      : pagesContext;

  // Section text is a hint on the vision path and may legitimately be
  // empty (images are the source of truth). Rendering an empty fenced
  // block invites the model to report "no text found" — so we omit the
  // block entirely instead.
  const textBlock =
    sectionText && sectionText.trim().length > 0
      ? `Section text (OCR output — a SECONDARY HINT ONLY; if it disagrees with the image, the image wins):
---
${sectionText}
---

`
      : `Section text: none supplied — read the attached image(s) directly.

`;

  // Output-budget guard. claudeClient assigns doc_extract.* a max_tokens
  // of 8192, which a very long line_items array can overrun. We cannot
  // raise that cap from here, so on top of the "every row, exactly once"
  // rule that buildLineItemsPromptBlock already states, we tell the model
  // how to fit: shorter cells, never a summary. A response that overruns
  // fails Zod loudly and is retried; a silently summarised table looks
  // like a clean extraction with rows missing, which is far worse.
  const lineItemsBlock = requestLineItems
    ? `${buildLineItemsPromptBlock(category, tileAxes ?? [])}

RESPONSE BUDGET: keep every cell terse (no commentary, no repeated units, no restating the header) so the WHOLE table fits in one response. Never write "... and N more rows" and never stop early — a partial table is worse than a long one.

`
    : '';

  return `Extract structured data from this section.

Document category: ${category}

${factsBlock}${hintBlock}Fields to extract:
${fieldLines}

Section context:
${contextBlock}

${textBlock}${lineItemsBlock}Return the JSON object as specified, with "fields", "per_field_confidence", and overall "confidence"${
    requestLineItems ? ', plus "line_items" and "line_items_confidence"' : ''
  }.`;
}
