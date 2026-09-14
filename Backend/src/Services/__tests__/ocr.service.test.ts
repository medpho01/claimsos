/**
 * Unit tests for OcrService.
 *
 * Uses Node's built-in `node:test` runner (no Jest/Vitest in this repo yet
 * — the root package.json's "test" script is a stub). Run with:
 *
 *   npx tsx --test src/Services/__tests__/ocr.service.test.ts
 *
 * Mocking note (2026-09). This file used to patch `Module._resolveFilename`
 * and `Module._load` to intercept the service's dynamic imports of pdf-parse /
 * pdf-to-png-converter / tesseract.js. Those hooks belong to the CJS loader
 * and are never consulted for an ESM `import()`, so once the package went
 * "type":"module" every one of these tests was silently running the REAL
 * pdf-parse against a 12-byte buffer and failing with `corrupted_pdf` — all
 * 11 of them, before this change. We now inject through the service's own
 * `__setOcrEnginesForTests` seam, which preloads the same memoised module
 * slots the lazy loaders fill. No network, no LLM, no real OCR engine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  OcrService,
  OcrParseError,
  OcrPausedError,
  __setOcrEnginesForTests,
  affordableVisionPages,
  pageHasUsableTypedText,
  censusPdfPages,
  IMAGE_CENSUS,
  PAGE_COUNT_UNKNOWN_PAGES,
} = await import('../ocr.service.js');

// ────────────────────────────────────────────────────────────────────────────
// Engine fakes
// ────────────────────────────────────────────────────────────────────────────

interface MockState {
  pdfParseCalls: number;
  pdfToPngCalls: number;
  tesseractCalls: number;
  visionCalls: number;
  /** pageNumbers of the last transcribePagesViaVision call. */
  visionPageNumbers: number[] | undefined;
  visionInputs: any[];
  /** Vision calls currently in flight, and the high-water mark of that. */
  visionInFlight: number;
  visionMaxInFlight: number;
  /**
   * Rupees the injected budget resolver hands back for the next read. Defaults
   * to the production per-read cap, so a test that isn't about money behaves
   * exactly like a claim with a full OCR budget. Tests that ARE about money set
   * it and assert on the page count that buys.
   */
  allowanceInr: number;
  /**
   * Which dimension the injected resolver claims produced that number.
   * 'run_budget' is the one that means "the user's approved budget for THIS
   * run is what stopped us", which the consumer turns into a consent pause —
   * so it has to be assertable here.
   */
  allowanceLimitedBy: string;
  /** Calls to the injected budget resolver. */
  allowanceCalls: any[];

  pdfParseImpl: (buf: Buffer, opts?: any) => Promise<any>;
  pdfToPngImpl: (buf: Buffer, opts?: any) => Promise<Array<{ content: Buffer }>>;
  tesseractImpl: (input: any, lang: string) => Promise<any>;
  visionImpl: (input: any) => Promise<any>;
}

const state: MockState = {
  pdfParseCalls: 0,
  pdfToPngCalls: 0,
  tesseractCalls: 0,
  visionCalls: 0,
  visionPageNumbers: undefined,
  visionInputs: [],
  visionInFlight: 0,
  visionMaxInFlight: 0,
  allowanceInr: 250,
  allowanceLimitedBy: 'per_read_cap',
  allowanceCalls: [],
  pdfParseImpl: async () => ({ numpages: 0, text: '', version: '1.10.100' }),
  pdfToPngImpl: async () => [{ content: Buffer.from('png') }],
  tesseractImpl: async () => ({ data: { text: '', confidence: 0 } }),
  visionImpl: async () => {
    throw new Error('vision not stubbed for this test');
  },
};

/** Build a VisionTranscribeResult for the requested pages. */
function visionResult(
  pages: Array<{
    pageNumber: number;
    text: string;
    confidence?: number;
    tileCount?: number;
    deskewAngleDeg?: number | null;
    warnings?: string[];
  }>,
  model = 'claude-sonnet-4-5',
) {
  return {
    pages: pages.map((p) => ({
      pageNumber: p.pageNumber,
      text: p.text,
      confidence: p.confidence ?? 0.93,
      tileCount: p.tileCount ?? 0,
      deskewAngleDeg: p.deskewAngleDeg ?? null,
      warnings: p.warnings ?? [],
    })),
    costInr: 0.42,
    model,
    latencyMs: 1234,
    tokensInput: 2000,
    tokensOutput: 500,
    warnings: [],
  };
}

/** Every page number handed to the vision reader, across all lanes. */
function allVisionPages(): number[] {
  return state.visionInputs
    .flatMap((i) => (i.pageNumbers as number[]) ?? [])
    .sort((a, b) => a - b);
}

function resetState(): void {
  state.pdfParseCalls = 0;
  state.pdfToPngCalls = 0;
  state.tesseractCalls = 0;
  state.visionCalls = 0;
  state.visionPageNumbers = undefined;
  state.visionInputs = [];
  state.visionInFlight = 0;
  state.visionMaxInFlight = 0;
  state.allowanceInr = 250;
  state.allowanceLimitedBy = 'per_read_cap';
  state.allowanceCalls = [];
  state.visionImpl = async () => {
    throw new Error('vision not stubbed for this test');
  };
  delete process.env.OCR_ENGINE;
  delete process.env.DOC_EXTRACT_DEFAULT_MODE;
  delete process.env.OCR_VISION_MAX_PAGES;
  delete process.env.OCR_VISION_MAX_PAGES_UNATTENDED;
  delete process.env.OCR_VISION_MAX_PAGES_DOCUMENT;
  delete process.env.OCR_VISION_CONCURRENCY;
  delete process.env.OCR_VISION_PAGES_PER_CALL;
  delete process.env.OCR_VISION_EST_PAGE_COST_INR;
  delete process.env.OCR_VISION_LATENCY_BUDGET_MS;
  delete process.env.OCR_VISION_FALLBACK_DISABLED;

  __setOcrEnginesForTests({
    pdfParse: async (buf: Buffer, opts?: any) => {
      state.pdfParseCalls++;
      return state.pdfParseImpl(buf, opts);
    },
    pdfToPng: async (buf: Buffer, opts?: any) => {
      state.pdfToPngCalls++;
      return state.pdfToPngImpl(buf, opts);
    },
    tesseractRecognize: async (input: any, lang: string) => {
      state.tesseractCalls++;
      return state.tesseractImpl(input, lang);
    },
    visionTranscribe: async (input: any) => {
      state.visionCalls++;
      state.visionInputs.push(input);
      state.visionPageNumbers = input.pageNumbers;
      state.visionInFlight++;
      state.visionMaxInFlight = Math.max(
        state.visionMaxInFlight,
        state.visionInFlight,
      );
      try {
        return await state.visionImpl(input);
      } finally {
        state.visionInFlight--;
      }
    },
    // The rupee bound is REAL in these tests — only its data source is faked.
    // Without this the resolver would hit a Postgres pool that does not exist
    // here, report infinite spend, and clamp every read to zero vision pages.
    costAllowance: async (opts: any) => {
      state.allowanceCalls.push(opts);
      return {
        allowanceInr: state.allowanceInr,
        limitedBy: state.allowanceLimitedBy,
        reason: `test allowance ₹${state.allowanceInr}`,
      };
    },
  });
}

/** Every page of the result that carries no text and a reason why. */
function unreadable(result: any): Array<{ pageNumber: number; reason: string }> {
  return result.pages
    .filter((p: any) => p.unreadable === true)
    .map((p: any) => ({ pageNumber: p.pageNumber, reason: p.unreadableReason }));
}

// ────────────────────────────────────────────────────────────────────────────
// Helper to build a pdf-parse response from per-page strings. pdf-parse's
// pagerender callback is invoked per page; we simulate that here so the
// service's pagesText[] array gets filled the way it would in prod.
// ────────────────────────────────────────────────────────────────────────────

function makePdfParseImpl(pageTexts: string[], version = '1.10.100') {
  return async (_buf: Buffer, opts?: any) => {
    if (opts?.pagerender) {
      for (const t of pageTexts) {
        const fakePageData = {
          getTextContent: async () => ({
            items: [{ str: t, transform: [0, 0, 0, 0, 0, 0] }],
          }),
        };
        await opts.pagerender(fakePageData);
      }
    }
    return {
      numpages: pageTexts.length,
      text: pageTexts.join('\n'),
      version,
    };
  };
}

test.after(() => {
  __setOcrEnginesForTests(null);
  delete process.env.OCR_ENGINE;
  delete process.env.DOC_EXTRACT_DEFAULT_MODE;
  delete process.env.OCR_VISION_MAX_PAGES;
  delete process.env.OCR_VISION_MAX_PAGES_UNATTENDED;
  delete process.env.OCR_VISION_MAX_PAGES_DOCUMENT;
  delete process.env.OCR_VISION_CONCURRENCY;
});

// ────────────────────────────────────────────────────────────────────────────
// Backward compatibility: the typed-text fast path is untouched by the
// vision-first flip. These two tests are the proof.
// ────────────────────────────────────────────────────────────────────────────

test('typed PDF → uses typed_pdf source, skips Tesseract', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl([
    'This is a long, typed page with plenty of alphanumerics 12345 abcdef ghijkl.',
  ]);

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-typed-1'));

  assert.equal(result.totalPages, 1);
  assert.equal(result.pages[0].source, 'typed_pdf');
  assert.equal(result.pages[0].confidence, 0.95);
  assert.equal(state.tesseractCalls, 0, 'tesseract should NOT be invoked for typed PDFs');
  assert.equal(state.pdfToPngCalls, 0, 'pdf-to-png should NOT be invoked for typed PDFs');
  assert.equal(state.visionCalls, 0, 'vision should NOT be invoked for typed PDFs — it is free and exact');
});

test('mixed PDF: page 1 typed, page 2 scanned → both branches', async () => {
  resetState();
  process.env.OCR_ENGINE = 'tesseract';
  state.pdfParseImpl = makePdfParseImpl([
    'This page has enough typed alphanumeric content abcdefghij 1234567890 to pass.',
    '', // page 2: no text layer → tesseract
  ]);
  state.tesseractImpl = async () => ({
    data: { text: 'page 2 ocr', confidence: 75 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-mixed'));

  assert.equal(result.totalPages, 2);
  assert.equal(result.pages[0].source, 'typed_pdf');
  assert.equal(result.pages[1].source, 'tesseract');
  assert.equal(state.tesseractCalls, 1, 'Tesseract only runs on the scanned page');
  // avgConfidence = (0.95 + 0.75) / 2 = 0.85
  assert.equal(Math.round(result.avgConfidence * 100) / 100, 0.85);
});

// ────────────────────────────────────────────────────────────────────────────
// The vision path — the replacement for the old 'vision_fallback_eligible' stub
// ────────────────────────────────────────────────────────────────────────────

test('scanned PDF → read by vision, NOT Tesseract (vision is the default engine)', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(['']); // empty text layer = scanned
  state.visionImpl = async () =>
    visionResult([
      {
        pageNumber: 1,
        text: 'FINAL BILL\nRoom rent 2 1500 3000',
        confidence: 0.93,
        tileCount: 3,
        deskewAngleDeg: -1.2,
      },
    ]);

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-scanned-vision'));

  const page = result.pages[0];
  assert.equal(page.source, 'vision_fallback');
  assert.ok(page.text.length > 0, 'vision read must produce text');
  assert.equal(page.confidence, 0.93);
  assert.equal(page.tileCount, 3);
  assert.equal(page.deskewAngleDeg, -1.2);
  assert.equal(page.visionModel, 'claude-sonnet-4-5');
  assert.ok(page.warnings?.includes('used_vision_read'));
  assert.ok(
    !page.warnings?.includes('vision_fallback_eligible'),
    'the old stub warning must be gone',
  );
  assert.equal(result.engineVersions.vision, 'claude-sonnet-4-5');
  assert.equal(state.visionCalls, 1);
  assert.equal(state.tesseractCalls, 0, 'Tesseract is off the critical path');
});

test('only the pixel pages go to vision, and every one of them is covered', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl([
    'A typed page with plenty of real words abcdefghij klmnopqr 1234567890 here.',
    '',
    '',
    '',
  ]);
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({
        pageNumber: n,
        text: `page ${n} transcription`,
      })),
    );

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-batch'), {
    claimId: 'claim-batch',
  });

  assert.deepEqual(allVisionPages(), [2, 3, 4], 'typed page 1 is excluded');
  assert.equal(result.pages[0].source, 'typed_pdf');
  assert.equal(result.pages[1].source, 'vision_fallback');
  assert.equal(result.pages[3].text, 'page 4 transcription');
  assert.equal(state.tesseractCalls, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// Cost + latency bounds (finding #4). The reader is ONE PROVIDER CALL PER
// PAGE, so both the page count and the call ordering are spend decisions.
// ────────────────────────────────────────────────────────────────────────────

test('vision pages are dispatched ONE PER CALL by a pool capped at OCR_VISION_CONCURRENCY', async () => {
  resetState();
  process.env.OCR_VISION_CONCURRENCY = '2';
  state.pdfParseImpl = makePdfParseImpl(['', '', '', '', '', '']);
  state.visionImpl = async (input: any) => {
    // Hold the call open long enough for its siblings to start.
    await new Promise((r) => setTimeout(r, 15));
    return visionResult(
      (input.pageNumbers as number[]).map((n) => ({
        pageNumber: n,
        text: `page ${n} transcription`,
      })),
    );
  };

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-lanes'), {
    claimId: 'claim-lanes',
  });

  // NEW-4. transcribePagesViaVision walks the pages of ONE call sequentially,
  // so handing it a contiguous lane of 3 pages bought no parallelism for pages
  // 2 and 3 — the old lane split produced 2 calls and 3 serial round-trips
  // inside each. One page per call is what makes the pool width real.
  assert.equal(state.visionCalls, 6, 'six pages, six provider calls');
  assert.ok(
    state.visionInputs.every((i) => (i.pageNumbers as number[]).length === 1),
    'one page per provider call',
  );
  assert.equal(
    state.visionMaxInFlight,
    2,
    'the pool must overlap calls, and must not exceed OCR_VISION_CONCURRENCY',
  );
  assert.deepEqual(allVisionPages(), [1, 2, 3, 4, 5, 6]);
  // Pages are still taken in document order — the cost log stays legible and
  // the pump's cost cut-off falls on the tail, not on a random subset.
  assert.deepEqual(
    state.visionInputs.slice(0, 2).map((i) => i.pageNumbers),
    [[1], [2]],
  );
  assert.ok(result.pages.every((p) => p.source === 'vision_fallback'));
});

test('OCR_VISION_PAGES_PER_CALL batches pages back into one call when asked', async () => {
  resetState();
  process.env.OCR_VISION_CONCURRENCY = '2';
  process.env.OCR_VISION_PAGES_PER_CALL = '3';
  state.pdfParseImpl = makePdfParseImpl(['', '', '', '', '', '']);
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const svc = new OcrService();
  await svc.extractTextFromPdf(Buffer.from('pdf-batched'), { claimId: 'claim-batched' });

  assert.equal(state.visionCalls, 2, 'six pages in chunks of three');
  assert.deepEqual(state.visionInputs[0].pageNumbers, [1, 2, 3]);
  assert.deepEqual(state.visionInputs[1].pageNumbers, [4, 5, 6]);
  assert.deepEqual(allVisionPages(), [1, 2, 3, 4, 5, 6]);
});

test('one failing call costs only its own page — the rest still read via vision', async () => {
  resetState();
  process.env.OCR_VISION_CONCURRENCY = '2';
  state.pdfParseImpl = makePdfParseImpl(['', '', '', '']);
  state.visionImpl = async (input: any) => {
    const pageNumbers = input.pageNumbers as number[];
    if (pageNumbers.includes(3)) throw new Error('anthropic 529 overloaded');
    return visionResult(
      pageNumbers.map((n) => ({ pageNumber: n, text: `page ${n} transcription` })),
    );
  };
  state.tesseractImpl = async () => ({
    data: { text: 'tesseract salvage', confidence: 80 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-lane-fail'), {
    claimId: 'claim-lane-fail',
  });

  assert.equal(result.pages[0].source, 'vision_fallback');
  assert.equal(result.pages[1].source, 'vision_fallback');
  // The failed page is a HOLE, not Tesseract text.
  assert.equal(result.pages[2].source, 'unreadable');
  assert.equal(result.pages[2].text, '');
  assert.equal(result.pages[2].unreadableReason, 'vision_failed');
  // Page 4 used to be collateral damage: it shared a lane with page 3, so one
  // 529 cost two pages. One page per call contains the blast radius.
  assert.equal(result.pages[3].source, 'vision_fallback');
  assert.ok(result.pages[2].warnings?.includes('vision_read_failed'));
  assert.equal(state.tesseractCalls, 0, 'no automatic Tesseract degrade');
  assert.equal(result.engineVersions.vision, 'claude-sonnet-4-5');
  // …and the run carries on: three of four pages still read.
  assert.equal(result.readablePageCount, 3);
  assert.ok(result.warnings?.includes('unreadable_pages'));
  assert.ok(!result.warnings?.includes('all_pages_unreadable'));
});

test('page budget defaults to 8 — a 50-page scan cannot spend 50 vision calls', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(new Array(50).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({
        pageNumber: n,
        text: `page ${n} transcription`,
      })),
    );
  state.tesseractImpl = async () => ({
    data: { text: 'tesseract tail', confidence: 75 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-50-attended'), {
    claimId: 'claim-50',
    hospitalId: 'hosp-50',
  });

  assert.deepEqual(allVisionPages(), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(result.pages[7].source, 'vision_fallback');
  assert.equal(result.pages[8].source, 'unreadable');
  assert.equal(result.pages[8].unreadableReason, 'page_budget');
  // The warning code is UNCHANGED — docBundleClassifier's
  // INCOMPLETE_PAGE_WARNINGS set keys on exactly this string.
  assert.ok(result.pages[8].warnings?.includes('vision_page_budget_exceeded'));
  assert.equal(state.tesseractCalls, 0, 'no automatic Tesseract degrade');
  // Page NUMBERING is preserved: every one of the 50 pages is still present,
  // because section boundaries are expressed in page numbers.
  assert.equal(result.pages.length, 50);
  assert.deepEqual(
    result.pages.map((p: any) => p.pageNumber),
    Array.from({ length: 50 }, (_, i) => i + 1),
  );
  assert.equal(result.readablePageCount, 8);
  assert.equal(result.unreadablePages?.length, 42);
});

test('no claim context (unattended ingestion) → the tighter 3-page budget', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(new Array(50).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({
        pageNumber: n,
        text: `page ${n} transcription`,
      })),
    );
  state.tesseractImpl = async () => ({
    data: { text: 'tesseract tail', confidence: 75 },
  });

  const svc = new OcrService();
  // This is exactly how emailIntelligence OCRs an inbound attachment: no
  // claim, no hospital, no explicit engine. The sender picks the page count,
  // so the budget must not be the attended one.
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-50-unattended'));

  assert.deepEqual(allVisionPages(), [1, 2, 3]);
  assert.equal(result.pages[3].source, 'unreadable');
  assert.equal(result.pages[3].unreadableReason, 'page_budget');
  assert.ok(result.pages[3].warnings?.includes('vision_page_budget_exceeded'));
});

test('the unattended budget never exceeds the operator-lowered full budget', async () => {
  resetState();
  process.env.OCR_VISION_MAX_PAGES = '1';
  process.env.OCR_VISION_MAX_PAGES_UNATTENDED = '9';
  state.pdfParseImpl = makePdfParseImpl(['', '', '']);
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  await svc.extractTextFromPdf(Buffer.from('pdf-clamped-budget'));

  assert.deepEqual(allVisionPages(), [1], 'the lower of the two wins');
});

test('an explicit vision request counts as attended even without a claim id', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(new Array(6).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const svc = new OcrService();
  await svc.extractTextFromPdf(Buffer.from('pdf-explicit-vision'), {
    forceEngine: 'vision',
  });

  assert.deepEqual(allVisionPages(), [1, 2, 3, 4, 5, 6], 'full budget, not 3');
});

// ────────────────────────────────────────────────────────────────────────────
// Budget SCOPE + explicit attendance (2026-09-14).
//
// These are the contract for engine coherence across dependent pipeline
// steps. The bug they pin down: docSegmenter / docBundleClassifier hand this
// service a whole 40-page bundle and derive section boundaries from the
// result, while docClassifier / docExtractor re-read those same pages as
// per-section slices. All four used to call extractTextFromPdf with NO opts,
// so the two bundle-level callers silently took the unattended 3-page budget
// and derived boundaries from Tesseract text for pages 4-40 that the
// extractor then read via vision. One document, two transcriptions.
// ────────────────────────────────────────────────────────────────────────────

test("visionBudgetScope:'document' scales the budget with the document, not to 8", async () => {
  resetState();
  // 20 pages, none with a usable typed layer → 20 pixel pages.
  state.pdfParseImpl = makePdfParseImpl(new Array(20).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  // Exactly how docSegmenter / docBundleClassifier now call in.
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-bundle-20'), {
    claimId: 'claim-b',
    hospitalId: 'hosp-b',
    attended: true,
    visionBudgetScope: 'document',
  });

  assert.deepEqual(
    allVisionPages(),
    Array.from({ length: 20 }, (_, i) => i + 1),
    'every pixel page in the bundle is read by vision',
  );
  assert.ok(
    result.pages.every((p) => p.source === 'vision_fallback'),
    'no page is demoted to Tesseract at the bundle level',
  );
  assert.equal(state.tesseractCalls, 0);
  assert.equal(result.warnings, undefined, 'nothing was clamped');
});

test("visionBudgetScope:'document' past the ceiling warns instead of truncating silently", async () => {
  resetState();
  process.env.OCR_VISION_MAX_PAGES_DOCUMENT = '10';
  state.pdfParseImpl = makePdfParseImpl(new Array(14).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-bundle-clamped'), {
    claimId: 'claim-c',
    hospitalId: 'hosp-c',
    attended: true,
    visionBudgetScope: 'document',
  });

  assert.deepEqual(allVisionPages(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(result.pages[10].source, 'unreadable');
  assert.equal(result.pages[10].unreadableReason, 'page_budget');
  // The pages the bundle pass and a later section pass will disagree about
  // are named on the result, not left for someone to infer from a log.
  assert.deepEqual(result.warnings, [
    'vision_document_budget_clamped',
    'unreadable_pages',
  ]);
});

test("visionBudgetScope:'document' never reads FEWER pages than section scope would", async () => {
  resetState();
  // An operator sets a document ceiling below the section budget. Document
  // scope must not turn into a downgrade.
  process.env.OCR_VISION_MAX_PAGES_DOCUMENT = '2';
  state.pdfParseImpl = makePdfParseImpl(new Array(5).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-bundle-floor'), {
    claimId: 'claim-f',
    hospitalId: 'hosp-f',
    attended: true,
    visionBudgetScope: 'document',
  });

  assert.deepEqual(allVisionPages(), [1, 2, 3, 4, 5], 'floored at the section budget of 8');
  assert.equal(result.warnings, undefined);
});

test('attended:false pins the tight budget even when a claim context is present', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(new Array(12).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  // emailIntelligence's gate. ProcessInboundEmailInput already carries these
  // ids, so the day somebody threads them through for cost attribution the
  // heuristic alone would have tripled this path's budget.
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-spam-attachment'), {
    claimId: 'claim-x',
    hospitalId: 'hosp-x',
    attended: false,
    // …and a scope declaration must not buy a wider budget either.
    visionBudgetScope: 'document',
  });

  assert.deepEqual(allVisionPages(), [1, 2, 3], 'unattended budget, unmoved');
  assert.ok(result.pages[3].warnings?.includes('vision_page_budget_exceeded'));
});

test('attended:true grants the full budget with no claim ids at all', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(new Array(6).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const svc = new OcrService();
  await svc.extractTextFromPdf(Buffer.from('pdf-attended-noids'), {
    attended: true,
  });

  assert.deepEqual(allVisionPages(), [1, 2, 3, 4, 5, 6], 'full budget, not 3');
});

// ────────────────────────────────────────────────────────────────────────────
// THE RUPEE BOUND (NEW-2, 2026-09-14).
//
// The merge blocker these pin down: a 40-page A4 portrait bundle reads at
// ~₹5.4/page, so a document-scope read is ~₹217. While that spend counted
// against the ₹15 per-claim cap, the sequence was — bundle classifier's
// pre-flight passes at ₹0, the read burns ₹217 against the claim, and the
// classify and extract calls that follow are BLOCKED, retried three times and
// dead-lettered. The claim was never classified.
//
// The contract now: the read is bounded in RUPEES from the inside, the bound
// is re-checked between pages, and crossing it degrades pages to Tesseract.
// It must never throw, and it must never leave the claim unprocessable.
// ────────────────────────────────────────────────────────────────────────────

test('affordableVisionPages floors, and refuses to guess on a broken estimate', () => {
  assert.equal(affordableVisionPages(250, 5.5), 45);
  assert.equal(affordableVisionPages(11, 5.5), 2, 'floors — half a page is no page');
  assert.equal(affordableVisionPages(5, 5.5), 0);
  assert.equal(affordableVisionPages(0, 5.5), 0);
  assert.equal(affordableVisionPages(-1, 5.5), 0);
  assert.equal(affordableVisionPages(Number.POSITIVE_INFINITY, 5.5), 0);
  assert.equal(affordableVisionPages(250, 0), 0, 'no estimate ⇒ no projection');
  assert.equal(affordableVisionPages(250, Number.NaN), 0);
});

test('a 40-page bundle inside its OCR budget still reads EVERY page via vision', async () => {
  resetState();
  // The ₹217 case, with the claim's OCR budget intact. This is the
  // no-regression guard: the rupee bound must not quietly demote the document
  // reads that the 100% structured-extraction numbers were measured on.
  state.allowanceInr = 250;
  state.pdfParseImpl = makePdfParseImpl(new Array(40).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-bundle-40'), {
    claimId: 'claim-40',
    hospitalId: 'hosp-40',
    attended: true,
    visionBudgetScope: 'document',
  });

  assert.equal(state.visionCalls, 40, 'one call per page, all forty');
  assert.equal(state.tesseractCalls, 0);
  assert.ok(result.pages.every((p) => p.source === 'vision_fallback'));
  assert.equal(result.warnings, undefined, 'nothing clamped');
});

test('a thin rupee allowance clamps the read instead of blocking the claim', async () => {
  resetState();
  // ₹11 at the ₹5.5/page estimate buys exactly two pages.
  state.allowanceInr = 11;
  state.pdfParseImpl = makePdfParseImpl(new Array(6).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-thin-budget'), {
    claimId: 'claim-thin',
    hospitalId: 'hosp-thin',
    attended: true,
    visionBudgetScope: 'document',
  });

  assert.deepEqual(allVisionPages(), [1, 2], 'two pages is what ₹11 buys');
  assert.equal(result.pages[2].source, 'unreadable');
  assert.equal(result.pages[2].unreadableReason, 'cost_budget');
  // The reason is named on the page AND on the document, and it is the COST
  // reason — not the page-ceiling one. They point at different knobs.
  assert.ok(result.pages[2].warnings?.includes('vision_cost_budget_exceeded'));
  assert.ok(result.warnings?.includes('vision_cost_budget_clamped'));
  assert.ok(result.warnings?.includes('unreadable_pages'));
  assert.ok(!result.warnings?.includes('vision_document_budget_clamped'));
  // A static cap is NOT a run-budget stop: nobody is asked for consent here,
  // an operator raises a cap.
  assert.ok(!result.warnings?.includes('run_budget_exhausted'));
  // The document is still 6 pages long and the two it could pay for are read.
  assert.equal(result.pages.length, 6);
  assert.equal(result.readablePageCount, 2);
  assert.ok(
    result.pages.slice(2).every((p: any) => p.text === '' && p.confidence === 0),
    'an unpaid-for page has NO text — it is never silently substituted',
  );
  assert.equal(state.tesseractCalls, 0);
});

test("a RUN-budget stop is reported as such, so the caller can pause for consent", async () => {
  resetState();
  // Same shape as the test above, but the binding dimension is the budget the
  // USER approved for this run rather than a static ops cap. The remedy is a
  // consent dialog, not an env change, so it must be distinguishable.
  state.allowanceInr = 11;
  state.allowanceLimitedBy = 'run_budget';
  state.pdfParseImpl = makePdfParseImpl(new Array(5).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-run-budget'), {
    claimId: 'claim-run',
    hospitalId: 'hosp-run',
    runId: 'run-abc',
    attended: true,
    visionBudgetScope: 'document',
  });

  assert.ok(
    result.warnings?.includes('run_budget_exhausted'),
    'the consumer keys on this to call pauseForConsent',
  );
  assert.ok(result.warnings?.includes('unreadable_pages'));
  assert.equal(result.pages[2].unreadableReason, 'cost_budget');
  // The run id reaches the budget resolver — that is what lets it subtract the
  // run's own spend from the approved budget.
  assert.equal(state.allowanceCalls[0].runId, 'run-abc');
});

test('a ZERO allowance makes every page unreadable and never throws', async () => {
  resetState();
  state.allowanceInr = 0; // claim OCR cap already exhausted
  state.pdfParseImpl = makePdfParseImpl(new Array(5).fill(''));
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-no-budget'), {
    claimId: 'claim-broke',
    hospitalId: 'hosp-broke',
    attended: true,
    visionBudgetScope: 'document',
  });

  assert.equal(state.visionCalls, 0, 'not one rupee spent');
  assert.equal(state.tesseractCalls, 0, 'and not one page of fabricated text');
  assert.ok(result.pages.every((p: any) => p.source === 'unreadable'));
  assert.ok(result.pages.every((p: any) => p.unreadableReason === 'cost_budget'));
  assert.ok(result.warnings?.includes('vision_cost_budget_clamped'));
  assert.ok(result.warnings?.includes('all_pages_unreadable'));
  assert.equal(result.readablePageCount, 0);
  // It RETURNED. The read never throws on budget; the consumer decides what to
  // do with a document it could not read.
  assert.equal(result.totalPages, 5);
});

test('a budget lookup that THROWS makes pages unreadable — it does not fail the read', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(new Array(3).fill(''));
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });
  __setOcrEnginesForTests({
    pdfParse: async (buf: Buffer, opts?: any) => state.pdfParseImpl(buf, opts),
    pdfToPng: async (buf: Buffer, opts?: any) => state.pdfToPngImpl(buf, opts),
    tesseractRecognize: async (i: any, l: string) => {
      state.tesseractCalls++;
      return state.tesseractImpl(i, l);
    },
    visionTranscribe: async (input: any) => {
      state.visionCalls++;
      return state.visionImpl(input);
    },
    costAllowance: async () => {
      throw new Error('pg pool exhausted');
    },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-budget-down'), {
    claimId: 'claim-db-down',
    hospitalId: 'hosp-db-down',
  });

  assert.equal(state.visionCalls, 0, 'fail CLOSED on spend');
  assert.equal(result.pages.length, 3, 'and OPEN on the pipeline — it returned');
  assert.ok(result.pages.every((p: any) => p.source === 'unreadable'));
  assert.ok(result.pages.every((p: any) => p.unreadableReason === 'cost_budget'));
  assert.equal(state.tesseractCalls, 0);
});

test('the allowance is re-checked BETWEEN pages against ACTUAL cost, not just up front', async () => {
  resetState();
  // ₹30 projects to 5 pages at the ₹5.5 estimate — but each page really costs
  // ₹12. A bound applied only before the first call would spend ₹60. The pump
  // reprojects from what it has observed and stops after two.
  state.allowanceInr = 30;
  process.env.OCR_VISION_CONCURRENCY = '1';
  state.pdfParseImpl = makePdfParseImpl(new Array(10).fill(''));
  state.visionImpl = async (input: any) => ({
    ...visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    ),
    costInr: 12,
  });
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-expensive-pages'), {
    claimId: 'claim-expensive',
    hospitalId: 'hosp-expensive',
  });

  assert.deepEqual(allVisionPages(), [1, 2], 'stopped once the real price showed');
  assert.equal(result.pages[2].unreadableReason, 'cost_budget');
  assert.ok(result.pages[2].warnings?.includes('vision_cost_budget_exceeded'));
  // Pages past the PAGE budget of 8 keep their own, different reason — one
  // means "approve more budget", the other means "split the document".
  assert.equal(result.pages[8].unreadableReason, 'page_budget');
  assert.ok(result.pages[8].warnings?.includes('vision_page_budget_exceeded'));
  assert.ok(result.warnings?.includes('vision_cost_budget_clamped'));
  assert.equal(state.tesseractCalls, 0);
});

test('OCR_VISION_LATENCY_BUDGET_MS stops the pump mid-run so the Bull job returns', async () => {
  resetState();
  process.env.OCR_VISION_CONCURRENCY = '1';
  process.env.OCR_VISION_LATENCY_BUDGET_MS = '20';
  state.pdfParseImpl = makePdfParseImpl(new Array(4).fill(''));
  state.visionImpl = async (input: any) => {
    await new Promise((r) => setTimeout(r, 40));
    return visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );
  };
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-slow-provider'), {
    claimId: 'claim-slow',
    hospitalId: 'hosp-slow',
  });

  assert.equal(state.visionCalls, 1, 'one page fitted inside the budget');
  assert.equal(result.pages[0].source, 'vision_fallback');
  assert.equal(result.pages[1].unreadableReason, 'latency_budget');
  assert.ok(result.pages[1].warnings?.includes('vision_latency_budget_exceeded'));
  assert.ok(result.warnings?.includes('vision_latency_budget_clamped'));
  assert.ok(result.warnings?.includes('unreadable_pages'));
  // The job RETURNED — that is what the latency budget is for — and it did so
  // without inventing text for the three pages it never read.
  assert.equal(result.pages.length, 4);
  assert.equal(state.tesseractCalls, 0);
});

test('the LRU cache is keyed by vision policy — a starved read is never replayed to a richer caller', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(new Array(10).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  const buf = Buffer.from('pdf-same-bytes-two-policies');

  // Unattended first — 3 pages, the rest Tesseract. This used to poison the
  // cache for everyone: keyed on the hash alone, the bundle-level caller
  // below would have been handed this exact result.
  const unattended = await svc.extractTextFromPdf(buf, { attended: false });
  assert.equal(unattended.pages[4].source, 'unreadable');

  const bundle = await svc.extractTextFromPdf(buf, {
    claimId: 'claim-p',
    hospitalId: 'hosp-p',
    attended: true,
    visionBudgetScope: 'document',
  });

  assert.equal(state.pdfParseCalls, 2, 'the richer policy forced its own read');
  assert.ok(
    bundle.pages.every((p) => p.source === 'vision_fallback'),
    'and got all ten pages by vision',
  );

  // Same policy twice still shares one read — coherence must not cost double.
  await svc.extractTextFromPdf(buf, {
    claimId: 'claim-p',
    hospitalId: 'hosp-p',
    attended: true,
    visionBudgetScope: 'document',
  });
  assert.equal(state.pdfParseCalls, 2, 'identical policy = cache hit');
});

test('a RUPEE-clamped read is NOT cached — approving more budget genuinely re-reads', async () => {
  resetState();
  // THE REGRESSION THIS PINS. The cache key carries the vision POLICY, never
  // the rupee allowance — deliberately, so the segmenter and the classifier
  // share one expensive read. The cost of that choice is that a read truncated
  // by a MOVING bound must not be stored: the resume after cost consent sends
  // byte-identical opts, so it would hit the same key, be handed the same
  // truncated result with 'run_budget_exhausted' still on it, and pause again
  // having spent ₹0. The user could approve forever and page 3 would never be
  // read.
  state.allowanceInr = 11; // ₹11 at ₹5.5/page buys exactly two pages
  state.allowanceLimitedBy = 'run_budget';
  state.pdfParseImpl = makePdfParseImpl(new Array(5).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 75 } });

  const svc = new OcrService();
  const buf = Buffer.from('pdf-clamped-never-cached');
  // Identical on both calls — that is the point. Nothing in the key changes.
  const opts = {
    claimId: 'claim-consent',
    hospitalId: 'hosp-consent',
    runId: 'run-consent',
    attended: true,
    visionBudgetScope: 'document' as const,
  };

  const first = await svc.extractTextFromPdf(buf, opts);
  assert.ok(first.warnings?.includes('run_budget_exhausted'));
  assert.equal(first.pages[2].unreadableReason, 'cost_budget');
  assert.equal(state.pdfParseCalls, 1);

  // The user approves more budget. Only the allowance moved.
  state.allowanceInr = 250;
  state.allowanceLimitedBy = 'per_read_cap';
  const second = await svc.extractTextFromPdf(buf, opts);

  assert.equal(
    state.pdfParseCalls,
    2,
    'the truncated read must not be replayed — consent has to buy a real re-read',
  );
  assert.deepEqual(
    second.pages.map((p: any) => p.source),
    new Array(5).fill('vision_fallback'),
    'every page is read the second time',
  );
  assert.equal(second.readablePageCount, 5);
  assert.equal(second.warnings, undefined, 'nothing is clamped any more');
  assert.deepEqual(allVisionPages(), [1, 1, 2, 2, 3, 4, 5]);
  assert.equal(state.tesseractCalls, 0);
});

test('a LATENCY-clamped read is NOT cached either — the clock is a moving bound too', async () => {
  resetState();
  process.env.OCR_VISION_CONCURRENCY = '1';
  process.env.OCR_VISION_LATENCY_BUDGET_MS = '20';
  state.pdfParseImpl = makePdfParseImpl(new Array(3).fill(''));
  state.visionImpl = async (input: any) => {
    await new Promise((r) => setTimeout(r, 40));
    return visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );
  };

  const svc = new OcrService();
  const buf = Buffer.from('pdf-slow-provider-cache');
  const opts = { claimId: 'claim-lat', hospitalId: 'hosp-lat' };

  const first = await svc.extractTextFromPdf(buf, opts);
  assert.ok(first.warnings?.includes('vision_latency_budget_clamped'));
  assert.equal(state.pdfParseCalls, 1);

  // An operator raises the wall-clock budget. It is not part of the cache key
  // either, so a stored timed-out read would survive the knob that fixes it.
  process.env.OCR_VISION_LATENCY_BUDGET_MS = '10000';
  const second = await svc.extractTextFromPdf(buf, opts);

  assert.equal(state.pdfParseCalls, 2, 'the timed-out read must not be replayed');
  assert.equal(second.readablePageCount, 3);
  assert.equal(second.warnings, undefined);
});

test('a CLEAN read is still cached — the segmenter and the classifier share one read', async () => {
  resetState();
  // The other half of the contract. Dropping clamped results must not cost the
  // read-sharing the cache exists for: two callers with the same bytes and the
  // same policy still pay for exactly one vision read.
  state.pdfParseImpl = makePdfParseImpl(new Array(4).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const svc = new OcrService();
  const buf = Buffer.from('pdf-clean-shared');
  const opts = {
    claimId: 'claim-share',
    hospitalId: 'hosp-share',
    attended: true,
    visionBudgetScope: 'document' as const,
  };

  const first = await svc.extractTextFromPdf(buf, opts);
  assert.equal(first.warnings, undefined, 'nothing clamped — this read is cacheable');
  const callsAfterFirst = state.visionCalls;

  const second = await svc.extractTextFromPdf(buf, opts);

  assert.equal(state.pdfParseCalls, 1, 'second caller was served from the cache');
  assert.equal(state.visionCalls, callsAfterFirst, 'and paid the provider nothing');
  assert.deepEqual(
    second.pages.map((p: any) => p.text),
    first.pages.map((p: any) => p.text),
    'one read, one transcription',
  );
});

test('a PAGE-BUDGET clamp is still cached — the page budget is policy, and policy is in the key', async () => {
  resetState();
  // The distinction that keeps the guard narrow: costSkipped/latencySkipped
  // move without any caller changing anything, so they must not be stored.
  // The page budget is part of visionPolicyCacheKey, so a richer caller
  // already gets its own entry and this result can safely be shared.
  state.pdfParseImpl = makePdfParseImpl(new Array(4).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const svc = new OcrService();
  const buf = Buffer.from('pdf-page-budget-cached');
  const opts = { attended: false as const };

  const first = await svc.extractTextFromPdf(buf, opts);
  assert.equal(first.pages[3].unreadableReason, 'page_budget');
  assert.ok(!first.warnings?.includes('vision_cost_budget_clamped'));

  await svc.extractTextFromPdf(buf, opts);
  assert.equal(state.pdfParseCalls, 1, 'a policy clamp is still a cacheable read');
});

test('coherence: identical slice + identical opts ⇒ one read, one transcription', async () => {
  resetState();
  // The classifier and the extractor both build this same slice with
  // fetchAndSlicePdf(s3_key, page_start, page_end) and both read it with
  // section scope. Byte-identical input under an identical budget must not
  // produce two different transcriptions of the same page.
  state.pdfParseImpl = makePdfParseImpl(['', '', '']);
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const svc = new OcrService();
  const slice = Buffer.from('pdf-section-slice');
  const opts = {
    claimId: 'claim-s',
    hospitalId: 'hosp-s',
    attended: true,
    visionBudgetScope: 'section' as const,
  };

  const classifierRead = await svc.extractTextFromPdf(slice, opts);
  const extractorRead = await svc.extractTextFromPdf(slice, opts);

  assert.equal(state.pdfParseCalls, 1);
  assert.deepEqual(
    classifierRead.pages.map((p) => [p.source, p.text]),
    extractorRead.pages.map((p) => [p.source, p.text]),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// THE CENTRAL BEHAVIOUR CHANGE (2026-09-14): no automatic Tesseract degrade.
// A page vision cannot read is an UNREADABLE PAGE with a reason, never
// Tesseract text that reads downstream like a real transcription.
// ────────────────────────────────────────────────────────────────────────────

test('vision failure with OCR_ENGINE unset → UNREADABLE, not Tesseract text', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(['']);
  state.visionImpl = async () => {
    throw new Error('anthropic 529 overloaded');
  };
  // Tesseract is available and WOULD have produced text. It must not be asked.
  state.tesseractImpl = async () => ({
    data: { text: 'tesseract salvage', confidence: 80 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-vision-down'));

  const page = result.pages[0];
  assert.equal(page.source, 'unreadable');
  assert.equal(page.text, '', 'no text at all — never "tesseract salvage"');
  assert.equal(page.confidence, 0);
  assert.equal(page.unreadable, true);
  assert.equal(page.unreadableReason, 'vision_failed');
  assert.ok((page.unreadableDetail?.length ?? 0) > 0);
  assert.ok((page.unreadableDetail?.length ?? 0) <= 200, 'detail is bounded');
  assert.ok(page.warnings?.includes('vision_read_failed'));
  assert.equal(state.tesseractCalls, 0, 'Tesseract is never fallen back to');
  assert.equal(result.engineVersions.vision, undefined);
  assert.ok(result.warnings?.includes('all_pages_unreadable'));
  assert.deepEqual(result.unreadablePages?.map((p: any) => p.pageNumber), [1]);
});

test('vision returns an empty page → that page is unreadable, the rest carries on', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(['', '']);
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) =>
        n === 2
          ? { pageNumber: 2, text: '   ', warnings: ['vision_page_failed'] }
          : { pageNumber: n, text: 'page one is fine' },
      ),
    );
  state.tesseractImpl = async () => ({
    data: { text: 'page two via tesseract', confidence: 70 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-partial-vision'));

  // FLAG AND CARRY ON: page 1 is fully read even though page 2 is a hole.
  assert.equal(result.pages[0].source, 'vision_fallback');
  assert.equal(result.pages[0].text, 'page one is fine');
  assert.equal(result.pages[1].source, 'unreadable');
  assert.equal(result.pages[1].unreadableReason, 'vision_failed');
  assert.ok(result.pages[1].warnings?.includes('vision_read_failed'));
  assert.equal(state.tesseractCalls, 0);
  assert.equal(result.readablePageCount, 1);
});

test('a page the model never saw an image of is render_failed, not vision_failed', async () => {
  resetState();
  // Different operator action: a page that failed to RENDER will fail again at
  // any budget, so the answer is "re-upload the document" — never "retry" and
  // never "approve more money".
  state.pdfParseImpl = makePdfParseImpl(['', '']);
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) =>
        n === 1
          ? { pageNumber: 1, text: '', warnings: ['vision_pdf_slice_failed'] }
          : { pageNumber: n, text: `p${n}` },
      ),
    );

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-render-broken'), {
    claimId: 'claim-render',
  });

  assert.deepEqual(unreadable(result), [
    { pageNumber: 1, reason: 'render_failed' },
  ]);
  assert.equal(result.pages[1].source, 'vision_fallback');
});

test('vision killed with no engine selected → every pixel page unreadable (vision_disabled)', async () => {
  resetState();
  // OCR_VISION_FALLBACK_DISABLED turns the reader OFF. It does NOT select
  // Tesseract — opting out of a reader is not choosing a different one — so a
  // spend freeze cannot silently re-route every page into an engine whose
  // wrong answers look like right ones.
  process.env.OCR_VISION_FALLBACK_DISABLED = 'true';
  state.pdfParseImpl = makePdfParseImpl(['', '']);
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 80 } });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-vision-killed'), {
    claimId: 'claim-killed',
  });
  delete process.env.OCR_VISION_FALLBACK_DISABLED;

  assert.equal(state.visionCalls, 0);
  assert.equal(state.tesseractCalls, 0);
  assert.ok(result.pages.every((p: any) => p.source === 'unreadable'));
  assert.ok(result.pages.every((p: any) => p.unreadableReason === 'vision_failed'));
  assert.equal(result.pages[0].unreadableDetail, 'vision_disabled');
});

test('forceVisionAllPages → skips the typed-text layer entirely', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl([
    'A perfectly good typed layer with many real words abcdefghij 1234567890.',
  ]);
  state.visionImpl = async () =>
    visionResult([{ pageNumber: 1, text: 'read from pixels anyway' }]);

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-force-vision'), {
    forceVisionAllPages: true,
  });

  assert.equal(result.pages[0].source, 'vision_fallback');
  assert.equal(result.pages[0].text, 'read from pixels anyway');
  assert.deepEqual(state.visionPageNumbers, [1]);
});

test('claimId / hospitalId are passed through to the vision reader for cost attribution', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(['']);
  state.visionImpl = async () => visionResult([{ pageNumber: 1, text: 'ok' }]);

  const svc = new OcrService();
  await svc.extractTextFromPdf(Buffer.from('pdf-cost-attrib'), {
    claimId: 'claim-123',
    hospitalId: 'hosp-9',
  });

  assert.equal(state.visionInputs[0].claimId, 'claim-123');
  assert.equal(state.visionInputs[0].hospitalId, 'hosp-9');
  assert.equal(state.visionInputs[0].taskName, 'ocr_vision_page');
  assert.equal(state.visionInputs[0].kind, 'pdf');
});

// ────────────────────────────────────────────────────────────────────────────
// TESSERACT AS THE MANUAL SAFETY VALVE. It is SELECTED, never fallen back to.
// OCR_ENGINE=tesseract must still restore the pre-2026-09 behaviour exactly.
// ────────────────────────────────────────────────────────────────────────────

test('OCR_ENGINE=tesseract → scanned PDF still goes through Tesseract, no vision call', async () => {
  resetState();
  process.env.OCR_ENGINE = 'tesseract';
  state.pdfParseImpl = makePdfParseImpl(['']);
  state.tesseractImpl = async () => ({
    data: { text: 'OCRd text from scan', confidence: 88 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-scanned-1'));

  assert.equal(result.pages[0].source, 'tesseract');
  assert.equal(result.pages[0].text, 'OCRd text from scan');
  assert.equal(result.pages[0].confidence, 0.88);
  assert.equal(state.tesseractCalls, 1);
  assert.equal(state.pdfToPngCalls, 1);
  assert.equal(state.visionCalls, 0, 'the revert switch must not call the LLM');
  assert.equal(result.pages[0].warnings, undefined, 'high confidence → no warning');
  assert.equal(result.unreadablePages, undefined, 'nothing is unreadable here');
  // An audit six months from now must be able to tell this read from a vision
  // read without guessing.
  assert.ok(result.warnings?.includes('tesseract_engine_selected'));
});

test('DOC_EXTRACT_DEFAULT_MODE=ocr reverts THIS layer too — no per-page vision calls', async () => {
  // Finding #11: the documented revert switch used to revert the extractor's
  // mode while leaving OCR_ENGINE defaulting to 'vision', so the Anthropic
  // bill kept running. One flag now reverts both.
  resetState();
  process.env.DOC_EXTRACT_DEFAULT_MODE = 'ocr';
  state.pdfParseImpl = makePdfParseImpl(['', '']);
  state.tesseractImpl = async () => ({
    data: { text: 'OCRd text from scan', confidence: 88 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-one-flag-revert'), {
    claimId: 'claim-revert',
    hospitalId: 'hosp-revert',
  });

  assert.equal(state.visionCalls, 0, 'the revert switch must stop the spend');
  assert.equal(result.pages[0].source, 'tesseract');
  assert.equal(result.pages[1].source, 'tesseract');
  assert.equal(
    result.pages[0].warnings,
    undefined,
    'vision was never attempted, so it did not fail',
  );
});

test('an explicit OCR_ENGINE still wins over DOC_EXTRACT_DEFAULT_MODE', async () => {
  resetState();
  process.env.DOC_EXTRACT_DEFAULT_MODE = 'ocr';
  process.env.OCR_ENGINE = 'vision';
  state.pdfParseImpl = makePdfParseImpl(['']);
  state.visionImpl = async () =>
    visionResult([{ pageNumber: 1, text: 'read from pixels' }]);

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-explicit-engine'));

  assert.equal(state.visionCalls, 1);
  assert.equal(result.pages[0].source, 'vision_fallback');
});

test('OCR_ENGINE=tesseract + low confidence → adds low_confidence_ocr warning', async () => {
  resetState();
  process.env.OCR_ENGINE = 'tesseract';
  state.pdfParseImpl = makePdfParseImpl(['']);
  state.tesseractImpl = async () => ({
    data: { text: 'blurry text', confidence: 40 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-blurry'));

  assert.equal(result.pages[0].source, 'tesseract');
  assert.deepEqual(result.pages[0].warnings, ['low_confidence_ocr']);
});

test('allowVisionFallback:false opts OUT of vision but selects nothing → unreadable', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(['']);
  state.tesseractImpl = async () => ({
    data: { text: 'blurry', confidence: 30 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-no-vision'), {
    allowVisionFallback: false,
  });

  assert.equal(state.visionCalls, 0);
  assert.equal(state.tesseractCalls, 0, 'opting out is not the same as choosing');
  assert.equal(result.pages[0].source, 'unreadable');
  assert.equal(result.pages[0].unreadableReason, 'vision_failed');
  assert.equal(result.pages[0].unreadableDetail, 'vision_disabled');
});

test('forceEngine:pdftotext selects Tesseract for pixel pages, as before', async () => {
  resetState();
  // 'pdftotext' means "typed layer only, no LLM". It is an explicit engine
  // choice, so its pixel pages take the Tesseract valve rather than becoming
  // holes — this is the pre-2026-09 behaviour and it is deliberately kept.
  state.pdfParseImpl = makePdfParseImpl(['']);
  state.tesseractImpl = async () => ({ data: { text: 'scanned', confidence: 82 } });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-pdftotext'), {
    forceEngine: 'pdftotext',
  });

  assert.equal(state.visionCalls, 0);
  assert.equal(result.pages[0].source, 'tesseract');
  assert.equal(result.pages[0].text, 'scanned');
  assert.ok(result.warnings?.includes('tesseract_engine_selected'));
});

test('forceEngine=tesseract → always OCRs, even with typed text', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl([
    'Plenty of typed alphanumerics here abcdefghij 1234567890 lorem ipsum.',
  ]);
  state.tesseractImpl = async () => ({
    data: { text: 'forced ocr', confidence: 80 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-force'), {
    forceEngine: 'tesseract',
  });

  assert.equal(result.pages[0].source, 'tesseract');
  assert.equal(state.tesseractCalls, 1);
  assert.equal(state.visionCalls, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// Error taxonomy + cache (unchanged contracts)
// ────────────────────────────────────────────────────────────────────────────

test('caching: same buffer twice → engines invoked only once', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(['Typed content long enough to pass threshold abcdef.']);

  const svc = new OcrService();
  const buf = Buffer.from('pdf-cache-1');

  const r1 = await svc.extractTextFromPdf(buf);
  const r2 = await svc.extractTextFromPdf(buf);

  assert.equal(r1.fileHash, r2.fileHash);
  assert.equal(state.pdfParseCalls, 1, 'pdf-parse should only be called once thanks to LRU cache');
});

test('encrypted PDF → throws OcrParseError("encrypted_pdf")', async () => {
  resetState();
  state.pdfParseImpl = async () => {
    throw new Error('PDF is encrypted with password protection');
  };

  const svc = new OcrService();
  await assert.rejects(
    svc.extractTextFromPdf(Buffer.from('pdf-encrypted')),
    (err: any) => err instanceof OcrParseError && err.message === 'encrypted_pdf'
  );
});

test('corrupted PDF → throws OcrParseError with cause', async () => {
  resetState();
  const cause = new Error('Invalid PDF structure');
  state.pdfParseImpl = async () => {
    throw cause;
  };

  const svc = new OcrService();
  await assert.rejects(
    svc.extractTextFromPdf(Buffer.from('pdf-corrupted')),
    (err: any) =>
      err instanceof OcrParseError &&
      err.message === 'corrupted_pdf' &&
      err.cause === cause
  );
});

test('empty PDF (0 pages) → returns empty result cleanly', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl([]);

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-empty'));

  assert.equal(result.totalPages, 0);
  assert.deepEqual(result.pages, []);
  assert.equal(result.avgConfidence, 0);
  assert.ok(result.fileHash);
  assert.equal(state.visionCalls, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// Image path
// ────────────────────────────────────────────────────────────────────────────

test('extractTextFromImage → vision-first when the vision engine is enabled', async () => {
  resetState();
  state.visionImpl = async () =>
    visionResult([{ pageNumber: 1, text: 'image text via vision', tileCount: 2 }]);

  const svc = new OcrService();
  const page = await svc.extractTextFromImage(Buffer.from('jpeg-bytes'));

  assert.equal(page.pageNumber, 1);
  assert.equal(page.source, 'vision_fallback');
  assert.equal(page.text, 'image text via vision');
  assert.equal(page.tileCount, 2);
  assert.ok(page.warnings?.includes('used_vision_read'));
  assert.equal(state.visionInputs[0].kind, 'image');
  assert.equal(state.visionInputs[0].taskName, 'ocr_vision_image');
  assert.equal(state.tesseractCalls, 0);
  assert.equal(state.pdfParseCalls, 0);
});

test('extractTextFromImage with OCR_ENGINE=tesseract → single OcrPage from Tesseract', async () => {
  resetState();
  process.env.OCR_ENGINE = 'tesseract';
  state.tesseractImpl = async () => ({
    data: { text: 'image text', confidence: 92 },
  });

  const svc = new OcrService();
  const page = await svc.extractTextFromImage(Buffer.from('jpeg-bytes'));

  assert.equal(page.pageNumber, 1);
  assert.equal(page.source, 'tesseract');
  assert.equal(page.text, 'image text');
  assert.equal(page.confidence, 0.92);
  assert.equal(state.visionCalls, 0);
  assert.equal(state.pdfParseCalls, 0);
});

test('extractTextFromImage → vision failure yields an UNREADABLE page, not Tesseract text', async () => {
  resetState();
  state.visionImpl = async () => {
    throw new Error('provider unavailable');
  };
  state.tesseractImpl = async () => ({
    data: { text: 'tesseract salvage', confidence: 91 },
  });

  const svc = new OcrService();
  const page = await svc.extractTextFromImage(Buffer.from('jpeg-bytes'));

  assert.equal(page.source, 'unreadable');
  assert.equal(page.text, '');
  assert.equal(page.confidence, 0);
  assert.equal(page.unreadableReason, 'vision_failed');
  assert.ok(page.warnings?.includes('vision_read_failed'));
  assert.equal(state.tesseractCalls, 0);
});

test('extractTextFromImage with OCR_ENGINE=tesseract still salvages after a vision failure', async () => {
  resetState();
  // Tesseract SELECTED: the valve behaves exactly as it did before. (Vision is
  // disabled outright by the engine choice, so this is the pure Tesseract path.)
  process.env.OCR_ENGINE = 'tesseract';
  state.tesseractImpl = async () => ({
    data: { text: 'tesseract salvage', confidence: 91 },
  });

  const svc = new OcrService();
  const page = await svc.extractTextFromImage(Buffer.from('jpeg-bytes'));

  assert.equal(page.source, 'tesseract');
  assert.equal(page.text, 'tesseract salvage');
  assert.equal(state.visionCalls, 0);
});

test('extractTextFromImage → no rupee headroom is cost_budget, not vision_failed', async () => {
  resetState();
  // The reason drives the button the operator is shown: "approve more budget"
  // rather than "retry". Getting this wrong sends them to a knob that cannot
  // help.
  state.allowanceInr = 0;
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 80 } });

  const svc = new OcrService();
  const page = await svc.extractTextFromImage(Buffer.from('jpeg-bytes'), {
    claimId: 'claim-img-broke',
  });

  assert.equal(page.source, 'unreadable');
  assert.equal(page.unreadableReason, 'cost_budget');
  assert.ok(page.warnings?.includes('vision_cost_budget_exceeded'));
  assert.equal(state.visionCalls, 0);
  assert.equal(state.tesseractCalls, 0);
});

test('extractTextFromImage: vision KILL SWITCH + no engine selected → unreadable, never Tesseract', async () => {
  resetState();
  // GAP 6. The `!tesseractSelected → unreadable` gate used to sit INSIDE the
  // `visionReadEnabled` block, so it only covered "vision ran and failed".
  // With vision disabled outright the block was skipped and the image slid
  // silently into Tesseract — a page of low-confidence text that reads like a
  // real transcription to everything downstream. The PDF pump has never done
  // that; the image path now matches it.
  process.env.OCR_VISION_FALLBACK_DISABLED = 'true';
  state.tesseractImpl = async () => ({
    data: { text: 'tesseract would have answered here', confidence: 88 },
  });

  const svc = new OcrService();
  const page = await svc.extractTextFromImage(Buffer.from('jpeg-bytes'), {
    claimId: 'claim-killswitch',
  });

  assert.equal(page.source, 'unreadable');
  assert.equal(page.text, '', 'an unread image carries NO text');
  assert.equal(page.confidence, 0);
  assert.equal(page.unreadableReason, 'vision_failed');
  // Same detail the PDF path stamps for this case — "restore the reader", not
  // "approve more money".
  assert.equal(page.unreadableDetail, 'vision_disabled');
  assert.ok(page.warnings?.includes('vision_read_failed'));
  assert.equal(state.visionCalls, 0, 'the kill switch means no provider call');
  assert.equal(state.tesseractCalls, 0, 'and NO silent degradation');
});

test('extractTextFromImage: allowVisionFallback:false selects nothing → unreadable, not Tesseract', async () => {
  resetState();
  // Opting OUT of vision is not the same as choosing Tesseract — exactly the
  // contract the PDF path already enforces.
  state.tesseractImpl = async () => ({ data: { text: 'tess', confidence: 80 } });

  const svc = new OcrService();
  const page = await svc.extractTextFromImage(Buffer.from('jpeg-bytes'), {
    allowVisionFallback: false,
  });

  assert.equal(page.source, 'unreadable');
  assert.equal(page.unreadableReason, 'vision_failed');
  assert.equal(page.unreadableDetail, 'vision_disabled');
  assert.equal(state.visionCalls, 0);
  assert.equal(state.tesseractCalls, 0);
});

test('extractTextFromImage: vision disabled but forceEngine:pdftotext SELECTS Tesseract → it still runs', async () => {
  resetState();
  // The other side of the gate. Tesseract is not dead — it is opt-in. An
  // EXPLICIT selection still runs it, with vision never consulted.
  process.env.OCR_VISION_FALLBACK_DISABLED = 'true';
  state.tesseractImpl = async () => ({
    data: { text: 'explicitly chosen tesseract', confidence: 87 },
  });

  const svc = new OcrService();
  const page = await svc.extractTextFromImage(Buffer.from('jpeg-bytes'), {
    forceEngine: 'pdftotext',
  });

  assert.equal(page.source, 'tesseract');
  assert.equal(page.text, 'explicitly chosen tesseract');
  assert.equal(page.confidence, 0.87);
  assert.equal(state.tesseractCalls, 1);
  assert.equal(state.visionCalls, 0);
  assert.ok(
    !page.warnings?.includes('vision_read_failed'),
    'vision was never attempted, so nothing about it failed',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// COOPERATIVE PAUSE. The API container sets the pause in Postgres; this worker
// observes it through the caller's hook, between pages.
// ────────────────────────────────────────────────────────────────────────────

test('shouldStop returning true raises OcrPausedError and caches NOTHING', async () => {
  resetState();
  process.env.OCR_VISION_CONCURRENCY = '1';
  state.pdfParseImpl = makePdfParseImpl(new Array(4).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const svc = new OcrService();
  const buf = Buffer.from('pdf-paused-midway');
  // Paused after the first page has been read.
  let calls = 0;
  const opts = {
    claimId: 'claim-pause',
    hospitalId: 'hosp-pause',
    runId: 'run-pause',
    shouldStop: async () => ++calls > 1,
  };

  await assert.rejects(
    svc.extractTextFromPdf(buf, opts),
    (err: any) =>
      err instanceof OcrPausedError &&
      err.runId === 'run-pause' &&
      err.pagesRead === 1 &&
      err.pagesRemaining === 3,
  );
  assert.equal(state.visionCalls, 1, 'the pause stopped further dispatch');

  // THE POINT: no cache entry. A resume-with-more-budget must re-read the
  // document rather than inherit the truncated transcription the extra money
  // was meant to replace.
  const parseCallsAfterPause = state.pdfParseCalls;
  calls = 10; // never paused this time
  const resumed = await svc.extractTextFromPdf(buf, {
    ...opts,
    shouldStop: async () => false,
  });
  assert.equal(
    state.pdfParseCalls,
    parseCallsAfterPause + 1,
    'the paused read left nothing behind — the resume genuinely re-read it',
  );
  assert.ok(resumed.pages.every((p: any) => p.source === 'vision_fallback'));
});

test('a shouldStop hook that THROWS is treated as not-paused', async () => {
  resetState();
  // An unreachable run row must not be able to wedge every OCR worker.
  state.pdfParseImpl = makePdfParseImpl(['', '']);
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-hook-throws'), {
    claimId: 'claim-hook',
    shouldStop: async () => {
      throw new Error('pg pool exhausted');
    },
  });

  assert.ok(result.pages.every((p: any) => p.source === 'vision_fallback'));
});

test('a SLOW shouldStop hook does not make two workers take the same page', async () => {
  resetState();
  // Regression guard. The hook is the only await before a worker takes its
  // chunk off the shared queue, and the take is atomic only because nothing
  // awaits between the peek and the shift. Park every worker on a slow hook
  // and they must still cover the pages exactly once between them — a
  // duplicated chunk means a dropped page, silently unread.
  process.env.OCR_VISION_CONCURRENCY = '6';
  state.pdfParseImpl = makePdfParseImpl(new Array(6).fill(''));
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-slow-hook'), {
    claimId: 'claim-slow-hook',
    attended: true,
    shouldStop: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return false;
    },
  });

  assert.deepEqual(allVisionPages(), [1, 2, 3, 4, 5, 6], 'each page exactly once');
  assert.equal(state.visionCalls, 6, 'and no chunk dispatched twice');
  assert.ok(result.pages.every((p: any) => p.source === 'vision_fallback'));
});

test('no shouldStop (an unattended caller) is never paused', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(['']);
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-unattended-nopause'));
  assert.equal(result.pages[0].source, 'vision_fallback');
});

// ────────────────────────────────────────────────────────────────────────────
// THE PAGE CENSUS. CPU-only, free, and it must count pages by the SAME rule
// the reader uses — otherwise the quote prices work the read does not do.
// ────────────────────────────────────────────────────────────────────────────

test('pageHasUsableTypedText is the reader’s own predicate', () => {
  assert.equal(
    pageHasUsableTypedText(
      'This is a long, typed page with plenty of alphanumerics 12345 abcdef ghijkl.',
    ),
    true,
  );
  assert.equal(pageHasUsableTypedText(''), false, 'a scanned page has no layer');
  assert.equal(pageHasUsableTypedText('   '), false);
  assert.equal(
    pageHasUsableTypedText('short'),
    false,
    'under TYPED_TEXT_MIN_CHARS',
  );
  // The garbled-pdf-parse guard: 60+ chars of single letters is not text.
  assert.equal(
    pageHasUsableTypedText('a b c d e f g h i j k l m n o p q r s t u v w x y z 1 2 3 4'),
    false,
    'fewer than 5 word-like tokens',
  );
  assert.equal(
    pageHasUsableTypedText('1234567890 1234567890 1234567890 1234567890 1234567890 12345'),
    false,
    'digits are not words',
  );
});

test('censusPdfPages counts pixel pages without spending anything', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl([
    'A typed page with plenty of real words abcdefghij klmnopqr 1234567890 here.',
    '',
    '',
    'Another properly typed page, long enough and wordy enough to be accepted.',
  ]);

  const census = await censusPdfPages(Buffer.from('pdf-census'));

  assert.equal(census.totalPages, 4);
  assert.deepEqual(census.pixelPages, [2, 3], 'only the scanned pages need vision');
  assert.equal(census.degraded, false);
  assert.equal(state.visionCalls, 0, 'ZERO provider calls — the quote is free');
  assert.equal(state.tesseractCalls, 0);
});

test('censusPdfPages NEVER throws — a broken PDF degrades to a conservative quote', async () => {
  resetState();
  state.pdfParseImpl = async () => {
    throw new Error('Invalid PDF structure');
  };

  const census = await censusPdfPages(Buffer.from('pdf-broken-census'));

  assert.deepEqual(census, { totalPages: 0, pixelPages: [], degraded: true });
  assert.equal(PAGE_COUNT_UNKNOWN_PAGES, 8, 'what the estimator quotes instead');
});

test('IMAGE_CENSUS says an image is exactly one pixel page', () => {
  assert.deepEqual(IMAGE_CENSUS, {
    totalPages: 1,
    pixelPages: [1],
    degraded: false,
  });
});

test('the census and the reader agree on which pages are pixels', async () => {
  resetState();
  const pageTexts = [
    'A typed page with plenty of real words abcdefghij klmnopqr 1234567890 here.',
    '',
    'x y z', // too short → pixels
    'Yet another properly typed page with enough words to clear the threshold.',
    '',
  ];
  state.pdfParseImpl = makePdfParseImpl(pageTexts);
  state.visionImpl = async (input: any) =>
    visionResult(
      (input.pageNumbers as number[]).map((n) => ({ pageNumber: n, text: `p${n}` })),
    );

  const buf = Buffer.from('pdf-census-vs-read');
  const census = await censusPdfPages(buf);

  const svc = new OcrService();
  await svc.extractTextFromPdf(buf, { claimId: 'claim-census', attended: true });

  assert.deepEqual(
    allVisionPages(),
    census.pixelPages,
    'a quote priced against a different page set is a quote for other work',
  );
});
