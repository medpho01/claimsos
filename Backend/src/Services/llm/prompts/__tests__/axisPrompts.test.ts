/**
 * AXIS PROMPT-CONTRACT TESTS. Pure — no network, no LLM, no Anthropic SDK.
 *
 * Run: npx tsx --test src/Services/llm/prompts/__tests__/axisPrompts.test.ts
 *
 * The companion to visionPrompt.test.ts, covering the FOUR prompts that were
 * still hard-coded to column strips after visionRead.ts was made axis-aware.
 *
 * The tiler measures both axes and picks the better one. A wide landscape bill
 * is cut into VERTICAL column strips (axis 'x'); a dense A4 portrait page is
 * cut into HORIZONTAL row bands (axis 'y'). The two merge rules are OPPOSITES:
 *
 *   x — every slice shows the SAME rows; the Nth row of one is the Nth row of
 *       all; join a row's CELLS across slices.
 *   y — every band shows DIFFERENT, CONSECUTIVE rows; concatenate the bands
 *       and de-duplicate only the overlap, by row key.
 *
 * docExtractor.generic.v1 is the one that mattered most: docExtractor.service
 * passed its x-only constant as the SYSTEM prompt on every call, while the
 * axis-aware layoutContext went into the USER turn. On a tiled PORTRAIT page —
 * the production structured-extraction path — the system prompt therefore
 * asserted column strips while the user prompt described row bands. A measured
 * counterfactual (n=2) showed today's model resolves that contradiction in
 * favour of the user turn, so these tests are about CONTRACT CORRECTNESS, not
 * about an accuracy claim: a prompt that argues with itself is not a
 * guarantee, and the next model need not resolve it the same way.
 *
 * So the assertions below are about the ABSENCE of the x-claims from the
 * y-prompt as much as the presence of the y-claims.
 *
 * The second invariant: the x-axis text must not move. Each builder's ['x']
 * output is pinned against the text as it was shipped when the landscape
 * fixture measured 100.00%.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOC_EXTRACTOR_GENERIC_SYSTEM_PROMPT,
  EXTRACTOR_PROMPT_VERSION,
  buildDocExtractorSystemPrompt,
  buildDocExtractorUserPrompt,
  docExtractorPromptVersion,
} from '../docExtractor.generic.v1.js';
import {
  PAGE_READER_PROMPT_VERSION,
  PAGE_READER_SYSTEM_PROMPT,
  buildPageReaderSystemPrompt,
  pageReaderPromptVersion,
} from '../pageReader.v1.js';
import {
  BUNDLE_CLASSIFIER_PROMPT_VERSION,
  DOC_BUNDLE_CLASSIFIER_SYSTEM_PROMPT,
  buildDocBundleClassifierSystemPrompt,
  bundleClassifierPromptVersion,
} from '../docBundleClassifier.v1.js';
import { buildLineItemsPromptBlock } from '../../../extractor/lineItems.js';

// ── the claims that are TRUE for one axis and FALSE for the other ───────
//
// Written case-sensitively on purpose: the row-band text legitimately says
// "the SAME left-to-right order" (about COLUMNS within one band), which is a
// different claim from "ordered LEFT TO RIGHT" (about the images).

/** True for column strips, FALSE for row bands. */
const X_ONLY_CLAIMS = [
  'OVERLAPPING HORIZONTAL SLICES',
  'ordered LEFT TO RIGHT',
  'ACROSS slices',
];

/** True for row bands, FALSE for column strips. */
const Y_ONLY_CLAIMS = [
  'FULL-WIDTH BANDS',
  'ordered TOP TO BOTTOM',
  'DIFFERENT, CONSECUTIVE block of rows',
  'CONCATENATE their rows',
];

// ═══════════════════════════════════════════════════════════════════════
// docExtractor.generic.v1 — THE PRODUCTION STRUCTURED-EXTRACTION PATH
// ═══════════════════════════════════════════════════════════════════════

describe('buildDocExtractorSystemPrompt — the three cases differ', () => {
  const x = buildDocExtractorSystemPrompt(['x']);
  const y = buildDocExtractorSystemPrompt(['y']);
  const none = buildDocExtractorSystemPrompt([]);

  it('emits a DIFFERENT prompt for each case', () => {
    assert.notEqual(x, y);
    assert.notEqual(x, none);
    assert.notEqual(y, none);
  });

  it('x carries the column-strip rule', () => {
    for (const claim of X_ONLY_CLAIMS) {
      assert.ok(x.includes(claim), `x-axis prompt is missing: ${claim}`);
    }
  });

  it('y carries the row-band rule and NONE of the column-strip claims', () => {
    for (const claim of Y_ONLY_CLAIMS) {
      assert.ok(y.includes(claim), `y-axis prompt is missing: ${claim}`);
    }
    // THE MERGE BLOCKER. Any of these in a row-band prompt tells the model the
    // bands repeat each other's rows.
    for (const claim of X_ONLY_CLAIMS) {
      assert.ok(!y.includes(claim), `y-axis prompt still asserts the x-axis rule: ${claim}`);
    }
  });

  it('x carries none of the row-band claims', () => {
    for (const claim of Y_ONLY_CLAIMS) {
      assert.ok(!x.includes(claim), `x-axis prompt leaked a row-band claim: ${claim}`);
    }
  });

  it('y de-duplicates by ROW KEY, never by position or by re-counting', () => {
    const flat = y.replace(/\n\s*/g, ' ');
    assert.ok(/De-duplicate ONLY the overlap/.test(flat));
    assert.ok(/by ROW KEY/.test(flat));
    assert.ok(/never by position/.test(flat));
    assert.ok(/never by re-counting rows against the first band/.test(flat));
    // And it must NOT tell the model the row count comes from one image.
    assert.ok(!/the Nth data row of one slice/.test(flat));
  });

  it('the untiled prompt promises no slices at all', () => {
    assert.ok(none.includes('COMPLETE page, not a slice'));
    for (const claim of [...X_ONLY_CLAIMS, ...Y_ONLY_CLAIMS]) {
      assert.ok(!none.includes(claim), `untiled prompt asserts a merge rule: ${claim}`);
    }
    assert.ok(!none.includes('DOWNSCALED OVERVIEW'));
  });

  it('defaults to the untiled prompt when no axes are given', () => {
    assert.equal(buildDocExtractorSystemPrompt(), none);
  });

  it('a mixed batch carries BOTH rules, each labelled', () => {
    const both = buildDocExtractorSystemPrompt(['x', 'y']);
    assert.ok(both.includes('- When a page is cut into VERTICAL slices:'));
    assert.ok(both.includes('- When a page is cut into HORIZONTAL bands:'));
    for (const claim of [...X_ONLY_CLAIMS, ...Y_ONLY_CLAIMS]) {
      assert.ok(both.includes(claim), `mixed prompt is missing: ${claim}`);
    }
  });

  it('every case keeps the persona, the field-schema contract and the output contract', () => {
    for (const p of [x, y, none]) {
      assert.ok(p.startsWith('You are a structured-data extraction specialist for ClaimOS'));
      assert.ok(p.includes('Treat that schema as the spec'));
      assert.ok(p.includes('Confidence calibration (per field):'));
      assert.ok(p.includes('Required vs optional fields:'));
      assert.ok(p.includes('Output format — STRICT:'));
      assert.ok(p.endsWith('Never add any other top-level field.'));
      // The one rule that holds whichever way the page was cut — and on an
      // untiled page too, where a drifted money column is still a money error.
      assert.ok(p.includes('NEVER shift a value from one row onto another.'));
    }
  });
});

describe('buildDocExtractorSystemPrompt — the certified x text is pinned', () => {
  it('DOC_EXTRACTOR_GENERIC_SYSTEM_PROMPT equals the x build', () => {
    assert.equal(DOC_EXTRACTOR_GENERIC_SYSTEM_PROMPT, buildDocExtractorSystemPrompt(['x']));
  });

  it('is byte-identical to the constant as it shipped before the axis fix', () => {
    // A literal copy of DOC_EXTRACTOR_GENERIC_SYSTEM_PROMPT as it was written
    // when the landscape trials scored 100.00% and the dense-A4 portrait
    // structured trials scored 100.00%. If this fails, the certified path has
    // been reworded — re-run the harness before touching this expectation.
    const CERTIFIED = `You are a structured-data extraction specialist for ClaimOS, an Indian healthcare claims processing platform.

You will receive a section of a hospital claim PDF that has already been:
  (a) segmented out of its parent document by an upstream layout splitter, and
  (b) classified into a single document category by an upstream classifier.

Your job is to read the section text and extract the fields requested in the user message. The exact field schema for the category is supplied per call — fields, their types, whether they are required, and any allowed enum values. Treat that schema as the spec; do not invent fields, do not skip fields you should have extracted.

Reading images — THE IMAGES ARE THE SOURCE OF TRUTH:
- When several images accompany one section they are NOT different documents. They are views of the SAME page(s).
- The FIRST image may be a DOWNSCALED OVERVIEW of the whole page. Use it ONLY for header, footer and grand-total fields, and to understand the page layout. It is deliberately low-resolution — never read an individual table cell off it.
- The remaining images are FULL-RESOLUTION OVERLAPPING HORIZONTAL SLICES of that SAME wide page, ordered LEFT TO RIGHT. Each slice overlaps its neighbour by roughly 16% of its width, so a band of columns appears in two adjacent slices.
- Reconstruct each table row by matching the ROW KEY — the serial number, or failing that the first column's text — ACROSS slices, then read that row's cells from whichever slice shows them most clearly.
- A row that appears in two adjacent slices is ONE row. Output it EXACTLY ONCE.
- Never invent a row that is not visible. Never drop a row that is. The number of rows you emit must equal the number of rows physically printed in the table.
- If a cell is cut off at a slice boundary, read it from the NEIGHBOURING slice rather than guessing.
- NEVER shift a value from one row onto another. When a money column looks misaligned with the particulars column, re-anchor on the row key and re-read — a misaligned amount is the single most damaging error you can make here.

Reading the input:
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
    assert.equal(buildDocExtractorSystemPrompt(['x']), CERTIFIED);
  });
});

describe('docExtractorPromptVersion', () => {
  it('keeps the certified label where the text is unchanged', () => {
    assert.equal(docExtractorPromptVersion(['x']), EXTRACTOR_PROMPT_VERSION);
  });

  it('labels every reworded prompt separately so an A/B can tell them apart', () => {
    assert.equal(docExtractorPromptVersion(['y']), `${EXTRACTOR_PROMPT_VERSION}-y`);
    assert.equal(docExtractorPromptVersion(['x', 'y']), `${EXTRACTOR_PROMPT_VERSION}-xy`);
    assert.equal(docExtractorPromptVersion([]), `${EXTRACTOR_PROMPT_VERSION}-notiles`);
  });

  it('fits llm_cost_log.prompt_version VARCHAR(32)', () => {
    for (const axes of [[], ['x'], ['y'], ['x', 'y']] as const) {
      assert.ok(docExtractorPromptVersion(axes).length <= 32);
    }
  });
});

// ── the user turn must agree with the system turn ───────────────────────

describe('buildDocExtractorUserPrompt — the line-items merge rule follows the axis', () => {
  const base = {
    category: 'final_bill',
    fields: [
      {
        field_key: 'bill_total',
        field_label: 'Bill total',
        field_type: 'money',
        is_required: true,
      },
    ],
    sectionText: '',
    pagesContext: 'Section spans pages 1-1.',
    requestLineItems: true,
  };

  it('a y-axis call never asks the model to match rows ACROSS slices', () => {
    const user = buildDocExtractorUserPrompt({ ...base, tileAxes: ['y'] });
    assert.ok(user.includes('CONCATENATE THE BANDS'));
    assert.ok(!user.includes('MERGE BY ROW KEY'));
    assert.ok(!user.includes('the Nth data row of one slice'));
  });

  it('an x-axis call keeps the certified column-strip rule', () => {
    const user = buildDocExtractorUserPrompt({ ...base, tileAxes: ['x'] });
    assert.ok(user.includes('MERGE BY ROW KEY'));
    assert.ok(!user.includes('CONCATENATE THE BANDS'));
  });

  it('an untiled call is told there is nothing to merge', () => {
    const user = buildDocExtractorUserPrompt({ ...base, tileAxes: [] });
    assert.ok(user.includes('NOTHING TO MERGE'));
    assert.ok(!user.includes('MERGE BY ROW KEY'));
    assert.ok(!user.includes('CONCATENATE THE BANDS'));
  });

  it('omitting tileAxes is the same as untiled — it never invents a merge rule', () => {
    assert.equal(
      buildDocExtractorUserPrompt(base),
      buildDocExtractorUserPrompt({ ...base, tileAxes: [] }),
    );
  });

  it('a call that wants no line items carries no merge rule at all', () => {
    const user = buildDocExtractorUserPrompt({
      ...base,
      requestLineItems: false,
      tileAxes: ['y'],
    });
    assert.ok(!user.includes('CONCATENATE THE BANDS'));
    assert.ok(!user.includes('MERGE BY ROW KEY'));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// lineItems.buildLineItemsPromptBlock — rule 3 is the merge rule
// ═══════════════════════════════════════════════════════════════════════

describe('buildLineItemsPromptBlock — rule 3 follows the axis', () => {
  const x = buildLineItemsPromptBlock('final_bill', ['x']);
  const y = buildLineItemsPromptBlock('final_bill', ['y']);
  const none = buildLineItemsPromptBlock('final_bill', []);

  it('emits a DIFFERENT block for each case', () => {
    assert.notEqual(x, y);
    assert.notEqual(x, none);
    assert.notEqual(y, none);
  });

  it('pins the certified x wording of rule 3 byte for byte', () => {
    const CERTIFIED_RULE_3 = [
      '3. MERGE BY ROW KEY. When the page is supplied as overlapping horizontal slices,',
      '   the cuts are VERTICAL: every slice shows the SAME rows in the SAME order, and',
      '   the Nth data row of one slice is the Nth data row of every other slice. The',
      '   LEFTMOST slice carries the row keys; a rightmost slice may show only money',
      "   columns with no key, which is expected. Join a row's cells across slices by",
      '   that shared ordering plus the columns adjacent slices have in common, take each',
      '   cell from whichever slice renders it most legibly, and emit the row ONCE.',
    ].join('\n');
    assert.ok(x.includes(CERTIFIED_RULE_3), 'the certified x rule 3 has been reworded');
  });

  it('the y block concatenates and de-duplicates by row key, never by position', () => {
    const flat = y.replace(/\n\s*/g, ' ');
    assert.ok(/CONCATENATE their rows into one array/.test(flat));
    assert.ok(/DIFFERENT, CONSECUTIVE block of rows/.test(flat));
    assert.ok(/matching on the row key/.test(flat));
    assert.ok(/never by position/.test(flat));
    assert.ok(/never by re-counting rows against the first band/.test(flat));
    // The x claims that are actively harmful on row bands.
    assert.ok(!/every slice shows the SAME rows/.test(flat));
    assert.ok(!/Nth data row of one slice/.test(flat));
    assert.ok(!/LEFTMOST slice/.test(flat));
  });

  it('the untiled block promises no second view of any row', () => {
    assert.ok(none.includes('NOTHING TO MERGE'));
    assert.ok(!none.includes('overlapping horizontal slices'));
    assert.ok(!none.includes('CONCATENATE'));
    assert.ok(!none.includes('LEFTMOST slice'));
  });

  it('defaults to the untiled block — it never assumes tiles it was not told about', () => {
    assert.equal(buildLineItemsPromptBlock('final_bill'), none);
  });

  it('a mixed section states both rules under labels', () => {
    const both = buildLineItemsPromptBlock('final_bill', ['x', 'y']);
    assert.ok(both.includes('3a. For a page cut into VERTICAL slices'));
    assert.ok(both.includes('3b. For a page cut into HORIZONTAL bands'));
  });

  it('every case keeps the row shape, the null-vs-zero rule and the no-summarising rule', () => {
    for (const block of [x, y, none]) {
      assert.ok(block.includes('ITEMISED TABLE (line_items) — REQUIRED for this document type'));
      assert.ok(block.includes('1. NULL vs ZERO.'));
      assert.ok(block.includes('2. EVERY ROW, EXACTLY ONCE.'));
      assert.ok(block.includes('2a. FIT BY BEING TERSE, NEVER BY DROPPING A ROW.'));
      assert.ok(block.includes('4. NEVER SHIFT A COLUMN.'));
      assert.ok(block.includes('5. NO INVENTION.'));
      assert.ok(block.includes('row_index'));
      assert.ok(block.includes('Also return "line_items_confidence"'));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// pageReader.v1
// ═══════════════════════════════════════════════════════════════════════

describe('buildPageReaderSystemPrompt — the three cases differ', () => {
  const x = buildPageReaderSystemPrompt(['x']);
  const y = buildPageReaderSystemPrompt(['y']);
  const none = buildPageReaderSystemPrompt([]);

  it('emits a DIFFERENT prompt for each case', () => {
    assert.notEqual(x, y);
    assert.notEqual(x, none);
    assert.notEqual(y, none);
  });

  it('is byte-identical, at the seam, to the paragraph that shipped', () => {
    // The head and tail of this prompt were not touched; the whole of the
    // change is the middle paragraph and the two joins around it. Pinning the
    // paragraph together with the sentence before and after it is what proves
    // nothing was lost when the constant was split into builder pieces.
    const HEAD_TAIL_SENTENCE =
      'Your job is to read what is ACTUALLY on this page — directly from the image — and return a single structured JSON object describing it.';
    const CERTIFIED_X_PARAGRAPH = `WHEN YOU ARE GIVEN SEVERAL IMAGES, THEY ARE ONE PAGE, NOT SEVERAL PAGES. A wide/landscape page is sent to you as multiple views of the SAME sheet: the FIRST image may be a DOWNSCALED OVERVIEW of the whole page (use it only for the header, the footer, grand totals, and to understand the layout — never read an individual table cell off it), and the remaining images are FULL-RESOLUTION OVERLAPPING HORIZONTAL SLICES of that same page, ordered LEFT TO RIGHT, each overlapping its neighbour by roughly 16% of its width. Reconstruct each table row by matching the ROW KEY (the serial number, or the first column's text) ACROSS slices, then read that row's cells from whichever slice shows them most clearly. A row visible in two adjacent slices is ONE row — transcribe it EXACTLY ONCE. Never invent a row that is not visible and never drop one that is. If a cell is cut off at a slice boundary, read it from the neighbouring slice rather than guessing. Never shift a value from one row onto another — when a money column looks misaligned, re-anchor on the row key and re-read. Everything you return (transcription, doc_type, identity, facts, dates) describes that ONE page.`;
    const TAIL_HEAD_SENTENCE = 'READ THE IMAGE, NOT YOUR EXPECTATIONS.';

    assert.ok(
      x.includes(
        `${HEAD_TAIL_SENTENCE}\n\n${CERTIFIED_X_PARAGRAPH}\n\n${TAIL_HEAD_SENTENCE}`,
      ),
      'the certified x paragraph, or one of its joins, has moved',
    );
    assert.equal(PAGE_READER_SYSTEM_PROMPT, x);
  });

  it('y carries the row-band rule and NONE of the column-strip claims', () => {
    for (const claim of Y_ONLY_CLAIMS) {
      assert.ok(y.includes(claim), `y-axis prompt is missing: ${claim}`);
    }
    for (const claim of X_ONLY_CLAIMS) {
      assert.ok(!y.includes(claim), `y-axis prompt still asserts the x-axis rule: ${claim}`);
    }
    const flat = y.replace(/\n\s*/g, ' ');
    assert.ok(/de-duplicate ONLY that overlap, matching on the ROW KEY/.test(flat));
    assert.ok(/never by position/.test(flat));
    assert.ok(/never by re-counting rows against the first band/.test(flat));
  });

  it('x carries none of the row-band claims', () => {
    for (const claim of Y_ONLY_CLAIMS) {
      assert.ok(!x.includes(claim), `x-axis prompt leaked a row-band claim: ${claim}`);
    }
  });

  it('the untiled prompt promises no slices at all', () => {
    assert.ok(none.includes('COMPLETE PAGE, NOT A SLICE OF ONE'));
    for (const claim of [...X_ONLY_CLAIMS, ...Y_ONLY_CLAIMS]) {
      assert.ok(!none.includes(claim), `untiled prompt asserts a merge rule: ${claim}`);
    }
  });

  it('defaults to the untiled prompt when no axes are given', () => {
    assert.equal(buildPageReaderSystemPrompt(), none);
  });

  it('a mixed batch carries BOTH rules, each labelled', () => {
    const both = buildPageReaderSystemPrompt(['x', 'y']);
    assert.ok(both.includes('When a page is cut into VERTICAL slices:'));
    assert.ok(both.includes('When a page is cut into HORIZONTAL bands:'));
    for (const claim of [...X_ONLY_CLAIMS, ...Y_ONLY_CLAIMS]) {
      assert.ok(both.includes(claim), `mixed prompt is missing: ${claim}`);
    }
  });

  it('every case keeps the PageRead contract intact', () => {
    for (const p of [x, y, none]) {
      assert.ok(p.startsWith('You are a vision-native medical-document page reader for ClaimOS'));
      assert.ok(p.includes('READ THE IMAGE, NOT YOUR EXPECTATIONS.'));
      assert.ok(p.includes('═══ Legibility — calibrate carefully'));
      assert.ok(p.includes('═══ Identity — structured IDs first'));
      assert.ok(p.includes('═══ Facts — value + verbatim quote + confidence ═══'));
      assert.ok(p.includes('═══ Dates — only what is printed, never metadata ═══'));
      assert.ok(p.endsWith('- Do not emit any text outside the fenced JSON block.'));
      assert.ok(p.includes('describes that ONE page.'));
    }
  });
});

describe('pageReaderPromptVersion', () => {
  it('keeps the shipped label only where the text is unchanged', () => {
    assert.equal(pageReaderPromptVersion(['x']), PAGE_READER_PROMPT_VERSION);
    assert.equal(pageReaderPromptVersion(['y']), `${PAGE_READER_PROMPT_VERSION}-y`);
    assert.equal(pageReaderPromptVersion(['x', 'y']), `${PAGE_READER_PROMPT_VERSION}-xy`);
    assert.equal(pageReaderPromptVersion([]), `${PAGE_READER_PROMPT_VERSION}-notiles`);
  });

  it('fits llm_cost_log.prompt_version VARCHAR(32)', () => {
    for (const axes of [[], ['x'], ['y'], ['x', 'y']] as const) {
      assert.ok(pageReaderPromptVersion(axes).length <= 32);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// docBundleClassifier.v1
// ═══════════════════════════════════════════════════════════════════════

describe('buildDocBundleClassifierSystemPrompt — the three cases differ', () => {
  const x = buildDocBundleClassifierSystemPrompt(['x']);
  const y = buildDocBundleClassifierSystemPrompt(['y']);
  const none = buildDocBundleClassifierSystemPrompt([]);

  it('emits a DIFFERENT prompt for each case', () => {
    assert.notEqual(x, y);
    assert.notEqual(x, none);
    assert.notEqual(y, none);
  });

  it('is byte-identical, at the seam, to the paragraph that shipped', () => {
    const HEAD_TAIL_SENTENCE =
      "When you see an attached page image AND the OCR text disagrees with what's visible in the image, TRUST THE IMAGE.";
    const CERTIFIED_X_PARAGRAPH = `**MULTIPLE IMAGES OF ONE PAGE**: When several images are provided for the SAME page number, they are NOT separate pages and MUST NOT become separate sections. A wide/landscape page is attached as multiple views of one sheet: the FIRST image may be a DOWNSCALED OVERVIEW of the whole page (use it for the letterhead, headings, footers and grand totals — never read an individual table cell off it), and the rest are FULL-RESOLUTION OVERLAPPING HORIZONTAL SLICES of that same page, ordered LEFT TO RIGHT, each overlapping its neighbour by roughly 16% of its width. Reconstruct each table row by matching the ROW KEY (serial number, or the first column's text) ACROSS slices and read each cell from whichever slice shows it most clearly; a row visible in two adjacent slices is ONE row. Never invent a row that is not visible, never drop one that is, and never shift a value from one row onto another. A page sent as N images still counts as exactly ONE page for page_start / page_end purposes.`;
    // The first sentence of the tail. It was lost once while splitting the
    // constant, which is exactly the failure this seam pin exists to catch.
    const TAIL_HEAD_SENTENCE =
      'Indian medical paperwork uses a mix of English, Hindi/Marathi/Tamil/etc. in proper nouns, and clinical abbreviations (TKR, THR, OA, ICP, OT, TPA, IPD, CGHS, AVN, ACS, MD, OBG, etc.). The text you see is overwhelmingly English with occasional non-Latin tokens.';

    assert.ok(
      x.includes(
        `${HEAD_TAIL_SENTENCE}\n\n${CERTIFIED_X_PARAGRAPH}\n\n${TAIL_HEAD_SENTENCE}`,
      ),
      'the certified x paragraph, or one of its joins, has moved',
    );
    assert.equal(DOC_BUNDLE_CLASSIFIER_SYSTEM_PROMPT, x);
  });

  it('y carries the row-band rule and NONE of the column-strip claims', () => {
    for (const claim of Y_ONLY_CLAIMS) {
      assert.ok(y.includes(claim), `y-axis prompt is missing: ${claim}`);
    }
    for (const claim of X_ONLY_CLAIMS) {
      assert.ok(!y.includes(claim), `y-axis prompt still asserts the x-axis rule: ${claim}`);
    }
  });

  it('x carries none of the row-band claims', () => {
    for (const claim of Y_ONLY_CLAIMS) {
      assert.ok(!x.includes(claim), `x-axis prompt leaked a row-band claim: ${claim}`);
    }
  });

  it('every tiled case still says N images of one page is ONE page', () => {
    // The segmentation-specific half of this rule: whichever way the page was
    // cut, its tiles must not become N sections.
    for (const p of [x, y]) {
      assert.ok(
        p.includes(
          'A page sent as N images still counts as exactly ONE page for page_start / page_end purposes.',
        ),
      );
      assert.ok(p.includes('MUST NOT become separate sections'));
    }
    // The y rule additionally has to stop a headerless later band reading as a
    // new document — a letterhead change is this prompt's strongest split
    // signal, and only the first band carries the letterhead.
    assert.ok(y.includes('a later band with no letterhead is NOT a new document'));
  });

  it('the untiled prompt promises no slices at all', () => {
    assert.ok(none.includes('**ONE IMAGE PER PAGE**'));
    for (const claim of [...X_ONLY_CLAIMS, ...Y_ONLY_CLAIMS]) {
      assert.ok(!none.includes(claim), `untiled prompt asserts a merge rule: ${claim}`);
    }
  });

  it('defaults to the untiled prompt when no axes are given', () => {
    assert.equal(buildDocBundleClassifierSystemPrompt(), none);
  });

  it('a mixed batch carries BOTH rules, each labelled', () => {
    const both = buildDocBundleClassifierSystemPrompt(['x', 'y']);
    assert.ok(both.includes('When a page is cut into VERTICAL slices:'));
    assert.ok(both.includes('When a page is cut into HORIZONTAL bands:'));
    for (const claim of [...X_ONLY_CLAIMS, ...Y_ONLY_CLAIMS]) {
      assert.ok(both.includes(claim), `mixed prompt is missing: ${claim}`);
    }
  });

  it('every case keeps the segmentation contract intact', () => {
    for (const p of [x, y, none]) {
      assert.ok(p.startsWith('You are a document-bundle classification specialist for ClaimOS'));
      assert.ok(p.includes('**VISION ATTACHMENTS**'));
      assert.ok(p.includes('═══ How to find document boundaries ═══'));
      assert.ok(p.includes('**HARD RULE — HOSPITAL LETTERHEAD CHANGE = NEW SECTION**'));
      assert.ok(p.includes('**HARD RULE — IMAGING REPORTS ARE NEVER CONSENT FORMS**'));
      assert.ok(p.includes('**HARD RULE — CONSENT FORMS ARE NEVER IMAGING REPORTS**'));
      assert.ok(p.endsWith('- Do not emit any text outside the fenced JSON block.'));
    }
  });
});

describe('bundleClassifierPromptVersion', () => {
  it('keeps the shipped label only where the text is unchanged', () => {
    assert.equal(bundleClassifierPromptVersion(['x']), BUNDLE_CLASSIFIER_PROMPT_VERSION);
    assert.equal(bundleClassifierPromptVersion(['y']), `${BUNDLE_CLASSIFIER_PROMPT_VERSION}-y`);
    assert.equal(
      bundleClassifierPromptVersion(['x', 'y']),
      `${BUNDLE_CLASSIFIER_PROMPT_VERSION}-xy`,
    );
    assert.equal(
      bundleClassifierPromptVersion([]),
      `${BUNDLE_CLASSIFIER_PROMPT_VERSION}-notiles`,
    );
  });

  it('fits llm_cost_log.prompt_version VARCHAR(32)', () => {
    for (const axes of [[], ['x'], ['y'], ['x', 'y']] as const) {
      assert.ok(bundleClassifierPromptVersion(axes).length <= 32);
    }
  });
});
