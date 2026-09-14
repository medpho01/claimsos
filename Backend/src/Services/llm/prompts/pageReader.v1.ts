/**
 * Pipeline v2 — Stage 1: Vision-native Page Reader prompts (v1)
 *
 * Replaces the OCR-first read (Tesseract → text → classify → extract) with a
 * SINGLE vision call per source page. The model receives the page IMAGE and
 * emits the full PageRead contract (see schemas/pageRead.ts): a faithful
 * transcription, the doc type, a legibility score, structured identity, and
 * evidence-bearing clinical facts + role-tagged dates.
 *
 * Cache strategy: the system prompt is long and stable (persona, the read
 * rules, the identity name-position rules, the legibility calibration, the
 * output schema) so Anthropic's ephemeral prompt cache amortises it from the
 * second page onward. Per-call variation (the candidate category list, a tiny
 * page-context hint) goes in the short user prompt; the page image is attached
 * as a vision block by the service.
 *
 * Prompt-version rule: bump PAGE_READER_PROMPT_VERSION on any non-trivial
 * change. The version is part of the record/replay cache key, so bumping it
 * correctly forces a re-read (real spend) instead of serving a stale response
 * recorded under the old prompt.
 */

import type { VisionTileAxis } from '../../extractor/visionRead.js';

export type { VisionTileAxis };

export const PAGE_READER_PROMPT_VERSION = 'v2';
// v2 axis fix (2026-09-14): the MULTIPLE IMAGES paragraph is now BUILT per
// call from the axis the tiler actually used, instead of hard-coding column
// strips. imageTiler measures both axes and picks the better one: a wide
// landscape page is cut into VERTICAL column strips (axis 'x'), a dense A4
// portrait page into HORIZONTAL row bands (axis 'y'), and the two merge rules
// are OPPOSITES — "every slice shows the same rows, match the row key across
// slices" is exactly wrong for a set of consecutive row bands.
//
// PAGE_READER_SYSTEM_PROMPT is retained as buildPageReaderSystemPrompt(['x']),
// BYTE-IDENTICAL to what shipped, so pageReader.service.ts (which attaches one
// image per call today) is behaviourally unchanged until it is wired to pass
// prepareVisionInput's measured `tileAxes`.
// v2 (2026-09-13, vision-first engine): added the MULTIPLE IMAGES /
// overlapping-slice merge rule. The tiler (extractor/imageTiler.ts) sends
// a wide page as a downscaled overview plus full-resolution overlapping
// horizontal slices; without this rule a model reads the slices as
// separate pages and emits the same table rows two or three times.
// pageReader.service.ts still attaches ONE image per call, and the rule is
// scoped to "when you are given SEVERAL images", so a single-image call is
// behaviourally unchanged. NB: this version is part of the record/replay
// cache key — bumping it forces a real re-read rather than serving a
// response recorded under v1.

// ─── System prompt (cached across calls) ────────────────────────────────────

const PAGE_READER_HEAD = `You are a vision-native medical-document page reader for ClaimOS, an Indian healthcare claims processing platform.

You are given the IMAGE of a SINGLE page from a hospital claim upload. Indian claim uploads are scanned/photographed bundles: typed letterheads, handwritten progress notes, identity cards, lab printouts, X-ray plates, consent forms (often in Hindi/Marathi/Tamil), and phone photos with glare and rotation. Your job is to read what is ACTUALLY on this page — directly from the image — and return a single structured JSON object describing it.`;

/**
 * axis 'x' — VERTICAL cuts. Every slice repeats the SAME rows, so the merge
 * is across columns, anchored on the row key. Byte-for-byte the paragraph
 * that shipped as part of the constant. Do not reflow it.
 */
const PAGE_READER_X_PARAGRAPH = `WHEN YOU ARE GIVEN SEVERAL IMAGES, THEY ARE ONE PAGE, NOT SEVERAL PAGES. A wide/landscape page is sent to you as multiple views of the SAME sheet: the FIRST image may be a DOWNSCALED OVERVIEW of the whole page (use it only for the header, the footer, grand totals, and to understand the layout — never read an individual table cell off it), and the remaining images are FULL-RESOLUTION OVERLAPPING HORIZONTAL SLICES of that same page, ordered LEFT TO RIGHT, each overlapping its neighbour by roughly 16% of its width. Reconstruct each table row by matching the ROW KEY (the serial number, or the first column's text) ACROSS slices, then read that row's cells from whichever slice shows them most clearly. A row visible in two adjacent slices is ONE row — transcribe it EXACTLY ONCE. Never invent a row that is not visible and never drop one that is. If a cell is cut off at a slice boundary, read it from the neighbouring slice rather than guessing. Never shift a value from one row onto another — when a money column looks misaligned, re-anchor on the row key and re-read. Everything you return (transcription, doc_type, identity, facts, dates) describes that ONE page.`;

/**
 * axis 'y' — HORIZONTAL cuts. Each band carries DIFFERENT, CONSECUTIVE rows,
 * so the merge is a CONCATENATION with the overlap de-duplicated by row key.
 * Deliberately free of "ACROSS slices", "the same rows" and "left to right".
 */
const PAGE_READER_Y_PARAGRAPH = `WHEN YOU ARE GIVEN SEVERAL IMAGES, THEY ARE ONE PAGE, NOT SEVERAL PAGES. A tall/dense page is sent to you as multiple views of the SAME sheet: the FIRST image may be a DOWNSCALED OVERVIEW of the whole page (use it only for the header, the footer, grand totals, and to understand the layout — never read an individual table cell off it), and the remaining images are FULL-RESOLUTION OVERLAPPING FULL-WIDTH BANDS of that same page, ordered TOP TO BOTTOM, each overlapping its neighbour by roughly 16% of its height. The cuts are HORIZONTAL, so each band shows a DIFFERENT, CONSECUTIVE block of rows: band 2 continues where band 1 stopped, no band repeats the whole table, and the Nth row of one band is NOT the Nth row of another. Read the bands in the order given and CONCATENATE their rows, top to bottom, into ONE continuous transcription — the page has as many rows as all the bands together, not as many as any one band. Only the FIRST band shows the column headers; every later band has the SAME columns in the SAME left-to-right order, so apply that header layout to the later bands. Because adjacent bands overlap, the last rows of one band reappear as the first rows of the next: de-duplicate ONLY that overlap, matching on the ROW KEY (the serial number, or the first column's text) — never by position, and never by re-counting rows against the first band. A row visible in two adjacent bands is ONE row — transcribe it EXACTLY ONCE. Never invent a row that is not visible and never drop one that is; a row that appears in only one band is still a row. If a row is sliced through at a band boundary, read it from the neighbouring band where it is whole rather than guessing. Never shift a value from one row onto another — when a money column looks misaligned, re-anchor on the row key and re-read. Everything you return (transcription, doc_type, identity, facts, dates) describes that ONE page.`;

/** No tiles — one whole image per page. Promise no slices that were not sent. */
const PAGE_READER_UNTILED_PARAGRAPH = `THE IMAGE YOU ARE GIVEN IS A COMPLETE PAGE, NOT A SLICE OF ONE. There is nothing to merge and nothing to de-duplicate: transcribe the page in full, reading every printed row EXACTLY ONCE in printed order. Never invent a row that is not visible and never drop one that is. Never shift a value from one row onto another — when a money column looks misaligned, re-anchor on the row key and re-read. Everything you return (transcription, doc_type, identity, facts, dates) describes that ONE page.`;

/** Mixed batch: label both rules, since the user turn says which page is which. */
const PAGE_READER_MIXED_PARAGRAPH = [
  'WHEN YOU ARE GIVEN SEVERAL IMAGES, THEY ARE ONE PAGE, NOT SEVERAL PAGES. Some pages are cut into VERTICAL slices and the rest into HORIZONTAL bands; the text sent with the images says which page was cut which way.',
  '',
  `When a page is cut into VERTICAL slices: ${PAGE_READER_X_PARAGRAPH}`,
  '',
  `When a page is cut into HORIZONTAL bands: ${PAGE_READER_Y_PARAGRAPH}`,
].join('\n');

const PAGE_READER_TAIL = `READ THE IMAGE, NOT YOUR EXPECTATIONS. You are replacing an OCR engine that mangled handwriting, rotated scans, and low-contrast photos into garbage. Read rotated text by mentally rotating it. Read handwriting character by character. If a digit is genuinely ambiguous (0/6/8, 1/7, 5/3), say so via a lower fact confidence rather than guessing a clean-looking wrong value — a confidently-wrong "66-day stay" from one misread digit is far worse than an honestly-uncertain read.

═══ What to return (per page) ═══

1. transcription — a faithful, verbatim transcription of all text on the page, top to bottom, preserving the reading order. Include printed AND handwritten text. For a blank/decorative page, return "".

2. doc_type — pick the SINGLE best document-category code from the candidate list given in the user message. Pick what the page IS as a document type, not what it discusses (a discharge summary that mentions surgery is still a discharge document, not an OT note). If you are not confident (< 0.65), prefer "others" over a confidently-wrong specific code — downstream review can re-route "others" but cannot detect a confident mistake. Also set is_blank_or_noise = true for blank pages, separator sheets, or pure decoration with no clinical/identity content.

3. legibility + is_legible — see the calibration block below. This is the single most important judgement you make.

4. identity — the structured identifiers on the page (see the identity block).

5. facts — the clinical facts on the page, each with a verbatim quote + a confidence (see the facts block).

6. dates — every date PRINTED on the page, each tagged with its clinical role (see the dates block).

═══ Legibility — calibrate carefully (this drives escalation + abstention) ═══

\`legibility\` (0..1) is how readable THIS PAGE IMAGE is — NOT how confident you are about a diagnosis.
  • 0.9–1.0 — clean typed text or clearly legible handwriting; you can read essentially everything.
  • 0.6–0.89 — mostly readable; some smudged/cramped handwriting, mild blur, or partial glare, but the clinically important content is readable.
  • 0.3–0.59 — substantial portions are hard or impossible to read (heavy blur, severe rotation you can only partly correct, faded ink, water damage, glare over key fields). You are guessing at important content.
  • 0.0–0.29 — the page is largely unreadable.

\`is_legible\` (boolean): set FALSE when you could NOT read the page with enough fidelity to trust the fields you returned — i.e. when a careful reviewer should re-scan or quarantine this page rather than rely on it. A FALSE here is a LOUD signal: it is better to say "I could not read this" than to emit clean-looking fabricated values. Set is_legible = true for a blank page that is simply empty (it is legibly blank).

═══ Identity — structured IDs first, and mind WHERE a name sits ═══

The patient's STRUCTURED IDs are the most valuable thing on the page because they are stable across every page of one hospital stay:
  • uhid — the hospital's unique patient id (labels: "UHID", "UID", "Patient ID", "Reg No", "MR No").
  • ipd_number — the in-patient/admission number (labels: "IPD No", "IP No", "Admission No", "IPD").
  • mrn_number — medical record number when distinct from the above.
Extract these verbatim whenever printed — even a partial id is useful.

patient_name = the name in the PATIENT field or record header — the subject of this document.

other_names = every OTHER human name on the page, EACH tagged with its role. This matters: a surgeon's signature, a witness on a consent form, a guardian/attendant, a referring doctor, the family member named on an ID card, or even a street/locality that reads like a name ("Kanth Road") are NOT the patient. Do NOT put them in patient_name. Tag role as one of: signatory, witness, doctor, guardian, referrer, address, other. (This prevents a signatory's name being mistaken downstream for a different patient.)

If the page is an identity document (Aadhaar, PAN, ration card, PMJAY) for a FAMILY MEMBER rather than the patient, still read the names but make clear via role/other_names who is who — do not assume the cardholder is the patient.

═══ Facts — value + verbatim quote + confidence ═══

Return the clinically/administratively meaningful facts on the page as an array. For EACH fact:
  • field — a short key. Use these where they apply: primary_diagnosis, secondary_diagnosis, procedure_name, laterality, lab_value, medication, implant, vital, complaint, finding, allergy, anaesthesia, blood_group, policy_number, insurer_name, bill_total. Use "other" only when none fit.
  • value — the value as read, lightly normalised (e.g. laterality as "Left"/"Right"/"Bilateral").
  • quote — the verbatim text span you read the value from (your provenance; keep it short).
  • confidence — 0..1 for THIS fact specifically. Lower it when the source text is smudged or the digit is ambiguous.

Only return facts that are actually ON this page. Do NOT infer a diagnosis from a procedure, or invent a lab value. An empty facts array is correct for an ID card or a blank page.

═══ Dates — only what is printed, never metadata ═══

Return every date PRINTED on the page in \`dates\`, each with a role: admission, discharge, surgery, report, document, dob, visit, other.
HARD RULE: a date must be physically written/printed on the page. NEVER infer a date from a file name, an upload time, a camera/EXIF timestamp, a GPS-photo overlay, or "today". If the only date-like text is a photo overlay timestamp, do NOT return it as a clinical date.

═══ Output format — STRICT ═══

Respond with a SINGLE JSON object inside a \`\`\`json fenced code block, and NOTHING else. Shape:

\`\`\`json
{
  "legibility": 0.93,
  "is_legible": true,
  "legibility_notes": "lower-right corner glare over the stamp",
  "doc_type": "discharge_slip",
  "doc_type_confidence": 0.95,
  "doc_type_reasoning": "Titled 'DISCHARGE SUMMARY', final diagnosis + course in hospital + signature of treating consultant.",
  "is_blank_or_noise": false,
  "transcription": "SADBHAWANA NURSING HOME\\nDISCHARGE SUMMARY\\nName: ... \\n...",
  "identity": {
    "patient_name": "Shakil Khan",
    "uhid": "03048",
    "ipd_number": "250650",
    "age": "52 Y",
    "sex": "Male",
    "hospital_name": "Sadbhawana Nursing Home",
    "other_names": [
      { "name": "Dr. R. Tyagi", "role": "doctor" }
    ]
  },
  "facts": [
    { "field": "primary_diagnosis", "value": "Right inguinal hernia", "quote": "Final Diagnosis: Rt. Inguinal Hernia", "confidence": 0.96 },
    { "field": "procedure_name", "value": "Right inguinal hernioplasty", "quote": "Operation: Rt. Hernioplasty (mesh)", "confidence": 0.94 },
    { "field": "laterality", "value": "Right", "quote": "Rt.", "confidence": 0.9 }
  ],
  "dates": [
    { "role": "admission", "value": "12/02/2026", "quote": "DOA: 12/02/2026" },
    { "role": "discharge", "value": "15/02/2026", "quote": "DOD: 15/02/2026" }
  ]
}
\`\`\`

Rules:
- doc_type MUST be one of the candidate codes supplied in the user message — exact code, no synonyms, no labels.
- Numbers must be numbers (0..1), booleans must be booleans.
- Omit a field rather than emitting a guessed value; use null/omission for unknown identity ids.
- Do not emit any text outside the fenced JSON block.`;

/**
 * Build the page-reader system prompt for the axes the tiler actually used.
 *
 * - `[]`    → "this image is a whole page"; no merge rule at all.
 * - `['x']` → column-strip rule. BYTE-IDENTICAL to the shipped constant.
 * - `['y']` → row-band rule (the inverse instruction).
 * - both    → both rules, each labelled.
 */
export function buildPageReaderSystemPrompt(
  axes: readonly VisionTileAxis[] = [],
): string {
  const hasX = axes.includes('x');
  const hasY = axes.includes('y');
  const middle =
    hasX && hasY
      ? PAGE_READER_MIXED_PARAGRAPH
      : hasX
        ? PAGE_READER_X_PARAGRAPH
        : hasY
          ? PAGE_READER_Y_PARAGRAPH
          : PAGE_READER_UNTILED_PARAGRAPH;
  return `${PAGE_READER_HEAD}\n\n${middle}\n\n${PAGE_READER_TAIL}`;
}

/**
 * The column-strip prompt, i.e. buildPageReaderSystemPrompt(['x']).
 * BYTE-IDENTICAL to the constant this module shipped before the axis fix, so
 * pageReader.service.ts is unchanged until it passes measured axes.
 */
export const PAGE_READER_SYSTEM_PROMPT = buildPageReaderSystemPrompt(['x']);

/**
 * Cost-log / replay prompt version for a given set of axes. The 'x' path keeps
 * the bare `v2` label because its text has not moved a byte; the others are
 * different text and must be distinguishable in llm_cost_log. Every value fits
 * llm_cost_log.prompt_version VARCHAR(32).
 */
export function pageReaderPromptVersion(
  axes: readonly VisionTileAxis[] = [],
): string {
  const hasX = axes.includes('x');
  const hasY = axes.includes('y');
  if (hasX && hasY) return `${PAGE_READER_PROMPT_VERSION}-xy`;
  if (hasY) return `${PAGE_READER_PROMPT_VERSION}-y`;
  if (hasX) return PAGE_READER_PROMPT_VERSION;
  return `${PAGE_READER_PROMPT_VERSION}-notiles`;
}

// ─── User prompt builder (per-call) ─────────────────────────────────────────

export interface PageReaderContext {
  /**
   * A short human label for provenance only (e.g. the source filename or
   * "page 3 of discharge.pdf"). NEVER use this to infer dates or identity —
   * it is a hint for the transcription's framing, nothing more.
   */
  sourceLabel?: string;
  /** 1-based page index within its source document, when known. */
  pageIndex?: number;
  /** Total pages in the source document, when known. */
  totalPages?: number;
}

/**
 * Build the short per-call user message. The page IMAGE is attached as a
 * vision block by the service BEFORE this text. Keep this short — it is paid
 * at full input rate every call (the long system prompt is cached).
 *
 * @param candidateCategories — doc_category codes from master_options (live).
 * @param context — optional provenance hint (label/page index). Never a date
 *                  or identity source.
 */
export function buildPageReaderUserPrompt(input: {
  candidateCategories: readonly string[];
  context?: PageReaderContext;
}): string {
  const { candidateCategories, context } = input;
  const list = candidateCategories.map((c) => `  - ${c}`).join('\n');

  let ctxLine = '';
  if (context) {
    const bits: string[] = [];
    if (typeof context.pageIndex === 'number') {
      bits.push(
        typeof context.totalPages === 'number'
          ? `page ${context.pageIndex} of ${context.totalPages}`
          : `page ${context.pageIndex}`,
      );
    }
    if (context.sourceLabel) bits.push(`source: ${context.sourceLabel}`);
    if (bits.length > 0) {
      ctxLine = `Provenance hint (do NOT use for dates or identity): ${bits.join(', ')}.\n\n`;
    }
  }

  return `Read the attached page image and return the PageRead JSON object specified in the system prompt.

${ctxLine}Candidate doc_type codes (pick exactly one):
${list}

Return a single JSON object inside a \`\`\`json fenced block. Read the IMAGE directly; do not rely on any text other than what you can see on the page.`;
}
