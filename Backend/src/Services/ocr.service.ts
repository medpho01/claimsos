/**
 * OCR Service — Sprint 5 (Intelligence Layer).
 *
 * Foundation layer that downstream document workers use to pull text out of
 * PDFs and images CHEAPLY, before deciding whether to spend vision-LLM tokens
 * on anything. Rough cost intuition we're optimising for:
 *
 *   - Vision tokens on Claude ≈ ₹2 per 1k tokens
 *   - Text input tokens   ≈ ₹0.07 per 1k tokens
 *
 * So for any document that has a typed text layer (the vast majority of
 * insurer-issued PDFs, discharge summaries from EMR systems, etc.) we can
 * skip vision entirely. For scans we fall back to Tesseract.js (WASM, no
 * native binaries — happy in Docker). LLM vision is reserved as a last
 * resort and is *not* auto-invoked from this service — the caller opts in.
 *
 * Decision tree per page:
 *
 *   1. pdf-parse pulls the page's typed text layer.
 *   2. If text length > 50 chars AND contains alphanumerics
 *        → source = 'typed_pdf', confidence = 0.95
 *   3. Else render page → PNG (pdf-to-png-converter), run tesseract.js
 *        → source = 'tesseract', confidence = Tesseract's page conf / 100
 *   4. If tesseract confidence < opts.minConfidence (default 0.6)
 *        → still return the text, but add 'low_confidence_ocr' warning.
 *        The caller can then choose to escalate to LLM vision via its own
 *        pipeline — this service does NOT call the LLM bridge.
 *
 * Caching: input buffers are SHA-256'd and an in-memory LRU (max 100
 * entries) shortcuts repeat calls. This matters because workers often
 * retry or re-fetch the same document across stages.
 *
 * NOT in scope for v1:
 *   - LLM vision fallback execution (allowVisionFallback is currently a
 *     no-op hook — see TODO at line ~end of extractTextFromPdf)
 *   - Multi-column layout detection
 *   - Indic-script language packs (English-only Tesseract for now)
 *   - Async/batch processing across workers
 */

import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { logger } from '../Utils/logger.js';

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface OcrPage {
  pageNumber: number;
  text: string;
  confidence: number;
  source: 'typed_pdf' | 'tesseract' | 'vision_fallback';
  warnings?: string[];
}

export interface OcrResult {
  pages: OcrPage[];
  totalPages: number;
  avgConfidence: number;
  processedAtMs: number;
  fileHash: string;
  engineVersions: {
    pdftotext?: string;
    tesseract?: string;
  };
}

export interface OcrExtractOpts {
  forceEngine?: 'pdftotext' | 'tesseract';
  minConfidence?: number;
  allowVisionFallback?: boolean;
}

export class OcrParseError extends Error {
  // Node's Error supports `cause` natively since 16.9, but we declare it
  // explicitly for clarity and to make the field show up in TS intellisense.
  override cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OcrParseError';
    if (cause !== undefined) this.cause = cause;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_MIN_CONFIDENCE = 0.6;
const TYPED_TEXT_MIN_CHARS = 50;
const TYPED_TEXT_CONFIDENCE = 0.95;
const CACHE_MAX_ENTRIES = 100;
const ALPHANUMERIC_RE = /[a-zA-Z0-9]/;

// ────────────────────────────────────────────────────────────────────────────
// Lazy-loaded engines
//
// We import these dynamically so the module doesn't crash at import time if
// optional native peer deps (canvas etc.) are missing in some environment.
// Each loader memoises the imported module.
// ────────────────────────────────────────────────────────────────────────────

let _pdfParse: any = null;
let _pdfToPng: any = null;
let _tesseract: any = null;

async function loadPdfParse(): Promise<any> {
  if (!_pdfParse) {
    const mod: any = await import('pdf-parse');
    _pdfParse = mod.default ?? mod;
  }
  return _pdfParse;
}

async function loadPdfToPng(): Promise<any> {
  if (!_pdfToPng) {
    const mod: any = await import('pdf-to-png-converter');
    _pdfToPng = mod;
  }
  return _pdfToPng;
}

async function loadTesseract(): Promise<any> {
  if (!_tesseract) {
    const mod: any = await import('tesseract.js');
    _tesseract = mod;
  }
  return _tesseract;
}

// ────────────────────────────────────────────────────────────────────────────
// OcrService
// ────────────────────────────────────────────────────────────────────────────

export class OcrService {
  private cache: LRUCache<string, OcrResult>;

  constructor() {
    this.cache = new LRUCache<string, OcrResult>({ max: CACHE_MAX_ENTRIES });
  }

  /**
   * Extract text from a PDF buffer using the decision tree described in the
   * module header.
   */
  async extractTextFromPdf(buffer: Buffer, opts: OcrExtractOpts = {}): Promise<OcrResult> {
    const fileHash = this.hashBuffer(buffer);

    const cached = this.cache.get(fileHash);
    if (cached) {
      logger.debug({ fileHash }, 'OCR: cache hit');
      return cached;
    }

    const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const force = opts.forceEngine;

    // 1. Parse the PDF with pdf-parse to pull (a) page count and (b) typed
    //    text per page.
    let parsed: { numpages: number; pagesText: string[]; pdfVersion?: string };
    try {
      parsed = await this.runPdfParse(buffer);
    } catch (err: any) {
      // pdf-parse leaks encryption errors with a recognisable message —
      // surface that as a structured error so callers can route accordingly.
      const msg = String(err?.message || err);
      if (/encrypt|password/i.test(msg)) {
        throw new OcrParseError('encrypted_pdf', err);
      }
      throw new OcrParseError('corrupted_pdf', err);
    }

    if (parsed.numpages === 0) {
      const empty: OcrResult = {
        pages: [],
        totalPages: 0,
        avgConfidence: 0,
        processedAtMs: Date.now(),
        fileHash,
        engineVersions: { pdftotext: parsed.pdfVersion },
      };
      this.cache.set(fileHash, empty);
      return empty;
    }

    // 2. Per-page decision: typed text vs OCR.
    const pages: OcrPage[] = [];
    let tesseractVersion: string | undefined;

    for (let i = 0; i < parsed.numpages; i++) {
      const pageNumber = i + 1;
      const typedText = (parsed.pagesText[i] ?? '').trim();

      const hasUsableTypedText =
        force !== 'tesseract' &&
        typedText.length > TYPED_TEXT_MIN_CHARS &&
        ALPHANUMERIC_RE.test(typedText);

      if (hasUsableTypedText && force !== 'tesseract') {
        pages.push({
          pageNumber,
          text: typedText,
          confidence: TYPED_TEXT_CONFIDENCE,
          source: 'typed_pdf',
        });
        continue;
      }

      // OCR path. Render this single page to PNG, run Tesseract.
      try {
        const { text, confidence, version } = await this.ocrPage(buffer, pageNumber);
        tesseractVersion = tesseractVersion ?? version;

        const warnings: string[] = [];
        if (confidence < minConfidence) {
          warnings.push('low_confidence_ocr');
          // Hook: if the caller has opted into LLM vision fallback we'd
          // dispatch here. We deliberately do NOT call the LLM from this
          // service — see module-level rationale.
          if (opts.allowVisionFallback) {
            // TODO(intelligence-layer): wire up vision fallback via the
            // LLM bridge once the bridge contract is finalised. For now
            // we just record the intent so the caller can decide.
            warnings.push('vision_fallback_eligible');
          }
        }

        const page: OcrPage = {
          pageNumber,
          text,
          confidence,
          source: 'tesseract',
        };
        if (warnings.length > 0) page.warnings = warnings;
        pages.push(page);
      } catch (err) {
        logger.warn({ err, pageNumber, fileHash }, 'OCR: tesseract failed on page');
        pages.push({
          pageNumber,
          text: '',
          confidence: 0,
          source: 'tesseract',
          warnings: ['ocr_engine_error'],
        });
      }
    }

    const avgConfidence =
      pages.length === 0
        ? 0
        : pages.reduce((acc, p) => acc + p.confidence, 0) / pages.length;

    const result: OcrResult = {
      pages,
      totalPages: parsed.numpages,
      avgConfidence,
      processedAtMs: Date.now(),
      fileHash,
      engineVersions: {
        pdftotext: parsed.pdfVersion,
        tesseract: tesseractVersion,
      },
    };

    this.cache.set(fileHash, result);
    return result;
  }

  /**
   * Extract text from a single image (PNG/JPEG) — straight Tesseract run.
   * Returns one OcrPage with pageNumber=1 so callers can treat images and
   * single-page PDFs uniformly.
   */
  async extractTextFromImage(buffer: Buffer): Promise<OcrPage> {
    try {
      const tesseract = await loadTesseract();
      const result: any = await tesseract.recognize(buffer, 'eng');
      const data = result?.data ?? {};
      const text: string = data.text ?? '';
      // Tesseract reports confidence on a 0-100 scale.
      const confidence: number =
        typeof data.confidence === 'number' ? data.confidence / 100 : 0;

      return {
        pageNumber: 1,
        text,
        confidence,
        source: 'tesseract',
      };
    } catch (err) {
      throw new OcrParseError('image_ocr_failed', err);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  private hashBuffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Wrap pdf-parse with a pagerender hook so we can grab per-page text
   * cleanly. pdf-parse otherwise concatenates everything into one blob.
   */
  private async runPdfParse(buffer: Buffer): Promise<{
    numpages: number;
    pagesText: string[];
    pdfVersion?: string;
  }> {
    const pdfParse = await loadPdfParse();
    const pagesText: string[] = [];

    const pagerender = async (pageData: any): Promise<string> => {
      // Mirrors pdf-parse's default pagerender, but stashes the rendered
      // text into our per-page array.
      const content = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      let last = -1;
      let text = '';
      for (const item of content.items) {
        if (last !== -1 && last !== item.transform[5]) text += '\n';
        text += item.str;
        last = item.transform[5];
      }
      pagesText.push(text);
      return text;
    };

    const data = await pdfParse(buffer, { pagerender });
    return {
      numpages: data.numpages ?? 0,
      pagesText,
      pdfVersion: data.version,
    };
  }

  /**
   * Render a single PDF page to PNG and run Tesseract on it.
   */
  private async ocrPage(
    buffer: Buffer,
    pageNumber: number
  ): Promise<{ text: string; confidence: number; version?: string }> {
    const { pdfToPng } = await loadPdfToPng();
    const tesseract = await loadTesseract();

    const pngs: Array<{ content: Buffer }> = await pdfToPng(buffer, {
      pagesToProcess: [pageNumber],
      viewportScale: 2.0,
    });
    const png = pngs?.[0]?.content;
    if (!png) {
      throw new OcrParseError('pdf_render_failed');
    }

    const recognised: any = await tesseract.recognize(png, 'eng');
    const data = recognised?.data ?? {};
    const text: string = data.text ?? '';
    const confidence: number =
      typeof data.confidence === 'number' ? data.confidence / 100 : 0;

    return { text, confidence, version: recognised?.version };
  }
}

export default new OcrService();
