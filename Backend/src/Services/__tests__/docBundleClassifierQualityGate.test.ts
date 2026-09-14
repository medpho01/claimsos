/**
 * The human-review gate: does a single unreadable page in a healthy bundle
 * reach a human?
 *
 * WHY THIS FILE EXISTS (N5).
 *
 * visionRead.ts computes a genuine per-page verdict. A page whose response was
 * cut off at max_tokens, or whose tiles never rendered, is `incomplete`, and
 * its confidence is CAPPED — not multiplied — at
 * VISION_READ_INCOMPLETE_CONFIDENCE = 0.25, deliberately below the 0.3 review
 * threshold. The read then publishes `pagesNeedingReview` and each page carries
 * `needsHumanReview`.
 *
 * Nothing consumed any of it. The only live gate,
 * docBundleClassifier.service.ts:~630-645, tests `avgConfidence` — the MEAN
 * across pages — so a 0.25 page sitting among nineteen 0.93s averages 0.90,
 * clears 0.3 comfortably, and the document is classified as if nothing were
 * missing. The signal existed; the gate could not see it.
 *
 * The tests below are in two groups:
 *
 *   1. ARITHMETIC + CONTRACT — green today. They pin the constants and show,
 *      as a number, why an average cannot detect one bad page. If someone
 *      later moves a threshold so that the mean WOULD catch it, these fail and
 *      say so.
 *
 *   2. BEHAVIOUR — driven through the real DocBundleClassifierService.
 *
 * THE CHANGE HAS NOW LANDED (docBundleClassifier.service.ts, P5 quality gate),
 * and it is not the bare one-liner this file originally asked for, because that
 * one-liner over-fires. The shipped rule splits two facts that arrive wearing
 * the same low number:
 *
 *   (a) the page is provably NOT WHOLE — truncated at max_tokens, an
 *       unrendered tile, an illegibility marker, an engine error. We are
 *       missing content and cannot know what. ONE such page gates the
 *       document, whatever the other nineteen scored. Detected as a
 *       CONJUNCTION: below the review floor AND carrying a failure marker in
 *       OcrPage.warnings. The conjunction is load-bearing — ocr.service merges
 *       vision and Tesseract warnings when it falls back, so a page can carry
 *       'vision_read_failed' while holding good Tesseract text at 0.85, and
 *       the marker alone would gate it.
 *
 *   (b) the page is merely LOW-SIGNAL — a blank verso, a separator sheet, one
 *       faint stamp. The read succeeded; there was little on it. Long bundles
 *       routinely contain a few. Gating on one of those would put every normal
 *       discharge bundle into the review queue, which is a worse failure than
 *       the one being fixed. So (b) needs >= 2 such pages AND >= 25% of the
 *       document.
 *
 * The control tests bound the change in both directions: the document-wide gate
 * still fires when the whole bundle is unreadable; a clean bundle is still
 * classified; a single blank page and a merged-warning page are NOT gated; and
 * a quarter of the bundle needing review IS.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DocBundleClassifierService,
  type DocBundleClassifierDeps,
} from '../docBundleClassifier.service.js';
import {
  VISION_READ_INCOMPLETE_CONFIDENCE,
  VISION_READ_REVIEW_THRESHOLD,
  scoreVisionReadConfidence,
  visionPageNeedsReview,
} from '../extractor/visionRead.js';
import type { OcrPage, OcrResult } from '../ocr.service.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'd0c0d0c0-0000-4000-8000-000000000001';
const CLAIM_ID = 'c1a1c1a1-0000-4000-8000-000000000002';
const HOSPITAL_ID = '40591741-0000-4000-8000-000000000003';
const S3_KEY = 'hosp/claim/doc/bundle.pdf';

/**
 * QUALITY_MIN_CONF is a private constant in docBundleClassifier. visionRead
 * exports VISION_READ_REVIEW_THRESHOLD explicitly to mirror it ("Mirrors
 * docBundleClassifier's QUALITY_MIN_CONF … so a caller can ask 'would this page
 * be reviewed?' without hard-coding 0.3 a third time"). If the two ever drift,
 * the behaviour tests below stop meaning what they say, so pin the mirror.
 */
const QUALITY_MIN_CONF = VISION_READ_REVIEW_THRESHOLD;

/** A page of ordinary, plausible hospital-bill text — well past the 20-char sparse floor. */
function healthyText(pageNumber: number): string {
  return (
    `IPD FINAL BILL — page ${pageNumber} of 20\n` +
    'Room rent 3 days @ 4500.00 = 13500.00\n' +
    'Nursing charges 2400.00  Investigations 8750.00\n' +
    'Pharmacy 11230.50  Consultant visits 3000.00\n'
  );
}

function ocrPage(pageNumber: number, confidence: number, extra: Partial<OcrPage> = {}): OcrPage {
  return {
    pageNumber,
    text: healthyText(pageNumber),
    confidence,
    source: 'vision_fallback',
    ...extra,
  };
}

function ocrResult(pages: OcrPage[]): OcrResult {
  return {
    pages,
    totalPages: pages.length,
    avgConfidence:
      pages.length === 0 ? 0 : pages.reduce((a, p) => a + p.confidence, 0) / pages.length,
    processedAtMs: 1,
    fileHash: 'deadbeefdeadbeef',
    engineVersions: { vision: 'claude-test' },
  };
}

/**
 * Nineteen clean pages and one that the model never finished reading. This is
 * the exact shape N5 describes, and the shape that reaches production: a long
 * bundle where ONE page hit max_tokens.
 */
const TRUNCATED_PAGE = 7;
function bundleWithOneTruncatedPage(): OcrResult {
  return ocrResult(
    Array.from({ length: 20 }, (_, i) => {
      const n = i + 1;
      return n === TRUNCATED_PAGE
        ? ocrPage(n, VISION_READ_INCOMPLETE_CONFIDENCE, {
            warnings: ['vision_read_truncated', 'used_vision_read'],
          })
        : ocrPage(n, 0.93);
    }),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Test doubles. Only what classifyBundle touches before (and just after) the
// quality gate: the idempotency SELECT, the budget pre-flight, the S3 fetch,
// the OCR read, the candidate-category SELECT, and the LLM call.
// ────────────────────────────────────────────────────────────────────────────

function makeDeps(ocr: OcrResult) {
  const llmCalls: unknown[] = [];
  const sql: string[] = [];

  const deps: DocBundleClassifierDeps = {
    pool: {
      query: async (text: any, _params?: any) => {
        const s = String(text);
        sql.push(s);
        if (/FROM hospital\.master_options/i.test(s)) {
          // loadCandidateCategories throws on an empty list, so give it a real
          // one — we want "the LLM was reached", not "the stub fell over".
          return {
            rows: [{ code: 'final_bill' }, { code: 'discharge_summary' }],
            rowCount: 2,
          } as any;
        }
        // Idempotency SELECT and everything else: nothing there yet.
        return { rows: [], rowCount: 0 } as any;
      },
    },
    s3: {
      // A PDF, not an image — isImageBuffer() sniffs magic bytes, and the
      // single-image branch takes a different (1-page) path entirely.
      download: async () => Buffer.from('%PDF-1.7\n% synthetic bundle for the gate test\n'),
    },
    ocr: {
      extractTextFromPdf: async () => ocr,
      extractTextFromImage: async () => {
        throw new Error('the image path must not be taken for a %PDF buffer');
      },
    },
    costAccounting: {
      checkBudget: async () => ({
        claimUnderLimit: true,
        hospitalUnderLimit: true,
        action: 'allow' as const,
        claimSpendInr: 0,
        hospitalDailySpendInr: 0,
        hospitalDailyCapInr: 3000,
      }),
      recordCall: async () => {},
    },
    kbHints: { getApprovedCategoryHints: async () => [] },
    llm: {
      // The ONLY thing these tests need from the LLM is whether it was reached.
      // Throwing a sentinel keeps the stub honest: the service cannot silently
      // proceed on a half-built response.
      extract: async (req: unknown) => {
        llmCalls.push(req);
        throw new Error('__LLM_REACHED__');
      },
    } as any,
    enqueueSegmenter: async () => {},
    enqueueExtractor: async () => {},
  };

  return { deps, llmCalls, sql };
}

function classify(deps: DocBundleClassifierDeps) {
  return new DocBundleClassifierService(deps).classifyBundle({
    documentId: DOCUMENT_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
    s3Key: S3_KEY,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Arithmetic + contract — green today, and the reason the behaviour below
//    is worth asserting at all.
// ────────────────────────────────────────────────────────────────────────────

test('the incomplete cap lands BELOW the review threshold, by construction', () => {
  assert.ok(
    VISION_READ_INCOMPLETE_CONFIDENCE < VISION_READ_REVIEW_THRESHOLD,
    `a page we know is missing content scores ${VISION_READ_INCOMPLETE_CONFIDENCE}, ` +
      `which must stay under the ${VISION_READ_REVIEW_THRESHOLD} review threshold — ` +
      'as a multiplier (0.93 x 0.5 = 0.47) truncation never reached the gate at all',
  );

  // The cap is reached from real evidence, not stamped: a truncated read of an
  // otherwise plausible page still comes back below the threshold.
  const verdict = scoreVisionReadConfidence({
    text: healthyText(TRUNCATED_PAGE).repeat(6),
    imageCount: 1,
    truncated: true,
    warnings: [],
  });
  assert.equal(verdict.incomplete, true);
  assert.equal(verdict.needsHumanReview, true);
  assert.ok(verdict.confidence <= VISION_READ_INCOMPLETE_CONFIDENCE);
  assert.ok(verdict.reasons.includes('vision_read_truncated'));
});

test('AN AVERAGE CANNOT SEE IT: one 0.25 page among nineteen 0.93s clears the gate', () => {
  const ocr = bundleWithOneTruncatedPage();

  // The page itself is unambiguous…
  const bad = ocr.pages.find((p) => p.pageNumber === TRUNCATED_PAGE)!;
  assert.equal(visionPageNeedsReview(bad), true, 'the page on its own evidence needs a human');

  // …and the number the gate actually reads is nowhere near it.
  assert.ok(
    ocr.avgConfidence > QUALITY_MIN_CONF,
    `mean confidence is ${ocr.avgConfidence.toFixed(3)}, which sails past ` +
      `QUALITY_MIN_CONF=${QUALITY_MIN_CONF}; the mean is not a detector of this fault`,
  );
  assert.ok(ocr.avgConfidence > 0.88, 'and it is not even close — ~0.90 vs a 0.3 floor');

  // How bad the document would have to be before the mean noticed: with
  // nineteen 0.93s, the twentieth page would need a NEGATIVE confidence.
  const othersTotal = 0.93 * 19;
  const needed = QUALITY_MIN_CONF * 20 - othersTotal;
  assert.ok(
    needed < 0,
    `to drag the mean under ${QUALITY_MIN_CONF} the bad page would have to score ` +
      `${needed.toFixed(2)} — i.e. no single page in a 20-page bundle can ever trip it`,
  );

  // visionRead already hands the caller the page numbers, per page, precisely
  // so nobody has to re-derive this.
  const pagesNeedingReview = ocr.pages.filter((p) => visionPageNeedsReview(p)).map((p) => p.pageNumber);
  assert.deepEqual(pagesNeedingReview, [TRUNCATED_PAGE]);
});

test('visionPageNeedsReview treats a MISSING confidence as needing review, not as passing', () => {
  // The fail-safe direction matters for the docBundleClassifier one-liner:
  // `pages` there types confidence as optional, and "we do not know" must not
  // silently mean "fine".
  assert.equal(visionPageNeedsReview({}), true);
  assert.equal(visionPageNeedsReview({ confidence: null }), true);
  assert.equal(visionPageNeedsReview({ confidence: Number.NaN }), true);
  assert.equal(visionPageNeedsReview({ confidence: 0.93 }), false);
  assert.equal(visionPageNeedsReview({ confidence: 0.93, needsHumanReview: true }), true);
  assert.equal(visionPageNeedsReview({ confidence: QUALITY_MIN_CONF }), false, 'the threshold is exclusive');
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Behaviour, through the real service.
// ────────────────────────────────────────────────────────────────────────────

test('a bundle whose pages are ALL unreadable is still gated (the document-wide rule must survive)', async () => {
  const { deps, llmCalls } = makeDeps(ocrResult(Array.from({ length: 6 }, (_, i) => ocrPage(i + 1, 0.18))));

  const result = await classify(deps);

  assert.equal(llmCalls.length, 0, 'no LLM call is paid for on a document nobody can read');
  assert.equal(result.sectionCount, 0);
  assert.deepEqual(result.sectionIds, []);
  assert.equal(result.shortCircuited, false);
  assert.equal(result.fellBack, false);
  assert.equal(result.costInr, 0);
});

test('a clean bundle is NOT gated — the per-page rule must not turn every document into a review', async () => {
  const { deps, llmCalls } = makeDeps(
    ocrResult(Array.from({ length: 20 }, (_, i) => ocrPage(i + 1, 0.93))),
  );

  // The sentinel from the LLM stub proves the gate let the document through.
  await assert.rejects(() => classify(deps), /__LLM_REACHED__/);
  assert.equal(llmCalls.length, 1, 'exactly one classify call for a healthy 20-page bundle');
});

test('ONE truncated page in twenty routes the document to a human', async () => {
  const { deps, llmCalls } = makeDeps(bundleWithOneTruncatedPage());

  const result = await classify(deps);

  // The gate's observable contract, identical to the avgConfidence path:
  // no LLM call, no sections, nothing spent — the ledger row this writes
  // (skipPhase 'classify' / 'needs_human_review') is what the FE's
  // Review-Required badge reads.
  assert.equal(
    llmCalls.length,
    0,
    'page 7 was never fully read, so classifying the bundle on it is guesswork sold as a result',
  );
  assert.equal(result.sectionCount, 0);
  assert.deepEqual(result.sectionIds, []);
  assert.equal(result.fellBack, false, 'this is a review, not a fall-back to the legacy segmenter');
  assert.equal(result.costInr, 0);
});

test('an ILLEGIBLE page gates too — the marker set is not just truncation', async () => {
  const { deps, llmCalls } = makeDeps(
    ocrResult(
      Array.from({ length: 12 }, (_, i) => {
        const n = i + 1;
        return n === 5
          ? ocrPage(n, 0.25, {
              warnings: ['vision_read_illegible_marker', 'used_vision_read'],
            })
          : ocrPage(n, 0.91);
      }),
    ),
  );

  const result = await classify(deps);

  assert.equal(llmCalls.length, 0, 'the model said it could not read page 5; believe it');
  assert.equal(result.sectionCount, 0);
  assert.equal(result.costInr, 0);
});

test('a page whose images never rendered gates too (vision_read_no_images)', async () => {
  // visionRead's failedPage('vision_read_no_images') path: the model was never
  // shown the page at all. Nothing about that page is known, so the bundle
  // cannot be classified over it.
  const { deps, llmCalls } = makeDeps(
    ocrResult(
      Array.from({ length: 15 }, (_, i) => {
        const n = i + 1;
        return n === 11
          ? ocrPage(n, 0.05, { text: '', warnings: ['vision_read_no_images'] })
          : ocrPage(n, 0.9);
      }),
    ),
  );

  const result = await classify(deps);

  assert.equal(llmCalls.length, 0);
  assert.equal(result.sectionCount, 0);
  assert.equal(result.costInr, 0);
});

test('the marker strings this gate keys on are the ones visionRead actually emits', () => {
  // If visionRead renames a reason, the marker set in docBundleClassifier goes
  // silently inert — the gate would stop firing and no test would notice.
  // These pin the exact strings on the producing side.
  const truncated = scoreVisionReadConfidence({
    text: healthyText(1).repeat(6),
    imageCount: 1,
    truncated: true,
    warnings: [],
  });
  assert.ok(truncated.reasons.includes('vision_read_truncated'));

  const empty = scoreVisionReadConfidence({
    text: '\n',
    imageCount: 1,
    truncated: false,
    warnings: [],
  });
  assert.ok(
    empty.reasons.includes('vision_read_short_text'),
    'the near-empty reason must keep this name — it is deliberately NOT in the ' +
      'incomplete-marker set, because a blank verso is case (b), not missing content',
  );
  assert.equal(
    empty.needsHumanReview,
    true,
    'a blank page IS below the floor; the gate declines to act on one of them, ' +
      'which is a decision about proportion, not about the page score',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 3. The false-positive direction. A gate that fires on every bundle with one
//    thin page is not a gate, it is an outage of the review queue.
// ────────────────────────────────────────────────────────────────────────────

test('ONE blank verso in twenty is NOT gated — a thin page is not a missing page', async () => {
  // Page 13 is a blank back-of-form: the read SUCCEEDED, there was simply
  // almost nothing on it. Confidence 0.20 (VISION_READ_EMPTY_CONFIDENCE) is
  // below the review floor, so the naive "any page under 0.3" rule would send
  // this perfectly ordinary bundle to a human.
  const { deps, llmCalls } = makeDeps(
    ocrResult(
      Array.from({ length: 20 }, (_, i) => {
        const n = i + 1;
        return n === 13
          ? ocrPage(n, 0.2, {
              text: '\n',
              warnings: ['vision_read_short_text', 'used_vision_read'],
            })
          : ocrPage(n, 0.93);
      }),
    ),
  );

  await assert.rejects(() => classify(deps), /__LLM_REACHED__/);
  assert.equal(llmCalls.length, 1, 'one blank page in twenty is normal, not a review');
});

test('a MERGED vision_read_failed warning on a page Tesseract recovered is NOT gated', async () => {
  // ocr.service merges vision + Tesseract warnings when it falls back, so the
  // failure marker survives onto a page whose text is fine. This is exactly
  // why the (a) test is a conjunction and not "does it carry a marker".
  const { deps, llmCalls } = makeDeps(
    ocrResult(
      Array.from({ length: 10 }, (_, i) => {
        const n = i + 1;
        return n === 3
          ? ocrPage(n, 0.85, {
              source: 'tesseract',
              warnings: ['vision_read_failed', 'used_vision_fallback'],
            })
          : ocrPage(n, 0.92);
      }),
    ),
  );

  await assert.rejects(() => classify(deps), /__LLM_REACHED__/);
  assert.equal(
    llmCalls.length,
    1,
    'vision failed but Tesseract read the page at 0.85 — there is nothing missing to review',
  );
});

test('a QUARTER of the bundle needing review IS gated, even with a healthy mean', async () => {
  // Five low-signal pages in twenty. No failure marker anywhere, so rule (a)
  // stays silent; the mean is 0.75, far above the 0.3 floor, so the
  // document-wide rule stays silent too. Only the proportion rule can see it.
  const pages = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    return n <= 5
      ? ocrPage(n, 0.2, { text: '\n', warnings: ['vision_read_short_text', 'used_vision_read'] })
      : ocrPage(n, 0.93);
  });
  const ocr = ocrResult(pages);
  assert.ok(ocr.avgConfidence > QUALITY_MIN_CONF, 'the mean is healthy — this is the point');

  const { deps, llmCalls } = makeDeps(ocr);
  const result = await classify(deps);

  assert.equal(llmCalls.length, 0, 'a quarter of the document is unreadable; that is not incidental');
  assert.equal(result.sectionCount, 0);
  assert.equal(result.fellBack, false);
  assert.equal(result.costInr, 0);
});

test('FOUR low-signal pages in twenty (under the 25% ratio) are NOT gated', async () => {
  // The boundary in the other direction: 4/20 = 20% < 25%. Bundles with a
  // handful of separator sheets stay in the pipeline.
  const { deps, llmCalls } = makeDeps(
    ocrResult(
      Array.from({ length: 20 }, (_, i) => {
        const n = i + 1;
        return n <= 4
          ? ocrPage(n, 0.2, { text: '\n', warnings: ['vision_read_short_text', 'used_vision_read'] })
          : ocrPage(n, 0.93);
      }),
    ),
  );

  await assert.rejects(() => classify(deps), /__LLM_REACHED__/);
  assert.equal(llmCalls.length, 1);
});
