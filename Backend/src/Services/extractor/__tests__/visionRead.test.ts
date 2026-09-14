/**
 * Vision-read confidence tests. Pure, no network, no LLM, no Anthropic SDK —
 * scoreVisionReadConfidence is deliberately a pure function so the gate that
 * decides whether a human ever looks at a document can be asserted on.
 *
 * Run: npx tsx --test src/Services/extractor/__tests__/visionRead.test.ts
 *
 * The invariant worth more than the rest: a page we have concrete reason to
 * distrust must land BELOW the downstream review threshold. docBundleClassifier
 * uses QUALITY_MIN_CONF = 0.3 to route a bundle to needs_human_review and skip
 * LLM classification. A constant 0.93 on every vision read — which is what this
 * module used to stamp — deletes that gate for every scanned document, because
 * the vision path now handles all of them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VISION_READ_CONFIDENCE,
  VISION_READ_REVIEW_THRESHOLD,
  acquirePdfSource,
  countAlnum,
  detectVisionMime,
  isImageBuffer,
  scoreVisionReadConfidence,
  visionPageNeedsReview,
} from '../visionRead.js';

/** The threshold docBundleClassifier gates human review on. */
const QUALITY_MIN_CONF = 0.3;

/** A plausible transcription: dense alphanumerics, like a real bill page. */
function billText(rows = 20): string {
  const lines: string[] = ['SUNRISE HOSPITAL — FINAL BILL', 'Bill No FB/2026/00184  IPD 55231'];
  for (let i = 1; i <= rows; i++) {
    lines.push(`${i}  HCP10${i}  Room Rent Semi Private  1  4500.00  4500.00`);
  }
  lines.push('GRAND TOTAL  90000.00');
  return lines.join('\n');
}

// ── the clean read ──────────────────────────────────────────────────────

describe('scoreVisionReadConfidence — a clean read', () => {
  it('awards the ceiling when there is no adverse evidence', () => {
    const v = scoreVisionReadConfidence({ text: billText(), imageCount: 4 });
    assert.equal(v.confidence, VISION_READ_CONFIDENCE);
    assert.deepEqual(v.reasons, []);
  });

  it('does not punish the benign tiler warnings', () => {
    // These describe a deliberate decision, not a degraded image.
    const v = scoreVisionReadConfidence({
      text: billText(),
      imageCount: 4,
      warnings: ['tiling_disabled', 'deskew_disabled', 'tile_downscaled', 'tile_no_resolution_gain'],
    });
    assert.equal(v.confidence, VISION_READ_CONFIDENCE);
    assert.deepEqual(v.reasons, []);
  });
});

// ── truncation (finding #10) ────────────────────────────────────────────

describe('scoreVisionReadConfidence — truncation', () => {
  // N5. The regression this file exists to prevent a second time: truncation
  // used to be a 0.5 MULTIPLIER, so a cut-off page scored 0.93 x 0.5 = 0.47 —
  // above QUALITY_MIN_CONF. And because the downstream gate tests the MEAN
  // confidence across pages, one truncated page in twenty moved the average by
  // 0.02 and nothing ever fired. A page we KNOW is half-missing must trip the
  // gate on its own evidence.
  it('drops a truncated page below the review threshold ON ITS OWN', () => {
    const v = scoreVisionReadConfidence({ text: billText(120), imageCount: 4, truncated: true });
    assert.ok(
      v.confidence < QUALITY_MIN_CONF,
      `truncation alone must reach the gate: got ${v.confidence}`,
    );
    assert.equal(v.incomplete, true);
    assert.equal(v.needsHumanReview, true);
    assert.ok(v.reasons.includes('vision_read_truncated'));
  });

  it('drops a page with a failed tile below the review threshold ON ITS OWN', () => {
    // The model was never shown part of this page. The text it returned is
    // clean, dense and plausible — and missing whatever was in that tile.
    const v = scoreVisionReadConfidence({
      text: billText(40),
      imageCount: 4,
      warnings: ['tile_failed'],
    });
    assert.ok(v.confidence < QUALITY_MIN_CONF, `expected < ${QUALITY_MIN_CONF}, got ${v.confidence}`);
    assert.equal(v.incomplete, true);
    assert.equal(v.needsHumanReview, true);
    assert.ok(v.reasons.includes('vision_read_degraded_images'));
  });

  it('exposes the threshold it used, so no caller re-derives 0.3', () => {
    assert.equal(VISION_READ_REVIEW_THRESHOLD, QUALITY_MIN_CONF);
  });

  it('does NOT gate a merely mis-oriented page — that image is still whole', () => {
    const v = scoreVisionReadConfidence({
      text: billText(),
      imageCount: 4,
      warnings: ['exif_orientation_unreadable'],
    });
    assert.ok(v.confidence < VISION_READ_CONFIDENCE, 'still a downgrade');
    assert.ok(v.confidence > QUALITY_MIN_CONF, `expected > ${QUALITY_MIN_CONF}, got ${v.confidence}`);
    assert.equal(v.incomplete, false);
    assert.equal(v.needsHumanReview, false);
    assert.ok(v.reasons.includes('vision_read_orientation_unknown'));
  });

  it('downgrades a response cut off at max_tokens and says so', () => {
    const full = scoreVisionReadConfidence({ text: billText(120), imageCount: 4 });
    const cut = scoreVisionReadConfidence({ text: billText(120), imageCount: 4, truncated: true });

    assert.equal(full.confidence, VISION_READ_CONFIDENCE);
    assert.ok(cut.confidence < full.confidence, `truncated ${cut.confidence} must be below ${full.confidence}`);
    assert.ok(cut.reasons.includes('vision_read_truncated'));
  });

  it('drops a truncated page with degraded images under the review threshold', () => {
    // Two independent reasons to distrust the read — a human should see it.
    const v = scoreVisionReadConfidence({
      text: billText(120),
      imageCount: 4,
      truncated: true,
      warnings: ['tile_failed'],
    });
    assert.ok(v.confidence < QUALITY_MIN_CONF, `expected < ${QUALITY_MIN_CONF}, got ${v.confidence}`);
    assert.ok(v.reasons.includes('vision_read_truncated'));
    assert.ok(v.reasons.includes('vision_read_degraded_images'));
  });
});

// ── the dead quality gate (finding #8) ──────────────────────────────────

describe('scoreVisionReadConfidence — the human-review gate', () => {
  it('routes an explicitly illegible page to human review', () => {
    // Tesseract used to score this ~0.1 and send the bundle to a human. Under
    // a flat 0.93 it sailed into full LLM classification instead.
    const v = scoreVisionReadConfidence({
      text: 'The image is too blurry to read. I cannot make out the text on this page.',
      imageCount: 1,
    });
    assert.ok(v.confidence < QUALITY_MIN_CONF, `expected < ${QUALITY_MIN_CONF}, got ${v.confidence}`);
    assert.ok(v.reasons.includes('vision_read_illegible_marker'));
  });

  it('routes a near-empty read to human review', () => {
    const v = scoreVisionReadConfidence({ text: 'Page 1', imageCount: 1 });
    assert.ok(v.confidence < QUALITY_MIN_CONF, `expected < ${QUALITY_MIN_CONF}, got ${v.confidence}`);
    assert.ok(v.reasons.includes('vision_read_short_text'));
  });

  it('routes an implausibly thin read of a blurred tiled page to human review', () => {
    // Four full-resolution images of a hospital document that yielded 30-odd
    // alphanumerics between them, on a page whose text rows the deskew sweep
    // could not even find. That is a bad upload, not a sparse page.
    const v = scoreVisionReadConfidence({
      text: 'Patient name: ????\nAmount: ...',
      imageCount: 4,
      warnings: ['deskew_low_confidence'],
    });
    assert.ok(v.confidence < QUALITY_MIN_CONF, `expected < ${QUALITY_MIN_CONF}, got ${v.confidence}`);
    assert.ok(v.reasons.includes('vision_read_low_text_density'));
    assert.ok(v.reasons.includes('vision_read_deskew_low_confidence'));
  });

  it('nudges, but does not condemn, a legitimately sparse single-image page', () => {
    // A stamp page or an ID card really does carry little text. Downgrade it
    // a little; do not send every one of them to a human.
    const v = scoreVisionReadConfidence({
      text: 'GOVERNMENT OF INDIA\nAADHAAR\n1234 5678 9012\nDOB 01/01/1970\nMALE',
      imageCount: 1,
    });
    assert.ok(v.confidence < VISION_READ_CONFIDENCE);
    assert.ok(v.confidence > QUALITY_MIN_CONF, `expected > ${QUALITY_MIN_CONF}, got ${v.confidence}`);
  });

  it('downgrades when the line items do not add up to the declared total', () => {
    const ok = scoreVisionReadConfidence({
      text: billText(),
      imageCount: 4,
      lineItemsTotalsMatch: true,
    });
    const bad = scoreVisionReadConfidence({
      text: billText(),
      imageCount: 4,
      lineItemsTotalsMatch: false,
    });
    assert.equal(ok.confidence, VISION_READ_CONFIDENCE, 'a matching total is not evidence against');
    assert.ok(bad.confidence < ok.confidence);
    assert.ok(bad.reasons.includes('vision_read_totals_mismatch'));
  });

  it('never returns 0 — that value means "the page failed", a different fact', () => {
    const v = scoreVisionReadConfidence({
      text: '',
      imageCount: 4,
      truncated: true,
      warnings: ['tile_failed', 'deskew_failed', 'deskew_low_confidence'],
      lineItemsTotalsMatch: false,
    });
    assert.ok(v.confidence > 0);
    assert.ok(v.confidence < QUALITY_MIN_CONF);
  });

  it('is monotonic: more adverse evidence never raises confidence', () => {
    const base = scoreVisionReadConfidence({ text: billText(), imageCount: 4 }).confidence;
    const one = scoreVisionReadConfidence({ text: billText(), imageCount: 4, truncated: true }).confidence;
    const two = scoreVisionReadConfidence({
      text: billText(),
      imageCount: 4,
      truncated: true,
      warnings: ['deskew_failed'],
    }).confidence;
    assert.ok(base >= one && one >= two, `${base} >= ${one} >= ${two}`);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────

describe('visionPageNeedsReview', () => {
  it('is the single place the 0.3 threshold is applied', () => {
    assert.equal(visionPageNeedsReview({ confidence: VISION_READ_CONFIDENCE }), false);
    assert.equal(visionPageNeedsReview({ confidence: 0.29 }), true);
    assert.equal(visionPageNeedsReview({ confidence: 0.3 }), false, 'the threshold itself passes');
    // A page that failed outright carries confidence 0.
    assert.equal(visionPageNeedsReview({ confidence: 0 }), true);
    // The explicit flag wins even if a confidence was somehow stamped high.
    assert.equal(visionPageNeedsReview({ confidence: 0.93, needsHumanReview: true }), true);
    // No number at all is not evidence of quality.
    assert.equal(visionPageNeedsReview({}), true);
    assert.equal(visionPageNeedsReview({ confidence: null }), true);
  });
});

// ── the hoisted PDF parse (finding N3) ──────────────────────────────────

describe('acquirePdfSource — one pdf-lib parse per document', () => {
  async function makePdf(pageCount: number): Promise<Buffer> {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) doc.addPage([595, 842]);
    return Buffer.from(await doc.save());
  }

  async function pageCountOf(bytes: Buffer): Promise<number> {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return doc.getPageCount();
  }

  it('reports the page count without the caller re-parsing', async () => {
    const pdf = await makePdf(5);
    const handle = await acquirePdfSource(pdf);
    try {
      assert.equal(handle.pageCount, 5);
    } finally {
      handle.release();
    }
  });

  it('slices a single page and reports the offset that restamps its number', async () => {
    const pdf = await makePdf(5);
    const handle = await acquirePdfSource(pdf);
    try {
      const sliced = await handle.slicePages(3, 3);
      assert.ok(sliced, 'expected a slice');
      assert.equal(sliced!.offset, 2, 'page 3 of the original is page 1 of the slice');
      assert.equal(await pageCountOf(sliced!.bytes), 1);
    } finally {
      handle.release();
    }
  });

  it('clamps a range that runs off the end rather than failing', async () => {
    const pdf = await makePdf(3);
    const handle = await acquirePdfSource(pdf);
    try {
      const sliced = await handle.slicePages(9, 12);
      assert.ok(sliced);
      assert.equal(sliced!.offset, 2, 'clamped to the last page');
      assert.equal(await pageCountOf(sliced!.bytes), 1);
    } finally {
      handle.release();
    }
  });

  it('serialises concurrent slices of one document without corrupting them', async () => {
    // This is the per-page loop's real shape: N slices requested off ONE
    // parsed source. They are queued, not run on top of each other.
    const pdf = await makePdf(6);
    const handle = await acquirePdfSource(pdf);
    try {
      const sliced = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => handle.slicePages(n, n)));
      for (let i = 0; i < sliced.length; i++) {
        assert.ok(sliced[i], `slice ${i + 1} missing`);
        assert.equal(sliced[i]!.offset, i);
        assert.equal(await pageCountOf(sliced[i]!.bytes), 1);
      }
    } finally {
      handle.release();
    }
  });

  it('is ref-counted: a second holder keeps the parse alive after the first lets go', async () => {
    // ocr.service dispatches OCR_VISION_CONCURRENCY lanes over the SAME
    // buffer. They must share one parse, and the first lane to finish must not
    // pull the document out from under the others.
    const pdf = await makePdf(4);
    const laneA = await acquirePdfSource(pdf);
    const laneB = await acquirePdfSource(pdf);

    assert.equal(laneA.pageCount, 4);
    assert.equal(laneB.pageCount, 4);

    laneA.release();
    laneA.release(); // idempotent — safe in a finally that runs twice

    const sliced = await laneB.slicePages(2, 2);
    assert.ok(sliced, 'lane B must still be able to slice');
    assert.equal(sliced!.offset, 1);
    laneB.release();

    // After the last release the buffer can still be re-acquired (a fresh
    // parse), so releasing is not a one-way door for the document.
    const again = await acquirePdfSource(pdf);
    assert.equal(again.pageCount, 4);
    again.release();
  });

  it('never throws on a buffer that is not a PDF — it reports nothing to slice', async () => {
    const handle = await acquirePdfSource(Buffer.from('this is not a pdf at all'));
    try {
      assert.equal(handle.pageCount, 0);
      assert.equal(await handle.slicePages(1, 1), null);
    } finally {
      handle.release();
    }
  });
});

describe('countAlnum', () => {
  it('counts latin and Devanagari, ignoring punctuation and whitespace', () => {
    assert.equal(countAlnum('AB 12 — .,'), 4);
    assert.equal(countAlnum('रोगी का नाम'), 9);
    assert.equal(countAlnum(''), 0);
    assert.equal(countAlnum(undefined as any), 0);
  });
});

describe('detectVisionMime / isImageBuffer', () => {
  it('sniffs the formats Anthropic accepts', () => {
    assert.equal(detectVisionMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(
      detectVisionMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      'image/png',
    );
    assert.equal(detectVisionMime(Buffer.alloc(0)), 'image/jpeg', 'defaults rather than throwing');
  });

  it('rejects a buffer that is not an image', () => {
    assert.equal(isImageBuffer(Buffer.from('%PDF-1.7')), false);
    assert.equal(isImageBuffer(Buffer.alloc(0)), false);
    assert.equal(isImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true);
  });
});
