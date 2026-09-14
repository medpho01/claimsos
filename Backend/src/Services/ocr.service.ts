/**
 * OCR Service — Sprint 5 (Intelligence Layer), vision-first since 2026-09.
 *
 * Foundation layer that downstream document workers use to pull text out of
 * PDFs and images. Claude Vision is the reader for every page that has no
 * typed text layer.
 *
 * ── 2026-09-14: NO AUTOMATIC TESSERACT DEGRADE ──────────────────────────────
 *
 * This service used to treat Tesseract as the catch-all: every bound (page
 * budget, rupee allowance, latency budget, a failed vision call) silently
 * produced Tesseract text with a warning nobody read. That is no longer the
 * design and this header is no longer a description of it.
 *
 * The founder's decision, implemented here verbatim: a page vision cannot
 * read becomes an UNREADABLE PAGE — `source: 'unreadable'`, `text: ''`,
 * `confidence: 0`, `unreadable: true`, and an `unreadableReason` from a frozen
 * five-member enum that maps one-to-one onto an operator action. It is a HOLE,
 * not a page of low-quality text, and it is never silently substituted.
 *
 * Why: Tesseract text that LOOKS like a transcription is worse than no text at
 * all. On a wide itemised bill its row association drifts and money lands on
 * the wrong line item — a number that is confidently wrong flows into the
 * dossier, the harmoniser and the adjudicator, and nothing downstream can tell
 * it apart from a real read. An empty page with a reason attached cannot be
 * mistaken for data, and it is the only shape that lets the run present ONE
 * consolidated end-of-run decision ("these 8 pages were not read, here is what
 * you can do about it") instead of a degraded answer nobody was told about.
 *
 * The run does NOT stop at the first unreadable page. Every remaining page is
 * still processed; the unreadable ones are flagged and carried.
 *
 * TESSERACT REMAINS IN THIS FILE, unchanged, as a MANUAL SAFETY VALVE. It is
 * SELECTED, never fallen back to — `OCR_ENGINE=tesseract`,
 * `DOC_EXTRACT_DEFAULT_MODE=ocr`, `forceEngine:'tesseract'|'pdftotext'`. Under
 * any of those, this service behaves exactly as it did before 2026-09 and
 * stamps the doc-level warning 'tesseract_engine_selected' so a Tesseract read
 * is never mistaken for a vision read in an audit. See
 * `tesseractExplicitlySelected`.
 *
 * THE TYPED-PDF PATH IS UNTOUCHED. A digital PDF with a real embedded text
 * layer still costs zero tokens, is read by pdf-parse alone, and is not
 * affected by any of this — see `pageHasUsableTypedText`, which is the same
 * predicate as before and is now exported so the cost estimator counts pages
 * by the identical rule the reader uses.
 *
 * Why the flip (docs/proposals/EXTRACTION_LANDSCAPE_FIX.md §3): correctness
 * first. Tesseract collapses on handwriting, stamps, Devanagari, photo
 * overlays and — most expensively — on wide itemised bills, where its row
 * association drifts and money lands on the wrong line item. A Claude Vision
 * read of the SAME page sent as high-DPI OVERLAPPING HORIZONTAL TILES scores
 * ~99.5% where a single downscaled image scores 80-97%. The tiling +
 * small-angle deskew lives in ./extractor/ (imageTiler / deskew / visionRead);
 * this service just calls it.
 *
 * Cost intuition we still respect:
 *
 *   - Vision tokens on Claude ≈ ₹2 per 1k tokens
 *   - Text input tokens   ≈ ₹0.07 per 1k tokens
 *
 * …which is exactly why the typed-text layer still wins outright when it is
 * usable: it is free AND exact. Vision only pays for the pages that are
 * genuinely pixels.
 *
 * Decision tree per PDF page:
 *
 *   1. pdf-parse pulls the page's typed text layer.
 *   2. If text length > 50 chars AND contains alphanumerics AND has ≥5
 *      word-like tokens
 *        → source = 'typed_pdf', confidence = 0.95. (Skipped entirely when
 *          the caller passes forceVisionAllPages / forceEngine:'vision'.)
 *   3. Else, when vision reading is enabled (OCR_ENGINE !== 'tesseract',
 *      caller has not opted out, kill-switch not set):
 *        → transcribePagesViaVision() renders the page at an aspect-aware
 *          DPI, deskews it, slices it into overlapping tiles, and returns a
 *          plain-text transcription.
 *        → source = 'vision_fallback', warning 'used_vision_read'.
 *   4a. Else, when TESSERACT IS EXPLICITLY SELECTED (OCR_ENGINE=tesseract /
 *      DOC_EXTRACT_DEFAULT_MODE=ocr / forceEngine 'tesseract'|'pdftotext') —
 *      render page → PNG, run tesseract.js
 *        → source = 'tesseract', confidence = Tesseract's page conf / 100.
 *        → If that confidence < opts.minConfidence (default 0.6), still return
 *          the text plus 'low_confidence_ocr'.
 *   4b. Else — vision was the engine and this page did not come back from it —
 *      the page is UNREADABLE.
 *        → source = 'unreadable', text = '', confidence = 0,
 *          unreadable = true, unreadableReason ∈ { 'render_failed',
 *          'vision_failed', 'cost_budget', 'latency_budget', 'page_budget' }.
 *        → The existing per-page warning codes ('vision_read_failed',
 *          'vision_cost_budget_exceeded', 'vision_latency_budget_exceeded',
 *          'vision_page_budget_exceeded') are KEPT on OcrPage.warnings
 *          unchanged — docBundleClassifier's INCOMPLETE_PAGE_WARNINGS set
 *          keys on them.
 *
 * Cost containment (2026-09-13, post-review). The vision reader makes ONE
 * PROVIDER CALL PER PAGE — `transcribePagesViaVision` is a single *function*
 * call, not a single Anthropic call — so an unbounded page budget is an
 * unbounded bill on a path that also runs unattended (inbound email
 * attachments). Every bound below now produces UNREADABLE PAGES rather than
 * Tesseract text, and every one of them carries on with the pages it still
 * can read:
 *
 *   1. Per-call page budget, SCOPED to what the buffer actually is
 *      (`OcrExtractOpts.visionBudgetScope`):
 *        - 'section' (default): 8, matching the extractor's MAX_VISION_PAGES.
 *          For a caller that handed us one section slice.
 *        - 'document': every pixel page in the buffer, clamped by
 *          OCR_VISION_MAX_PAGES_DOCUMENT (40). For docSegmenter /
 *          docBundleClassifier, which hand us a whole bundle and derive
 *          section boundaries from the result.
 *      Pages past the budget are UNREADABLE with reason 'page_budget' and the
 *      warning 'vision_page_budget_exceeded'. Operator action: split the
 *      document, or raise the ceiling.
 *   2. A TIGHTER budget (default 3) for an unattended call — no claim context
 *      and no explicit vision intent, or `attended: false` stated outright.
 *      That is the signature of an unattended ingestion path —
 *      emailIntelligence OCRs every inbound attachment, and a spam mail with a
 *      50-page scan must not be able to spend ₹300 with nobody watching. An
 *      unattended caller cannot widen its own budget by declaring a scope.
 *   3. A RUPEE bound on the read itself (see `runVisionPagePump`). A page
 *      budget is a bound on COUNT; the thing that can stop a claim is a bound
 *      on SPEND, and no pre-flight check can provide one for the call it
 *      authorises. Before the read, costAccounting.getOcrReadAllowanceInr says
 *      how many rupees this read may spend — the intersection of the per-read
 *      cap, the claim's OCR headroom, the hospital's headroom AND, when
 *      `opts.runId` is supplied, the RUN's remaining approved budget. Between
 *      pages, the pump re-checks ACTUAL accumulated spend against that
 *      allowance and stops dispatching when the next page would cross it.
 *      Pages it cannot pay for are UNREADABLE with reason 'cost_budget'.
 *      The read NEVER throws on budget.
 *      When the binding dimension was the RUN's approved budget, the result
 *      additionally carries the doc-level warning 'run_budget_exhausted' —
 *      that is the code the CONSUMER keys on to pause the run for consent.
 *      This service never pauses a run itself: it does not own run state.
 *   4. A LATENCY bound (OCR_VISION_LATENCY_BUDGET_MS, default 5 min). Same
 *      mechanism, different axis: past the budget the pump stops dispatching
 *      and the remaining pages are UNREADABLE with reason 'latency_budget'.
 *      A Bull job must not sit on a worker for eight minutes.
 *   5. Bounded concurrency. Pages are dispatched by a POOL of
 *      OCR_VISION_CONCURRENCY (default 6, hard max 8) workers, one page per
 *      provider call, each holding an `acquireLlmSlot` slot so OCR shares the
 *      process-wide Anthropic concurrency ceiling with every other caller
 *      instead of fanning out beside it. A page that fails only costs itself —
 *      it becomes one unreadable page — rather than taking a whole lane.
 *
 * COOPERATIVE PAUSE (2026-09-14). `OcrExtractOpts.shouldStop` is checked in the
 * pump's worker loop, between pages, in the same place the latency budget is
 * checked. The API container and the worker container are separate processes,
 * so the pause cannot be a process-local flag: the caller's hook reads the
 * authoritative run row in Postgres (memoised ~1s) and this service just asks
 * it. Returning true raises `OcrPausedError` — the ONE deliberate, documented
 * exception to this service's never-throws invariant, because it is a
 * control-flow signal rather than a failure, and because throwing is what
 * guarantees no partial transcription is cached. A paused read leaves NO cache
 * entry, so a resume genuinely re-reads instead of inheriting the truncated
 * result the extra budget was meant to replace. In-flight provider calls are
 * never abandoned: they complete and are billed.
 *
 * WHY ONE PAGE PER CALL (NEW-4). `transcribePagesViaVision` walks the pages it
 * is given SEQUENTIALLY. Handing it a lane of 14 pages therefore produced 14
 * serial ~36s round-trips — 6-8 minutes inside a Bull job for a 40-page bundle,
 * no matter how many lanes ran beside it. Dispatching one page per call makes
 * the pool's width the real parallelism: 40 pages at concurrency 6 is ~7 waves
 * (~4 min), and the spend is unchanged to the rupee because the call count per
 * page is identical.
 *
 * ENGINE COHERENCE ACROSS DEPENDENT STEPS (2026-09-14). The pipeline reads one
 * document twice: once whole (segmenter / bundle classifier, to find section
 * boundaries) and once per section (classifier / extractor, to read fields).
 * If those two passes disagree about which engine read page 20, the boundaries
 * describe a transcription that nothing downstream ever sees. Until today all
 * four callers passed NO opts, so the two whole-document callers silently took
 * the unattended budget of 3 while the extractor read the same pages by vision
 * at 8. Three things now make the two passes agree:
 *
 *   a. Per-page engine choice is a pure function of (page bytes, vision-enabled
 *      env, the page's index among the buffer's pixel pages, the budget). No
 *      randomness, no wall-clock, no ordering effects.
 *   b. Section-slice callers (docClassifier, docExtractor) both slice the same
 *      page range from the same S3 object and both use scope 'section', so
 *      they feed byte-identical buffers under an identical budget.
 *   c. Whole-document callers use scope 'document', whose budget is the
 *      document's own pixel-page count — so no page is left unread at the
 *      bundle level while a section read gives it vision.
 *
 * The cache key carries the resolved policy (see visionPolicyCacheKey) so a
 * cheap read can never be replayed to a caller that asked for a richer one.
 * The single residual case — a document with more pixel pages than
 * OCR_VISION_MAX_PAGES_DOCUMENT — sets 'vision_document_budget_clamped' on
 * OcrResult.warnings and logs the affected page numbers at error level.
 *
 * Vision stays ON by default: the directive is prove correctness first,
 * optimise later. Bounded is not the same as disabled.
 *
 * Caching: input buffers are SHA-256'd and an in-memory LRU (max 100
 * entries) shortcuts repeat calls. This matters because workers often
 * retry or re-fetch the same document across stages.
 *
 * Flags (all reversible without a deploy):
 *   - OCR_ENGINE=tesseract           → SELECTS Tesseract and restores the
 *     pre-2026-09 behaviour exactly. This is the manual safety valve; nothing
 *     falls back to Tesseract on its own any more.
 *   - DOC_EXTRACT_DEFAULT_MODE=ocr   → the ONE-FLAG revert. Reverts the
 *     extractor's default mode AND (when OCR_ENGINE is unset) this service's
 *     engine, so no per-page Anthropic call survives the switch. Counts as an
 *     explicit Tesseract selection here.
 *   - OCR_VISION_FALLBACK_DISABLED=true → hard kill-switch for every vision
 *     call. Note it does NOT select Tesseract: with vision killed and no engine
 *     chosen, every pixel page comes back UNREADABLE ('vision_disabled'). If
 *     the intent is "keep reading without vision", set OCR_ENGINE=tesseract.
 *   - OCR_VISION_MAX_PAGES=<n>       → section-scope vision page budget (8)
 *   - OCR_VISION_MAX_PAGES_UNATTENDED=<n> → budget with no claim context (3)
 *   - OCR_VISION_MAX_PAGES_DOCUMENT=<n> → ceiling on a document-scope read (40)
 *   - OCR_VISION_CONCURRENCY=<n>     → parallel vision page workers (6, max 8)
 *   - OCR_VISION_PAGES_PER_CALL=<n>  → pages per provider call (1; >1 makes
 *     those pages sequential inside the call — raise only to cut per-call
 *     overhead on a provider that is rate-limiting you)
 *   - OCR_VISION_MAX_COST_INR_PER_READ=<inr> → rupee ceiling on ONE read (250)
 *   - CLAIM_OCR_HARD_LIMIT_INR=<inr> → rupee ceiling on a claim's OCR (300)
 *   - OCR_VISION_EST_PAGE_COST_INR=<inr> → projection seed, ₹5.5 (measured on
 *     a dense A4 portrait page: ~6,272 image tokens at 4 images/page). Only
 *     seeds the projection — once pages start returning, the pump projects
 *     from the OBSERVED mean instead.
 *   - OCR_VISION_LATENCY_BUDGET_MS=<ms> → wall-clock ceiling on one read
 *     (300000). Past it, undispatched pages are unreadable ('latency_budget').
 *   - EXTRACT_TILING_ENABLED=0 / EXTRACT_DESKEW_ENABLED=0 → read by ./extractor/
 *
 * NOT in scope:
 *   - Multi-column layout detection
 *   - Indic-script language packs (English-only Tesseract on the manual valve;
 *     Devanagari is handled by the vision reader)
 *   - Async/batch processing across workers
 */

import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import sharp from 'sharp';
import { logger } from '../Utils/logger.js';
// Process-wide Anthropic concurrency pools. The vision reader calls the SDK
// directly (it does not go through Services/llm/providers/claudeClient), so
// without this the OCR page pump would fan out BESIDE the semaphore that exists
// to stop exactly that. Static import is safe: llmConcurrency imports only the
// logger, so there is no cycle with costAccounting / the extractor barrel.
import { acquireLlmSlot } from '../Utils/llmConcurrency.js';
// Type-only import: erased at runtime, so this module still loads even if the
// extractor barrel is mid-deploy. Every RUNTIME use of ./extractor/ goes
// through the lazy loaders below.
import type {
  DeskewResult,
  RenderScaleDecision,
  RenderScaleOptions,
  VisionTranscribeInput,
  VisionTranscribeResult,
  VisionTranscribedPage,
} from './extractor/index.js';

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

/**
 * Why a page could not be read. FROZEN at five members. Each member maps to
 * exactly one operator action, which is the whole reason they are separate.
 *
 *   'vision_failed'  — we sent the page to the model and got nothing usable
 *                      (call threw, empty transcription, reader unavailable,
 *                      or vision disabled by kill switch). ACTION: retry.
 *   'cost_budget'    — never dispatched; the read ran out of rupees (per-read
 *                      cap, claim OCR cap, hospital headroom, or the run's
 *                      approved budget). ACTION: approve more budget.
 *   'latency_budget' — never dispatched; the read ran out of wall clock.
 *                      ACTION: raise OCR_VISION_LATENCY_BUDGET_MS / concurrency.
 *   'page_budget'    — never dispatched; past the page-count budget.
 *                      ACTION: split the document / raise the document ceiling.
 *   'render_failed'  — the page never became an image (pdf slice/render/tiler
 *                      failure). ACTION: re-upload the document.
 */
export type UnreadableReason =
  | 'vision_failed'
  | 'cost_budget'
  | 'latency_budget'
  | 'page_budget'
  | 'render_failed';

export interface OcrUnreadablePage {
  pageNumber: number;
  reason: UnreadableReason;
  /** Short, PHI-free, safe to log and to show an operator. <= 200 chars. */
  detail?: string;
}

/** Cap on `OcrUnreadablePage.detail`, enforced by `unreadableDetail()`. */
const UNREADABLE_DETAIL_MAX_CHARS = 200;

/** Truncate a detail string to the contract's 200-char ceiling. */
function unreadableDetail(detail: string): string {
  return detail.length <= UNREADABLE_DETAIL_MAX_CHARS
    ? detail
    : `${detail.slice(0, UNREADABLE_DETAIL_MAX_CHARS - 1)}…`;
}

export interface OcrPage {
  pageNumber: number;
  /** '' when unreadable === true. Consumers MUST NOT treat '' as "blank page". */
  text: string;
  /** 0 when unreadable === true. */
  confidence: number;
  /**
   * 'vision_fallback' covers BOTH the legacy single-image escalation and the
   * tiled vision read.
   *
   * BREAKING-BY-WIDENING (2026-09-14), and the ONE place backward
   * compatibility cannot be preserved: 'unreadable' is added to the union.
   * This is safe for all five existing consumers — none switches on `source`,
   * and the test doubles PRODUCE OcrPage rather than consume it, so a widened
   * union in the producer direction still typechecks. Any code that DOES
   * switch exhaustively on `source` must add an 'unreadable' arm.
   */
  source: 'typed_pdf' | 'tesseract' | 'vision_fallback' | 'unreadable';
  warnings?: string[];
  /** Tiles sent for this page. 0 (or absent) = single image / not a vision read. */
  tileCount?: number;
  /** Deskew correction applied before reading, in degrees. */
  deskewAngleDeg?: number | null;
  /** Provider model id — only set when source === 'vision_fallback'. */
  visionModel?: string;
  /**
   * TRUE => there is NO text for this page and there never will be without
   * operator action. Always accompanied by unreadableReason.
   */
  unreadable?: boolean;
  unreadableReason?: UnreadableReason;
  unreadableDetail?: string;
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
    /** Model id of the vision reader, when any page was read by it. */
    vision?: string;
  };
  /**
   * Document-level warnings (page-level ones stay on OcrPage.warnings).
   * OPTIONAL and additive — every existing producer and consumer of
   * OcrResult stays valid without it.
   *
   * EXISTING members, unchanged and still emitted. Each means "some pixel
   * pages in this read were cut short by a bound", which breaks the
   * engine-coherence guarantee documented on `visionBudgetScope`, so each is
   * surfaced loudly rather than left to be discovered downstream:
   *
   *   - 'vision_document_budget_clamped' — a `visionBudgetScope: 'document'`
   *     read hit OCR_VISION_MAX_PAGES_DOCUMENT. Knob: that env, or split the
   *     bundle.
   *   - 'vision_cost_budget_clamped' — the read ran out of rupees (per-read
   *     cap, claim OCR cap, or hospital headroom). Knob:
   *     OCR_VISION_MAX_COST_INR_PER_READ / CLAIM_OCR_HARD_LIMIT_INR, or
   *     hospital_cost_caps.
   *   - 'vision_latency_budget_clamped' — the read ran out of wall clock.
   *     Knob: OCR_VISION_LATENCY_BUDGET_MS / OCR_VISION_CONCURRENCY.
   *
   * NEW members (2026-09-14):
   *
   *   - 'unreadable_pages'     — at least one page is unreadable.
   *   - 'all_pages_unreadable' — every page is unreadable. A consumer MUST NOT
   *     call an LLM on this result; there is nothing to reason about.
   *   - 'run_budget_exhausted' — the stop was the RUN's approved budget, not a
   *     static cap. This is the code a consumer keys on to pause the run for
   *     consent (`pauseForConsent`). This service never pauses a run itself.
   *   - 'tesseract_engine_selected' — OCR_ENGINE=tesseract / forceEngine was
   *     used. Present so a Tesseract read is never mistaken for a vision read
   *     in an audit.
   */
  warnings?: string[];
  /** Every page that could not be read, with its reason. */
  unreadablePages?: OcrUnreadablePage[];
  /** pages.length - unreadablePages.length */
  readablePageCount?: number;
}

/**
 * Which slice of the document does this buffer represent? This is the single
 * knob that keeps dependent pipeline steps reading the SAME pages with the
 * SAME engine — see `resolveVisionPageBudget` for the full argument.
 *
 *   'section'  — the buffer is one section slice (docClassifier /
 *                docExtractor both call `fetchAndSlicePdf` for the same
 *                page range). Budget = OCR_VISION_MAX_PAGES (8), which is
 *                docExtractor's own MAX_VISION_PAGES. Byte-identical input +
 *                identical budget ⇒ identical per-page engine decision.
 *   'document' — the buffer is a whole multi-section bundle (docSegmenter,
 *                docBundleClassifier). Budget SCALES with the document: every
 *                pixel page in it is read by vision, up to
 *                OCR_VISION_MAX_PAGES_DOCUMENT. A fixed budget here is what
 *                produced two different transcriptions of one document.
 */
export type OcrVisionBudgetScope = 'section' | 'document';

export interface OcrExtractOpts {
  forceEngine?: 'pdftotext' | 'tesseract' | 'vision';
  minConfidence?: number;
  allowVisionFallback?: boolean;
  /**
   * Skip the typed-text fast path and read EVERY page with vision. For
   * documents whose embedded text layer is known-bad (glyph-mapped scans that
   * pass the word-density gate, insurer PDFs with a bogus OCR layer baked in).
   * Default false — the typed layer is free and exact when it is real.
   */
  forceVisionAllPages?: boolean;
  /**
   * Explicit statement of whether a claim pipeline (i.e. a human) is behind
   * this call, overriding the claimId/hospitalId heuristic in BOTH directions.
   *
   * `false` is the important one: it pins a caller to the unattended vision
   * budget permanently, so an unattended ingestion path cannot escalate later
   * just because somebody starts threading a claimId through it for logging.
   * emailIntelligence's inbound-attachment reader passes it.
   *
   * Omitted → the heuristic in `resolveAttendance` decides, exactly as before.
   */
  attended?: boolean;
  /**
   * Whether this buffer is one section slice or a whole document. Defaults to
   * 'section' — the conservative, fixed-budget behaviour. See
   * `OcrVisionBudgetScope`.
   */
  visionBudgetScope?: OcrVisionBudgetScope;
  /** Cost-log attribution, passed through to the vision reader. */
  claimId?: string | null;
  hospitalId?: string | null;
  /**
   * Run attribution (claim_ai_runs.id). Threads into the cost allowance so the
   * run's approved budget becomes one more dimension of
   * getOcrReadAllowanceInr — the ONLY way a mid-run consent gate can bound the
   * page reads it authorises. Omit for an unattended read (emailIntelligence),
   * which has no run.
   */
  runId?: string | null;
  /**
   * Cooperative pause hook. Checked in runVisionPagePump's worker loop in the
   * SAME place the latency budget is checked — before the next chunk is
   * reserved. Returning true raises OcrPausedError. Absent => never paused.
   *
   * It is a FUNCTION, not a boolean, because the pause lives in Postgres and
   * the worker that must observe it is in a different container from the API
   * that set it. The caller supplies
   * `claimAiRunService.makeShouldStop(runId)`, which does a memoised indexed
   * read of the run row; a process-local flag would not be observable at all.
   */
  shouldStop?: () => boolean | Promise<boolean>;
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

/**
 * Raised when an OCR engine dependency is missing or the wrong version —
 * i.e. an *environment* problem, not a problem with the document. Callers
 * MUST NOT label this `corrupted_pdf`: the file is fine, the parser isn't.
 *
 * Root-cause provenance (2026-06-01): a transient `pdf-parse@2.x` install
 * (which exports a `PDFParse` *class*, not a callable) made `runPdfParse`
 * throw `TypeError: pdfParse is not a function`. The old catch mapped that
 * to `corrupted_pdf`, so a dependency bug masqueraded as a corrupt document
 * — every PDF across every patient silently failed while we debugged the
 * files instead of the install. Surfacing it distinctly makes the real
 * cause obvious at a glance.
 */
export class OcrEngineUnavailableError extends Error {
  override cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OcrEngineUnavailableError';
    if (cause !== undefined) this.cause = cause;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Raised ONLY when the caller supplied `shouldStop` and it returned true.
 *
 * This is a DELIBERATE, DOCUMENTED exception to this service's "never throws"
 * invariant: it is a control-flow signal, not a failure. It is thrown instead
 * of returning a partial result because a partial transcription persisted as
 * 'done' is exactly what resume-with-more-budget must not inherit. Throwing
 * also means `extractTextFromPdf` never reaches its `cache.set`, so a paused
 * read leaves NO cache entry and the resume genuinely re-reads the document.
 *
 * The caller catches it, writes doc_phase_ledger status='blocked' for that
 * (doc, phase), and returns — it must NOT be allowed to dead-letter through
 * Bull's retries, because the run was parked on purpose.
 */
export class OcrPausedError extends Error {
  readonly runId: string | null;
  readonly pagesRead: number;
  readonly pagesRemaining: number;

  constructor(input: {
    runId?: string | null;
    pagesRead: number;
    pagesRemaining: number;
    message?: string;
  }) {
    super(
      input.message ??
        `OCR read paused by the caller's shouldStop hook after ${input.pagesRead} ` +
          `page(s); ${input.pagesRemaining} page(s) were not dispatched. ` +
          'Nothing was cached; a resume re-reads this document.',
    );
    this.name = 'OcrPausedError';
    this.runId = input.runId ?? null;
    this.pagesRead = input.pagesRead;
    this.pagesRemaining = input.pagesRemaining;
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

/**
 * The typed-text acceptance predicate, extracted VERBATIM from
 * extractTextFromPdf's per-page loop. TRUE => the page has a real embedded
 * text layer and needs no vision call.
 *
 * Exported because the cost estimator and the reader must agree, to the page,
 * on what a "pixel page" is. The rule used to be inlined in the loop where
 * nothing else could see it, so an estimate computed by any other rule would
 * have quoted a price for a different amount of work than the read performs.
 *
 * Note this predicate is about the TEXT ONLY. The caller-policy gates that sit
 * beside it in the loop (forceVisionAllPages, forceEngine:'vision' skipping the
 * typed layer outright, forceEngine:'tesseract' refusing it) are decisions
 * about the CALL, not properties of the page, and stay at the call site.
 *
 * Constants unchanged: TYPED_TEXT_MIN_CHARS=50, TYPED_TEXT_MIN_WORDS=5.
 */
export function pageHasUsableTypedText(typedText: string): boolean {
  const text = (typedText ?? '').trim();
  if (text.length <= TYPED_TEXT_MIN_CHARS) return false;
  if (!ALPHANUMERIC_RE.test(text)) return false;
  return (text.match(WORDLIKE_RE) ?? []).length >= TYPED_TEXT_MIN_WORDS;
}

/**
 * How many pages a document has, and which of them need a paid vision call.
 * Produced by `censusPdfPages` / `IMAGE_CENSUS`, consumed by the run cost
 * estimator.
 */
export interface PdfPageCensus {
  totalPages: number;
  /** 1-based page numbers with NO usable typed layer — these need vision. */
  pixelPages: number[];
  /** True when pdf-parse threw; caller must treat the doc as all-pixel. */
  degraded: boolean;
}

/**
 * Page count assumed for a document whose census failed. Deliberately the
 * section-scope vision budget (8): a quote must be conservative rather than
 * absent, and quoting 0 for a document we could not parse would let a bundle
 * start a run its approved budget cannot finish.
 */
export const PAGE_COUNT_UNKNOWN_PAGES = 8;

/** Images are always exactly one pixel page. */
export const IMAGE_CENSUS: PdfPageCensus = {
  totalPages: 1,
  pixelPages: [1],
  degraded: false,
};

/**
 * CPU-only page census. Runs pdf-parse and applies `pageHasUsableTypedText`
 * per page.
 *
 * Makes NO provider call and spends NOTHING — that is the entire point: the
 * pre-flight estimate the user approves a budget against must itself be free,
 * or the consent dialog costs money to render.
 *
 * NEVER THROWS. A parse failure returns
 * `{ totalPages: 0, pixelPages: [], degraded: true }`; the estimator treats a
 * degraded doc as PAGE_COUNT_UNKNOWN_PAGES pixel pages, so the quote is
 * conservative rather than absent.
 */
export async function censusPdfPages(buffer: Buffer): Promise<PdfPageCensus> {
  try {
    const parsed = await parsePdfPages(buffer);
    const pixelPages: number[] = [];
    for (let i = 0; i < parsed.numpages; i++) {
      if (!pageHasUsableTypedText(parsed.pagesText[i] ?? '')) {
        pixelPages.push(i + 1);
      }
    }
    return { totalPages: parsed.numpages, pixelPages, degraded: false };
  } catch (err) {
    logger.warn(
      { err: (err as any)?.message ?? String(err), bytes: buffer?.length ?? 0 },
      'OCR: page census failed — the estimator will quote this document at the ' +
        'conservative unknown-page count',
    );
    return { totalPages: 0, pixelPages: [], degraded: true };
  }
}

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

// ── Engine selection ────────────────────────────────────────────────────────
//
// 'vision' is the DEFAULT as of 2026-09, per the user's directive: prove
// correctness first, optimise cost later. A page with no usable typed text is
// read by Claude Vision (overlapping high-DPI tiles + deskew, see
// ./extractor/visionRead.ts); Tesseract only runs when vision is disabled or
// the vision call failed.
//
//   OCR_ENGINE=tesseract  → restores the pre-2026-09 behaviour exactly
//                           (Tesseract on the critical path, no vision read).
//   OCR_ENGINE=auto       → same as 'vision' today; reserved for a future
//                           heuristic that picks per page. Treated as
//                           vision-enabled so the flag is forward-compatible.
//   OCR_ENGINE=vision     → explicit default.
//
// ONE-FLAG REVERT (2026-09-13). docExtractor documents
// `DOC_EXTRACT_DEFAULT_MODE=ocr` as the switch that restores the pre-v3
// default. It used to revert only the *extractor's* mode: this service still
// defaulted to 'vision', so extractTextFromPdf kept making a per-page
// Anthropic call and the flag reverted behaviour without reverting spend —
// the worst possible outcome for a switch you reach for during an incident.
// It now reverts BOTH. An explicit OCR_ENGINE still wins in either direction,
// so `DOC_EXTRACT_DEFAULT_MODE=ocr OCR_ENGINE=vision` remains expressible.
//
// Read per call rather than captured at import time so the flag is reversible
// by an env change + restart of a single worker, and so tests can toggle it
// without re-importing the module.
type OcrEngineMode = 'vision' | 'tesseract' | 'auto';
const OCR_ENGINE_DEFAULT: OcrEngineMode = 'vision';

function resolveOcrEngine(): OcrEngineMode {
  const raw = process.env.OCR_ENGINE;
  if (raw === 'tesseract' || raw === 'auto' || raw === 'vision') return raw;
  // No explicit engine → inherit the extractor's revert switch.
  if (process.env.DOC_EXTRACT_DEFAULT_MODE === 'ocr') return 'tesseract';
  return OCR_ENGINE_DEFAULT;
}

// Section-scope ceiling on vision page reads. transcribePagesViaVision makes
// ONE PROVIDER CALL PER PAGE, so the old budget of 50 meant a single scanned
// bundle could spend ~₹300 and 10-20 minutes in one job. 8 matches the
// extractor's MAX_VISION_PAGES, which is the largest section we ever send as
// images anyway. Pages past the budget fall through to Tesseract with a
// 'vision_page_budget_exceeded' warning, which keeps the document readable
// instead of failing it.
const VISION_PAGE_BUDGET_DEFAULT = 8;

// The budget for a caller that supplies NO claim context and has not asked
// for vision explicitly. That describes the unattended ingestion paths —
// emailIntelligence.service OCRs every inbound attachment before anything is
// bound to a claim — where an attacker (or an over-enthusiastic vendor)
// chooses the page count. Three pages is enough to classify/route a document;
// the rest go to Tesseract, which is exactly what those callers got before
// the vision flip. Callers with a claimId/hospitalId (docExtractor) or an
// explicit vision intent keep the full budget.
const VISION_PAGE_BUDGET_UNATTENDED_DEFAULT = 3;

// Ceiling for a `visionBudgetScope: 'document'` read (2026-09-14).
//
// Why a document scope exists at all. docSegmenter / docBundleClassifier hand
// this service the WHOLE bundle and derive section boundaries from what comes
// back; docClassifier / docExtractor then re-read each of those sections as a
// slice. Until today all four called extractTextFromPdf with NO opts, so the
// bundle-level pair silently landed on the UNATTENDED budget of 3: on a
// 40-page bundle, boundaries were derived from Tesseract text for pages 4-40
// while the extractor later read those same pages via vision at budget 8. One
// document, two transcriptions, two dependent steps disagreeing about what is
// on the page.
//
// A fixed budget cannot fix that, because the bundle-level read has to cover
// every page any later section read might cover. So the document budget is the
// document's OWN pixel-page count, clamped here.
//
// The clamp is a spend bound, not a modelling choice: a tiled vision page is
// ~₹4-6, so 40 pixel pages is ~₹150-240 for one bundle read. Note that the
// read is per DOCUMENT and memoised by the LRU below, so segmenter and bundle
// classifier looking at the same bytes pay once, not twice. Documents past the
// clamp are the one case the coherence guarantee cannot cover, and they are
// reported as 'vision_document_budget_clamped' on OcrResult.warnings plus an
// error-level log naming the affected pages — never silently.
const VISION_PAGE_BUDGET_DOCUMENT_MAX_DEFAULT = 40;

// Parallel vision page workers per document (NEW-4, 2026-09-14).
//
// This used to be a LANE count: the budgeted pages were split into 3 contiguous
// lanes and each lane handed wholesale to `transcribePagesViaVision`, which
// walks its pages SEQUENTIALLY. On a 40-page bundle that is 3 lanes of ~14
// serial ~36s round-trips = 6-8 minutes of wall time inside a Bull job, and
// raising the lane count was the only lever — each lane still blocked on its
// own pages one at a time.
//
// It is now a WORKER-POOL width over one-page calls (see
// VISION_PAGES_PER_CALL_DEFAULT), so the number means what it says: this many
// provider calls in flight. 40 pages at 6 is ~7 waves ≈ 4 minutes, at the same
// rupee cost — the per-page call count is unchanged.
//
// 6, not 8, by default: every worker also takes an `acquireLlmSlot` slot from
// the shared sonnet pool (LLM_MAX_CONCURRENT_SONNET, default 8), and one OCR
// read must not starve the harmoniser outright. 8 is the hard ceiling — beyond
// that a burst of documents fans out into a 429 retry storm, which costs more
// wall time than it saves.
const VISION_CONCURRENCY_DEFAULT = 6;
const VISION_CONCURRENCY_MAX = 8;

// Pages handed to ONE `transcribePagesViaVision` call. 1 by default because
// that function is sequential internally: anything above 1 re-introduces the
// serial walk inside the call and makes the pool width a lie. Kept
// configurable (capped at the section budget) only as an escape hatch for a
// provider that prefers fewer, larger requests.
const VISION_PAGES_PER_CALL_DEFAULT = 1;
const VISION_PAGES_PER_CALL_MAX = 8;

// Seed for the per-page cost projection, in INR.
//
// Measured 2026-09-14 on a dense A4 portrait bundle: 4.0 images/page and
// 6,272 image tokens/page at Sonnet 4.5 rates, plus a full-page transcription
// on the output side — ~₹5.4/page, ~₹217 for a 40-page document-scope read.
// Deliberately rounded UP: the projection decides how many pages we are
// willing to start, and over-estimating costs accuracy on a page while
// under-estimating costs rupees.
//
// This value only SEEDS the projection. As soon as pages start returning, the
// pump projects from the observed mean of THIS read (see runVisionPagePump),
// so a cheap sparse document is not throttled by a dense document's number.
const VISION_EST_PAGE_COST_INR_DEFAULT = 5.5;

// Wall-clock ceiling on ONE vision read, in ms. The pump stops dispatching new
// pages past it and the rest go to Tesseract. 5 minutes is chosen against the
// measured envelope (40 pages / 6 workers × ~36s ≈ 4 min), so a healthy read
// never trips it and a degraded provider cannot pin a Bull worker indefinitely.
const VISION_LATENCY_BUDGET_MS_DEFAULT = 300_000;

// Model id used ONLY to pick the acquireLlmSlot pool. Mirrors
// visionRead.VISION_READ_MODEL; duplicated rather than imported because every
// runtime touch of ./extractor/ in this file is lazy, and a static import here
// would drag the barrel (and sharp/pdf-lib) into every process that loads this
// service. A drift here costs pool selection, never correctness.
const VISION_READ_SLOT_MODEL = 'claude-sonnet-4-5';

// Cost-log task name for the PDF page reader. Distinct from the legacy
// single-image 'ocr_vision_fallback' so the two paths stay separable in
// hospital.llm_cost_log.
const VISION_READ_TASK_PDF = 'ocr_vision_page';
const VISION_READ_TASK_IMAGE = 'ocr_vision_image';

function envPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Same, but keeps the fraction — rupee knobs are not integers. */
function envPositiveFloat(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Does this call carry enough context to be considered attended? A claim or
 * hospital id means a human-initiated claim pipeline is behind it; an explicit
 * vision request means the caller has decided on purpose. Anything else is
 * treated as unattended ingestion and gets the tighter budget.
 *
 * `opts.attended` outranks every heuristic input, in BOTH directions. The
 * heuristic was always a guess about the caller's situation, and a guess is
 * the wrong thing to have in front of a spend gate on a path an attacker can
 * reach: emailIntelligence OCRs whatever an unauthenticated sender mailed in,
 * and the day somebody threads a hospitalId through that path for logging, the
 * heuristic quietly triples its budget. `attended: false` makes that
 * impossible to do by accident.
 */
function resolveAttendance(opts: OcrExtractOpts): boolean {
  if (typeof opts.attended === 'boolean') return opts.attended;
  return (
    Boolean(opts.claimId) ||
    Boolean(opts.hospitalId) ||
    opts.forceEngine === 'vision' ||
    opts.forceVisionAllPages === true ||
    opts.allowVisionFallback === true
  );
}

function resolveBudgetScope(opts: OcrExtractOpts): OcrVisionBudgetScope {
  return opts.visionBudgetScope === 'document' ? 'document' : 'section';
}

/**
 * TESSERACT IS SELECTED, NEVER FALLEN BACK TO.
 *
 * The single predicate that decides whether a page vision did not read becomes
 * Tesseract text or an UNREADABLE PAGE. It is true only when somebody CHOSE
 * Tesseract:
 *
 *   - `forceEngine: 'tesseract' | 'pdftotext'` — the caller asked outright.
 *   - `OCR_ENGINE=tesseract` (which `resolveOcrEngine` also returns for
 *     DOC_EXTRACT_DEFAULT_MODE=ocr) — the operator's deploy-free revert.
 *
 * Note what is deliberately NOT here: `allowVisionFallback:false` and
 * `OCR_VISION_FALLBACK_DISABLED=true` turn vision OFF but select nothing, so
 * their pixel pages come back unreadable. Opting out of the reader is not the
 * same as choosing a different one, and a spend freeze must not silently
 * re-route every page into an engine whose wrong answers look like right ones.
 * An operator who wants reading to continue without vision sets
 * OCR_ENGINE=tesseract, which is one env var and is documented in the header.
 */
function tesseractExplicitlySelected(opts: OcrExtractOpts): boolean {
  return (
    opts.forceEngine === 'tesseract' ||
    opts.forceEngine === 'pdftotext' ||
    resolveOcrEngine() === 'tesseract'
  );
}

/**
 * visionRead warning codes that mean THE MODEL NEVER SAW AN IMAGE of the page
 * — the PDF slice failed, the render produced nothing, or the tiler threw.
 * They are separated from every other vision failure because they are a
 * different operator action: a page that failed to render will fail again at
 * any budget, so the answer is "re-upload the document", never "retry" or
 * "approve more money".
 */
const RENDER_FAILURE_WARNINGS: ReadonlySet<string> = new Set([
  'vision_no_images_rendered',
  'vision_pdf_slice_failed',
  'vision_prepare_failed',
  'vision_read_no_images',
]);

/**
 * The `OcrReadAllowance.limitedBy` member that means "the RUN's approved
 * budget was the binding constraint". Kept as a named constant here because
 * this file keys a behavioural decision on it (pause the run for consent vs
 * raise an ops cap), and a typo would silently turn a consent prompt into a
 * mystery clamp.
 */
const RUN_BUDGET_LIMIT_DIMENSION = 'run_budget';

/**
 * Everything `readPdfPagesViaVision` learned about a set of pixel pages. The
 * disjoint page SETS are what the assembly loop turns into `unreadableReason`
 * values — each set is one reason, and one operator action.
 */
interface VisionPdfReadOutcome {
  byPage: Map<number, VisionTranscribedPage>;
  model?: string;
  /** Pages we actually sent to vision (used to stamp 'vision_read_failed'). */
  attempted: Set<number>;
  /** Pages dropped by the per-document PAGE budget before the call. */
  overBudget: Set<number>;
  /** Pages never dispatched because the read ran out of rupees. */
  costSkipped: Set<number>;
  /** Pages never dispatched because the read ran out of wall clock. */
  latencySkipped: Set<number>;
  /**
   * Pages the model NEVER SAW AN IMAGE OF — the slice, the render or the tiler
   * failed. Distinguished from a plain vision failure because no amount of
   * budget, time or retries fixes it: the document has to be re-uploaded.
   */
  renderFailed: Set<number>;
  /**
   * True only when a `visionBudgetScope: 'document'` read was cut short by
   * OCR_VISION_MAX_PAGES_DOCUMENT — i.e. the one configuration where the
   * bundle-level and section-level reads of these pages will disagree about
   * which engine read them.
   */
  clampedByDocumentCeiling: boolean;
  /** Actual rupees this read spent, as reported by the provider. */
  spentInr: number;
  /** The vision reader was not used at all (kill switch / opt-out / engine). */
  visionDisabled: boolean;
  /**
   * The binding rupee dimension was the RUN's approved budget rather than a
   * static cap. The CONSUMER pauses the run for consent on this; ocr.service
   * does not own run state and never pauses anything itself.
   */
  runBudgetExhausted: boolean;
  /** `OcrReadAllowance.limitedBy` for this read, for logs and page details. */
  allowanceLimitedBy: string;
}

/**
 * The per-document ceiling on vision page reads for THIS call.
 *
 * `pixelPageCount` is how many pages of this buffer actually need pixels (the
 * typed-text pages are free and exact and were never in the running). It is
 * what lets the 'document' scope scale with the document instead of
 * truncating.
 *
 * Precedence:
 *   1. Unattended → the tight budget, whatever the scope says. An unattended
 *      caller does not get to widen its own budget by declaring a scope.
 *   2. scope 'document' → every pixel page, clamped by
 *      OCR_VISION_MAX_PAGES_DOCUMENT, and never below the section budget (a
 *      document-scope read must not do WORSE than a section-scope one).
 *   3. scope 'section' → OCR_VISION_MAX_PAGES (8), unchanged.
 */
function resolveVisionPageBudget(
  opts: OcrExtractOpts,
  pixelPageCount: number,
): number {
  const full = envPositiveInt('OCR_VISION_MAX_PAGES', VISION_PAGE_BUDGET_DEFAULT);

  if (!resolveAttendance(opts)) {
    // Never let the unattended budget exceed the full one — an operator who
    // lowers OCR_VISION_MAX_PAGES during an incident means it for every caller.
    return Math.min(
      full,
      envPositiveInt(
        'OCR_VISION_MAX_PAGES_UNATTENDED',
        VISION_PAGE_BUDGET_UNATTENDED_DEFAULT,
      ),
    );
  }

  if (resolveBudgetScope(opts) === 'document') {
    const ceiling = envPositiveInt(
      'OCR_VISION_MAX_PAGES_DOCUMENT',
      VISION_PAGE_BUDGET_DOCUMENT_MAX_DEFAULT,
    );
    return Math.max(full, Math.min(pixelPageCount, ceiling));
  }

  return full;
}

/**
 * Everything about THIS call that can change which engine reads which page.
 *
 * The LRU below used to be keyed on the file hash alone, which made the result
 * a function of whoever asked FIRST: an unattended 3-page read of some bytes
 * would be served verbatim to a later document-scope read of the same bytes,
 * silently re-introducing the exact demotion this scope mechanism exists to
 * prevent. Folding the resolved policy into the key means identical callers
 * still share one expensive read (segmenter and bundle classifier on the same
 * bundle pay once) while a richer caller can never inherit a poorer read.
 *
 * Env vars are read here rather than captured at import time so the key
 * tracks an ops toggle the same way every other decision in this file does.
 */
function visionPolicyCacheKey(opts: OcrExtractOpts): string {
  return [
    resolveOcrEngine(),
    process.env.OCR_VISION_FALLBACK_DISABLED === 'true' ? 'killed' : 'live',
    opts.forceEngine ?? '-',
    opts.forceVisionAllPages === true ? 'allpages' : '-',
    opts.allowVisionFallback === false ? 'novision' : '-',
    resolveAttendance(opts) ? 'attended' : 'unattended',
    resolveBudgetScope(opts),
    envPositiveInt('OCR_VISION_MAX_PAGES', VISION_PAGE_BUDGET_DEFAULT),
    envPositiveInt(
      'OCR_VISION_MAX_PAGES_UNATTENDED',
      VISION_PAGE_BUDGET_UNATTENDED_DEFAULT,
    ),
    envPositiveInt(
      'OCR_VISION_MAX_PAGES_DOCUMENT',
      VISION_PAGE_BUDGET_DOCUMENT_MAX_DEFAULT,
    ),
    opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
  ].join('|');
}

function resolveVisionConcurrency(): number {
  return Math.min(
    VISION_CONCURRENCY_MAX,
    envPositiveInt('OCR_VISION_CONCURRENCY', VISION_CONCURRENCY_DEFAULT),
  );
}

function resolveVisionPagesPerCall(): number {
  return Math.min(
    VISION_PAGES_PER_CALL_MAX,
    envPositiveInt('OCR_VISION_PAGES_PER_CALL', VISION_PAGES_PER_CALL_DEFAULT),
  );
}

function resolveVisionEstPageCostInr(): number {
  return envPositiveFloat(
    'OCR_VISION_EST_PAGE_COST_INR',
    VISION_EST_PAGE_COST_INR_DEFAULT,
  );
}

function resolveVisionLatencyBudgetMs(): number {
  return envPositiveInt(
    'OCR_VISION_LATENCY_BUDGET_MS',
    VISION_LATENCY_BUDGET_MS_DEFAULT,
  );
}

/**
 * Split `items` into CONTIGUOUS chunks of at most `size`. Contiguous (rather
 * than round-robin) because the reader re-slices the PDF per call: keeping a
 * chunk's pages adjacent keeps that work cheap and keeps the cost-log page
 * order legible. With the default size of 1 this is simply "one page per
 * provider call", which is what makes the worker pool's width the real
 * parallelism.
 */
function chunkPages<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const step = Math.max(1, size);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    out.push(items.slice(i, i + step));
  }
  return out;
}

/**
 * How many pages an allowance buys, at an estimated per-page cost. Pure, so
 * the projection that decides whether a 40-page bundle is read by vision or by
 * Tesseract is testable without a database or a provider.
 *
 * Floors, never rounds: a page we can only half afford is a page we cannot
 * afford. A non-finite or non-positive estimate means we have no basis for a
 * projection, in which case we refuse to start rather than guess — the pump's
 * between-page re-check would still bound it, but starting a read whose cost we
 * cannot model is how a ₹15 cap became a stopped pipeline in the first place.
 */
export function affordableVisionPages(
  allowanceInr: number,
  estPerPageInr: number,
): number {
  if (!Number.isFinite(allowanceInr) || allowanceInr <= 0) return 0;
  if (!Number.isFinite(estPerPageInr) || estPerPageInr <= 0) return 0;
  return Math.max(0, Math.floor(allowanceInr / estPerPageInr));
}

// Tesseract-path render scale clamp. Tesseract has no 1568px ceiling — it
// wants MORE pixels, not fewer — so where the vision path targets ~1500px on
// the short edge, the Tesseract path clamps the aspect-aware scale into
// [2.0, 4.0]. The 2.0 floor is the value this service used unconditionally
// before aspect awareness existed, so no page renders smaller than it used to.
const TESSERACT_RENDER_SCALE_MIN = 2.0;
const TESSERACT_RENDER_SCALE_MAX = 4.0;

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
let _pdfLib: any = null;

async function loadPdfParse(): Promise<any> {
  // Only ever cache a *callable*. pdf-parse 1.x is a CJS module whose
  // module.exports IS the parse function; under both Node and tsx ESM
  // interop that surfaces as `mod.default`.
  //
  // We deliberately re-import on every call until we get a function, rather
  // than memoising whatever `import` returned. Memoising a non-callable was
  // the root cause of the 2026-06-01 incident: a transient pdf-parse@2.x
  // (which exports a `PDFParse` class, not a callable) got cached once, and
  // because the old guard was `if (!_pdfParse)` — truthy for a non-null
  // object — the process never re-imported. Every PDF in that worker failed
  // with "pdfParse is not a function" for hours, even after the on-disk
  // version was corrected, until a manual restart. Caching only functions
  // makes a corrected install self-heal on the very next job.
  if (typeof _pdfParse === 'function') return _pdfParse;

  const mod: any = await import('pdf-parse');
  const candidate =
    typeof mod === 'function'
      ? mod
      : typeof mod?.default === 'function'
        ? mod.default
        : typeof mod?.default?.default === 'function'
          ? mod.default.default
          : null;

  if (typeof candidate !== 'function') {
    const shape =
      mod && typeof mod === 'object'
        ? `{${Object.keys(mod).join(',')}}`
        : typeof mod;
    throw new OcrEngineUnavailableError(
      `pdf-parse did not resolve to a callable (module shape: ${shape}). ` +
        `This code path expects pdf-parse@^1.1.1 (a CJS-callable function). ` +
        `pdf-parse 2.x exports a PDFParse class and is incompatible — pin ` +
        `pdf-parse to ^1.1.1 in package.json and rebuild the worker image.`,
    );
  }

  _pdfParse = candidate;
  return _pdfParse;
}

/**
 * Run pdf-parse with a pagerender hook so per-page text comes back as an
 * array rather than one concatenated blob.
 *
 * Module-level (rather than a method) because BOTH the reader
 * (`OcrService.runPdfParse`) and the free CPU-only page census
 * (`censusPdfPages`, which the run cost estimator calls before a run exists)
 * need it. Two implementations of "what text does this page have" would let
 * the quote and the read disagree about which pages are pixels — i.e. quote a
 * price for work the reader does not do, or do work the quote never mentioned.
 *
 * Throws whatever pdf-parse throws; `extractTextFromPdf` maps those to its
 * error taxonomy and `censusPdfPages` swallows them into `degraded: true`.
 */
async function parsePdfPages(buffer: Buffer): Promise<{
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

async function loadPdfLib(): Promise<any> {
  if (!_pdfLib) {
    const mod: any = await import('pdf-lib');
    _pdfLib = mod?.default ?? mod;
  }
  return _pdfLib;
}

// ────────────────────────────────────────────────────────────────────────────
// Vision engine bridge (./extractor/)
//
// Loaded dynamically for the same reason every other engine here is: this
// module must import cleanly even when an optional piece of the vision stack
// is unavailable, and the deskew/tiling helpers are best-effort niceties on
// the Tesseract path. `transcribePagesViaVision` is the one hard dependency,
// and its loader throws OcrEngineUnavailableError so a missing barrel reads as
// an environment problem (never as `corrupted_pdf`).
// ────────────────────────────────────────────────────────────────────────────

type VisionTranscribeFn = (
  input: VisionTranscribeInput,
) => Promise<VisionTranscribeResult>;
type DeskewFn = (image: Buffer, opts?: any) => Promise<DeskewResult>;
type ChooseViewportScaleFn = (
  widthPt: number,
  heightPt: number,
  opts?: RenderScaleOptions,
) => RenderScaleDecision;

let _visionTranscribe: VisionTranscribeFn | null = null;
// `undefined` = never attempted, `null` = attempted and unavailable. The
// negative result is cached so a missing optional helper costs one failed
// import per process, not one per page.
let _deskewFn: DeskewFn | null | undefined;
let _chooseViewportScaleFn: ChooseViewportScaleFn | null | undefined;

async function loadVisionTranscriber(): Promise<VisionTranscribeFn> {
  if (_visionTranscribe) return _visionTranscribe;
  let mod: any;
  try {
    mod = await import('./extractor/index.js');
  } catch (err) {
    throw new OcrEngineUnavailableError(
      'vision extractor barrel (./extractor/index.js) failed to load — ' +
        'set OCR_ENGINE=tesseract to run without the vision reader.',
      err,
    );
  }
  const fn = mod?.transcribePagesViaVision ?? mod?.default?.transcribePagesViaVision;
  if (typeof fn !== 'function') {
    throw new OcrEngineUnavailableError(
      'transcribePagesViaVision is not exported by ./extractor/index.js ' +
        `(module shape: {${Object.keys(mod ?? {}).join(',')}})`,
    );
  }
  _visionTranscribe = fn as VisionTranscribeFn;
  return _visionTranscribe;
}

async function loadDeskew(): Promise<DeskewFn | null> {
  if (_deskewFn !== undefined) return _deskewFn;
  try {
    const mod: any = await import('./extractor/index.js');
    const fn = mod?.deskewImage ?? mod?.default?.deskewImage;
    _deskewFn = typeof fn === 'function' ? (fn as DeskewFn) : null;
  } catch (err) {
    logger.debug?.(
      { err: (err as any)?.message ?? String(err) },
      'OCR: deskew helper unavailable — preprocessing continues without it',
    );
    _deskewFn = null;
  }
  return _deskewFn;
}

async function loadChooseViewportScale(): Promise<ChooseViewportScaleFn | null> {
  if (_chooseViewportScaleFn !== undefined) return _chooseViewportScaleFn;
  try {
    const mod: any = await import('./extractor/index.js');
    const fn = mod?.chooseViewportScale ?? mod?.default?.chooseViewportScale;
    _chooseViewportScaleFn =
      typeof fn === 'function' ? (fn as ChooseViewportScaleFn) : null;
  } catch (err) {
    logger.debug?.(
      { err: (err as any)?.message ?? String(err) },
      'OCR: chooseViewportScale unavailable — falling back to fixed render scale',
    );
    _chooseViewportScaleFn = null;
  }
  return _chooseViewportScaleFn;
}

/**
 * Test seam: preload the lazily-imported engines with in-process fakes.
 *
 * Why this exists. Every engine in this module is pulled in with a dynamic
 * `import()` of a BARE specifier, and under ESM (this package is
 * "type":"module", run through tsx) there is no supported way for a test file
 * to intercept that. The suite used to patch `Module._resolveFilename` /
 * `Module._load`, which only ever worked while the codebase was CJS — under
 * the ESM loader those hooks are never consulted, so the "mocked" tests were
 * silently running the REAL pdf-parse against a 12-byte buffer and failing
 * with `corrupted_pdf`. Rather than leave the suite dead, the loaders (which
 * already memoise into module-scope variables) accept a preload.
 *
 * Production code never calls this. Pass `null` to drop every override and go
 * back to importing the real packages on the next call.
 *
 * `osdDetect` deliberately defaults to "OSD unavailable" when a Tesseract fake
 * is supplied: the real OSD worker downloads traineddata on first use, which
 * has no business happening in a unit test.
 */
export interface OcrEngineTestOverrides {
  pdfParse?: (buf: Buffer, opts?: any) => Promise<any>;
  pdfToPng?: (buf: Buffer, opts?: any) => Promise<Array<{ content: Buffer }>>;
  tesseractRecognize?: (image: any, lang: string) => Promise<any>;
  osdDetect?: (image: any) => Promise<{ data: any }>;
  visionTranscribe?: VisionTranscribeFn;
  /**
   * The rupee allowance resolver (normally costAccounting.getOcrReadAllowanceInr).
   *
   * A unit test has no Postgres, so the real resolver reports infinite spend
   * and correctly clamps every read to zero vision pages — which would make
   * every vision test in the suite pass vacuously. Injecting it here keeps the
   * budget path REAL in the tests that care about it (a test can hand back ₹11
   * and assert exactly two pages were read) instead of stubbed out globally.
   */
  costAllowance?: VisionCostAllowanceFn;
}

/** Resolver for "how many rupees may this read spend". */
export type VisionCostAllowanceFn = (
  opts: OcrExtractOpts,
) => Promise<{ allowanceInr: number; limitedBy: string; reason: string }>;

export function __setOcrEnginesForTests(
  overrides: OcrEngineTestOverrides | null,
): void {
  if (overrides === null) {
    _pdfParse = null;
    _pdfToPng = null;
    _tesseract = null;
    _visionTranscribe = null;
    _costAllowance = null;
    _osdWorker = null;
    _osdWorkerUnavailable = false;
    return;
  }

  if (overrides.pdfParse) _pdfParse = overrides.pdfParse;
  if (overrides.pdfToPng) _pdfToPng = { pdfToPng: overrides.pdfToPng };
  if (overrides.tesseractRecognize) {
    _tesseract = { recognize: overrides.tesseractRecognize };
    _osdWorker = null;
    _osdWorkerUnavailable = !overrides.osdDetect;
  }
  if (overrides.osdDetect) {
    _osdWorker = { detect: overrides.osdDetect };
    _osdWorkerUnavailable = false;
  }
  _visionTranscribe = overrides.visionTranscribe ?? null;
  _costAllowance = overrides.costAllowance ?? null;
}

/** Injected rupee-allowance resolver; null means "ask costAccounting". */
let _costAllowance: VisionCostAllowanceFn | null = null;

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
    // Two callers with the same bytes AND the same vision policy share one
    // read; a caller with a richer policy gets its own rather than silently
    // inheriting a starved one. See visionPolicyCacheKey.
    const cacheKey = `${fileHash}:${visionPolicyCacheKey(opts)}`;

    // Banner log so we can confirm OCR is being invoked and which buffer
    // it's working on. Promoted to info May 20, 2026 while debugging the
    // rotation-detection deployment that mysteriously produced no logs.
    logger.info(
      {
        file_hash_8: fileHash.slice(0, 8),
        bytes: buffer.length,
        // shouldStop is a closure; log its presence, not the function object.
        opts: { ...opts, shouldStop: opts.shouldStop ? 'supplied' : undefined },
        attended: resolveAttendance(opts),
        budget_scope: resolveBudgetScope(opts),
        tesseract_selected: tesseractExplicitlySelected(opts),
        run_id: opts.runId ?? null,
      },
      'OCR: extractTextFromPdf entered',
    );

    const cached = this.cache.get(cacheKey);
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
      const msg = String(err?.message || err);
      // An engine/dependency failure (missing or wrong-version pdf-parse) is
      // NOT a corrupt document — the file is fine, the parser isn't. Surface
      // it distinctly so it can't masquerade as `corrupted_pdf` and send the
      // next person debugging the PDF instead of the install.
      if (
        err instanceof OcrEngineUnavailableError ||
        /pdfParse is not a function|did not resolve to a callable/i.test(msg)
      ) {
        throw new OcrParseError('ocr_engine_unavailable', err);
      }
      // pdf-parse leaks encryption errors with a recognisable message —
      // surface that as a structured error so callers can route accordingly.
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
      this.cache.set(cacheKey, empty);
      return empty;
    }

    // 2. Per-page decision: typed text vs pixels.
    //
    // Pass 1 classifies every page WITHOUT doing any work, so that all the
    // pages needing pixels can be handed to the vision reader in one call —
    // one render pass over the PDF instead of one per page.
    const skipTypedLayer =
      opts.forceVisionAllPages === true || force === 'vision';
    const typedByPage = new Map<number, string>();
    const needPixels: number[] = [];

    for (let i = 0; i < parsed.numpages; i++) {
      const pageNumber = i + 1;
      const typedText = (parsed.pagesText[i] ?? '').trim();

      // Count word-like tokens (3+ consecutive Latin letters). For Hindi-
      // only pages this will return 0 — that's fine, we fall through to
      // the pixel path, where the vision reader handles Devanagari far
      // better than Tesseract's eng traineddata ever did. For garbled
      // pdf-parse output of rotated pages this also returns ~0, correctly
      // triggering the pixel path.
      const wordlikeTokens = (typedText.match(WORDLIKE_RE) ?? []).length;
      // The text test itself lives in the exported `pageHasUsableTypedText` so
      // the cost estimator counts pixel pages by the identical rule; the two
      // gates beside it are caller policy, not properties of the page.
      const hasUsableTypedText =
        !skipTypedLayer &&
        force !== 'tesseract' &&
        pageHasUsableTypedText(typedText);

      if (!hasUsableTypedText && typedText.length > 0) {
        logger.info(
          {
            pageNumber,
            typed_chars: typedText.length,
            wordlike_tokens: wordlikeTokens,
            threshold: TYPED_TEXT_MIN_WORDS,
            skip_typed_layer: skipTypedLayer,
            // `sample` text omitted — OCR'd letter content is PHI.
          },
          'OCR: pdf-parse text rejected — falling through to the pixel path',
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

      if (hasUsableTypedText) {
        typedByPage.set(pageNumber, typedText);
      } else {
        needPixels.push(pageNumber);
      }
    }

    // 3. ONE batched vision read for every page that needs pixels.
    const visionRead = await this.readPdfPagesViaVision(buffer, needPixels, opts);

    // 4. Assemble pages in order: typed layer → vision → (selected Tesseract
    //    | UNREADABLE). Page numbering is preserved unconditionally: every
    //    section boundary in this system is expressed in page numbers, so a
    //    dropped page would silently shift every boundary after it.
    const pages: OcrPage[] = [];
    const unreadablePages: OcrUnreadablePage[] = [];
    let tesseractVersion: string | undefined;
    let visionVersion: string | undefined;
    const tesseractSelected = tesseractExplicitlySelected(opts);

    for (let i = 0; i < parsed.numpages; i++) {
      const pageNumber = i + 1;

      const typedText = typedByPage.get(pageNumber);
      if (typedText !== undefined) {
        pages.push({
          pageNumber,
          text: typedText,
          confidence: TYPED_TEXT_CONFIDENCE,
          source: 'typed_pdf',
        });
        continue;
      }

      const visionPage = visionRead.byPage.get(pageNumber);
      if (visionPage) {
        visionVersion = visionVersion ?? visionRead.model;
        const page: OcrPage = {
          pageNumber,
          text: visionPage.text,
          confidence: visionPage.confidence,
          source: 'vision_fallback',
          tileCount: visionPage.tileCount,
          deskewAngleDeg: visionPage.deskewAngleDeg,
          warnings: [...(visionPage.warnings ?? []), 'used_vision_read'],
        };
        if (visionRead.model) page.visionModel = visionRead.model;
        pages.push(page);
        continue;
      }

      // This page has no typed layer and did not come back from vision.
      //
      // The per-page warning codes below are UNCHANGED and still emitted —
      // docBundleClassifier's INCOMPLETE_PAGE_WARNINGS set keys on them, and
      // breaking that would silently disarm the bundle quality gate.
      const fallbackWarnings = visionRead.attempted.has(pageNumber)
        ? ['vision_read_failed']
        : visionRead.costSkipped.has(pageNumber)
          ? ['vision_cost_budget_exceeded']
          : visionRead.latencySkipped.has(pageNumber)
            ? ['vision_latency_budget_exceeded']
            : visionRead.overBudget.has(pageNumber)
              ? ['vision_page_budget_exceeded']
              : [];

      // ── THE MANUAL SAFETY VALVE ──────────────────────────────────────────
      // Tesseract runs ONLY when somebody selected it. This is the whole of
      // the pre-2026-09 behaviour, unchanged, reached only through an explicit
      // choice — never as an automatic degrade.
      if (tesseractSelected) {
        try {
          const { text, confidence, version } = await this.ocrPage(buffer, pageNumber);
          tesseractVersion = tesseractVersion ?? version;

          const warnings: string[] = [...fallbackWarnings];
          if (confidence < minConfidence) warnings.push('low_confidence_ocr');

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
            warnings: [...fallbackWarnings, 'ocr_engine_error'],
          });
        }
        continue;
      }

      // ── UNREADABLE PAGE ──────────────────────────────────────────────────
      // No engine was selected to take over, so this page has no text and will
      // not get any without an operator action. Say exactly that, name the
      // action by naming the reason, keep the page in the array so numbering
      // holds, and CARRY ON with the remaining pages.
      const { reason, detail } = this.classifyUnreadablePage(
        pageNumber,
        visionRead,
      );
      const page: OcrPage = {
        pageNumber,
        text: '',
        confidence: 0,
        source: 'unreadable',
        unreadable: true,
        unreadableReason: reason,
        unreadableDetail: detail,
      };
      if (fallbackWarnings.length > 0) page.warnings = fallbackWarnings;
      pages.push(page);
      unreadablePages.push({ pageNumber, reason, detail });
    }

    const avgConfidence =
      pages.length === 0
        ? 0
        : pages.reduce((acc, p) => acc + p.confidence, 0) / pages.length;

    const engineVersions: OcrResult['engineVersions'] = {
      pdftotext: parsed.pdfVersion,
      tesseract: tesseractVersion,
    };
    if (visionVersion) engineVersions.vision = visionVersion;

    const result: OcrResult = {
      pages,
      totalPages: parsed.numpages,
      avgConfidence,
      processedAtMs: Date.now(),
      fileHash,
      engineVersions,
    };
    if (unreadablePages.length > 0) {
      result.unreadablePages = unreadablePages;
    }
    result.readablePageCount = pages.length - unreadablePages.length;

    // Document-level warnings. The three EXISTING codes are unchanged and
    // still emitted; each says "some pixel pages in this read were cut short
    // by a bound", which matters because a later per-section read of the same
    // pages may well succeed, and then the boundaries describe a transcription
    // nothing downstream sees. They are separate codes because they point at
    // different knobs.
    const resultWarnings: string[] = [];
    if (visionRead.costSkipped.size > 0) {
      resultWarnings.push('vision_cost_budget_clamped');
      logger.warn(
        {
          file_hash_8: fileHash.slice(0, 8),
          pixel_pages: needPixels.length,
          unread_pages: [...visionRead.costSkipped].sort((a, b) => a - b),
          spent_inr: visionRead.spentInr,
          limited_by: visionRead.allowanceLimitedBy,
          run_id: opts.runId ?? null,
          claim_id: opts.claimId ?? null,
          hospital_id: opts.hospitalId ?? null,
        },
        'OCR: vision read was clamped by its RUPEE allowance — these pages are ' +
          'UNREADABLE (reason cost_budget), not degraded. Approve more budget, ' +
          'or raise CLAIM_OCR_HARD_LIMIT_INR / OCR_VISION_MAX_COST_INR_PER_READ. ' +
          'The rest of the document still processed.',
      );
    }
    if (visionRead.latencySkipped.size > 0) {
      resultWarnings.push('vision_latency_budget_clamped');
      logger.warn(
        {
          file_hash_8: fileHash.slice(0, 8),
          pixel_pages: needPixels.length,
          unread_pages: [...visionRead.latencySkipped].sort((a, b) => a - b),
          latency_budget_ms: resolveVisionLatencyBudgetMs(),
        },
        'OCR: vision read was clamped by OCR_VISION_LATENCY_BUDGET_MS — these ' +
          'pages are UNREADABLE (reason latency_budget) so the job returned ' +
          'inside its budget. Raise OCR_VISION_CONCURRENCY or the latency budget.',
      );
    }
    // The ONE case where a document-scope read cannot guarantee that a later
    // per-section read of the same pages uses the same engine: the document
    // had more pixel pages than OCR_VISION_MAX_PAGES_DOCUMENT allows.
    if (visionRead.clampedByDocumentCeiling) {
      resultWarnings.push('vision_document_budget_clamped');
      logger.error(
        {
          file_hash_8: fileHash.slice(0, 8),
          total_pages: parsed.numpages,
          pixel_pages: needPixels.length,
          document_ceiling: envPositiveInt(
            'OCR_VISION_MAX_PAGES_DOCUMENT',
            VISION_PAGE_BUDGET_DOCUMENT_MAX_DEFAULT,
          ),
          unread_pages: [...visionRead.overBudget].sort((a, b) => a - b),
        },
        'OCR: document-scope vision budget clamped — these pages are UNREADABLE ' +
          'here (reason page_budget) though a later per-section read may reach ' +
          'them. Raise OCR_VISION_MAX_PAGES_DOCUMENT or split the bundle.',
      );
    }

    // ── NEW doc-level codes ────────────────────────────────────────────────
    if (tesseractSelected) {
      // Present so a Tesseract read is never mistaken for a vision read in an
      // audit six months from now.
      resultWarnings.push('tesseract_engine_selected');
    }
    if (unreadablePages.length > 0) {
      resultWarnings.push('unreadable_pages');
      if (unreadablePages.length === pages.length && pages.length > 0) {
        // Load-bearing for the consumers: on this code they must NOT call an
        // LLM. There is nothing on the page to reason about, and a model asked
        // to classify an empty string will confabulate a category.
        resultWarnings.push('all_pages_unreadable');
      }
      logger.warn(
        {
          file_hash_8: fileHash.slice(0, 8),
          total_pages: parsed.numpages,
          unreadable: unreadablePages.length,
          readable: result.readablePageCount,
          by_reason: unreadablePages.reduce<Record<string, number>>((acc, p) => {
            acc[p.reason] = (acc[p.reason] ?? 0) + 1;
            return acc;
          }, {}),
          run_id: opts.runId ?? null,
          claim_id: opts.claimId ?? null,
        },
        'OCR: some pages could not be read and carry NO text. They are flagged ' +
          'unreadable with a reason; the remaining pages processed normally.',
      );
    }
    if (visionRead.runBudgetExhausted) {
      // The consumer keys on this to pause the run for cost consent. This
      // service does not own run state and never pauses anything itself.
      resultWarnings.push('run_budget_exhausted');
      logger.warn(
        {
          file_hash_8: fileHash.slice(0, 8),
          run_id: opts.runId ?? null,
          claim_id: opts.claimId ?? null,
          unread_pages: [...visionRead.costSkipped].sort((a, b) => a - b),
          spent_inr: visionRead.spentInr,
        },
        "OCR: the RUN's approved budget — not a static cap — is what stopped " +
          'this read. The caller must pause the run for cost consent.',
      );
    }
    if (resultWarnings.length > 0) result.warnings = resultWarnings;

    // CACHE ADMISSION. The cache key deliberately does NOT carry the rupee
    // allowance: it carries the vision POLICY, and the spend headroom is not
    // policy — it is a moving number. Folding it in would mean docSegmenter and
    // docBundleClassifier, which read the same bundle back-to-back, each paid
    // the full ~₹217 instead of sharing one read, which is the opposite of what
    // a spend bound is for. That read-sharing is the whole point of this cache
    // and is preserved exactly.
    //
    // What is NOT preserved is storing a read that a MOVING bound cut short.
    // Because the allowance is not in the key, a truncated result would be
    // replayed to the identical caller after the bound moved, and mid-run cost
    // consent would be a permanent no-op: run pauses → user approves more
    // budget → resume re-arms the row → same worker, same key → cache HIT →
    // the identical result with 'run_budget_exhausted' still on it → pauses
    // again having spent ₹0. The user could approve forever and those pages
    // would never be read.
    //
    // So: a read bounded by RUPEES (costSkipped / runBudgetExhausted) or by
    // WALL CLOCK (latencySkipped) is returned to this caller and then dropped.
    // Both bounds are outside the key and can change between calls without any
    // caller changing anything. `clampedByDocumentCeiling` is deliberately NOT
    // in this list: the page budget IS policy, it IS in the key, and a caller
    // with a richer page budget already gets its own entry.
    //
    // (The third truncation — a cooperative pause — never gets here at all:
    // OcrPausedError is thrown before this line. See OcrPausedError.)
    const truncatedByMovingBound =
      visionRead.costSkipped.size > 0 ||
      visionRead.latencySkipped.size > 0 ||
      visionRead.runBudgetExhausted;

    if (truncatedByMovingBound) {
      logger.info(
        {
          file_hash_8: fileHash.slice(0, 8),
          cost_skipped: visionRead.costSkipped.size,
          latency_skipped: visionRead.latencySkipped.size,
          run_budget_exhausted: visionRead.runBudgetExhausted,
          run_id: opts.runId ?? null,
          claim_id: opts.claimId ?? null,
        },
        'OCR: NOT caching this read — it was cut short by a rupee or latency ' +
          'bound, which is not part of the cache key. Caching it would replay ' +
          'the truncation after the budget moved and make cost consent a no-op.',
      );
      return result;
    }

    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Is the Claude Vision reader allowed for this call? Gates, in precedence
   * order:
   *   1. OCR_VISION_FALLBACK_DISABLED=true → never. It is the hard kill-switch
   *      and outranks even explicit caller intent, because the reason to flip
   *      it (a provider incident, a spend freeze) is exactly the reason a
   *      caller's forceVisionAllPages must not punch through.
   *   2. forceEngine 'tesseract' / 'pdftotext' → never (explicit caller intent).
   *   3. forceEngine 'vision' or forceVisionAllPages → always (ditto).
   *   4. OCR_ENGINE=tesseract → never (the deploy-free revert switch).
   *   5. Otherwise: the caller hasn't opted out via allowVisionFallback:false.
   *
   * Note `allowVisionFallback` DEFAULTS TO TRUE here, matching the existing
   * image path (maybeEscalateToVision has always defaulted it true). The old
   * PDF stub only looked at it when it was explicitly truthy, but since that
   * branch merely appended a warning string, defaulting it true now changes
   * no caller's contract — no production caller passes the flag at all.
   */
  private visionReadEnabled(opts: OcrExtractOpts): boolean {
    if (process.env.OCR_VISION_FALLBACK_DISABLED === 'true') return false;
    if (opts.forceEngine === 'tesseract' || opts.forceEngine === 'pdftotext') {
      return false;
    }
    if (opts.forceEngine === 'vision' || opts.forceVisionAllPages === true) {
      return true;
    }
    return (
      resolveOcrEngine() !== 'tesseract' && (opts.allowVisionFallback ?? true)
    );
  }

  /**
   * WHY is this page unreadable? Derived from the sets `readPdfPagesViaVision`
   * returns, evaluated in the order below — FIRST MATCH WINS, and the order is
   * not arbitrary:
   *
   *   renderFailed   first, because a page that never became an image is a
   *                  different problem from a page the model read badly, and
   *                  it is the one reason more money/time/retries cannot fix.
   *   attempted      next: we sent it and got nothing usable back.
   *   costSkipped / latencySkipped / overBudget: never dispatched, each for a
   *                  different reason with a different operator action.
   *   vision disabled entirely, then the residual case.
   *
   * Every `detail` is short, PHI-free and safe to show an operator — it says
   * what happened to the PAGE, never what was on it.
   */
  private classifyUnreadablePage(
    pageNumber: number,
    visionRead: {
      renderFailed: Set<number>;
      attempted: Set<number>;
      costSkipped: Set<number>;
      latencySkipped: Set<number>;
      overBudget: Set<number>;
      visionDisabled: boolean;
      allowanceLimitedBy: string;
    },
  ): { reason: UnreadableReason; detail: string } {
    if (visionRead.renderFailed.has(pageNumber)) {
      return {
        reason: 'render_failed',
        detail: unreadableDetail(
          'the page never rendered to an image (pdf slice / render / tiler ' +
            'failure) — re-upload the document',
        ),
      };
    }
    if (visionRead.attempted.has(pageNumber)) {
      return {
        reason: 'vision_failed',
        detail: unreadableDetail(
          'the page was sent to the vision reader and came back with no usable ' +
            'transcription',
        ),
      };
    }
    if (visionRead.costSkipped.has(pageNumber)) {
      return {
        reason: 'cost_budget',
        detail: unreadableDetail(
          `never dispatched — the read ran out of rupees (limited by ${visionRead.allowanceLimitedBy})`,
        ),
      };
    }
    if (visionRead.latencySkipped.has(pageNumber)) {
      return {
        reason: 'latency_budget',
        detail: unreadableDetail(
          'never dispatched — the read ran out of wall clock ' +
            '(OCR_VISION_LATENCY_BUDGET_MS)',
        ),
      };
    }
    if (visionRead.overBudget.has(pageNumber)) {
      return {
        reason: 'page_budget',
        detail: unreadableDetail(
          'never dispatched — past this read’s page-count budget',
        ),
      };
    }
    if (visionRead.visionDisabled) {
      // Kill switch, allowVisionFallback:false, or a missing extractor barrel,
      // with no engine selected to take over. 'vision_failed' is the right
      // member: the action is to restore the reader and retry.
      return {
        reason: 'vision_failed',
        detail: unreadableDetail('vision_disabled'),
      };
    }
    return {
      reason: 'vision_failed',
      detail: unreadableDetail('no_transcription_returned'),
    };
  }

  /**
   * Read the given PDF pages with Claude Vision, bounded on every axis.
   *
   * Four bounds, all deliberate:
   *
   *   - PAGE BUDGET. `resolveVisionPageBudget` returns the tight unattended
   *     budget for a call with no claim context, the document's own pixel-page
   *     count (clamped) for a 'document'-scope call, and the fixed section
   *     budget otherwise. Pages past it are recorded in `overBudget` and come
   *     back UNREADABLE with reason 'page_budget'.
   *   - RUPEES. `costAccounting.getOcrReadAllowanceInr` says what this read may
   *     spend — including, when `opts.runId` is set, the run's own remaining
   *     approved budget. The page budget is clamped to what that allowance buys
   *     BEFORE the first call, and `runVisionPagePump` re-checks accumulated
   *     ACTUAL spend between pages. Pages we cannot pay for land in
   *     `costSkipped` and come back UNREADABLE with reason 'cost_budget'. A
   *     budget problem never fails the read and never throws, because a throw
   *     here becomes a dead-lettered claim three retries later.
   *   - WALL CLOCK. OCR_VISION_LATENCY_BUDGET_MS bounds the read the same way:
   *     past it, undispatched pages land in `latencySkipped`.
   *   - CONCURRENCY. OCR_VISION_CONCURRENCY workers, one page per provider
   *     call, each holding a shared `acquireLlmSlot` slot.
   *
   * Never throws, with ONE documented exception: `OcrPausedError`, and only
   * when the caller supplied `opts.shouldStop`. Everything else (barrel
   * missing, provider error, a page rejecting) leaves those pages out of the
   * map, and the assembly loop turns them into unreadable pages carrying the
   * reason — which is what the sets returned here are for.
   */
  private async readPdfPagesViaVision(
    buffer: Buffer,
    pageNumbers: number[],
    opts: OcrExtractOpts,
  ): Promise<VisionPdfReadOutcome> {
    const byPage = new Map<number, VisionTranscribedPage>();
    const attempted = new Set<number>();
    const overBudget = new Set<number>();
    const renderFailed = new Set<number>();
    const empty: VisionPdfReadOutcome = {
      byPage,
      attempted,
      overBudget,
      renderFailed,
      costSkipped: new Set<number>(),
      latencySkipped: new Set<number>(),
      clampedByDocumentCeiling: false,
      spentInr: 0,
      visionDisabled: false,
      runBudgetExhausted: false,
      allowanceLimitedBy: 'not_evaluated',
    };
    const scope = resolveBudgetScope(opts);

    if (pageNumbers.length === 0) {
      return empty;
    }

    if (!this.visionReadEnabled(opts)) {
      logger.info(
        {
          pages: pageNumbers.length,
          ocr_engine: resolveOcrEngine(),
          tesseract_selected: tesseractExplicitlySelected(opts),
        },
        tesseractExplicitlySelected(opts)
          ? 'OCR: vision read disabled — Tesseract is the SELECTED engine, pixel ' +
              'pages read on it'
          : 'OCR: vision read disabled and no engine selected — every pixel page ' +
              'will be UNREADABLE. Set OCR_ENGINE=tesseract to keep reading ' +
              'without vision.',
      );
      return { ...empty, visionDisabled: true };
    }

    const attended = resolveAttendance(opts);
    // pageNumbers IS the pixel-page count — the typed-text pages never got
    // here. That is precisely what a 'document'-scope budget scales to.
    const pageBudget = resolveVisionPageBudget(opts, pageNumbers.length);

    // ── THE RUPEE BOUND (NEW-2) ──────────────────────────────────────────
    //
    // The page budget above is a bound on COUNT. On the measured numbers a
    // document-scope read of a 40-page A4 bundle is ~₹217, so a count bound
    // alone let one read outspend an entire claim's budget and — because the
    // spend was then attributed to the claim — blocked the classify and
    // extract calls that were supposed to follow it. The claim dead-lettered
    // without ever being classified.
    //
    // So before anything is dispatched we ask what this read may spend, and
    // convert that to pages using the measured per-page estimate. Whichever
    // of the two bounds is tighter wins. Failing to reach the budget service
    // yields an allowance of ₹0, which makes every pixel page unreadable —
    // a visible, actionable hole, never a stopped claim and never a silent
    // substitution.
    //
    // When `opts.runId` is set, the allowance additionally intersects the RUN's
    // remaining approved budget, and `limitedBy === 'run_budget'` says so. That
    // is the ONLY signal distinguishing "this claim is out of OCR budget" (a
    // static cap; an operator raises it) from "this RUN needs more consent" (a
    // user decision; the consumer pauses and asks).
    const estPageCostInr = resolveVisionEstPageCostInr();
    const allowance = await this.resolveVisionCostAllowance(opts);
    const affordablePages = affordableVisionPages(
      allowance.allowanceInr,
      estPageCostInr,
    );
    const budget = Math.min(pageBudget, affordablePages);

    const wanted = pageNumbers.slice(0, budget);
    // Pages inside the PAGE budget that only the RUPEE budget rejected are
    // reported as a cost clamp, not as "the document was too long" — those are
    // different operator actions (raise the spend cap vs split the bundle) and
    // conflating them sends the next person to the wrong knob.
    const costSkipped = new Set<number>(pageNumbers.slice(budget, pageBudget));
    for (const p of pageNumbers.slice(pageBudget)) overBudget.add(p);

    const clampedByDocumentCeiling =
      scope === 'document' && attended && overBudget.size > 0;

    if (costSkipped.size > 0) {
      logger.warn(
        {
          allowance_inr: Math.round(allowance.allowanceInr * 100) / 100,
          limited_by: allowance.limitedBy,
          reason: allowance.reason,
          est_page_cost_inr: estPageCostInr,
          page_budget: pageBudget,
          affordable_pages: affordablePages,
          pixel_pages: pageNumbers.length,
          run_id: opts.runId ?? null,
          claim_id: opts.claimId ?? null,
          hospital_id: opts.hospitalId ?? null,
        },
        'OCR: vision read is RUPEE-CLAMPED — the pages it cannot pay for are ' +
          'UNREADABLE (reason cost_budget). The claim still classifies and ' +
          'extracts everything else; those pages carry no text at all.',
      );
    }

    if (overBudget.size > 0) {
      logger.warn(
        {
          budget,
          attended,
          scope,
          requested: pageNumbers.length,
          unreadable_pages: overBudget.size,
        },
        !attended
          ? 'OCR: unattended vision page budget exceeded (no claim context) — the remaining pages are unreadable'
          : clampedByDocumentCeiling
            ? 'OCR: document-scope vision budget hit OCR_VISION_MAX_PAGES_DOCUMENT — the remaining pages are unreadable'
            : 'OCR: vision page budget exceeded — the remaining pages are unreadable',
      );
    }

    const started = Date.now();
    const latencyBudgetMs = resolveVisionLatencyBudgetMs();
    const concurrency = resolveVisionConcurrency();
    const pagesPerCall = resolveVisionPagesPerCall();
    const latencySkipped = new Set<number>();

    if (wanted.length === 0) {
      logger.warn(
        {
          pixel_pages: pageNumbers.length,
          allowance_inr: Math.round(allowance.allowanceInr * 100) / 100,
          limited_by: allowance.limitedBy,
          reason: allowance.reason,
          page_budget: pageBudget,
          run_id: opts.runId ?? null,
        },
        'OCR: vision read has no affordable pages — every pixel page in this ' +
          'document is UNREADABLE (reason cost_budget). Nothing is blocked and ' +
          'no text is fabricated; the user is asked to approve more budget.',
      );
      return {
        ...empty,
        byPage,
        attempted,
        overBudget,
        costSkipped,
        latencySkipped,
        clampedByDocumentCeiling,
        spentInr: 0,
        allowanceLimitedBy: allowance.limitedBy,
        runBudgetExhausted:
          allowance.limitedBy === RUN_BUDGET_LIMIT_DIMENSION && costSkipped.size > 0,
      };
    }

    let transcribe: VisionTranscribeFn;
    try {
      transcribe = await loadVisionTranscriber();
    } catch (err) {
      // The reader itself is missing/broken. These pages were never sent, but
      // the operator action is the same as a failed send — restore the reader
      // and retry — so they are attributed 'vision_failed' via visionDisabled
      // rather than being dressed up as a budget problem.
      logger.error(
        {
          err: (err as any)?.message ?? String(err),
          pages: wanted.length,
        },
        'OCR: vision reader unavailable — these pages are UNREADABLE. Set ' +
          'OCR_ENGINE=tesseract if you need reading to continue without it.',
      );
      return {
        ...empty,
        byPage,
        attempted,
        overBudget,
        costSkipped,
        latencySkipped,
        clampedByDocumentCeiling,
        spentInr: 0,
        visionDisabled: true,
        allowanceLimitedBy: allowance.limitedBy,
      };
    }

    // Projected wall time, stated up front so a long read is visible in the
    // logs BEFORE it happens rather than inferred from a job that timed out.
    logger.info(
      {
        pages: wanted.length,
        concurrency,
        pages_per_call: pagesPerCall,
        allowance_inr: Math.round(allowance.allowanceInr * 100) / 100,
        est_cost_inr: Math.round(wanted.length * estPageCostInr * 100) / 100,
        latency_budget_ms: latencyBudgetMs,
        limited_by: allowance.limitedBy,
        pausable: Boolean(opts.shouldStop),
        run_id: opts.runId ?? null,
        claim_id: opts.claimId ?? null,
      },
      'OCR: vision page pump starting',
    );

    // NOTE: a pause raises OcrPausedError out of the pump and straight out of
    // extractTextFromPdf, deliberately un-caught here — see OcrPausedError.
    const pump = await this.runVisionPagePump({
      buffer,
      pages: wanted,
      opts,
      transcribe,
      allowanceInr: allowance.allowanceInr,
      estPageCostInr,
      concurrency,
      pagesPerCall,
      latencyBudgetMs,
      startedAtMs: started,
    });

    for (const [pageNumber, page] of pump.byPage) byPage.set(pageNumber, page);
    for (const p of pump.attempted) attempted.add(p);
    for (const p of pump.costSkipped) costSkipped.add(p);
    for (const p of pump.latencySkipped) latencySkipped.add(p);
    for (const p of pump.renderFailed) renderFailed.add(p);

    // The run's approved budget is the ONE rupee dimension whose remedy is a
    // user decision rather than an ops change, so it is reported separately.
    // Both shapes count: the pre-dispatch clamp (the run had no headroom when
    // the read started) and the mid-pump stop (it ran out between pages).
    const runBudgetExhausted =
      allowance.limitedBy === RUN_BUDGET_LIMIT_DIMENSION && costSkipped.size > 0;

    logger.info(
      {
        requested: wanted.length,
        dispatched: pump.attempted.size,
        transcribed: byPage.size,
        calls: pump.callsMade,
        calls_failed: pump.callsFailed,
        concurrency,
        pages_per_call: pagesPerCall,
        cost_skipped: costSkipped.size,
        latency_skipped: latencySkipped.size,
        render_failed: renderFailed.size,
        run_budget_exhausted: runBudgetExhausted,
        attended,
        scope,
        budget,
        page_budget: pageBudget,
        allowance_inr: Math.round(allowance.allowanceInr * 100) / 100,
        limited_by: allowance.limitedBy,
        model: pump.model,
        cost_inr: Math.round(pump.spentInr * 10000) / 10000,
        latency_ms: Date.now() - started,
        latency_budget_ms: latencyBudgetMs,
        tokens_in: pump.tokensInput,
        tokens_out: pump.tokensOutput,
        run_id: opts.runId ?? null,
      },
      byPage.size === 0
        ? 'OCR: vision read produced nothing — every requested page is unreadable'
        : 'OCR: vision read completed',
    );

    return {
      byPage,
      model: pump.model,
      attempted,
      overBudget,
      costSkipped,
      latencySkipped,
      renderFailed,
      clampedByDocumentCeiling,
      spentInr: pump.spentInr,
      visionDisabled: false,
      runBudgetExhausted,
      allowanceLimitedBy: allowance.limitedBy,
    };
  }

  /**
   * Ask the budget service what this read may spend. Never throws — a budget
   * service that is down must produce unreadable pages, not a failed claim.
   *
   * `opts.runId` is passed down so `getOcrReadAllowanceInr` can intersect one
   * more dimension: the run's approved budget minus what the run has already
   * spent. That is ENFORCEMENT POINT 1 of the mid-run cost consent — the only
   * place a per-page OCR spend can be bounded by a number the user approved,
   * because a pre-flight check cannot bound the call it authorises.
   *
   * Imported lazily for the same reason `ocrViaVision` does it: costAccounting
   * pulls in the pg pool, and this service is consumed by docSegmenter which is
   * consumed by the LLM bridge in some test paths.
   */
  private async resolveVisionCostAllowance(
    opts: OcrExtractOpts,
  ): Promise<{ allowanceInr: number; limitedBy: string; reason: string }> {
    try {
      if (_costAllowance) return await _costAllowance(opts);
      const costAccounting = (await import('./costAccounting.service.js')).default;
      // Called through a widened signature: the run dimension is an optional
      // trailing argument on costAccounting's side, and this file must keep
      // compiling while that lands. An older build simply ignores it, which
      // costs the run-budget tightening here (enforcement point 2, the
      // pre-LLM-call checkBudget, still holds) and never mis-reports a number.
      const allowance = await (
        costAccounting.getOcrReadAllowanceInr as unknown as (
          claimId?: string | null,
          hospitalId?: string | null,
          db?: unknown,
          runOpts?: { runId?: string | null },
        ) => Promise<{ allowanceInr: number; limitedBy: string; reason: string }>
      )(opts.claimId ?? null, opts.hospitalId ?? null, undefined, {
        runId: opts.runId ?? null,
      });
      return {
        allowanceInr: allowance.allowanceInr,
        limitedBy: allowance.limitedBy,
        reason: allowance.reason,
      };
    } catch (err) {
      // Fail CLOSED on spend, OPEN on the pipeline: no vision pages, so those
      // pages come back unreadable with a reason — nothing downstream blocks,
      // and nothing downstream is handed text we did not actually read.
      logger.error(
        { err: (err as any)?.message ?? String(err), run_id: opts.runId ?? null },
        'OCR: could not resolve the vision cost allowance — vision disabled ' +
          'for this read; every pixel page will be UNREADABLE',
      );
      return {
        allowanceInr: 0,
        limitedBy: 'budget_query_failed',
        reason: 'cost allowance lookup threw',
      };
    }
  }

  /**
   * Dispatch `pages` to the vision reader under a rupee bound, a wall-clock
   * bound and a concurrency bound, all three enforced BETWEEN calls.
   *
   * The shape is a worker pool over a shared queue rather than N fixed lanes,
   * for two reasons:
   *
   *   1. LATENCY (NEW-4). `transcribePagesViaVision` walks the pages of one
   *      call sequentially, so a fixed lane of 14 pages is 14 serial
   *      round-trips however many lanes run beside it. One page per call makes
   *      the pool width the actual parallelism, and a slow page delays only
   *      itself instead of everything queued behind it in its lane.
   *   2. SPEND. A bound you can only apply before dispatch is not a bound. A
   *      shared queue lets every worker re-read accumulated ACTUAL spend before
   *      it takes the next page, which is the only place a per-call cost can
   *      actually be stopped.
   *
   * Concurrent accounting detail: a worker RESERVES the projected cost of its
   * page before dispatching and reconciles the reservation against the actual
   * cost when the call returns. Without the reservation, N workers all read the
   * same stale total and all pass the same check, overshooting the allowance by
   * up to N pages. A call that THROWS keeps its reservation — Anthropic bills
   * partial responses, so assuming a failed call was free is the wrong
   * direction to be wrong in.
   *
   * PAUSE. `opts.shouldStop` is consulted in the same between-pages place the
   * latency budget is, and for the same reason: it is the only point at which
   * stopping costs nothing and abandons nothing. A pause never cancels a call
   * that is already billing, and never interrupts a transaction. When a worker
   * observes the pause every worker winds down, the in-flight calls complete
   * and are billed, and then the pump raises OcrPausedError — the ONE way this
   * function does not return normally.
   *
   * Never throws, except OcrPausedError.
   */
  private async runVisionPagePump(params: {
    buffer: Buffer;
    pages: number[];
    opts: OcrExtractOpts;
    transcribe: VisionTranscribeFn;
    allowanceInr: number;
    estPageCostInr: number;
    concurrency: number;
    pagesPerCall: number;
    latencyBudgetMs: number;
    startedAtMs: number;
  }): Promise<{
    byPage: Map<number, VisionTranscribedPage>;
    model?: string;
    attempted: Set<number>;
    costSkipped: Set<number>;
    latencySkipped: Set<number>;
    renderFailed: Set<number>;
    spentInr: number;
    tokensInput: number;
    tokensOutput: number;
    callsMade: number;
    callsFailed: number;
  }> {
    const {
      buffer,
      pages,
      opts,
      transcribe,
      allowanceInr,
      estPageCostInr,
      concurrency,
      pagesPerCall,
      latencyBudgetMs,
      startedAtMs,
    } = params;

    const byPage = new Map<number, VisionTranscribedPage>();
    const attempted = new Set<number>();
    const costSkipped = new Set<number>();
    const latencySkipped = new Set<number>();
    const renderFailed = new Set<number>();

    const queue = chunkPages(pages, pagesPerCall);
    let model: string | undefined;
    let spentInr = 0;
    let tokensInput = 0;
    let tokensOutput = 0;
    let callsMade = 0;
    let callsFailed = 0;
    // Actuals observed in THIS read. Once we have any, they beat the static
    // env estimate — a sparse discharge summary and a dense itemised bill
    // differ by 3-4x and the static number cannot know which one this is.
    let observedPages = 0;
    let observedInr = 0;
    let stopReason: 'cost' | 'latency' | 'paused' | null = null;

    const projectedPageCostInr = (): number =>
      observedPages > 0 && observedInr > 0
        ? observedInr / observedPages
        : estPageCostInr;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (stopReason) return;
        if (queue.length === 0) return;

        // ── THE PAUSE CHECKPOINT ─────────────────────────────────────────
        // Between units of work, before anything is peeked, reserved or
        // dispatched. The hook reads Postgres (memoised), because the pause
        // was set by a different container and a process-local flag would be
        // invisible here. A hook that THROWS is treated as "not paused": an
        // unreachable run row must not wedge every OCR worker in the fleet.
        //
        // CRITICAL ORDERING: this is the only `await` in the loop before the
        // chunk is taken, and it happens BEFORE the peek. Awaiting between
        // `queue[0]` and `queue.shift()` would hand the SAME chunk to every
        // worker that was parked on the await and silently drop the chunks
        // they should have taken — the take below is atomic only because no
        // await separates the peek from the shift.
        if (opts.shouldStop) {
          let halted = false;
          try {
            halted = await opts.shouldStop();
          } catch (err) {
            logger.warn(
              { err: (err as any)?.message ?? String(err) },
              'OCR: shouldStop hook threw — treating the run as NOT paused and ' +
                'continuing. The static budget bounds still apply.',
            );
          }
          if (halted) {
            stopReason = 'paused';
            return;
          }
          // Another worker may have stopped the pump, or drained the queue,
          // while this one was awaiting.
          if (stopReason) return;
        }

        if (Date.now() - startedAtMs >= latencyBudgetMs) {
          stopReason = 'latency';
          return;
        }

        // ── ATOMIC TAKE: no `await` from here to the shift ───────────────
        const next = queue[0];
        if (!next) return;

        const reservation = projectedPageCostInr() * next.length;
        if (spentInr + reservation > allowanceInr) {
          stopReason = 'cost';
          return;
        }

        queue.shift();
        spentInr += reservation;
        for (const p of next) attempted.add(p);
        callsMade++;

        // Share the process-wide Anthropic ceiling rather than fanning out
        // beside it. Released in the finally so a throw cannot leak a slot.
        const releaseSlot = await acquireLlmSlot(VISION_READ_SLOT_MODEL);
        let res: VisionTranscribeResult | null = null;
        try {
          res = await transcribe({
            source: buffer,
            kind: 'pdf',
            pageNumbers: next,
            // The reader defaults to 8 pages (the extractor's MAX_VISION_PAGES
            // budget). We have already applied our own budget and chunked it,
            // so ask for exactly this chunk — otherwise its tail pages silently
            // vanish.
            maxPages: next.length,
            claimId: opts.claimId ?? null,
            hospitalId: opts.hospitalId ?? null,
            taskName: VISION_READ_TASK_PDF,
          });
        } catch (err) {
          callsFailed++;
          // Reservation stands: a rejected call may still have been billed.
          logger.warn(
            {
              err: (err as any)?.message ?? String(err),
              call_pages: next,
            },
            'OCR: vision call failed — those pages fall back to Tesseract',
          );
          continue;
        } finally {
          releaseSlot();
        }
        /* c8 ignore next */
        if (!res) continue;

        for (const page of res.pages ?? []) {
          // An empty transcription is a per-page failure by contract — leave it
          // out of the map. It becomes an unreadable page downstream.
          if (typeof page?.text === 'string' && page.text.trim().length > 0) {
            byPage.set(page.pageNumber, page);
            continue;
          }
          // …but WHY it is empty decides what the operator is told. A page the
          // model never saw an image of (slice/render/tile failure) needs the
          // document re-uploaded; a page the model saw and could not read
          // needs a retry. Only visionRead knows which, and it says so in the
          // page's own warnings.
          if ((page?.warnings ?? []).some((w) => RENDER_FAILURE_WARNINGS.has(w))) {
            renderFailed.add(page.pageNumber);
          }
        }
        model = model ?? res.model;
        tokensInput += res.tokensInput ?? 0;
        tokensOutput += res.tokensOutput ?? 0;

        const actualInr = Number(res.costInr);
        if (Number.isFinite(actualInr) && actualInr >= 0) {
          // Reconcile the reservation against what it really cost.
          spentInr += actualInr - reservation;
          observedPages += next.length;
          observedInr += actualInr;
        }
      }
    };

    // Promise.all, not race: every worker winds down on its own checkpoint and
    // every in-flight provider call is awaited to completion. Abandoning a call
    // that is already billing would cost the money and lose the page.
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, () =>
        worker(),
      ),
    );

    const undispatched = queue.flat();

    // ── PAUSED ────────────────────────────────────────────────────────────
    // Raise rather than return. A partial transcription returned here would be
    // written to doc_phase_ledger as 'done' and the resume — the whole point of
    // which is to buy the pages that were missed — would inherit it. Throwing
    // also means extractTextFromPdf never reaches `cache.set`, so no truncated
    // result is left behind for the next caller with the same policy.
    if (stopReason === 'paused') {
      logger.info(
        {
          run_id: opts.runId ?? null,
          claim_id: opts.claimId ?? null,
          pages_read: byPage.size,
          pages_remaining: undispatched.length,
          spent_inr: Math.round(observedInr * 10000) / 10000,
        },
        'OCR: run paused mid-read — discarding this partial transcription and ' +
          'raising OcrPausedError. Nothing is cached; the resume re-reads this ' +
          'document from page one.',
      );
      throw new OcrPausedError({
        runId: opts.runId ?? null,
        pagesRead: byPage.size,
        pagesRemaining: undispatched.length,
      });
    }

    // Everything still queued when the pump stopped is UNREADABLE, tagged with
    // WHY — the two reasons point at different actions.
    if (undispatched.length > 0) {
      const target = stopReason === 'latency' ? latencySkipped : costSkipped;
      for (const p of undispatched) target.add(p);
      logger.warn(
        {
          stop_reason: stopReason ?? 'unknown',
          undispatched: undispatched.length,
          spent_inr: Math.round(spentInr * 100) / 100,
          allowance_inr: Math.round(allowanceInr * 100) / 100,
          elapsed_ms: Date.now() - startedAtMs,
          latency_budget_ms: latencyBudgetMs,
          observed_page_cost_inr:
            observedPages > 0
              ? Math.round((observedInr / observedPages) * 100) / 100
              : null,
          run_id: opts.runId ?? null,
          claim_id: opts.claimId ?? null,
        },
        stopReason === 'latency'
          ? 'OCR: vision read hit OCR_VISION_LATENCY_BUDGET_MS mid-run — the ' +
              'remaining pages are UNREADABLE so the job returns'
          : 'OCR: vision read exhausted its rupee allowance mid-run — the ' +
              'remaining pages are UNREADABLE. The claim is NOT blocked and the ' +
              'rest of the document still processed.',
      );
    }

    return {
      byPage,
      model,
      attempted,
      costSkipped,
      latencySkipped,
      renderFailed,
      // Report what the provider actually charged, not the reservation
      // arithmetic: leftover reservations from failed calls are a spend guard,
      // not an audit figure. llm_cost_log remains the ledger of record.
      spentInr: Math.round(observedInr * 10000) / 10000,
      tokensInput,
      tokensOutput,
      callsMade,
      callsFailed,
    };
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
   *
   * As of 2026-09 that whole Tesseract sweep is a SELECTED engine, not a
   * fallback: when OCR_ENGINE is vision (the default) the image goes straight
   * to the tiled vision reader, which deskews it and — for a wide bill —
   * slices it into overlapping full-resolution tiles. The rotation sweep runs
   * ONLY when Tesseract was explicitly chosen (OCR_ENGINE=tesseract,
   * forceEngine 'tesseract'/'pdftotext'). "Vision unavailable / provider down"
   * is NOT a reason to run it: that image comes back unreadable with a reason,
   * exactly as the PDF pump's pixel pages do, because free-but-wrong text is
   * worse than a flagged hole.
   */
  async extractTextFromImage(
    buffer: Buffer,
    opts: OcrExtractOpts = {}
  ): Promise<OcrPage> {
    // Vision-first. A 90°-rotated phone scan that Tesseract needs four passes
    // to recover is simply legible to the model, and a wide itemised bill is
    // only correct via tiling.
    let visionAttempted = false;
    const tesseractSelected = tesseractExplicitlySelected(opts);
    const outcome: { reason?: UnreadableReason } = {};

    if (this.visionReadEnabled(opts)) {
      visionAttempted = true;
      const visionPage = await this.readImageViaVision(buffer, opts, outcome);
      if (visionPage) return visionPage;
    }

    // THE GATE, and note where it sits: OUTSIDE the vision block, exactly like
    // the PDF pump's. Tesseract runs here only when it was EXPLICITLY SELECTED
    // (OCR_ENGINE=tesseract, forceEngine 'tesseract'/'pdftotext'). It is never
    // reached by falling through.
    //
    // It used to sit INSIDE `if (this.visionReadEnabled(opts))`, which meant
    // the only case it actually guarded was "vision ran and produced nothing".
    // Whenever vision was DISABLED — the OCR_VISION_FALLBACK_DISABLED kill
    // switch, allowVisionFallback:false, a missing extractor barrel — the block
    // was skipped entirely and the image slid silently into Tesseract, which
    // returns a page of low-confidence text that reads like a transcription to
    // everything downstream. That is precisely the silent degradation this
    // service no longer does: an unread page is a HOLE WITH A REASON, and the
    // reason is what maps to the operator's button.
    if (!tesseractSelected) {
      // 'cost_budget' → approve more budget. Everything else → restore the
      // reader and retry, which is what 'vision_failed' means; the detail
      // separates "the reader was off" from "the reader returned nothing", the
      // same two details classifyUnreadablePage uses on the PDF side.
      const reason = outcome.reason ?? 'vision_failed';
      const detail =
        reason === 'cost_budget'
          ? 'image vision read skipped — no rupee headroom'
          : visionAttempted
            ? 'image vision read produced nothing'
            : 'vision_disabled';
      logger.warn(
        {
          reason,
          detail,
          vision_attempted: visionAttempted,
          claim_id: opts.claimId ?? null,
          run_id: opts.runId ?? null,
        },
        'OCR: image could not be read by vision and no engine is selected — ' +
          'the image is UNREADABLE. Tesseract is NOT run as a silent fallback.',
      );
      return {
        pageNumber: 1,
        text: '',
        confidence: 0,
        source: 'unreadable',
        unreadable: true,
        unreadableReason: reason,
        unreadableDetail: unreadableDetail(detail),
        warnings: [
          reason === 'cost_budget'
            ? 'vision_cost_budget_exceeded'
            : 'vision_read_failed',
        ],
      };
    }

    if (visionAttempted) {
      logger.info(
        {},
        'OCR: vision-first image read unavailable — Tesseract is the SELECTED ' +
          'engine, running its pipeline',
      );
    }

    const page = await this.runTesseractImagePipeline(
      buffer,
      opts,
      visionAttempted,
    );
    if (!visionAttempted) return page;
    return {
      ...page,
      warnings: [...(page.warnings ?? []), 'vision_read_failed'],
    };
  }

  /**
   * Read one image with the tiled vision reader. Returns null (never throws)
   * when the reader is unavailable, errors, or produces nothing usable.
   *
   * `outcome.reason` reports WHY it returned null, because the two cases have
   * different answers: a read we could not PAY for is fixed by approving more
   * budget, a read that FAILED is fixed by retrying. The caller turns that into
   * the page's `unreadableReason`, which is what the end-of-run decision maps
   * to a button. Optional so the Tesseract-escalation caller can ignore it.
   */
  private async readImageViaVision(
    buffer: Buffer,
    opts: OcrExtractOpts,
    outcome?: { reason?: UnreadableReason },
  ): Promise<OcrPage | null> {
    try {
      // Same rupee bound as the PDF pump, one page wide. An image read is a
      // single ~₹5 call, so the check is cheap insurance rather than a hot
      // path: it stops a claim that has already exhausted its OCR budget from
      // adding more, and — like every other budget decision here — it never
      // throws.
      const allowance = await this.resolveVisionCostAllowance(opts);
      if (
        affordableVisionPages(
          allowance.allowanceInr,
          resolveVisionEstPageCostInr(),
        ) < 1
      ) {
        if (outcome) outcome.reason = 'cost_budget';
        logger.warn(
          {
            allowance_inr: Math.round(allowance.allowanceInr * 100) / 100,
            limited_by: allowance.limitedBy,
            reason: allowance.reason,
            run_id: opts.runId ?? null,
            claim_id: opts.claimId ?? null,
          },
          'OCR: image vision read skipped — no rupee headroom. The image is ' +
            'unreadable unless Tesseract is the selected engine.',
        );
        return null;
      }

      const transcribe = await loadVisionTranscriber();
      const releaseSlot = await acquireLlmSlot(VISION_READ_SLOT_MODEL);
      let res: VisionTranscribeResult;
      try {
        res = await transcribe({
          source: buffer,
          kind: 'image',
          maxPages: 1,
          claimId: opts.claimId ?? null,
          hospitalId: opts.hospitalId ?? null,
          taskName: VISION_READ_TASK_IMAGE,
        });
      } finally {
        releaseSlot();
      }

      const first = res.pages?.[0];
      if (!first || typeof first.text !== 'string' || first.text.trim().length === 0) {
        // An image that never rendered is 'render_failed' (re-upload it), not
        // 'vision_failed' (retry it) — the model was never shown anything.
        const renderFailed = (first?.warnings ?? []).some((w) =>
          RENDER_FAILURE_WARNINGS.has(w),
        );
        if (outcome) outcome.reason = renderFailed ? 'render_failed' : 'vision_failed';
        logger.warn(
          { warnings: res.warnings ?? [], render_failed: renderFailed },
          'OCR: vision image read returned no text',
        );
        return null;
      }

      logger.info(
        {
          text_len: first.text.length,
          tiles: first.tileCount,
          deskew_deg: first.deskewAngleDeg,
          cost_inr: res.costInr,
          latency_ms: res.latencyMs,
        },
        'OCR: image read via vision',
      );

      const page: OcrPage = {
        pageNumber: 1,
        text: first.text,
        confidence: first.confidence,
        source: 'vision_fallback',
        tileCount: first.tileCount,
        deskewAngleDeg: first.deskewAngleDeg,
        warnings: [...(first.warnings ?? []), 'used_vision_read'],
      };
      if (res.model) page.visionModel = res.model;
      return page;
    } catch (err) {
      if (outcome) outcome.reason = 'vision_failed';
      logger.warn(
        { err: (err as any)?.message ?? String(err) },
        'OCR: vision image read failed',
      );
      return null;
    }
  }

  /**
   * The Tesseract baseline + OSD + brute-force rotation sweep, unchanged from
   * the pre-vision implementation. Split out of extractTextFromImage so the
   * vision reader can sit in front of it without duplicating any of it.
   *
   * `visionAlreadyTried` suppresses the low-confidence escalation at the end —
   * there is no point paying for a second vision call on the same bytes after
   * the vision-first attempt already failed.
   */
  private async runTesseractImagePipeline(
    buffer: Buffer,
    opts: OcrExtractOpts,
    visionAlreadyTried = false,
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
        return this.maybeEscalateToVision(
          buffer,
          upright,
          opts,
          visionAlreadyTried,
        );
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

      return this.maybeEscalateToVision(
        buffer,
        tesseractBest,
        opts,
        visionAlreadyTried,
      );
    } catch (err) {
      throw new OcrParseError('image_ocr_failed', err);
    }
  }

  /**
   * Decide whether to escalate from a low-confidence Tesseract result to
   * the Claude vision reader. Four gates:
   *   1. The vision-first attempt hasn't already run and failed on these bytes
   *   2. Tesseract confidence < VISION_FALLBACK_THRESHOLD
   *   3. Caller hasn't opted out via opts.allowVisionFallback = false
   *   4. Env kill-switch OCR_VISION_FALLBACK_DISABLED !== 'true'
   * If any gate fails, return the Tesseract result unchanged. If vision
   * succeeds, return the vision result with merged warnings. If vision
   * fails (provider error, rate-limit, etc.), return the Tesseract
   * result with a 'vision_fallback_failed' warning.
   *
   * Escalation goes through the TILED reader first (deskew + overlapping
   * slices — the thing that fixes wide bills) and only falls back to the
   * legacy single-image ocrViaVision() when the reader is unavailable. That
   * ordering matters: a landscape bill sent as one image is the exact failure
   * mode this whole change exists to remove.
   *
   * Deliberately does NOT consult OCR_ENGINE. That flag reverts the *engine
   * ordering* to the pre-2026-09 behaviour, and the pre-2026-09 behaviour
   * INCLUDED this low-confidence escalation — gating it here would make the
   * revert switch strictly worse than what it reverts to. The hard
   * "no vision calls at all" switch is OCR_VISION_FALLBACK_DISABLED=true.
   */
  private async maybeEscalateToVision(
    buffer: Buffer,
    tesseractBest: OcrPage,
    opts: OcrExtractOpts,
    visionAlreadyTried = false
  ): Promise<OcrPage> {
    const visionAllowed =
      !visionAlreadyTried &&
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

    const tiled = await this.readImageViaVision(buffer, opts);
    if (tiled) {
      return {
        ...tiled,
        warnings: [
          ...(tesseractBest.warnings ?? []),
          ...(tiled.warnings ?? []),
        ],
      };
    }

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

    // Retry transient overloads/timeouts; cap each vision call (slower than text).
    const client = new Anthropic({ maxRetries: 3, timeout: 120_000 });
    const b64 = buffer.toString('base64');

    let response: any;
    // Same shared Anthropic ceiling the page pump uses. This path is rare (it
    // only runs when the tiled reader already failed) but it is still a direct
    // SDK call, and a call that skips the semaphore is a call the semaphore
    // cannot protect the account from.
    const releaseSlot = await acquireLlmSlot(VISION_FALLBACK_MODEL);
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
    } finally {
      releaseSlot();
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
   *   1b. Small-angle DESKEW (±5°) via ./extractor/deskew.ts — see below.
   *   2. Upscale on a LONG-EDGE + aspect-aware rule (lanczos3) —
   *      Tesseract's classifier struggles with low-DPI phone photos.
   *   3. Grayscale (Tesseract is grayscale internally anyway).
   *   4. Normalise (auto-levels) — recovers faded ink / uneven lighting.
   *   5. Light sharpen (sigma 0.8) — counteracts upscale blur.
   *
   * Step 1b is cause #3 from docs/proposals/EXTRACTION_LANDSCAPE_FIX.md: a
   * 1-2° tilt is invisible to a human and fatal to a wide table, because over
   * 3000px of width it drifts the far-right money column a full row off its
   * line item. The rotation salvage elsewhere in this service only handles 90°
   * multiples, so nothing corrected it before. Deskew hardens the Tesseract
   * fallback path here the same way it hardens the vision path in the tiler.
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
    let deskewAngle: number | null = null;

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

    // Step 1b: small-angle deskew. Runs AFTER the EXIF orient (so the ±5°
    // search is against the upright page) and BEFORE the upscale (so we don't
    // resample twice). Best-effort: deskewImage never throws, and when the
    // helper isn't loadable we simply skip it.
    try {
      const deskew = await loadDeskew();
      if (deskew) {
        const dk = await deskew(working);
        if (dk.applied) {
          working = dk.bytes;
          deskewAngle = dk.angleDeg;
        }
      }
    } catch (err) {
      logger.debug?.({ err }, 'OCR preprocess: deskew failed, continuing');
    }

    // Step 2: upscale when the page is under-resolved.
    //
    // The old gate was `origWidth < 1500`, which NEVER fires on a landscape
    // bill — a 3400x1400 scan is already 3400px wide, so it looked
    // high-resolution and was passed through untouched. But on a wide page it
    // is the ROWS that are under-resolved: 1400px of height spread over 25+
    // line items is ~50px per row, and Tesseract's row association starts
    // guessing. So:
    //   - long edge < 1800  → upscale the long edge to 1800 (the old intent,
    //     now orientation-independent instead of width-only), and
    //   - aspect > 1.3 and height < 1000 → upscale so the SHORT edge reaches
    //     ~1100, which is what actually buys per-row pixels on a wide bill.
    try {
      const w = typeof origWidth === 'number' ? origWidth : 0;
      const h = typeof origHeight === 'number' ? origHeight : 0;
      const longEdge = Math.max(w, h);
      const aspect = h > 0 ? w / h : 0;

      if (longEdge > 0 && longEdge < 1800) {
        working = await sharp(working)
          .resize({
            width: w >= h ? 1800 : undefined,
            height: h > w ? 1800 : undefined,
            withoutEnlargement: false,
            kernel: 'lanczos3',
          })
          .toBuffer();
      } else if (aspect > 1.3 && h > 0 && h < 1000) {
        working = await sharp(working)
          .resize({
            height: 1100,
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
        deskewAngle,
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
   *
   * Thin instance wrapper over the module-level `parsePdfPages`, which
   * `censusPdfPages` also uses — the estimator and the reader must derive
   * their page text the same way or they are describing different documents.
   */
  private async runPdfParse(buffer: Buffer): Promise<{
    numpages: number;
    pagesText: string[];
    pdfVersion?: string;
  }> {
    return parsePdfPages(buffer);
  }

  /**
   * Pick the pdf-to-png-converter viewportScale for the TESSERACT path.
   *
   * Replaces the hard-coded 2.0 this service used for every page regardless of
   * shape. pdf.js renders 1pt → 1px at scale 1.0, so a landscape A4
   * (842x595pt) at 2.0 produced 1684x1190 — only ~1190px of height for a
   * 25-row table. The shared chooseViewportScale() helper is aspect-aware and
   * targets the SHORT edge on wide pages, which is exactly the axis that was
   * starved.
   *
   * It is tuned for the vision path's 1568px ceiling, though, and Tesseract
   * has no such ceiling — it wants more pixels, not fewer — so the result is
   * clamped up into [2.0, 4.0]. The 2.0 floor guarantees no page renders
   * smaller than it did before this change.
   *
   * Falls back to 2.0 on any failure (pdf-lib unavailable, encrypted page
   * tree, helper missing): the render must not fail over a sizing hint.
   */
  private async chooseTesseractViewportScale(
    buffer: Buffer,
    pageNumber: number,
  ): Promise<number> {
    try {
      const chooseViewportScale = await loadChooseViewportScale();
      if (!chooseViewportScale) return TESSERACT_RENDER_SCALE_MIN;

      const { PDFDocument } = await loadPdfLib();
      const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const page = doc.getPage(pageNumber - 1);
      const { width, height } = page.getSize();
      if (!(width > 0) || !(height > 0)) return TESSERACT_RENDER_SCALE_MIN;

      const decision = chooseViewportScale(width, height);
      const scale = Math.min(
        TESSERACT_RENDER_SCALE_MAX,
        Math.max(TESSERACT_RENDER_SCALE_MIN, decision.scale),
      );

      logger.debug?.(
        {
          pageNumber,
          width_pt: width,
          height_pt: height,
          is_wide: decision.isWide,
          suggested_scale: decision.scale,
          tesseract_scale: scale,
        },
        'OCR: chose Tesseract viewport scale',
      );
      return scale;
    } catch (err) {
      logger.debug?.(
        { pageNumber, err: (err as any)?.message ?? String(err) },
        'OCR: viewport scale selection failed — using the 2.0 default',
      );
      return TESSERACT_RENDER_SCALE_MIN;
    }
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

    const viewportScale = await this.chooseTesseractViewportScale(
      buffer,
      pageNumber,
    );

    const pngs: Array<{ content: Buffer }> = await pdfToPng(buffer, {
      pagesToProcess: [pageNumber],
      viewportScale,
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
