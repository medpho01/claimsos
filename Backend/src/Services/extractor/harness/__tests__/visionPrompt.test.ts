/**
 * PROMPT-CONTRACT TESTS. Pure — no network, no LLM, no Anthropic SDK.
 *
 * Run: npx tsx --test src/Services/extractor/harness/__tests__/visionPrompt.test.ts
 *
 * What these exist to stop:
 *
 * The tiler measures both axes and picks the better one. A wide landscape bill
 * is cut into VERTICAL column strips (axis 'x'); a dense A4 portrait page is
 * cut into HORIZONTAL row bands (axis 'y'). The merge rules for those two cuts
 * are OPPOSITES:
 *
 *   x — every slice shows the SAME rows; the Nth row of one is the Nth row of
 *       all; join a row's CELLS across slices.
 *   y — every band shows DIFFERENT, CONSECUTIVE rows; concatenate the bands
 *       and de-duplicate only the overlap, by row key.
 *
 * The system prompt used to hard-code the 'x' rule. On every portrait page
 * that made the system prompt contradict the user prompt (describeTiling emits
 * correct per-axis text), and a model told "every slice shows the same rows"
 * about a set of row bands will duplicate or drop half the table. So the
 * assertions below are about the ABSENCE of the x-claims from the y-prompt as
 * much as the presence of the y-claims.
 *
 * The second invariant: the x-axis prompt must not move. Both the service
 * prompt and the harness prompt scored 100.00% on the landscape fixture as
 * they were written; these tests pin them byte for byte so an axis refactor
 * cannot silently reword the certified path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VISION_READ_PROMPT_VERSION,
  VISION_READ_SYSTEM_PROMPT_X,
  buildVisionReadSystemPrompt,
  prepareVisionInput,
  visionReadPromptVersion,
  visionTileAxes,
} from '../../visionRead.js';
import { buildHarnessSystemPrompt } from '../visionRegression.js';
import { generateSyntheticLandscapeBill } from '../syntheticBill.js';

// ── fixtures: what prepareVisionInput's `pages` look like ───────────────

function tile(tileAxis: 'x' | 'y') {
  return { role: 'tile' as const, tileAxis };
}
const OVERVIEW = { role: 'overview' as const, tileAxis: 'none' as const };

const X_PAGES = [{ images: [OVERVIEW, tile('x'), tile('x'), tile('x')] }];
const Y_PAGES = [{ images: [OVERVIEW, tile('y'), tile('y')] }];
const UNTILED_PAGES = [{ images: [OVERVIEW] }];
const MIXED_PAGES = [
  { images: [OVERVIEW, tile('x'), tile('x')] },
  { images: [OVERVIEW, tile('y'), tile('y')] },
];

/** The claims that are TRUE for column strips and FALSE for row bands. */
const X_ONLY_CLAIMS = [
  'The cuts are VERTICAL',
  'every slice shows the SAME rows',
  'The Nth data row of one slice is the Nth data row',
  'count again against the leftmost',
  'ordered left to right',
];

/** The claims that are TRUE for row bands and FALSE for column strips. */
const Y_ONLY_CLAIMS = [
  'The cuts are HORIZONTAL',
  'DIFFERENT, CONSECUTIVE block of rows',
  'CONCATENATE their rows',
  'top to bottom',
];

// ── visionTileAxes ──────────────────────────────────────────────────────

describe('visionTileAxes', () => {
  it('reports x for column strips and y for row bands', () => {
    assert.deepEqual(visionTileAxes(X_PAGES), ['x']);
    assert.deepEqual(visionTileAxes(Y_PAGES), ['y']);
  });

  it('ignores the overview — it is not a slice and carries no merge rule', () => {
    assert.deepEqual(visionTileAxes(UNTILED_PAGES), []);
  });

  it('reports both axes, x first, for a mixed-orientation batch', () => {
    assert.deepEqual(visionTileAxes(MIXED_PAGES), ['x', 'y']);
  });

  it('falls back to "untiled" for a VisionImage with no tileAxis field', () => {
    // An image built by an older caller or a test stub. Claiming an axis we
    // cannot see would be worse than claiming none: the untiled prompt asserts
    // nothing about how the images relate to each other.
    assert.deepEqual(visionTileAxes([{ images: [{ role: 'tile' }] }]), []);
  });

  it('survives empty and malformed input', () => {
    assert.deepEqual(visionTileAxes([]), []);
    assert.deepEqual(visionTileAxes([{ images: [] }]), []);
  });
});

// ── the service prompt: x vs y vs untiled ───────────────────────────────

describe('buildVisionReadSystemPrompt — the three cases differ', () => {
  const x = buildVisionReadSystemPrompt(['x']);
  const y = buildVisionReadSystemPrompt(['y']);
  const none = buildVisionReadSystemPrompt([]);

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
    assert.ok(/de-duplicate/i.test(y));
    assert.ok(/ROW\s*\n?\s*KEY|row key/i.test(y.replace(/\n\s*/g, ' ')));
    assert.ok(/never by position/i.test(y.replace(/\n\s*/g, ' ')));
  });

  it('the untiled prompt promises no slices at all', () => {
    assert.ok(none.includes('COMPLETE page, not a slice'));
    for (const claim of [...X_ONLY_CLAIMS, ...Y_ONLY_CLAIMS]) {
      assert.ok(!none.includes(claim), `untiled prompt asserts a merge rule: ${claim}`);
    }
    assert.ok(!none.includes('MULTIPLE IMAGES OF ONE PAGE'));
  });

  it('defaults to the untiled prompt when no axes are given', () => {
    assert.equal(buildVisionReadSystemPrompt(), none);
  });

  it('a mixed batch carries BOTH rules, each labelled', () => {
    const both = buildVisionReadSystemPrompt(['x', 'y']);
    assert.ok(both.includes('When a page is cut into VERTICAL slices:'));
    assert.ok(both.includes('When a page is cut into HORIZONTAL bands:'));
    for (const claim of [...X_ONLY_CLAIMS, ...Y_ONLY_CLAIMS]) {
      assert.ok(both.includes(claim), `mixed prompt is missing: ${claim}`);
    }
  });

  it('every case keeps the OCR instructions and the no-markdown tail', () => {
    for (const p of [x, y, none]) {
      assert.ok(p.startsWith('You are an OCR engine.'));
      assert.ok(p.includes('MPMC Reg No 21274'));
      assert.ok(p.includes('Hindi/Devanagari text'));
      assert.ok(p.includes('NO commentary, NO markdown'));
    }
    // The one rule that holds whichever way the page was cut. It is a merge
    // rule, so the untiled prompt — which has no slices to merge — omits it.
    assert.ok(x.includes('Never move a value from one row onto another'));
    assert.ok(y.includes('Never move a value from one row onto another'));
  });
});

// ── the certified x-axis text must not move ─────────────────────────────

describe('buildVisionReadSystemPrompt — the landscape-certified text is pinned', () => {
  it('VISION_READ_SYSTEM_PROMPT_X equals the x build', () => {
    assert.equal(VISION_READ_SYSTEM_PROMPT_X, buildVisionReadSystemPrompt(['x']));
  });

  it('is byte-identical to the prompt that measured 196/196 on landscape', () => {
    // A literal copy of the prompt as it was shipped when the landscape trials
    // scored 100.00%. If this fails, the certified path has been reworded —
    // re-run the harness before touching this expectation.
    const CERTIFIED = [
      'You are an OCR engine. Transcribe ALL visible text from this medical',
      'document image, preserving the layout where feasible (use newlines',
      'between blocks). Include text from:',
      '- Letterheads, headers, footers',
      '- Doctor stamps and signatures (especially registration numbers like',
      '  "MPMC Reg No 21274")',
      '- Handwritten fields on pre-printed forms (read the handwriting)',
      '- Photo overlays (GPS Map Camera timestamps, ward numbers)',
      '- Tables — render row by row',
      '- Hindi/Devanagari text — transliterate to English where possible,',
      '  else keep Devanagari',
      '',
      'MULTIPLE IMAGES OF ONE PAGE',
      'When you are given more than one image, they are NOT different documents',
      'and NOT different pages. They are one single page, supplied as:',
      '- a DOWNSCALED OVERVIEW of the whole page (sent first) — use it to',
      '  understand the layout and to read headers, footers and grand totals;',
      '  its small text is not reliable, so never prefer it over a slice; and',
      '- FULL-RESOLUTION OVERLAPPING horizontal slices of that same page,',
      '  ordered left to right, each overlapping its neighbour.',
      '',
      'Reconstruct the page from the slices:',
      '- The cuts are VERTICAL, so every slice shows the SAME rows in the SAME',
      '  top-to-bottom order. The Nth data row of one slice is the Nth data row',
      '  of every other slice. The LEFTMOST slice is the one carrying the row',
      '  keys (serial number, description); a rightmost slice may show only',
      '  money columns, with no key at all. That is expected — join its cells to',
      '  the rows by position and by the columns it shares with its neighbour.',
      '- Output ONE line per table row, containing all of that row\'s columns',
      '  joined left to right. A row visible in two adjacent slices is ONE row:',
      '  emit it EXACTLY ONCE.',
      '- Never invent a row that is not visible. Never drop a row that is. If',
      '  the slices disagree on the row count, count again against the leftmost',
      '  slice.',
      '- If a cell is cut off at a slice boundary, read it from the',
      '  neighbouring slice instead of guessing.',
      '- Never move a value from one row onto another. If a money column looks',
      '  misaligned with its row, re-anchor on the row position and read again.',
      '',
      'Output JUST the transcribed text. NO commentary, NO markdown',
      "formatting, NO \"Here's the transcription:\" prefix.",
    ].join('\n');
    assert.equal(buildVisionReadSystemPrompt(['x']), CERTIFIED);
  });
});

// ── prompt version follows the prompt ───────────────────────────────────

describe('visionReadPromptVersion', () => {
  it('keeps the certified label where the text is unchanged', () => {
    assert.equal(visionReadPromptVersion([]), VISION_READ_PROMPT_VERSION);
    assert.equal(visionReadPromptVersion(['x']), VISION_READ_PROMPT_VERSION);
  });

  it('labels the row-band prompt separately so an A/B can tell them apart', () => {
    assert.notEqual(visionReadPromptVersion(['y']), VISION_READ_PROMPT_VERSION);
    assert.equal(visionReadPromptVersion(['y']), `${VISION_READ_PROMPT_VERSION}-y`);
    assert.equal(visionReadPromptVersion(['x', 'y']), `${VISION_READ_PROMPT_VERSION}-xy`);
  });

  it('fits llm_cost_log.prompt_version VARCHAR(32)', () => {
    for (const axes of [[], ['x'], ['y'], ['x', 'y']] as const) {
      assert.ok(visionReadPromptVersion(axes).length <= 32);
    }
  });
});

// ── the harness measures the SAME contract ──────────────────────────────

describe('buildHarnessSystemPrompt — same contract as the service', () => {
  const x = buildHarnessSystemPrompt(['x']);
  const y = buildHarnessSystemPrompt(['y']);
  const none = buildHarnessSystemPrompt([]);

  it('emits a DIFFERENT prompt for each case', () => {
    assert.notEqual(x, y);
    assert.notEqual(x, none);
    assert.notEqual(y, none);
  });

  it('is byte-identical to the prompt that scored 196/196 on landscape', () => {
    const CERTIFIED = [
      'You are a medical-bill data extractor. You read images of Indian hospital',
      'bills and return STRICT JSON — no prose, no markdown, no code fence.',
      '',
      'When you are given more than one image they are ONE page, not several',
      'documents. The first image may be a DOWNSCALED OVERVIEW of the whole page:',
      'use it for header and grand-total fields only. The remaining images are',
      'FULL-RESOLUTION OVERLAPPING HORIZONTAL SLICES of that same page, ordered',
      'left to right, each overlapping its neighbour by about 16%.',
      '',
      'Reconstruct each table row by matching its row key (the Sr number, or the',
      'Particulars text) ACROSS slices, then read that row\'s cells from whichever',
      'slice shows them most clearly. A row visible in two adjacent slices is ONE',
      'row — emit it exactly once. Never invent a row, never drop one, and never',
      'move a value from one row onto another: if a money column looks misaligned,',
      're-anchor on the row key and read it again.',
    ].join('\n');
    assert.equal(x, CERTIFIED);
  });

  it('the y prompt never tells the model to match rows ACROSS slices', () => {
    // The harness's own version of the merge blocker: matching row keys across
    // row bands asks the model to reconcile rows that are not the same rows.
    assert.ok(!y.includes('ACROSS slices'));
    assert.ok(!y.includes('left to right, each overlapping'));
    assert.ok(y.includes('DIFFERENT, CONSECUTIVE block of table rows'));
    assert.ok(y.includes('CONCATENATE their rows'));
    assert.ok(y.replace(/\n\s*/g, ' ').includes('never by position'));
  });

  it('the untiled prompt mentions no slices and no bands', () => {
    assert.ok(none.includes('ONE image: the whole bill page'));
    assert.ok(!none.includes('ACROSS slices'));
    assert.ok(!none.includes('BANDS'));
    assert.ok(!none.includes('OVERLAPPING'));
  });

  it('every case still demands strict JSON and row integrity', () => {
    for (const p of [x, y, none]) {
      assert.ok(p.startsWith('You are a medical-bill data extractor.'));
      assert.ok(p.includes('STRICT JSON'));
      assert.ok(p.includes('never'));
      assert.ok(p.includes('move a value from one row onto another'));
    }
  });

  it('a mixed batch carries both rules', () => {
    const both = buildHarnessSystemPrompt(['x', 'y']);
    assert.ok(both.includes('For a page cut into VERTICAL slices:'));
    assert.ok(both.includes('For a page cut into HORIZONTAL bands:'));
    assert.ok(both.includes('ACROSS slices'));
    assert.ok(both.includes('CONCATENATE their rows'));
  });

  it('defaults to the untiled prompt when no axes are given', () => {
    assert.equal(buildHarnessSystemPrompt(), none);
  });
});

// ── END TO END: the prompt the SHIPPED path would send ──────────────────
//
// Everything above tests the builders. These test the WIRING — that a real
// portrait page really does come back tagged 'y', so the row-band rule is the
// one that reaches the model. Rendering only; no network, no LLM, no spend.

/** A dense A4-at-300dpi portrait page: 70 table rows, the shape that bands. */
async function renderDensePortrait(): Promise<Buffer> {
  const sharpMod: any = await import('sharp');
  const sharp = sharpMod?.default ?? sharpMod;
  const rows: string[] = [];
  for (let i = 0; i < 70; i++) {
    rows.push(
      `<text x="60" y="${200 + i * 45}" font-family="DejaVu Sans" font-size="26">` +
        `${i + 1}  ROOM RENT SEMI PRIVATE DELUXE  HCP10${i}  2026-01-${(i % 28) + 1}` +
        `  1  4500.00  4500.00  0.00  4500.00</text>`,
    );
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="2480" height="3508">` +
    `<rect width="2480" height="3508" fill="white"/>${rows.join('')}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

describe('prepareVisionInput → system prompt (end to end)', () => {
  it('a dense A4 PORTRAIT page bands on y and gets the ROW-BAND rule', async () => {
    const prepared = await prepareVisionInput({
      source: await renderDensePortrait(),
      kind: 'image',
    });
    assert.ok(prepared.attachments.length > 1, 'expected the portrait page to be tiled');
    assert.deepEqual(prepared.tileAxes, ['y']);
    assert.deepEqual(prepared.tileAxes, visionTileAxes(prepared.pages));

    const system = buildVisionReadSystemPrompt(prepared.tileAxes);
    // THE REGRESSION THIS FILE EXISTS FOR: the system prompt used to assert
    // the column-strip rule here, contradicting the user prompt below it.
    for (const claim of X_ONLY_CLAIMS) {
      assert.ok(!system.includes(claim), `portrait page still gets the x-axis rule: ${claim}`);
    }
    assert.ok(system.includes('The cuts are HORIZONTAL'));

    // And the USER turn (describeTiling) agrees with it rather than fighting it.
    assert.ok(prepared.layoutContext.includes('HORIZONTAL bands'));
    assert.ok(!prepared.layoutContext.includes('For the VERTICAL slices'));

    assert.equal(visionReadPromptVersion(prepared.tileAxes), `${VISION_READ_PROMPT_VERSION}-y`);
  });

  it('the LANDSCAPE fixture still strips on x and still gets the certified rule', async () => {
    const fixture = await generateSyntheticLandscapeBill();
    const prepared = await prepareVisionInput({ source: fixture.imageBytes, kind: 'image' });
    assert.ok(prepared.attachments.length > 1, 'expected the landscape bill to be tiled');
    assert.deepEqual(prepared.tileAxes, ['x']);

    // Byte-identical to the prompt behind the 196/196 measurement.
    assert.equal(buildVisionReadSystemPrompt(prepared.tileAxes), VISION_READ_SYSTEM_PROMPT_X);
    assert.equal(visionReadPromptVersion(prepared.tileAxes), VISION_READ_PROMPT_VERSION);
    assert.ok(prepared.layoutContext.includes('VERTICAL slices'));
  });

  it('a small page is not tiled and is told there is nothing to merge', async () => {
    const sharpMod: any = await import('sharp');
    const sharp = sharpMod?.default ?? sharpMod;
    const small: Buffer = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();

    const prepared = await prepareVisionInput({ source: small, kind: 'image' });
    assert.equal(prepared.attachments.length, 1);
    assert.deepEqual(prepared.tileAxes, []);

    const system = buildVisionReadSystemPrompt(prepared.tileAxes);
    assert.ok(system.includes('COMPLETE page, not a slice'));
    for (const claim of [...X_ONLY_CLAIMS, ...Y_ONLY_CLAIMS]) {
      assert.ok(!system.includes(claim), `untiled page was given a merge rule: ${claim}`);
    }
  });
});
