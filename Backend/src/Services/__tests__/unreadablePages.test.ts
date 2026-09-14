/**
 * Unreadable pages — the consumer contract (§C.3).
 *
 * WHY THIS FILE EXISTS.
 *
 * Until this round, every OCR consumer could assume `page.text` was a
 * transcription, because a page vision could not read silently became
 * Tesseract text. That assumption is now false, and the failure mode it
 * creates is the quiet kind: a missing implant charge on page 7 looks exactly
 * like a complete extraction.
 *
 * So the tests below pin the three behaviours that stop it being quiet:
 *
 *   1. PAGE NUMBERING SURVIVES. The bundle classifier sends a placeholder,
 *      not a deletion. Drop page 7 from a 20-page array and the model's
 *      "pages 8-12 are the final bill" silently means pages 9-13 in the file
 *      the operator opens — every boundary after the hole shifts by one, and
 *      nothing in the system notices.
 *
 *   2. ONE BLOCKED PAGE DOES NOT STOP THE DOCUMENT. A bundle with one
 *      unreadable page is still classified on its readable remainder, and the
 *      document is flagged for review rather than abandoned. This is the
 *      founder's "flag and carry on".
 *
 *   3. A WHOLLY UNREADABLE DOCUMENT COSTS NOTHING AND THROWS NOTHING. No LLM
 *      call (there is no input to send) and no exception (a throw here
 *      dead-letters through Bull's three retries and takes the rest of the
 *      run's documents with it — precisely the behaviour that was rejected).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DocBundleClassifierService,
  type DocBundleClassifierDeps,
} from '../docBundleClassifier.service.js';
import {
  isUnreadable,
  readablePages,
  allUnreadable,
  unreadableIn,
  unreadablePagesOf,
  unreadablePlaceholderText,
  formatPageRanges,
} from '../ocrUnreadable.js';
import {
  UNREADABLE_ACTION_BY_REASON,
  claimAiRunService,
} from '../claimAiRun.service.js';
import type { OcrPage, OcrResult, UnreadableReason } from '../ocr.service.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'd0c0d0c0-0000-4000-8000-000000000011';
const CLAIM_ID = 'c1a1c1a1-0000-4000-8000-000000000012';
const HOSPITAL_ID = '40591741-0000-4000-8000-000000000013';
const S3_KEY = 'hosp/claim/doc/bundle.pdf';

function healthyText(pageNumber: number): string {
  return (
    `IPD FINAL BILL — page ${pageNumber} of 20\n` +
    'Room rent 3 days @ 4500.00 = 13500.00\n' +
    'Nursing charges 2400.00  Investigations 8750.00\n' +
    'Pharmacy 11230.50  Consultant visits 3000.00\n'
  );
}

function readablePage(pageNumber: number): OcrPage {
  return {
    pageNumber,
    text: healthyText(pageNumber),
    confidence: 0.93,
    source: 'vision_fallback',
  };
}

function unreadablePage(
  pageNumber: number,
  reason: UnreadableReason = 'cost_budget',
): OcrPage {
  return {
    pageNumber,
    text: '',
    confidence: 0,
    source: 'unreadable' as OcrPage['source'],
    unreadable: true,
    unreadableReason: reason,
    unreadableDetail: 'ran out of rupees before this page was dispatched',
    warnings: ['vision_cost_budget_exceeded'],
  } as OcrPage;
}

function ocrResult(pages: OcrPage[]): OcrResult {
  const readable = pages.filter((p) => !(p as any).unreadable);
  return {
    pages,
    totalPages: pages.length,
    avgConfidence:
      readable.length === 0
        ? 0
        : readable.reduce((a, p) => a + p.confidence, 0) / readable.length,
    processedAtMs: 1,
    fileHash: 'deadbeefdeadbeef',
    engineVersions: { vision: 'claude-test' },
    warnings: pages.some((p) => (p as any).unreadable) ? ['unreadable_pages'] : [],
    unreadablePages: pages
      .filter((p) => (p as any).unreadable)
      .map((p) => ({
        pageNumber: p.pageNumber,
        reason: (p as any).unreadableReason as UnreadableReason,
        detail: (p as any).unreadableDetail,
      })),
    readablePageCount: readable.length,
  } as OcrResult;
}

const HOLE_PAGE = 7;

/** Nineteen readable pages and one hole — the shape that reaches production. */
function bundleWithOneHole(): OcrResult {
  return ocrResult(
    Array.from({ length: 20 }, (_, i) => {
      const n = i + 1;
      return n === HOLE_PAGE ? unreadablePage(n) : readablePage(n);
    }),
  );
}

function bundleAllUnreadable(): OcrResult {
  return ocrResult(
    Array.from({ length: 5 }, (_, i) => unreadablePage(i + 1, 'render_failed')),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Test doubles. Only what classifyBundle touches up to (and just past) the
// quality gate.
// ────────────────────────────────────────────────────────────────────────────

function makeDeps(ocr: OcrResult) {
  const llmCalls: any[] = [];

  const deps: DocBundleClassifierDeps = {
    pool: {
      query: async (text: any) => {
        const s = String(text);
        if (/FROM hospital\.master_options/i.test(s)) {
          return {
            rows: [{ code: 'final_bill' }, { code: 'discharge_summary' }],
            rowCount: 2,
          } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      },
    },
    s3: {
      download: async () =>
        Buffer.from('%PDF-1.7\n% synthetic bundle for the unreadable tests\n'),
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
      // We only need to know whether the LLM was reached, and with what.
      // Throwing a sentinel keeps the stub honest.
      extract: async (req: any) => {
        llmCalls.push(req);
        throw new Error('__LLM_REACHED__');
      },
    } as any,
    enqueueSegmenter: async () => {},
    enqueueExtractor: async () => {},
  };

  return { deps, llmCalls };
}

function classify(deps: DocBundleClassifierDeps) {
  return new DocBundleClassifierService(deps).classifyBundle({
    documentId: DOCUMENT_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
    s3Key: S3_KEY,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. The pure vocabulary
// ════════════════════════════════════════════════════════════════════════════

test('isUnreadable keys on the flag, not on empty text', () => {
  const blankButRead: OcrPage = {
    pageNumber: 3,
    text: '',
    confidence: 0.88,
    source: 'vision_fallback',
  };
  assert.equal(
    isUnreadable(blankButRead),
    false,
    'a page we READ and found blank is readable — a blank verso is ordinary ' +
      'content, and treating it as a hole would flag every real bundle',
  );
  assert.equal(isUnreadable(unreadablePage(3)), true);
});

test('readablePages excludes holes; allUnreadable needs every page', () => {
  const one = bundleWithOneHole();
  assert.equal(readablePages(one).length, 19);
  assert.equal(allUnreadable(one), false);
  assert.equal(allUnreadable(bundleAllUnreadable()), true);

  // A zero-page result is a PARSE failure, not an unreadable document. The two
  // have different operator actions, so they must not collapse into one.
  assert.equal(allUnreadable(ocrResult([])), false);
});

test('unreadableIn is inclusive on both ends of a section page range', () => {
  const r = bundleWithOneHole();
  assert.equal(unreadableIn(r, 7, 7).length, 1);
  assert.equal(unreadableIn(r, 1, 6).length, 0);
  assert.equal(unreadableIn(r, 8, 20).length, 0);
  assert.equal(unreadableIn(r, 5, 9)[0]?.reason, 'cost_budget');
});

test('unreadablePagesOf carries the reason through', () => {
  const pages = unreadablePagesOf(bundleAllUnreadable());
  assert.equal(pages.length, 5);
  assert.deepEqual(
    [...new Set(pages.map((p) => p.reason))],
    ['render_failed'],
  );
});

test('formatPageRanges collapses runs and keeps singletons', () => {
  assert.equal(formatPageRanges([5, 6, 7, 8, 9, 10, 11, 12]), '5-12');
  assert.equal(formatPageRanges([4, 5, 6, 7, 11]), '4-7, 11');
  assert.equal(formatPageRanges([11, 4, 7, 5, 6]), '4-7, 11');
  assert.equal(formatPageRanges([3]), '3');
  assert.equal(formatPageRanges([]), '');
});

test('every unreadable reason maps to exactly one operator action', () => {
  const reasons: UnreadableReason[] = [
    'vision_failed',
    'cost_budget',
    'latency_budget',
    'page_budget',
    'render_failed',
  ];
  for (const r of reasons) {
    assert.ok(
      UNREADABLE_ACTION_BY_REASON[r],
      `${r} has no action — the reasons exist as separate members precisely ` +
        'because each implies a different thing for the operator to do',
    );
  }
  // The two that are most often confused: running out of money is fixed by
  // approving more; a page that never rendered is not.
  assert.equal(UNREADABLE_ACTION_BY_REASON.cost_budget, 'approve_more_budget');
  assert.equal(UNREADABLE_ACTION_BY_REASON.render_failed, 'reupload_document');
});

test('the suggested top-up covers the remaining work with headroom, in ₹10 steps', () => {
  // ₹96.25 of work left → 96.25 × 1.25 = 120.3 → ₹130.
  assert.equal(claimAiRunService.suggestedAdditionalBudgetInr(96.25), 130);
  // Never offers ₹0: an "Approve ₹0 more" button resumes straight into the
  // same wall.
  assert.equal(claimAiRunService.suggestedAdditionalBudgetInr(0), 10);
  assert.equal(claimAiRunService.suggestedAdditionalBudgetInr(8), 10);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. The bundle classifier
// ════════════════════════════════════════════════════════════════════════════

test('a hole is a PLACEHOLDER, not a deletion — page numbering survives', async () => {
  const { deps, llmCalls } = makeDeps(bundleWithOneHole());

  await assert.rejects(
    () => classify(deps),
    /__LLM_REACHED__/,
    'one unreadable page in a healthy 20-page bundle must NOT stop the ' +
      'document being classified on its readable remainder',
  );

  assert.equal(llmCalls.length, 1);
  const prompt = String(llmCalls[0].userPrompt ?? '');

  // The hole is announced, in place.
  assert.match(
    prompt,
    new RegExp(`UNREADABLE PAGE ${HOLE_PAGE}`),
    'the prompt must say a page is missing rather than presenting a gap as blank',
  );
  assert.match(prompt, /cost_budget/, 'the reason travels with the marker');

  // And — the load-bearing part — page 20 is still page 20. If the hole had
  // been dropped, the last page would be numbered 19 and every boundary the
  // model emits past page 7 would point one page too early.
  assert.match(prompt, /page 20 of 20/i);
  assert.match(prompt, /page 8 of 20/i);
});

test('the placeholder never pretends to be content', () => {
  const text = unreadablePlaceholderText(unreadablePage(7, 'page_budget'));
  assert.equal(text, '[UNREADABLE PAGE 7 — page_budget]');
  assert.ok(
    text.startsWith('[UNREADABLE'),
    'it must be unmistakably a marker: a model given prose here would reason from it',
  );
});

test('a wholly unreadable document: no LLM call, no throw, run carries on', async () => {
  const { deps, llmCalls } = makeDeps(bundleAllUnreadable());

  const result = await classify(deps);

  assert.equal(
    llmCalls.length,
    0,
    'there is no input to send — classifying five holes would be paying to ' +
      'guess',
  );
  assert.equal(result.sectionCount, 0);
  assert.equal(result.costInr, 0);
  assert.equal(
    result.fellBack,
    false,
    'unreadable pages are not a classifier problem, so the legacy segmenter ' +
      'fallback must NOT fire — that path exists for oversize documents and ' +
      'invalid LLM responses only',
  );
  // The absence of a throw is the whole point: a throw here would burn Bull's
  // three retries, dead-letter the document, and take the rest of the run's
  // documents with it.
});

test('a clean bundle is unaffected — no placeholders, no flags', async () => {
  const clean = ocrResult(
    Array.from({ length: 6 }, (_, i) => readablePage(i + 1)),
  );
  const { deps, llmCalls } = makeDeps(clean);

  await assert.rejects(() => classify(deps), /__LLM_REACHED__/);
  const prompt = String(llmCalls[0].userPrompt ?? '');
  assert.doesNotMatch(
    prompt,
    /UNREADABLE PAGE/,
    'the marker must appear only when a page is genuinely unreadable',
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 3. The pause observation primitive
// ════════════════════════════════════════════════════════════════════════════

test('isRunHalted reports not-halted for a missing run id', async () => {
  const out = await claimAiRunService.isRunHalted(null);
  assert.deepEqual(out, { halted: false, status: null, pauseReason: null });

  const undef = await claimAiRunService.isRunHalted(undefined);
  assert.equal(
    undef.halted,
    false,
    'a run that does not exist cannot be paused — blocking on a missing row ' +
      'would wedge the worker on a claim whose run was deleted',
  );
});

test('makeShouldStop returns undefined without a run id', () => {
  assert.equal(
    claimAiRunService.makeShouldStop(null),
    undefined,
    'an unattended caller (emailIntelligence opens no run) must never receive ' +
      'a pause hook, or it could raise OcrPausedError with nothing to resume',
  );
  assert.equal(typeof claimAiRunService.makeShouldStop('some-run-id'), 'function');
});
