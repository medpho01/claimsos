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
import sharp from 'sharp';
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
// Garbled-pdf-parse guard (May 20, 2026):
//   pdf-parse can pull "text" out of a rotated/embedded-image PDF that
//   passes a naive alphanumeric test but is actually meaningless glyph-
//   mapped characters. The MGM imaging reports in Qamruddin's claim were
//   slipping through with 0.95 confidence as 'typed_pdf' even though
//   pdf-parse returned a stream of single-letter fragments and no
//   coherent words. Result: bundle classifier saw 'consent'-like
//   gibberish and mis-categorised the pages.
//
// New test: count tokens of ≥3 consecutive A-Z/a-z letters (language-
// agnostic — works for English imaging-report headings like "FINDINGS",
// "IMPRESSION", "Patient" without depending on a Hindi dictionary).
// pdf-parse on a rotated page typically produces zero such tokens.
const TYPED_TEXT_MIN_WORDS = 5;          // require at least 5 real words
const WORDLIKE_RE = /[a-zA-Z]{3,}/g;       // 3+ consecutive Latin letters = a word
const CACHE_MAX_ENTRIES = 100;
const ALPHANUMERIC_RE = /[a-zA-Z0-9]/;

// Rotation auto-detection threshold. Iterated twice on May 20, 2026:
//
//   v1 (failed):  conf ≥ 0.55 OR alnum ≥ 80  → fast path.
//                 Rotated MGM imaging pages had alnum=200+ from
//                 single-letter Tesseract noise. Fast-pathed despite
//                 confidence=0.28.
//   v2 (failed):  conf ≥ 0.55 OR wordlike ≥ 10  → fast path.
//                 Even gibberish like "y HH aN Hid Seif BHF" produces
//                 20-28 tokens of 3+ consecutive letters, so the wordlike
//                 gate didn't distinguish either.
//   v3 (this):    conf ≥ 0.55 alone is the gate. Tesseract's confidence
//                 is the only honest signal here — when it reports 0.28
//                 the page IS unreadable, regardless of how many spurious
//                 letter sequences it spat out. The score-based
//                 comparison at the end of the rotation loop still
//                 protects "correctly oriented but noisy" pages: a 90°
//                 rotation of those will produce equal-or-worse
//                 confidence, so the baseline keeps its spot.
//
// Cost note: ~3 extra Tesseract passes per page that falls below 0.55.
// Tesseract.js is CPU-only, no LLM tokens. On Qamruddin's 14-page PDF,
// 13 pages would re-OCR, adding ~80s. Worth it — those pages were
// previously fed to Sonnet as unreadable junk.
//
// The wordlike regex is still kept for the post-rotation SCORE
// calculation, where it discriminates real text from noise effectively
// when comparing multiple rotation candidates against each other.
const ROTATION_GOOD_ENOUGH = 0.55;
const ROTATION_WORDLIKE_RE = /[a-zA-Z]{3,}/g;

// Vision-LLM fallback threshold (added 2026-05-22).
//
// Tesseract collapses on:
//   - Handwritten consent forms (e.g. Anuj's MPMC reg "21274" missed)
//   - Stamps / signatures (e.g. Shabana's doctor reg "68274" missed)
//   - Pre-printed forms with handwritten field values (age "14" / "M")
//   - Hindi/Devanagari script
//   - Photo overlays (GPS Map Camera timestamps, ward numbers)
//
// When both the baseline pass AND the rotation re-OCR fail to clear this
// threshold, AND the caller hasn't opted out, we re-OCR the image with
// Claude Sonnet vision. Threshold sits BELOW ROTATION_GOOD_ENOUGH so the
// rotation path still gets first crack at the "merely rotated, otherwise
// legible" case — free CPU is preferable to paid vision tokens.
const VISION_FALLBACK_THRESHOLD = 0.55;
const VISION_FALLBACK_MODEL = 'claude-sonnet-4-5';
// USD per million tokens. Duplicated from
// Services/llm/providers/claudeClient.ts to avoid an import cycle
// (ocr.service is consumed by docSegmenter which is consumed by the LLM
// bridge in some test paths).
const VISION_FALLBACK_USD_PER_M_INPUT = 3;
const VISION_FALLBACK_USD_PER_M_OUTPUT = 15;
const VISION_FALLBACK_USD_TO_INR = 83;
const VISION_FALLBACK_PROMPT_VERSION = 'ocr-vision-v1';
// Vision OCR system prompt. Kept terse: we want a transcription, NOT
// model reasoning or commentary. Markdown formatting is explicitly
// banned because downstream OCR consumers (bundle classifier,
// harmoniser) match against plain-text regexes — markdown asterisks and
// pipes would corrupt those matches.
const VISION_FALLBACK_SYSTEM_PROMPT = [
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
  'Output JUST the transcribed text. NO commentary, NO markdown',
  "formatting, NO \"Here's the transcription:\" prefix.",
].join('\n');

// OSD (Orientation and Script Detection) — Tesseract's built-in one-shot
// orientation probe. Added May 20, 2026 as a fast pre-check before the
// 3-rotation brute-force loop. A single OSD call costs ~200-600ms vs the
// brute-force loop's ~6s × 3 rotations.
//
// Threshold (2.0) is Tesseract's documented sanity floor for OSD
// confidence — it's NOT a 0-1 scale, it's a script-margin metric. Below
// 2.0 the orientation guess is unreliable; above 2.0 it's typically
// correct. We fall through to the existing brute-force loop whenever OSD
// declines (null result) or is below threshold, so the worst case is
// "OSD pre-check adds ~500ms then brute-force runs as before".
//
// Empirical note for tesseract.js v5.1.1 (LSTM-only core, eng+osd
// traineddata): OSD confidence values observed on Qamruddin's PDF range
// from 0.03 (sparse-text rotated page) to 5.6 (full-text correctly-
// oriented page). The 2.0 floor is conservative — it deliberately
// errs toward the brute-force loop. We can lower it later once we
// have more validation data.
const OSD_CONFIDENCE_MIN = 2.0;

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
let _sharp: any = null;

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
    // tesseract.js exposes `.recognize` on its default export under ESM.
    // Fall back to the namespace itself for CJS-shim cases.
    _tesseract = mod?.default ?? mod;
  }
  return _tesseract;
}

async function loadSharp(): Promise<any> {
  if (!_sharp) {
    const mod: any = await import('sharp');
    _sharp = mod?.default ?? mod;
  }
  return _sharp;
}

// ────────────────────────────────────────────────────────────────────────────
// Vision-fallback helpers (module-scope, no instance state needed)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Sniff image MIME type from magic bytes. Anthropic's image content
 * block requires the media_type to match the actual bytes; mismatches
 * return HTTP 400. We support JPEG / PNG / WEBP / GIF — the set
 * Anthropic accepts. Anything else falls back to image/jpeg (Anthropic's
 * most permissive decoder), which is the lesser evil vs throwing.
 */
function detectImageMediaType(
  buf: Buffer
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return 'image/gif';
  }
  return 'image/jpeg';
}

/**
 * Remove a leading ```...``` fence wrapper if the vision model emitted
 * one despite the "no markdown" instruction. We ONLY strip a fence that
 * wraps the whole response — if the model uses a fence inside a longer
 * answer we leave it alone. Trailing fence is also removed when matched.
 */
function stripLeadingFence(s: string): string {
  const trimmed = s.trim();
  // Match ```optional_language\n ... \n```
  const m = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```\s*$/);
  if (m && m[1] !== undefined) return m[1];
  return s;
}

// Lazy-loaded OSD worker. tesseract.js's `worker.detect()` requires the
// legacy/combined core (LSTM-only doesn't ship the OSD components), so we
// construct this worker with OEM.TESSERACT_LSTM_COMBINED + legacyCore:true.
// Worker init is heavy (~2s) so we memoise it across calls and pages.
// Returns null if init fails — callers must treat detect-availability as
// optional and fall back to the brute-force rotation loop.
let _osdWorker: any = null;
let _osdWorkerInit: Promise<any> | null = null;
let _osdWorkerUnavailable = false;

async function loadOsdWorker(): Promise<any | null> {
  if (_osdWorkerUnavailable) return null;
  if (_osdWorker) return _osdWorker;
  if (_osdWorkerInit) return _osdWorkerInit;

  _osdWorkerInit = (async () => {
    try {
      const tesseract: any = await import('tesseract.js');
      const tesseractNs = tesseract?.default ?? tesseract;
      const createWorker = tesseractNs.createWorker;
      const OEM = tesseractNs.OEM;
      if (typeof createWorker !== 'function' || !OEM) {
        _osdWorkerUnavailable = true;
        return null;
      }
      // legacyCore:true tells tesseract.js to load the combined wasm
      // (tesseract-core.wasm) rather than the lstm-only build, which is
      // required for the DetectOS path that backs worker.detect().
      const worker = await createWorker('eng', OEM.TESSERACT_LSTM_COMBINED, {
        legacyCore: true,
      });
      _osdWorker = worker;
      return worker;
    } catch (err) {
      logger.warn(
        { err: (err as any)?.message ?? String(err) },
        'OCR: OSD worker init failed — orientation pre-check disabled, brute-force rotation loop will handle bad orientations',
      );
      _osdWorkerUnavailable = true;
      return null;
    } finally {
      _osdWorkerInit = null;
    }
  })();

  return _osdWorkerInit;
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

    // Banner log so we can confirm OCR is being invoked and which buffer
    // it's working on. Promoted to info May 20, 2026 while debugging the
    // rotation-detection deployment that mysteriously produced no logs.
    logger.info(
      { file_hash_8: fileHash.slice(0, 8), bytes: buffer.length, opts },
      'OCR: extractTextFromPdf entered',
    );

    const cached = this.cache.get(fileHash);
    if (cached) {
      logger.info(
        { file_hash_8: fileHash.slice(0, 8), cached_pages: cached.pages.length },
        'OCR: cache HIT — serving previous result without re-OCR',
      );
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

      // Count word-like tokens (3+ consecutive Latin letters). For Hindi-
      // only pages this will return 0 — that's fine, we fall through to
      // Tesseract which handles Devanagari well via the eng+hin trained
      // data. For garbled pdf-parse output of rotated pages this also
      // returns ~0, correctly triggering OCR fallback.
      const wordlikeTokens = (typedText.match(WORDLIKE_RE) ?? []).length;
      const hasUsableTypedText =
        force !== 'tesseract' &&
        typedText.length > TYPED_TEXT_MIN_CHARS &&
        ALPHANUMERIC_RE.test(typedText) &&
        wordlikeTokens >= TYPED_TEXT_MIN_WORDS;

      if (!hasUsableTypedText && typedText.length > 0) {
        logger.info(
          {
            pageNumber,
            typed_chars: typedText.length,
            wordlike_tokens: wordlikeTokens,
            threshold: TYPED_TEXT_MIN_WORDS,
            sample: typedText.slice(0, 120),
          },
          'OCR: pdf-parse text rejected (low word density) — falling through to Tesseract',
        );
      } else if (hasUsableTypedText) {
        logger.info(
          {
            pageNumber,
            typed_chars: typedText.length,
            wordlike_tokens: wordlikeTokens,
          },
          'OCR: pdf-parse text accepted (typed_pdf source)',
        );
      }

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
   * Extract text from a single image (PNG/JPEG).
   *
   * Indian hospital uploads are routinely rotated 90/180/270° — phones
   * scan in portrait, the original is landscape, and EXIF orientation
   * tags are stripped by the upload pipeline. Tesseract has no native
   * auto-rotate, so OCR on a rotated image returns 1-3% confidence and
   * unreadable garbage. Documented case: a rotated Aadhaar produced
   * confidence=0.01 even though the card text is perfectly legible
   * once you tilt your head.
   *
   * Strategy (brute-force, ~free to compute):
   *   1. Run OCR on the image as-is.
   *   2. If confidence is solid (≥ROTATION_GOOD_ENOUGH) OR the text has
   *      a healthy alphanumeric character count, accept and return.
   *   3. Otherwise rotate by 90°, 180°, 270° via sharp and OCR each.
   *   4. Return whichever orientation produced the best score (highest
   *      confidence × alphanumeric-char-count). Stamp a warning so the
   *      caller / audit log knows we auto-rotated.
   *
   * Cost: 3 extra Tesseract passes only when the baseline is bad.
   * Tesseract.js is CPU-only (no LLM tokens). Latency adds ~3-6s in the
   * pathological case; baseline-good images pay nothing extra.
   */
  async extractTextFromImage(
    buffer: Buffer,
    opts: OcrExtractOpts = {}
  ): Promise<OcrPage> {
    try {
      const baseline = await this.runImageOcrOnce(buffer);

      // Confidence is the only honest signal for "should we rotate".
      // Wordlike count + alnum count both get false-positive'd by
      // rotated-scan noise from Tesseract.
      const baselineWordlike =
        (baseline.text.match(ROTATION_WORDLIKE_RE) ?? []).length;

      logger.info(
        {
          baseline_conf: Number(baseline.confidence.toFixed(3)),
          baseline_wordlike: baselineWordlike,
        },
        'OCR: image baseline pass',
      );

      if (baseline.confidence >= ROTATION_GOOD_ENOUGH) {
        return baseline;
      }

      logger.info(
        {
          baseline_conf: baseline.confidence,
          baseline_wordlike: baselineWordlike,
        },
        'OCR: image baseline confidence low — attempting rotated re-OCR',
      );

      const sharp = await loadSharp();
      const rotations = [90, 180, 270] as const;
      // Score uses WORDLIKE count, not raw alnum — single-letter noise from
      // a rotated scan was the original bug (cf. Qamruddin pp.5-8, May 20).
      const baselineScore =
        baseline.confidence * (1 + baselineWordlike / 5);
      let best: { angle: number; page: OcrPage; score: number } = {
        angle: 0,
        page: baseline,
        score: baselineScore,
      };

      // OSD pre-check: same fast-path idea as ocrPage(). One ~500ms call
      // tells us if the image is rotated and which way. If confidence
      // clears the sanity floor we try only that single rotation; if it
      // beats the baseline score we skip the brute-force loop entirely.
      // On null / low-confidence OSD we fall through to the existing
      // 3-rotation sweep — same behaviour as before this commit.
      const osd = await this.detectOrientationViaOSD(buffer);
      if (osd) {
        logger.info(
          {
            osd_degrees: osd.degrees,
            osd_confidence: Number(osd.confidence.toFixed(3)),
            osd_threshold: OSD_CONFIDENCE_MIN,
          },
          'OCR: image OSD pre-check result',
        );
      }
      // Short-circuit when OSD confidently says the image is upright —
      // baseline is the best Tesseract will produce; rotating only makes
      // it worse. We still need to consider the vision fallback though:
      // a handwriting-heavy form (Anuj's consent) is upright AND
      // unreadable to Tesseract, and that's exactly what vision is for.
      if (osd && osd.degrees === 0 && osd.confidence >= OSD_CONFIDENCE_MIN) {
        logger.info(
          {
            baseline_conf: Number(baseline.confidence.toFixed(3)),
            osd_conf: Number(osd.confidence.toFixed(3)),
          },
          'OCR: image baseline kept (OSD confirms upright; skipping brute-force loop)',
        );
        const upright: OcrPage = {
          ...baseline,
          warnings: [
            ...(baseline.warnings ?? []),
            'low_confidence_after_osd_upright',
          ],
        };
        return this.maybeEscalateToVision(buffer, upright, opts);
      }
      if (osd && osd.confidence >= OSD_CONFIDENCE_MIN && osd.degrees !== 0) {
        try {
          const rotated = await sharp(buffer).rotate(osd.degrees).toBuffer();
          const candidate = await this.runImageOcrOnce(rotated);
          const candidateWordlike =
            (candidate.text.match(ROTATION_WORDLIKE_RE) ?? []).length;
          const candidateScore =
            candidate.confidence * (1 + candidateWordlike / 5);
          if (candidateScore > best.score) {
            logger.info(
              {
                baseline_conf: baseline.confidence,
                osd_angle: osd.degrees,
                osd_conf: Number(osd.confidence.toFixed(3)),
                rotated_conf: candidate.confidence,
                rotated_score: Number(candidateScore.toFixed(3)),
              },
              'OCR: image recovered via OSD pre-check (skipped brute-force loop)',
            );
            return {
              ...candidate,
              warnings: [
                ...(candidate.warnings ?? []),
                `osd_rotated_${osd.degrees}deg`,
              ],
            };
          }
          // OSD picked the wrong angle (or right angle that scored worse)
          // — seed best so we don't redo it in the brute-force loop.
          best = { angle: osd.degrees, page: candidate, score: candidateScore };
        } catch (osdRotateErr) {
          logger.warn(
            {
              angle: osd.degrees,
              err: (osdRotateErr as any)?.message ?? String(osdRotateErr),
            },
            'OCR: image OSD-suggested rotation failed; continuing with brute-force loop',
          );
        }
      }

      for (const angle of rotations) {
        // Skip angles already evaluated via the OSD pre-check above.
        if (best.angle === angle && best.page !== baseline) continue;
        try {
          // sharp keeps stripping EXIF — `.rotate(angle)` here means a
          // pure pixel rotation, not "respect EXIF orientation".
          const rotated = await sharp(buffer).rotate(angle).toBuffer();
          const page = await this.runImageOcrOnce(rotated);
          const wordlike =
            (page.text.match(ROTATION_WORDLIKE_RE) ?? []).length;
          // Higher score = more real words at higher confidence. A
          // rotated 90° pass that produces "FINDINGS IMPRESSION PATIENT"
          // beats a baseline that produced 200 chars of single-letter
          // junk.
          const score = page.confidence * (1 + wordlike / 5);
          if (score > best.score) {
            best = { angle, page, score };
          }
        } catch (rotateErr) {
          // sharp can fail on corrupted/non-image buffers; log and move on
          // — we already have the baseline as a safe fallback.
          logger.warn(
            { angle, err: (rotateErr as any)?.message ?? String(rotateErr) },
            'OCR: rotation attempt failed; skipping',
          );
        }
      }

      // Settle on the best Tesseract candidate (baseline vs rotation).
      const tesseractBest: OcrPage =
        best.angle === 0
          ? {
              ...baseline,
              warnings: [
                ...(baseline.warnings ?? []),
                'low_confidence_after_rotation_scan',
              ],
            }
          : {
              ...best.page,
              warnings: [
                ...(best.page.warnings ?? []),
                `auto_rotated_${best.angle}deg`,
              ],
            };

      return this.maybeEscalateToVision(buffer, tesseractBest, opts);
    } catch (err) {
      throw new OcrParseError('image_ocr_failed', err);
    }
  }

  /**
   * Decide whether to escalate from a low-confidence Tesseract result to
   * the Claude vision fallback. Three gates:
   *   1. Tesseract confidence < VISION_FALLBACK_THRESHOLD
   *   2. Caller hasn't opted out via opts.allowVisionFallback = false
   *   3. Env kill-switch OCR_VISION_FALLBACK_DISABLED !== 'true'
   * If any gate fails, return the Tesseract result unchanged. If vision
   * succeeds, return the vision result with merged warnings. If vision
   * fails (provider error, rate-limit, etc.), return the Tesseract
   * result with a 'vision_fallback_failed' warning.
   */
  private async maybeEscalateToVision(
    buffer: Buffer,
    tesseractBest: OcrPage,
    opts: OcrExtractOpts
  ): Promise<OcrPage> {
    const visionAllowed =
      (opts.allowVisionFallback ?? true) &&
      process.env.OCR_VISION_FALLBACK_DISABLED !== 'true';

    if (!visionAllowed || tesseractBest.confidence >= VISION_FALLBACK_THRESHOLD) {
      return tesseractBest;
    }

    logger.info(
      {
        tesseract_best_conf: Number(tesseractBest.confidence.toFixed(3)),
        threshold: VISION_FALLBACK_THRESHOLD,
      },
      'OCR: image below threshold — escalating to vision fallback',
    );
    try {
      const vision = await this.ocrViaVision(buffer);
      return {
        ...vision,
        warnings: [
          ...(tesseractBest.warnings ?? []),
          ...(vision.warnings ?? []),
        ],
      };
    } catch (visionErr) {
      logger.warn(
        { err: (visionErr as any)?.message ?? String(visionErr) },
        'OCR: vision fallback failed — returning best Tesseract result',
      );
      return {
        ...tesseractBest,
        warnings: [
          ...(tesseractBest.warnings ?? []),
          'vision_fallback_failed',
        ],
      };
    }
  }

  /**
   * Vision-LLM fallback. One Claude Sonnet vision call with the image as
   * a base64 content block; the model is instructed to transcribe text
   * only (no commentary, no markdown). Used by extractTextFromImage when
   * Tesseract + rotation re-OCR both fail to clear
   * VISION_FALLBACK_THRESHOLD.
   *
   * Cost: a typical 1-page hospital form image (~2-4MP) runs ~1500-2500
   * vision input tokens + ~300-800 output tokens = ~₹0.50-1.20 per call
   * at Sonnet 4.5 rates. The per-claim guardrail (CLAIM_HARD_LIMIT_INR
   * = ₹15) is the macro safety net; this service does NOT check the
   * budget itself because OCR runs upstream of any claim_id binding.
   *
   * Cost is recorded to hospital.llm_cost_log via costAccounting.recordCall
   * with task='ocr_vision_fallback' and no claim_id. Logging failures are
   * swallowed — the OCR result is too valuable to discard over an audit
   * insert hiccup.
   */
  private async ocrViaVision(buffer: Buffer): Promise<OcrPage> {
    const started = Date.now();

    // Lazy imports — keep ocr.service light when vision is disabled and
    // avoid a static import cycle with costAccounting.
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const costAccounting = (await import('./costAccounting.service.js')).default;

    // Detect media type from the magic bytes. Anthropic's image block
    // requires the correct media_type; sending image/png for a JPEG
    // returns HTTP 400. Sniff rather than trust the caller — the buffer
    // may be a rotated sharp re-encode.
    const mediaType = detectImageMediaType(buffer);

    const client = new Anthropic();
    const b64 = buffer.toString('base64');

    let response: any;
    try {
      response = await client.messages.create({
        model: VISION_FALLBACK_MODEL,
        max_tokens: 4096,
        system: VISION_FALLBACK_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: b64,
                },
              },
              {
                type: 'text',
                text: 'Transcribe this image.',
              },
            ],
          },
        ],
      });
    } catch (err) {
      logger.error(
        { err: (err as any)?.message ?? String(err) },
        'OCR: vision fallback provider call failed',
      );
      throw err;
    }

    const latencyMs = Date.now() - started;

    const rawText: string = Array.isArray(response?.content)
      ? response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
      : '';

    // Strip a leading markdown code-fence if the model defied the
    // "no markdown" instruction (Sonnet usually obeys but older
    // snapshots have wrapped responses in ```text fences). We leave
    // any OTHER markdown intact — the bundle classifier tolerates
    // stray asterisks but a fenced wrapper distorts the regex on the
    // very first line.
    const text = stripLeadingFence(rawText).trim();

    const tokensIn = Number(response?.usage?.input_tokens ?? 0);
    const tokensOut = Number(response?.usage?.output_tokens ?? 0);
    const usd =
      (tokensIn * VISION_FALLBACK_USD_PER_M_INPUT +
        tokensOut * VISION_FALLBACK_USD_PER_M_OUTPUT) /
      1_000_000;
    const costInr =
      Math.round(usd * VISION_FALLBACK_USD_TO_INR * 10000) / 10000;

    // Best-effort cost log. Never blocks the OCR pipeline.
    try {
      await costAccounting.recordCall({
        claimId: null,
        hospitalId: null,
        task: 'ocr_vision_fallback',
        provider: 'anthropic',
        model: response?.model ?? VISION_FALLBACK_MODEL,
        promptVersion: VISION_FALLBACK_PROMPT_VERSION,
        tokensInputUncached: tokensIn,
        tokensInputCached: 0,
        tokensOutput: tokensOut,
        latencyMs,
        costInr,
        succeeded: true,
      });
    } catch (logErr) {
      logger.warn(
        { err: (logErr as any)?.message ?? String(logErr) },
        'OCR: vision fallback cost log failed (continuing)',
      );
    }

    logger.info(
      {
        latency_ms: latencyMs,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_inr: costInr,
        text_len: text.length,
        media_type: mediaType,
      },
      'OCR: vision fallback succeeded',
    );

    // Confidence is a fixed-ish value. The model returned a transcription
    // so we trust it more than a sub-0.55 Tesseract result, but not as
    // much as a clean typed PDF (0.95). 0.85 lets downstream consumers
    // that gate on confidence still distinguish "vision-recovered" from
    // "machine-printed gold".
    return {
      pageNumber: 1,
      text,
      confidence: 0.85,
      source: 'vision_fallback',
      warnings: ['used_vision_fallback'],
    };
  }

  /**
   * Cheap orientation pre-check via Tesseract's OSD (Orientation and Script
   * Detection). One call returns {orientation_degrees, orientation_confidence}
   * in ~200-600ms — much faster than the brute-force 3-rotation re-OCR loop
   * (~6s × 3). Returns null when OSD declines (sparse pages where it can't
   * decide) or when the worker isn't available. Callers MUST treat a null
   * return as "no signal" and fall through to the brute-force loop.
   *
   * The returned confidence is on Tesseract's internal scale (NOT 0-1) —
   * compare against OSD_CONFIDENCE_MIN to decide whether to trust it.
   */
  private async detectOrientationViaOSD(
    buffer: Buffer
  ): Promise<{ degrees: number; confidence: number } | null> {
    const worker = await loadOsdWorker();
    if (!worker) return null;
    try {
      const { data } = await worker.detect(buffer);
      const deg = typeof data?.orientation_degrees === 'number'
        ? data.orientation_degrees
        : null;
      const conf = typeof data?.orientation_confidence === 'number'
        ? data.orientation_confidence
        : null;
      if (deg === null || conf === null) return null;
      return { degrees: deg, confidence: conf };
    } catch (err) {
      logger.warn(
        { err: (err as any)?.message ?? String(err) },
        'OCR: OSD detect call failed — falling back to brute-force rotation',
      );
      return null;
    }
  }

  /** Single Tesseract pass. Used by extractTextFromImage for both the
   *  baseline call and each rotation candidate. */
  private async runImageOcrOnce(buffer: Buffer): Promise<OcrPage> {
    const preprocessed = await this.preprocessImageForOcr(buffer);
    const tesseract = await loadTesseract();
    const result: any = await tesseract.recognize(preprocessed, 'eng');
    const data = result?.data ?? {};
    const text: string = data.text ?? '';
    const confidence: number =
      typeof data.confidence === 'number' ? data.confidence / 100 : 0;
    return {
      pageNumber: 1,
      text,
      confidence,
      source: 'tesseract',
    };
  }

  /**
   * Preprocess an image buffer to improve Tesseract OCR accuracy.
   *
   * Pipeline (each step is best-effort; on failure we fall back to the
   * previous good buffer so a preprocessing error never kills OCR):
   *   1. EXIF auto-orient (cheap; prevents 90/180 rotation mis-reads)
   *   2. Upscale to 1800px wide if input width < 1500px (lanczos3) —
   *      Tesseract's classifier struggles with low-DPI phone photos.
   *   3. Grayscale (Tesseract is grayscale internally anyway).
   *   4. Normalise (auto-levels) — recovers faded ink / uneven lighting.
   *   5. Light sharpen (sigma 0.8) — counteracts upscale blur.
   *
   * Output is JPEG q=90 to keep downstream hashing/transport cheap.
   * Disabled when env OCR_PREPROCESS_DISABLED=true.
   */
  private async preprocessImageForOcr(buffer: Buffer): Promise<Buffer> {
    if (process.env.OCR_PREPROCESS_DISABLED === 'true') return buffer;

    let working: Buffer = buffer;
    let origWidth: number | undefined;
    let origHeight: number | undefined;
    let finalWidth: number | undefined;
    let finalHeight: number | undefined;

    // Step 0: read metadata (used for the upscale decision + the debug log).
    try {
      const meta = await sharp(buffer).metadata();
      origWidth = meta.width;
      origHeight = meta.height;
    } catch (err) {
      logger.debug?.({ err }, 'OCR preprocess: metadata read failed, returning original');
      return buffer;
    }

    // Step 1: auto-orient via EXIF.
    try {
      working = await sharp(working).rotate().toBuffer();
    } catch (err) {
      logger.debug?.({ err }, 'OCR preprocess: EXIF rotate failed, continuing');
    }

    // Step 2: upscale if small.
    try {
      const needsUpscale =
        typeof origWidth === 'number' && origWidth > 0 && origWidth < 1500;
      if (needsUpscale) {
        working = await sharp(working)
          .resize({
            width: 1800,
            withoutEnlargement: false,
            kernel: 'lanczos3',
          })
          .toBuffer();
      }
    } catch (err) {
      logger.debug?.({ err }, 'OCR preprocess: upscale failed, continuing');
    }

    // Steps 3-5: grayscale -> normalise -> sharpen -> JPEG encode.
    // These chain inside one sharp pipeline so we only re-encode once.
    try {
      const out = await sharp(working)
        .grayscale()
        .normalise()
        .sharpen({ sigma: 0.8 })
        .jpeg({ quality: 90 })
        .toBuffer();
      working = out;
    } catch (err) {
      logger.debug?.({ err }, 'OCR preprocess: grayscale/normalise/sharpen failed, continuing');
    }

    // Read final dims for the debug log (best-effort, single log per call).
    try {
      const finalMeta = await sharp(working).metadata();
      finalWidth = finalMeta.width;
      finalHeight = finalMeta.height;
    } catch {
      /* ignore — debug log only */
    }

    logger.debug?.(
      {
        origWidth,
        origHeight,
        finalWidth,
        finalHeight,
        origBytes: buffer.length,
        finalBytes: working.length,
      },
      'OCR preprocess: image dimensions before/after',
    );

    return working;
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
   * Render a single PDF page to PNG and run Tesseract on it. Includes
   * rotation auto-detection (May 20, 2026): when the baseline Tesseract
   * pass returns low confidence OR sparse text, we re-OCR at 90/180/270
   * rotations and keep the best result. Critical for PDFs containing
   * scanned imaging reports (MRI/CT) that frequently come in 90°-rotated
   * — without this, the OCR text is garbled and downstream classifier
   * mis-categorises them as 'consent' or 'others'.
   *
   * Mirrors the rotation logic in extractTextFromImage() — same constants,
   * same scoring (confidence × alphanumeric density).
   */
  private async ocrPage(
    buffer: Buffer,
    pageNumber: number
  ): Promise<{ text: string; confidence: number; version?: string; warnings?: string[] }> {
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

    // Baseline Tesseract pass.
    const runOnce = async (img: Buffer) => {
      const recognised: any = await tesseract.recognize(img, 'eng');
      const data = recognised?.data ?? {};
      const text: string = data.text ?? '';
      const confidence: number =
        typeof data.confidence === 'number' ? data.confidence / 100 : 0;
      return { text, confidence, version: recognised?.version };
    };

    const baseline = await runOnce(png);
    const baselineWordlike =
      (baseline.text.match(ROTATION_WORDLIKE_RE) ?? []).length;

    // Always log the baseline outcome — was previously invisible.
    logger.info(
      {
        pageNumber,
        baseline_conf: Number(baseline.confidence.toFixed(3)),
        baseline_wordlike: baselineWordlike,
        good_enough_threshold: ROTATION_GOOD_ENOUGH,
      },
      'OCR: PDF page baseline pass',
    );

    // Fast path: confidence above threshold means orientation is fine.
    // Anything below triggers rotation re-OCR; the score-based comparison
    // afterwards will keep the baseline if no rotation produces better
    // text (so "low-conf but correctly-oriented" pages are safe).
    if (baseline.confidence >= ROTATION_GOOD_ENOUGH) {
      return baseline;
    }

    // Slow path: baseline OCR is poor (likely rotated page). Try 90°,
    // 180°, 270° and keep the best. Each rotation adds ~1-2s of CPU
    // (tesseract.js is single-threaded WASM) but only on the small
    // fraction of pages that need it.
    logger.info(
      {
        pageNumber,
        baseline_conf: baseline.confidence,
        baseline_wordlike: baselineWordlike,
      },
      'OCR: PDF page baseline confidence low — attempting rotated re-OCR',
    );

    const sharp = await loadSharp();
    // Score uses wordlike count, not raw alnum. See block-comment at the
    // top of the file for why — Qamruddin pp.5-8 (May 20) were rotated
    // imaging reports that produced 200+ single-letter noise tokens that
    // looked good by alnum but had ~2 real words.
    const baselineScore =
      baseline.confidence * (1 + baselineWordlike / 5);
    let best = {
      angle: 0,
      result: baseline,
      score: baselineScore,
    };

    // OSD pre-check: ask Tesseract once whether this page is rotated. If
    // confidence is above the documented sanity floor AND the suggested
    // angle is non-zero, try that single rotation first. If it wins the
    // score race we return immediately and skip the brute-force loop.
    // Otherwise fall through — the brute-force loop is still the source
    // of truth; OSD is purely a fast-path optimisation.
    const osd = await this.detectOrientationViaOSD(png);
    if (osd) {
      logger.info(
        {
          pageNumber,
          osd_degrees: osd.degrees,
          osd_confidence: Number(osd.confidence.toFixed(3)),
          osd_threshold: OSD_CONFIDENCE_MIN,
        },
        'OCR: PDF page OSD pre-check result',
      );
    }
    // Short-circuit when OSD is highly confident the page is already
    // upright (deg=0, conf >= floor). The baseline Tesseract pass is the
    // best we can do for this page — rotating 90/180/270 will only
    // produce worse OCR. Accept the baseline and skip ~18s of brute-force.
    // Empirically on Qamruddin's PDF, pages 9-13 hit this branch (baseline
    // conf 0.31-0.54, OSD conf 4.6-5.6 with deg=0) — recovering ~90s.
    if (osd && osd.degrees === 0 && osd.confidence >= OSD_CONFIDENCE_MIN) {
      logger.info(
        {
          pageNumber,
          baseline_conf: Number(baseline.confidence.toFixed(3)),
          osd_conf: Number(osd.confidence.toFixed(3)),
        },
        'OCR: PDF page baseline kept (OSD confirms upright; skipping brute-force loop)',
      );
      return {
        ...baseline,
        warnings: ['low_confidence_after_osd_upright'],
      };
    }
    if (osd && osd.confidence >= OSD_CONFIDENCE_MIN && osd.degrees !== 0) {
      try {
        const rotated = await sharp(png).rotate(osd.degrees).toBuffer();
        const candidate = await runOnce(rotated);
        const candidateWordlike =
          (candidate.text.match(ROTATION_WORDLIKE_RE) ?? []).length;
        const candidateScore =
          candidate.confidence * (1 + candidateWordlike / 5);
        if (candidateScore > best.score) {
          logger.info(
            {
              pageNumber,
              baseline_conf: baseline.confidence,
              osd_angle: osd.degrees,
              osd_conf: Number(osd.confidence.toFixed(3)),
              rotated_conf: candidate.confidence,
              rotated_score: Number(candidateScore.toFixed(3)),
            },
            'OCR: PDF page recovered via OSD pre-check (skipped brute-force loop)',
          );
          return {
            ...candidate,
            warnings: [`osd_rotated_${osd.degrees}deg`],
          };
        }
        // OSD's suggestion didn't beat the baseline — feed it into the
        // brute-force comparison so we don't redo the work below.
        best = { angle: osd.degrees, result: candidate, score: candidateScore };
      } catch (osdRotateErr) {
        logger.warn(
          {
            pageNumber,
            angle: osd.degrees,
            err: (osdRotateErr as any)?.message ?? String(osdRotateErr),
          },
          'OCR: OSD-suggested rotation failed; continuing with brute-force loop',
        );
      }
    }

    for (const angle of [90, 180, 270] as const) {
      // Skip angles already evaluated via the OSD pre-check above.
      if (best.angle === angle && best.result !== baseline) continue;
      try {
        const rotated = await sharp(png).rotate(angle).toBuffer();
        const result = await runOnce(rotated);
        const wordlike =
          (result.text.match(ROTATION_WORDLIKE_RE) ?? []).length;
        const score = result.confidence * (1 + wordlike / 5);
        if (score > best.score) {
          best = { angle, result, score };
        }
      } catch (rotateErr) {
        logger.warn(
          {
            pageNumber,
            angle,
            err: (rotateErr as any)?.message ?? String(rotateErr),
          },
          'OCR: page rotation attempt failed; skipping',
        );
      }
    }

    if (best.angle === 0) {
      // Nothing beat the baseline; return as-is with a warning so the
      // bundle classifier knows OCR quality is genuinely bad for this page.
      return {
        ...baseline,
        warnings: ['low_confidence_after_rotation_scan'],
      };
    }

    logger.info(
      {
        pageNumber,
        baseline_conf: baseline.confidence,
        rotated_angle: best.angle,
        rotated_conf: best.result.confidence,
      },
      'OCR: PDF page recovered via rotation',
    );
    return {
      ...best.result,
      warnings: [`auto_rotated_${best.angle}deg`],
    };
  }
}

export default new OcrService();
