/**
 * Unit tests for OcrService.
 *
 * Uses Node's built-in `node:test` runner (no Jest/Vitest in this repo yet
 * — the root package.json's "test" script is a stub). Run with:
 *
 *   npx tsx --test src/Services/__tests__/ocr.service.test.ts
 *
 * We dynamically inject mocks for pdf-parse, pdf-to-png-converter and
 * tesseract.js by stubbing Node's module resolution before importing the
 * service. This keeps the tests offline and avoids pulling in the real
 * OCR engines.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Module } from 'node:module';

// ────────────────────────────────────────────────────────────────────────────
// Module mocks
// ────────────────────────────────────────────────────────────────────────────

interface MockState {
  pdfParseCalls: number;
  pdfToPngCalls: number;
  tesseractCalls: number;

  // Per-test injected responses
  pdfParseImpl: (buf: Buffer, opts?: any) => Promise<any>;
  pdfToPngImpl: (buf: Buffer, opts?: any) => Promise<Array<{ content: Buffer }>>;
  tesseractImpl: (input: any, lang: string) => Promise<any>;
}

const state: MockState = {
  pdfParseCalls: 0,
  pdfToPngCalls: 0,
  tesseractCalls: 0,
  pdfParseImpl: async () => ({ numpages: 0, text: '', version: '1.10.100' }),
  pdfToPngImpl: async () => [{ content: Buffer.from('png') }],
  tesseractImpl: async () => ({ data: { text: '', confidence: 0 } }),
};

function resetState() {
  state.pdfParseCalls = 0;
  state.pdfToPngCalls = 0;
  state.tesseractCalls = 0;
}

// Patch the module resolver so dynamic imports of the OCR engine packages
// return our in-process stubs.
const origResolve = (Module as any)._resolveFilename;
const origLoad = (Module as any)._load;

const MOCK_PREFIX = '__ocr_mock__:';

(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  ...rest: any[]
) {
  if (
    request === 'pdf-parse' ||
    request === 'pdf-to-png-converter' ||
    request === 'tesseract.js'
  ) {
    return MOCK_PREFIX + request;
  }
  return origResolve.call(this, request, parent, ...rest);
};

(Module as any)._load = function (request: string, parent: any, ...rest: any[]) {
  if (request.startsWith(MOCK_PREFIX)) {
    const name = request.slice(MOCK_PREFIX.length);
    if (name === 'pdf-parse') {
      const fn = async (buf: Buffer, opts?: any) => {
        state.pdfParseCalls++;
        return state.pdfParseImpl(buf, opts);
      };
      return { default: fn, __esModule: true };
    }
    if (name === 'pdf-to-png-converter') {
      return {
        pdfToPng: async (buf: Buffer, opts?: any) => {
          state.pdfToPngCalls++;
          return state.pdfToPngImpl(buf, opts);
        },
        __esModule: true,
      };
    }
    if (name === 'tesseract.js') {
      return {
        recognize: async (input: any, lang: string) => {
          state.tesseractCalls++;
          return state.tesseractImpl(input, lang);
        },
        __esModule: true,
      };
    }
  }
  return origLoad.call(this, request, parent, ...rest);
};

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

// ────────────────────────────────────────────────────────────────────────────
// Now import the service (after mocks are in place)
// ────────────────────────────────────────────────────────────────────────────

const { OcrService, OcrParseError } = await import('../ocr.service.js');

// ────────────────────────────────────────────────────────────────────────────
// Tests
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
});

test('scanned PDF (no typed text) → falls back to Tesseract', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(['']); // empty text layer = scanned
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
  assert.equal(result.pages[0].warnings, undefined, 'high confidence → no warning');
});

test('low confidence Tesseract → adds low_confidence_ocr warning', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(['']);
  state.tesseractImpl = async () => ({
    data: { text: 'blurry text', confidence: 40 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-blurry'));

  assert.equal(result.pages[0].source, 'tesseract');
  assert.deepEqual(result.pages[0].warnings, ['low_confidence_ocr']);
});

test('low confidence + allowVisionFallback → adds vision_fallback_eligible (no LLM call)', async () => {
  resetState();
  state.pdfParseImpl = makePdfParseImpl(['']);
  state.tesseractImpl = async () => ({
    data: { text: 'blurry', confidence: 30 },
  });

  const svc = new OcrService();
  const result = await svc.extractTextFromPdf(Buffer.from('pdf-blurry-fallback'), {
    allowVisionFallback: true,
  });

  assert.ok(result.pages[0].warnings?.includes('low_confidence_ocr'));
  assert.ok(result.pages[0].warnings?.includes('vision_fallback_eligible'));
});

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
});

test('extractTextFromImage → single OcrPage from Tesseract', async () => {
  resetState();
  state.tesseractImpl = async () => ({
    data: { text: 'image text', confidence: 92 },
  });

  const svc = new OcrService();
  const page = await svc.extractTextFromImage(Buffer.from('jpeg-bytes'));

  assert.equal(page.pageNumber, 1);
  assert.equal(page.source, 'tesseract');
  assert.equal(page.text, 'image text');
  assert.equal(page.confidence, 0.92);
  assert.equal(state.pdfParseCalls, 0);
});

test('mixed PDF: page 1 typed, page 2 scanned → both branches', async () => {
  resetState();
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
});
