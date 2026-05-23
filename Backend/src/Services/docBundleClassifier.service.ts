/**
 * Wave 12 — Bundle Classifier Service
 *
 * Replaces the (docSegmenter + per-section docClassifier) chain with a
 * single Sonnet call that processes an entire PDF and emits both the
 * section boundaries AND each section's category in one shot.
 *
 * Why combine the two stages:
 * - The segmenter and classifier today make independent LLM decisions
 *   over the same evidence; they can disagree. (Segmenter says p.3 is a
 *   new doc; classifier sees the slice in isolation and picks the wrong
 *   category because it can't see the surrounding bundle.)
 * - Doing both in one call lets the model use full bundle context
 *   ("consent → consent → consent" is plausible; "consent → OT-notes
 *    → consent" is suspicious).
 * - Cost: one Sonnet call (~₹0.40 per typical 5-doc bundle) beats one
 *   Sonnet segmenter + N Haiku classifiers (~₹0.48) at typical N≥4.
 * - Latency: one round trip beats N+1 sequential round trips. Wall-clock
 *   drops from ~22s to ~8s at p95 for a 15-page bundle.
 *
 * Idempotency:
 *   - Stage cache: existing rows AT classifier_version='v2-bundle' AND
 *     classifier_model='bundle' short-circuit.
 *   - Bull cache: jobId='bundle-classify:<documentId>'; force suffix
 *     '...:force:<ts>' to defeat dedup on force re-run.
 *   - LLM cache: LRU + Anthropic prompt cache on the system block.
 *
 * Failure modes:
 *   - Off-list category: rejected at validate-categories step, error
 *     bubbles up, Bull retries × 3. After exhaustion the worker falls
 *     back to the per-section path (enqueues docSegmenter for the same
 *     document) so we always produce SOMETHING.
 *   - Page coverage gaps/overlaps: rejected at validate-coverage step,
 *     same retry+fallback path.
 *   - Context window overflow on huge PDFs: pre-flight check on total
 *     estimated tokens; if over the soft ceiling, fall back to per-
 *     section path BEFORE the LLM call (no wasted spend).
 *   - LLM schema validation error: tried once, then fallback.
 *
 * Persistence:
 *   - Bundle classifier writes both segmenter_version AND classifier_*
 *     columns in one transaction. classifier_version='v2-bundle' lets
 *     downstream (extractor) treat these rows as already classified.
 *   - Emits both 'doc_segmented' and one 'section_classified' event per
 *     section so the dossier projector and downstream queues see the
 *     same lifecycle they do under the v2 pipeline.
 */

import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { z } from 'zod';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import defaultS3Service from './s3.service.js';
import defaultOcrService from './ocr.service.js';
import costAccountingService from './costAccounting.service.js';
import { eventDispatcher as defaultEventDispatcher } from './events/eventDispatcher.service.js';
import { getLlmClient } from './llm/factory.js';
import { LlmBudgetExceededError, LlmSchemaValidationError } from './llm/LlmClient.js';
import {
  DOC_BUNDLE_CLASSIFIER_SYSTEM_PROMPT,
  buildBundleClassifierUserPrompt,
  BUNDLE_CLASSIFIER_PROMPT_VERSION,
} from './llm/prompts/docBundleClassifier.v1.js';
import {
  BundleClassifierOutputSchema,
  type BundleClassifierOutput,
} from './llm/schemas/bundleClassifierOutput.js';
import {
  KbHintsService,
  kbHintsService as defaultKbHintsService,
} from './kbHints.service.js';
import { SectionDedupService } from './sectionDedup.service.js';
import { computePhash, computeDhash } from '../Utils/perceptualHash.util.js';
import { documentFormatLibraryService } from './documentFormatLibrary.service.js';

/**
 * Minimum normalized-text length for a section to participate in
 * content-hash dedup at persist time. Matches the guard in
 * SectionDedupService — pure-image sections (X-rays, scar photos,
 * sticker close-ups) typically OCR to <80 chars and all collapse to
 * the same near-empty hash; we'd rather store NULL and extract them
 * separately than wrongly dedup unrelated photos.
 *
 * v2's perceptual-hash branch will catch the sub-threshold cases.
 */
const MIN_TEXT_LEN_FOR_DEDUP_PERSIST = 80;

/**
 * Bump when the prompt, schema, or persisted shape changes. Stamped on
 * each row in segmenter_version + classifier_version so existing rows
 * stamped with the old value are eligible for re-bundling on the next
 * force run (and ignored by the idempotency short-circuit until then).
 */
export const BUNDLE_CLASSIFIER_VERSION = 'v2-bundle';

/**
 * Soft ceiling on the per-call OCR text size we'll send to the LLM.
 * Sonnet 4.5's input window is 200k tokens (~600k chars) but cost scales
 * linearly with input length. 80k chars ≈ 20k tokens ≈ ~$0.06 at Sonnet
 * input pricing — well within the ₹15/claim cap for a single call.
 * Anything bigger falls back to the per-section path which can stream
 * sections through Haiku at much lower per-token cost.
 */
const MAX_BUNDLE_INPUT_CHARS = 80_000;

/**
 * H7 (May 20, 2026): sentinel category code written as a per-doc marker
 * row when every recovery path is exhausted. See migration 062 for the
 * master_options seed + the design rationale. Downstream consumers must
 * treat this code as a no-op signal — the extractor's "no schema → skip"
 * path handles it, and we belt-and-braces gate it in the cascade too.
 */
const FAILED_CATEGORY = '__failed__';

/**
 * H12 (May 20, 2026): when the bundle classifier returns the umbrella
 * 'investigations' category for a section, we re-prompt with a tighter
 * sub-category list because no extractor schema exists for the umbrella
 * label (Sanno's claim daf9e760-9712-44ef-a33b-c30ecfe74d85 — single
 * 'investigations' doc → no extracted_fields → no harmonised episode →
 * full claim invisible in the FE).
 *
 * Kept in code rather than DB because the prompt itself enumerates the
 * options and we want the list to be reviewed alongside the prompt text
 * when either changes. All codes here MUST exist in
 * master_options.doc_category — verified at startup by
 * loadCandidateCategories which is the source of truth.
 */
const INVESTIGATIONS_UMBRELLA_CODE = 'investigations';
const INVESTIGATIONS_SUB_CATEGORIES = [
  'xray_reports',
  'mri_reports',
  'ct_scan_reports',
  'ultrasound_reports',
  'pet_scan_reports',
  'mammography_reports',
  'blood_test_reports',
  'urine_test_reports',
  'culture_reports',
  'histopathology_reports',
  'biopsy_reports',
  'serology_reports',
  'ecg',
  'echo',
  'tmt_reports',
  'holter_monitoring_reports',
  'pulmonary_function_test',
  'endoscopy_reports',
  'colonoscopy_reports',
  'sleep_study_reports',
  'neurodiagnostic_reports',
  'pre_surgery_diagnostics',
  'post_surgery_diagnostics',
  'anaesthesia_fitness_reports',
  'surgical_fitness_reports',
  'abg_reports',
] as const;

export interface BundleClassifySectionInput {
  documentId: string;
  claimId: string;
  hospitalId: string;
  s3Key: string;
  /** When true, ignore the version-based short-circuit. */
  force?: boolean;
}

export interface BundleClassifySectionResult {
  /** Section ids in page-order. */
  sectionIds: string[];
  /** Number of sections produced. */
  sectionCount: number;
  /** True when the short-circuit fired and no LLM call was made. */
  shortCircuited: boolean;
  /** True when the bundle classifier punted to the per-section path. */
  fellBack: boolean;
  costInr: number;
  tokensUsed: number;
}

/**
 * Optional dependencies bag for tests and alternate wiring.
 */
export interface DocBundleClassifierDeps {
  pool?: Pick<Pool, 'query'>;
  llm?: ReturnType<typeof getLlmClient>;
  s3?: Pick<typeof defaultS3Service, 'download'>;
  ocr?: Pick<
    typeof defaultOcrService,
    'extractTextFromPdf' | 'extractTextFromImage'
  >;
  events?: Pick<typeof defaultEventDispatcher, 'dispatch'>;
  costAccounting?: Pick<typeof costAccountingService, 'checkBudget'>;
  kbHints?: Pick<KbHintsService, 'getApprovedCategoryHints'>;
  /**
   * Fallback path — when the bundle classifier can't / shouldn't run,
   * enqueue the legacy segmenter for this document. Injected so tests
   * don't pull Bull in.
   */
  enqueueSegmenter?: (
    documentId: string,
    claimId: string,
    hospitalId: string,
    s3Key: string,
    idempotencyKey?: string,
  ) => Promise<void>;
  /** Cascade: enqueue extractor for each new section. */
  enqueueExtractor?: (
    sectionId: string,
    claimId: string,
    hospitalId: string,
    force?: boolean,
  ) => Promise<void>;
}

export class DocBundleClassifierService {
  private readonly pool: Pick<Pool, 'query'>;
  private readonly llm: ReturnType<typeof getLlmClient>;
  private readonly s3: Pick<typeof defaultS3Service, 'download'>;
  private readonly ocr: Pick<
    typeof defaultOcrService,
    'extractTextFromPdf' | 'extractTextFromImage'
  >;
  private readonly events: Pick<typeof defaultEventDispatcher, 'dispatch'>;
  private readonly costAccounting: Pick<
    typeof costAccountingService,
    'checkBudget'
  >;
  private readonly kbHints: Pick<KbHintsService, 'getApprovedCategoryHints'>;
  private readonly enqueueSegmenter: NonNullable<
    DocBundleClassifierDeps['enqueueSegmenter']
  >;
  private readonly enqueueExtractor: NonNullable<
    DocBundleClassifierDeps['enqueueExtractor']
  >;

  constructor(deps: DocBundleClassifierDeps = {}) {
    this.pool = deps.pool ?? defaultPool;
    this.llm = deps.llm ?? getLlmClient();
    this.s3 = deps.s3 ?? defaultS3Service;
    this.ocr = deps.ocr ?? defaultOcrService;
    this.events = deps.events ?? defaultEventDispatcher;
    this.costAccounting = deps.costAccounting ?? costAccountingService;
    this.kbHints = deps.kbHints ?? defaultKbHintsService;
    this.enqueueSegmenter =
      deps.enqueueSegmenter ??
      (async (documentId, claimId, hospitalId, s3Key, idempotencyKey) => {
        const mod = await import('../Workers/docSegmenter.queue.js');
        await mod.enqueueDocSegmentation(
          documentId,
          claimId,
          hospitalId,
          s3Key,
          idempotencyKey,
        );
      });
    this.enqueueExtractor =
      deps.enqueueExtractor ??
      (async (sectionId, claimId, hospitalId, force = false) => {
        const mod = await import('../Workers/docExtractor.queue.js');
        await mod.enqueueDocExtraction(sectionId, claimId, hospitalId, force);
      });
  }

  async classifyBundle(
    input: BundleClassifySectionInput,
  ): Promise<BundleClassifySectionResult> {
    const { documentId, claimId, hospitalId, s3Key, force } = input;

    // ─── Phase ledger setup (P6, migration 061) ──────────────────────────
    // Look up the current run cursor so we can write ingest/classify
    // ledger rows. If no run exists (legacy path, system-triggered call),
    // ledgerRunId stays null and all ledger writes below no-op silently.
    let ledgerRunId: string | null = null;
    let ledger: any = null;
    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claimId);
      if (run && (run.status === 'queued' || run.status === 'running')) {
        ledgerRunId = run.id;
        const { default: docPhaseLedgerService } = await import('./docPhaseLedger.service.js');
        ledger = docPhaseLedgerService;
      }
    } catch (err) {
      logger.debug(
        { err, claimId },
        'docBundleClassifier: phase ledger lookup failed (non-fatal — ledger writes will be skipped)',
      );
    }
    // Helper: silently no-op when no run cursor.
    const ledgerSafe = async (
      fn: 'startPhase' | 'finishPhase' | 'skipPhase' | 'failPhase',
      phase: 'ingest' | 'classify',
      arg3: any = null,
      arg4: any = null,
    ) => {
      if (!ledger || !ledgerRunId) return;
      try {
        if (fn === 'failPhase') {
          await ledger.failPhase(documentId, ledgerRunId, phase, arg3, arg4);
        } else if (fn === 'skipPhase') {
          await ledger.skipPhase(documentId, ledgerRunId, phase, arg3, arg4);
        } else {
          await (ledger as any)[fn](documentId, ledgerRunId, phase, arg3);
        }
      } catch (e) {
        logger.debug({ e, documentId, phase, fn }, 'docBundleClassifier: ledger write failed');
      }
    };

    // ─── 1. Idempotency short-circuit ────────────────────────────────────
    // If we've already bundle-classified this doc at the current version
    // AND not forcing, return without an LLM call. The classifier_version
    // column is the canonical signal — segmenter_version may match an
    // older value (e.g. legacy segmenter wrote 'v1') and we don't want
    // to over-trigger.
    if (!force) {
      const existing = await this.pool.query<{ id: string }>(
        // H7 (May 20, 2026): exclude __failed__ sentinel rows from the
        // short-circuit so a force re-run after a marker write actually
        // attempts to reclassify (rather than being told "already done"
        // and re-cascading the failure marker).
        `SELECT id, category
           FROM hospital.document_sections
          WHERE document_id = $1
            AND classifier_version = $2
            AND category IS NOT NULL
            AND category <> $3
          ORDER BY page_start, id`,
        [documentId, BUNDLE_CLASSIFIER_VERSION, FAILED_CATEGORY],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        logger.info(
          { documentId, sectionCount: existing.rowCount, BUNDLE_CLASSIFIER_VERSION },
          'docBundleClassifier: idempotent short-circuit',
        );
        // Phase ledger: mark ingest + classify as done with a
        // skip_reason explaining this was an idempotent reuse, not
        // freshly computed. Keeps the FE from showing "pending" forever
        // when a doc's sections already exist from a previous run.
        await ledgerSafe('finishPhase', 'ingest', { reused: true });
        await ledgerSafe('finishPhase', 'classify', {
          reused: true,
          sections_created: existing.rowCount,
        });
        // Even on short-circuit, still cascade extractor in case it
        // missed a section (e.g. extractor worker was down when the
        // original classify completed). H7: skip __failed__ sentinel
        // rows here too (the SELECT excludes them, but belt-and-braces
        // in case a future change adds another sentinel).
        for (const r of existing.rows) {
          if ((r as any).category === FAILED_CATEGORY) continue;
          await this.safeEnqueueExtractor(r.id, claimId, hospitalId, force === true);
        }
        return {
          sectionIds: existing.rows.map((r) => r.id),
          sectionCount: existing.rowCount,
          shortCircuited: true,
          fellBack: false,
          costInr: 0,
          tokensUsed: 0,
        };
      }
    }

    // ─── 2. Budget pre-flight ────────────────────────────────────────────
    // Same pattern as segmenter/classifier — fail fast before we spend
    // OCR cycles on a section we can't pay to classify.
    const verdict = await this.costAccounting.checkBudget(claimId, hospitalId);
    if (verdict.action === 'block') {
      throw new LlmBudgetExceededError(
        verdict.claimUnderLimit ? 'hospital_daily' : 'claim',
        verdict.claimUnderLimit
          ? verdict.hospitalDailySpendInr ?? 0
          : verdict.claimSpendInr ?? 0,
        verdict.claimUnderLimit ? verdict.hospitalDailyCapInr ?? 0 : 15,
        { claimId, hospitalId },
      );
    }

    // ─── 3. Download + OCR the FULL document ─────────────────────────────
    // Phase: INGEST starts here (P6). Covers S3 download + OCR + pHash
    // compute. The classify phase (LLM call) starts after this block.
    await ledgerSafe('startPhase', 'ingest');
    const sourceBytes = await this.s3.download(s3Key);

    // Image fast-path — single-page image documents don't need bundle
    // segmentation. We persist one section spanning page 1 and let the
    // category come from a tiny in-prompt classify run on this same
    // service (so we still get the bundle-prompt benefits for
    // category disambiguation). The "bundle" of one section is a
    // degenerate case but the prompt handles it cleanly.
    const isImage = this.isImageBuffer(sourceBytes);
    let pages: { page_number: number; text: string; confidence?: number }[];
    let totalPages: number;
    let avgConfidence: number;

    if (isImage) {
      const page = await this.ocr.extractTextFromImage(sourceBytes);
      pages = [{ page_number: 1, text: page.text, confidence: page.confidence }];
      totalPages = 1;
      avgConfidence = page.confidence;
    } else {
      const ocr = await this.ocr.extractTextFromPdf(sourceBytes);
      pages = ocr.pages.map((p) => ({
        page_number: p.pageNumber,
        text: p.text,
        confidence: p.confidence,
      }));
      totalPages = ocr.totalPages;
      avgConfidence = ocr.avgConfidence;
    }

    // ─── 3b. Per-page perceptual-hash arrays + page-image buffers ───────
    // Renders each page once. The PNG buffer is then used for TWO things:
    //   1. pHash + dHash (Wave 12 Phase 1C dedup)
    //   2. Hybrid vision attachments (v1.3): when a page's OCR confidence
    //      is below VISION_RESCUE_THRESHOLD, attach the PNG to the LLM
    //      call so Sonnet can read rotated/handwritten/low-contrast
    //      content the OCR butchered.
    //
    // Best-effort: if rendering fails for a doc, we skip pHash and
    // vision for that doc; classification still proceeds on OCR text
    // alone.
    const pagePhashes: (string | null)[] = new Array(totalPages).fill(null);
    const pageDhashes: (string | null)[] = new Array(totalPages).fill(null);
    // NOTE (memory safety, May 20, 2026):
    // Vision attachments to Sonnet were disabled (see block at line ~400)
    // after the off-by-one page mapping regression. With vision gone,
    // there is no downstream consumer of the rendered page BUFFERS — we
    // only need their pHash + dHash (each ~32 bytes). Previously we
    // accumulated all rendered buffers into a `pageImages` array, which
    // at viewportScale=2.0 ≈ 4MB per page × N pages × concurrency=2
    // workers grew to ~1.6GB resident on a 200-page discharge bundle and
    // OOM'd the worker.
    //
    // Two changes:
    //   (1) pageImages array dropped entirely — no consumer.
    //   (2) PDFs are rendered in batches of PAGE_RENDER_BATCH so peak
    //       buffer count is bounded to BATCH_SIZE × concurrency, not
    //       totalPages × concurrency. Each batch is released to GC
    //       before the next one starts.
    const PAGE_RENDER_BATCH = 10;
    try {
      if (isImage) {
        pagePhashes[0] = await computePhash(sourceBytes);
        pageDhashes[0] = await computeDhash(sourceBytes);
      } else {
        const pdfToPngMod: any = await import('pdf-to-png-converter');
        const pdfToPng =
          pdfToPngMod?.pdfToPng ?? pdfToPngMod?.default?.pdfToPng;
        if (typeof pdfToPng !== 'function') {
          logger.warn(
            { documentId },
            'docBundleClassifier: pdf-to-png-converter API not found; pHash skipped',
          );
        } else {
          // Render in chunks. pdf-to-png-converter accepts pagesToProcess
          // as an array of 1-indexed page numbers; we call it once per
          // batch and let each batch's Buffer array fall out of scope
          // between iterations so the GC can reclaim it.
          //
          // viewportScale 2.0 kept for pHash quality (pHash resizes to
          // 64x64 internally so visually-similar pages still match even
          // with the higher resolution).
          for (let batchStart = 0; batchStart < totalPages; batchStart += PAGE_RENDER_BATCH) {
            const batchEnd = Math.min(batchStart + PAGE_RENDER_BATCH, totalPages);
            const pageNumbers = Array.from(
              { length: batchEnd - batchStart },
              (_, i) => batchStart + i + 1, // 1-indexed
            );
            const rendered: Array<{ content: Buffer }> = await pdfToPng(
              sourceBytes,
              { viewportScale: 2.0, pagesToProcess: pageNumbers },
            );
            for (let i = 0; i < rendered.length; i++) {
              const pageIdx = batchStart + i; // 0-indexed back into our arrays
              if (pageIdx >= totalPages) break;
              const buf = rendered[i]?.content;
              if (!buf) continue;
              try {
                pagePhashes[pageIdx] = await computePhash(buf);
                pageDhashes[pageIdx] = await computeDhash(buf);
              } catch (err) {
                logger.warn(
                  { err, documentId, page: pageIdx + 1 },
                  'docBundleClassifier: page pHash failed',
                );
              }
            }
            // `rendered` falls out of scope at loop iteration boundary;
            // V8 GC can reclaim the buffers before the next batch
            // allocates its own.
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err, documentId },
        'docBundleClassifier: pHash render failed (non-fatal — section dedup falls back to text-hash only for this doc)',
      );
    }

    // ─── INGEST phase complete — record evidence ──────────────────────────
    // OCR + pHash both done. Record per-doc evidence so the FE can show
    // "Doc 2: ingested · 14 pages · avg conf 0.62 · 4 rotated".
    const totalChars = pages.reduce((acc, p) => acc + (p.text?.length ?? 0), 0);
    await ledgerSafe('finishPhase', 'ingest', {
      page_count: totalPages,
      total_chars: totalChars,
      ocr_avg_confidence: Number(avgConfidence?.toFixed?.(3) ?? 0),
      phash_pages: pagePhashes.filter((h) => h != null).length,
      is_image: isImage,
    });

    // ─── P5: Quality gate (OCR-readiness check) ───────────────────────────
    // Decide BEFORE the LLM call whether this doc is worth classifying.
    // Per the ADR decision (May 20, 2026): flag for human review rather
    // than reject — operators can decide if it's worth a manual retry,
    // re-upload, or whether to escalate the patient case.
    //
    // Signals (cheap, all in-memory from OCR result):
    //   1. avgConfidence < QUALITY_MIN_CONF: tesseract reports it can't
    //      read the doc reliably. 0.3 picked empirically — at 0.3 we've
    //      seen "Aadhar card 80% legible" still get above; below 0.3 is
    //      mostly garbage.
    //   2. totalChars / pages < MIN_CHARS_PER_PAGE: doc has so little
    //      text that classification will be a coin flip. Includes the
    //      case of pure-image scans where OCR pulled almost nothing AND
    //      the rotation pre-check didn't help.
    //   3. totalPages === 0: corrupt or empty file. Shouldn't reach here
    //      (pdf-parse would have thrown earlier) but defensive.
    //
    // When the gate trips: mark BOTH the ingest evidence and a new
    // 'classify' skip row with reason='needs_human_review'. The FE
    // surfaces a Review-Required badge on the doc. We do NOT enqueue
    // the LLM call. If the user later manually fixes the upload, a
    // force re-run will re-OCR and re-evaluate.
    //
    // For non-bundleable formats (pdfs over the input ceiling) we still
    // run the legacy segmenter — that's a separate skip reason below.
    const QUALITY_MIN_CONF = 0.3;
    const MIN_CHARS_PER_PAGE = 20;
    const avgCharsPerPage = totalPages > 0 ? totalChars / totalPages : 0;
    const qualityIssues: string[] = [];
    if (totalPages === 0) qualityIssues.push('zero_pages');
    if (avgConfidence < QUALITY_MIN_CONF) {
      qualityIssues.push(`low_ocr_confidence:${avgConfidence.toFixed(2)}`);
    }
    if (avgCharsPerPage < MIN_CHARS_PER_PAGE && !isImage) {
      // Skip for single-image uploads: a 1-page Aadhaar image can
      // legitimately have low char count if the photo is the dominant
      // content. Images go through a different downstream path that
      // can still classify by visual features.
      qualityIssues.push(`sparse_ocr:${avgCharsPerPage.toFixed(0)}_chars_per_page`);
    }

    if (qualityIssues.length > 0) {
      logger.warn(
        {
          documentId,
          claimId,
          quality_issues: qualityIssues,
          total_pages: totalPages,
          avg_chars_per_page: avgCharsPerPage,
          avg_confidence: avgConfidence,
        },
        'docBundleClassifier: quality gate tripped — flagging for human review, skipping LLM classify',
      );
      // Mark classify skipped with the quality flag. The FE rolls these
      // into a "Review Required" filter on the Documents tab.
      await ledgerSafe('skipPhase', 'classify', 'needs_human_review', {
        quality_issues: qualityIssues,
        total_pages: totalPages,
        avg_chars_per_page: Number(avgCharsPerPage.toFixed(1)),
        avg_confidence: Number(avgConfidence.toFixed(3)),
      });
      return {
        sectionIds: [],
        sectionCount: 0,
        shortCircuited: false,
        fellBack: false,
        costInr: 0,
        tokensUsed: 0,
      };
    }

    // ─── 4. Pre-flight: estimate input size; fall back if huge ───────────
    if (totalChars > MAX_BUNDLE_INPUT_CHARS) {
      logger.warn(
        { documentId, totalPages, totalChars, MAX_BUNDLE_INPUT_CHARS },
        'docBundleClassifier: document text exceeds bundle input ceiling; falling back to per-section segmenter',
      );
      // Mark classify as 'skipped' with reason so the ledger reflects
      // the fallback decision; the legacy segmenter cascade has its own
      // event flow (not yet ledger-wired in P6).
      await ledgerSafe('skipPhase', 'classify', 'exceeds_bundle_ceiling', {
        total_chars: totalChars,
        ceiling: MAX_BUNDLE_INPUT_CHARS,
      });
      return this.fallbackToSegmenter(
        documentId,
        claimId,
        hospitalId,
        s3Key,
        force === true,
      );
    }

    // ─── CLASSIFY phase starts here ───────────────────────────────────────
    await ledgerSafe('startPhase', 'classify');

    // ─── 5. Load candidate categories + KB hints ─────────────────────────
    const candidateCategories = await this.loadCandidateCategories();
    const categoryHints = await this.kbHints.getApprovedCategoryHints();

    // H5 (May 20, 2026): build a category-constrained variant of the
    // bundle output schema using the LIVE master_options enum. The
    // upstream BundleClassifierOutputSchema declares `category: z.string()`
    // which let the LLM free-text invalid codes like 'consent' (without
    // _form), 'aadhaar_card' (instead of _front/_back), 'investigations'
    // (umbrella, no extractor schema). Switching to z.enum() pushes
    // enforcement into Anthropic's structured-output validator AND lets
    // the prompt builder emit a tight category list. We filter out the
    // `__failed__` sentinel so the LLM can never emit it — that code is
    // reserved for the post-hoc failed-marker writer.
    const llmCategoryCodes = candidateCategories.filter(
      (c) => c !== FAILED_CATEGORY,
    );
    const constrainedSchema = z.object({
      sections: z
        .array(
          z.object({
            page_start: z.number().int().min(1),
            page_end: z.number().int().min(1),
            // z.enum requires a non-empty tuple. We've already thrown in
            // loadCandidateCategories when the master_options table is
            // empty, so the cast here is safe at runtime.
            category: z.enum(llmCategoryCodes as unknown as [string, ...string[]]),
            boundary_confidence: z.number().min(0).max(1),
            classification_confidence: z.number().min(0).max(1),
            reasoning: z.preprocess(
              (v) => (typeof v === 'string' ? v.slice(0, 500) : ''),
              z.string().optional(),
            ),
          }),
        )
        .min(1, 'bundle classifier must produce at least one section')
        .refine(
          (arr) => arr.every((s) => s.page_end >= s.page_start),
          'every section must have page_end >= page_start',
        ),
      document_summary: z.preprocess(
        (v) => (typeof v === 'string' ? v.slice(0, 500) : ''),
        z.string().optional(),
      ),
    });

    // ─── 5b. Hybrid vision (DISABLED — May 20, 2026) ────────────────────
    // First-pass hybrid vision attachment shipped but regressed
    // classification quality vs text-only: Sonnet couldn't reliably map
    // image-N to page-N even with explicit page-number labels in the
    // prompt, leading to off-by-one category drift starting at the
    // first page that DIDN'T have a vision attachment. Reverted to
    // text-only until we have a more robust per-image labeling
    // approach (likely: interleave each image with its OCR text block
    // in a single content sequence rather than batching images upfront).
    //
    // The image rendering + pHash code above stays — those are independent
    // of vision attachment and still useful for content-dedup.

    // ─── 6. Call LLM ─────────────────────────────────────────────────────
    let llmResult;
    try {
      llmResult = await this.llm.extract<BundleClassifierOutput>({
        systemPrompt: DOC_BUNDLE_CLASSIFIER_SYSTEM_PROMPT,
        userPrompt: buildBundleClassifierUserPrompt({
          // H5: pass the FILTERED list (without __failed__) so the prompt
          // doesn't even hint at the sentinel. Order matches the schema's
          // enum so the model's structured-output validator agrees with
          // the prompt's enumeration.
          candidateCategories: llmCategoryCodes,
          pages,
          categoryHints: categoryHints.map((h) => ({
            previous_category: h.previous_category,
            corrected_category: h.corrected_category,
            sample_size: h.sample_size,
          })),
          totalPages,
          avgOcrConfidence: avgConfidence,
        }),
        // H5: pass the enum-constrained schema so Anthropic's
        // structured-output validator rejects off-enum codes at the
        // model level. The original BundleClassifierOutputSchema lives
        // in /llm/schemas/bundleClassifierOutput.ts and uses
        // z.string().min(1) for `category` because the file is shared
        // with consumers that don't have the live enum handy; we
        // tighten it here at the only call site that DOES.
        schema: constrainedSchema as unknown as typeof BundleClassifierOutputSchema,
        cacheKey: this.buildCacheKey(documentId, pages),
        promptVersion: BUNDLE_CLASSIFIER_PROMPT_VERSION,
        taskName: 'doc_bundle_classify',
        // The bundle classifier is the workhorse — Sonnet for accuracy.
        // We don't escalate from a cheaper tier because the cost gap
        // disappears once you account for the wins on bundle context
        // resolution.
        tier: 'premium',
        claimId,
        hospitalId,
      });
    } catch (err) {
      if (err instanceof LlmSchemaValidationError) {
        logger.error(
          {
            documentId,
            rawResponse: (err as any)?.cause?.rawResponse?.slice(0, 800),
            zod: (err as any)?.cause?.zodIssues?.slice(0, 4),
          },
          'docBundleClassifier: schema-validation failed; falling back to per-section segmenter',
        );
        return this.fallbackToSegmenter(
          documentId,
          claimId,
          hospitalId,
          s3Key,
          force === true,
        );
      }
      // Budget exceeded / network errors etc. — let Bull retry.
      throw err;
    }

    // ─── 7. Validate categories + page coverage ──────────────────────────
    const validated = this.validateAndCoerceOutput(
      llmResult.data,
      candidateCategories,
      totalPages,
    );
    if (!validated.ok) {
      logger.warn(
        { documentId, reason: validated.reason, totalPages },
        'docBundleClassifier: validation failed post-LLM; falling back',
      );
      return this.fallbackToSegmenter(
        documentId,
        claimId,
        hospitalId,
        s3Key,
        force === true,
      );
    }

    // ─── 7b. H12 — resolve umbrella 'investigations' to a sub-category ───
    // The 'investigations' code in master_options is too coarse — no
    // extractor field_schema exists for it. Sanno's claim
    // daf9e760-9712-44ef-a33b-c30ecfe74d85 had ONE doc that classified
    // as 'investigations'; the extractor's "no schema → skip" path then
    // produced null extracted_fields, no harmonised episode landed, and
    // the entire claim went invisible on the FE. We re-prompt the model
    // per such section with a tight sub-category list so the section
    // gets a downstream-usable code.
    //
    // The secondary call is cheap (just that section's pages) and runs
    // BEFORE persist so the persisted row already carries the resolved
    // code. If the sub-classifier ALSO returns generic/umbrella we keep
    // the section but stamp a `needs_human_review` meta flag on its
    // extraction_confidence column so the FE surfaces it.
    const umbrellaSections = validated.sections.filter(
      (s) => s.category === INVESTIGATIONS_UMBRELLA_CODE,
    );
    const umbrellaResolutions = new Map<number, {
      resolved_category: string;
      needs_human_review: boolean;
      reasoning?: string;
    }>(); // keyed by page_start (unique within a doc by coverage invariant)
    for (const section of umbrellaSections) {
      try {
        const resolution = await this.resolveInvestigationSubcategory({
          section,
          pages,
          claimId,
          hospitalId,
          documentId,
          validSubCategories: INVESTIGATIONS_SUB_CATEGORIES.filter((c) =>
            candidateCategories.includes(c),
          ),
        });
        umbrellaResolutions.set(section.page_start, resolution);
        if (resolution.resolved_category !== INVESTIGATIONS_UMBRELLA_CODE) {
          section.category = resolution.resolved_category;
          logger.info(
            {
              documentId,
              page_start: section.page_start,
              page_end: section.page_end,
              resolved: resolution.resolved_category,
            },
            'docBundleClassifier: H12 — resolved umbrella investigations to sub-category',
          );
        } else {
          logger.warn(
            {
              documentId,
              page_start: section.page_start,
              page_end: section.page_end,
            },
            'docBundleClassifier: H12 — sub-classifier returned umbrella again, flagging for human review',
          );
        }
      } catch (err) {
        // Best-effort: failed sub-classify keeps the umbrella code and
        // gets the needs_human_review flag so the FE still flags it.
        logger.warn(
          { err, documentId, page_start: section.page_start },
          'docBundleClassifier: H12 — sub-classifier failed, marking section needs_human_review',
        );
        umbrellaResolutions.set(section.page_start, {
          resolved_category: INVESTIGATIONS_UMBRELLA_CODE,
          needs_human_review: true,
          reasoning: `sub_classifier_error: ${(err as Error)?.message?.slice(0, 200) ?? 'unknown'}`,
        });
      }
    }

    // ─── 8. Persist + cascade ────────────────────────────────────────────
    // Pass `pages` so persistBundle can compute the per-section
    // content_text_hash inline (free — we already OCR'd these).
    // Pass per-page pHash + dHash arrays so persistBundle can also
    // persist the section's pHash array for Layer 5 visual dedup.
    const sectionIds = await this.persistBundle({
      documentId,
      claimId,
      sections: validated.sections,
      pages,
      pagePhashes,
      pageDhashes,
      umbrellaResolutions,
    });

    // ─── Phase 3 — format-library detection ────────────────────────────
    // Use the first section's first-page pHash as the document's
    // representative layout fingerprint. Match against the per-hospital
    // library. If matched (hamming ≤ 5): bump occurrence and stash the
    // label in document_sections.notes. If unmatched: register a new
    // format so the next doc with this layout DOES match.
    //
    // Behaviour is purely observational this turn — we BUILD the library
    // but don't route extraction differently on matches. Later
    // iterations can fast-path matched formats.
    try {
      const firstSection = validated.sections[0];
      const firstSectionId = sectionIds[0];
      if (firstSection && firstSectionId && pagePhashes && pagePhashes.length > 0) {
        const sectionPagePhashes: string[] = [];
        for (let pn = firstSection.page_start; pn <= firstSection.page_end; pn++) {
          const ph = pagePhashes[pn - 1];
          if (ph) sectionPagePhashes.push(ph);
        }
        if (sectionPagePhashes.length > 0) {
          const match = await documentFormatLibraryService.matchFormat(
            hospitalId,
            sectionPagePhashes,
          );
          if (match.matched && match.format_id && match.format_label) {
            await documentFormatLibraryService.incrementOccurrence(
              match.format_id,
            );
            // Stash label in notes (idempotent: COALESCE+append guard).
            await this.pool.query(
              `UPDATE hospital.document_sections
                  SET notes = CASE
                    WHEN notes IS NULL OR notes = '' THEN $2
                    WHEN position($2 IN notes) > 0 THEN notes
                    ELSE notes || ' | ' || $2
                  END
                WHERE id = $1`,
              [firstSectionId, `format=${match.format_label}`],
            );
            logger.info(
              {
                documentId,
                claimId,
                hospitalId,
                format_id: match.format_id,
                format_label: match.format_label,
                hamming_distance: match.hamming_distance,
              },
              'docBundleClassifier: format matched from library',
            );
          } else {
            const newFormatId = await documentFormatLibraryService.registerNewFormat({
              hospital_id: hospitalId,
              doc_category: firstSection.category,
              representative_phash: sectionPagePhashes[0]!,
              sample_section_id: firstSectionId,
            });
            logger.info(
              {
                documentId,
                claimId,
                hospitalId,
                format_id: newFormatId,
                doc_category: firstSection.category,
                representative_phash: sectionPagePhashes[0]!.slice(0, 12),
              },
              'docBundleClassifier: new format detected, registered in library',
            );
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err, documentId, claimId, hospitalId },
        'docBundleClassifier: format-library detection failed (non-fatal)',
      );
    }

    // Dispatch doc_segmented (idempotency keyed by version so retries
    // don't double-emit) + per-section section_classified events.
    try {
      await this.events.dispatch({
        kind: 'doc_segmented',
        claimId,
        hospitalId,
        payload: {
          document_id: documentId,
          // Fix 15 (May 21, 2026): event schema requires section_ids array,
          // not section_count. Iter6 surfaced InvalidEventPayloadError on
          // every doc_segmented dispatch because section_ids was undefined.
          // We send BOTH the IDs (schema requirement) and the count (for
          // existing consumers that read .section_count).
          section_ids: sectionIds,
          section_count: sectionIds.length,
          segmenter_version: BUNDLE_CLASSIFIER_VERSION,
        },
        idempotencyKey: `doc_segmented:${documentId}:${BUNDLE_CLASSIFIER_VERSION}`,
      });
    } catch (err) {
      logger.warn({ err, documentId }, 'docBundleClassifier: doc_segmented dispatch failed (non-fatal)');
    }

    // ─── 8a. Dispatch section_classified events for ALL sections ───
    // Including duplicates — the dossier projector wants to know every
    // section that exists, even if downstream extraction will skip
    // duplicates. These dispatches are independent of dedup and can
    // happen before it.
    for (let i = 0; i < sectionIds.length; i++) {
      const sectionId = sectionIds[i]!;
      const sec = validated.sections[i]!;
      try {
        await this.events.dispatch({
          kind: 'section_classified',
          claimId,
          hospitalId,
          payload: {
            section_id: sectionId,
            category: sec.category,
            confidence: sec.classification_confidence,
            classifier_version: BUNDLE_CLASSIFIER_VERSION,
          },
          idempotencyKey: `section_classified:${sectionId}:${BUNDLE_CLASSIFIER_VERSION}`,
        });
      } catch (err) {
        logger.warn(
          { err, sectionId },
          'docBundleClassifier: section_classified dispatch failed (non-fatal)',
        );
      }
    }

    // ─── 8b. Run section dedup SYNCHRONOUSLY before extractor enqueue ───
    // ORDER CHANGE (May 20, 2026, architectural review): dedup MUST run
    // before extractor enqueue, not after. Previously sections were
    // enqueued at 8a (above) and dedup ran at 9 (below) — with extractor
    // concurrency=4 in the Bull worker, up to 4 LLM calls could fire on
    // sections that would have been marked as duplicates ~50-200ms later.
    // The extractor's per-job dedup_of recheck (docExtractor.queue.ts:104)
    // closes most of this window, but jobs that pick up a connection
    // before the dedup UPDATE commits will still bill the LLM.
    //
    // Also closes the force-re-run idempotency hole: when the bundle
    // classifier replaces existing 'status=auto' sections, any
    // document_sections.dedup_of pointing at a deleted canonical gets
    // FK-cascaded to NULL. Until dedup runs again, those duplicates are
    // un-canonicalized and would be picked up for extraction. Doing
    // dedup BEFORE extractor enqueue gives us a clean handoff.
    //
    // Dedup is idempotent — same hashes → same canonicals → same UPDATEs.
    // If it fails, we still enqueue extractors (defensive: better to
    // extract dups than to extract nothing). The extractor's own
    // dedup_of guard catches anything dedup would have marked.
    let dedupRan = false;
    try {
      const dedupResult = await new SectionDedupService(this.pool as any).dedupClaim(claimId);
      dedupRan = true;
      if (dedupResult.groups_found > 0) {
        logger.info(
          {
            claim_id: claimId,
            documentId,
            groups_found: dedupResult.groups_found,
            sections_deduped: dedupResult.sections_deduped,
          },
          'docBundleClassifier: section dedup applied BEFORE extractor enqueue',
        );
      }
    } catch (err) {
      logger.warn(
        { err, claim_id: claimId, documentId },
        'docBundleClassifier: section dedup failed (continuing — extractor per-job guard will re-check dedup_of at pickup)',
      );
    }

    // ─── 8c. Enqueue extractor — for canonical sections only ───
    // After dedup ran, query the DB for which of OUR sections are
    // canonical (dedup_of IS NULL). Duplicates are skipped here AND in
    // the extractor as belt-and-braces — projecting canonical's results
    // onto them is handled by the extractor's post-success hook
    // (docExtractor.queue.ts).
    //
    // If dedup failed above (dedupRan=false), enqueue ALL — the
    // extractor's own dedup_of check will still skip duplicates that
    // some PRIOR successful dedup run on this claim happened to mark.
    let sectionsToEnqueue: string[] = sectionIds;
    if (dedupRan) {
      try {
        const canonicalRes = await this.pool.query(
          `SELECT id FROM hospital.document_sections
            WHERE id = ANY($1::uuid[]) AND dedup_of IS NULL`,
          [sectionIds],
        );
        sectionsToEnqueue = canonicalRes.rows.map((r: any) => r.id as string);
        const skipped = sectionIds.length - sectionsToEnqueue.length;
        if (skipped > 0) {
          logger.info(
            { claim_id: claimId, documentId, total: sectionIds.length, canonical: sectionsToEnqueue.length, skipped },
            'docBundleClassifier: enqueuing extractor only for canonical sections (duplicates already pointed at canonical)',
          );
        }
      } catch (err) {
        logger.warn(
          { err, claim_id: claimId, documentId },
          'docBundleClassifier: canonical lookup failed — falling back to enqueueing ALL sections (extractor guard will still skip dups)',
        );
        sectionsToEnqueue = sectionIds;
      }
    }
    for (const sectionId of sectionsToEnqueue) {
      await this.safeEnqueueExtractor(sectionId, claimId, hospitalId, force === true);
    }

    // ─── CLASSIFY phase complete — record evidence ──────────────────────
    await ledgerSafe('finishPhase', 'classify', {
      sections_created: sectionIds.length,
      cost_inr: Number(llmResult.costInr?.toFixed?.(4) ?? 0),
      tokens_used:
        (llmResult.tokensInputUncached ?? 0) +
        (llmResult.tokensInputCached ?? 0) +
        (llmResult.tokensOutput ?? 0),
      classifier_version: BUNDLE_CLASSIFIER_VERSION,
    });

    logger.info(
      {
        documentId,
        sectionCount: sectionIds.length,
        cost_inr: llmResult.costInr,
        tokens_in_uncached: llmResult.tokensInputUncached,
        tokens_in_cached: llmResult.tokensInputCached,
        tokens_out: llmResult.tokensOutput,
      },
      'docBundleClassifier: bundle classified',
    );

    return {
      sectionIds,
      sectionCount: sectionIds.length,
      shortCircuited: false,
      fellBack: false,
      costInr: llmResult.costInr,
      tokensUsed:
        (llmResult.tokensInputUncached ?? 0) +
        (llmResult.tokensInputCached ?? 0) +
        (llmResult.tokensOutput ?? 0),
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Validate the LLM output against the candidate category list AND the
   * page-coverage invariant (every page from 1..N belongs to exactly one
   * section). Returns a typed discriminated union so the caller can
   * cleanly fall back on failure.
   */
  private validateAndCoerceOutput(
    output: BundleClassifierOutput,
    candidateCategories: readonly string[],
    totalPages: number,
  ):
    | {
        ok: true;
        sections: BundleClassifierOutput['sections'];
        summary?: string;
      }
    | { ok: false; reason: string } {
    const sections = [...output.sections].sort(
      (a, b) => a.page_start - b.page_start,
    );

    // Category list check. H5 (May 20, 2026): the schema-level z.enum
    // SHOULD have rejected off-list values at the LLM-validation layer,
    // but belt-and-braces: if anything sneaks through (e.g. legacy cache
    // hit on a pre-H5 prompt-version, or a future code path that swaps
    // the schema), map the off-enum value to 'others' rather than
    // throwing. 'others' is a documented code and the FE shows it as
    // "needs human review" — far better than dropping the section. The
    // sentinel __failed__ is also rejected here in case a malformed
    // post-hoc write feeds back through this validator.
    const allowed = new Set(candidateCategories);
    for (const s of sections) {
      if (s.category === FAILED_CATEGORY) {
        // Sentinel must never come from the LLM — coerce to 'others'.
        logger.warn(
          { category: s.category, page_start: s.page_start },
          'docBundleClassifier: LLM emitted __failed__ sentinel — coercing to "others"',
        );
        s.category = 'others';
        s.classification_confidence = Math.min(
          s.classification_confidence,
          0.5,
        );
        continue;
      }
      if (!allowed.has(s.category)) {
        logger.warn(
          {
            original_category: s.category,
            page_start: s.page_start,
            page_end: s.page_end,
          },
          'docBundleClassifier: off-enum category despite schema constraint — coercing to "others"',
        );
        s.category = 'others';
        s.classification_confidence = Math.min(
          s.classification_confidence,
          0.5,
        );
      }
    }

    // Page coverage check: contiguous from 1..totalPages with no gaps
    // and no overlaps. We allow the LLM to merge multi-page docs but
    // not to skip pages or double-claim them.
    let expectedNext = 1;
    for (const s of sections) {
      if (s.page_start !== expectedNext) {
        return {
          ok: false,
          reason: `coverage_gap_or_overlap:expected_p${expectedNext}_got_p${s.page_start}`,
        };
      }
      if (s.page_end < s.page_start) {
        return {
          ok: false,
          reason: `inverted_range:p${s.page_start}_to_p${s.page_end}`,
        };
      }
      expectedNext = s.page_end + 1;
    }
    if (expectedNext - 1 !== totalPages) {
      return {
        ok: false,
        reason: `last_page_mismatch:expected_p${totalPages}_got_p${expectedNext - 1}`,
      };
    }

    return { ok: true, sections, summary: output.document_summary };
  }

  /**
   * Persist all sections in one multi-row INSERT. Mirrors the
   * docSegmenter pattern but writes BOTH segmenter_version AND
   * classifier_version + category + classifier_model so downstream
   * (extractor, dossier projector) treats these rows as fully classified.
   *
   * LAYER 2 DEDUP: wraps the work in a transaction that first DELETES
   * existing `status='auto'` sections for this document, then INSERTs
   * the fresh set. Without this, force-reruns of the bundle classifier
   * accumulate sections — the new run's page-range may overlap the
   * old run's range, and (worse) the LLM is non-deterministic so the
   * same page can end up labelled differently across runs. Both
   * problems vanish when we replace-not-append.
   *
   * `status='corrected'` sections (user manually re-classified) are
   * NEVER deleted — those carry intent the LLM should respect. The
   * unique constraint `(document_id, page_start, page_end)` added in
   * migration 055 is the belt-and-braces backstop: if a future code
   * path accidentally INSERTs without the delete, the DB rejects the
   * overlap instead of silently doubling up.
   */
  private async persistBundle(args: {
    documentId: string;
    claimId: string;
    sections: BundleClassifierOutput['sections'];
    /**
     * Page-by-page OCR output. Required so we can compute the per-section
     * `content_text_hash` (section-content dedup, migration 056) using
     * the text we already OCR'd — no extra cost. If absent (legacy call
     * sites that don't have pages handy), the hash is NULL and the
     * section just won't participate in dedup.
     */
    pages?: ReadonlyArray<{ page_number: number; text: string }>;
    /**
     * Per-page perceptual hashes (Wave 12 Phase 1C / migration 058).
     * `pagePhashes[i]` corresponds to page i+1 of the document. NULL
     * entries mean rendering or hashing failed for that page — the
     * section just won't contribute those pages to Layer 5 dedup.
     */
    pagePhashes?: ReadonlyArray<string | null>;
    pageDhashes?: ReadonlyArray<string | null>;
    /**
     * H12 (May 20, 2026): per-section meta from the umbrella-resolver
     * pass. Keyed by page_start (unique by coverage invariant). When a
     * section's resolution is still 'investigations' (sub-classifier
     * returned umbrella again), we stamp the needs_human_review flag
     * into the extraction_confidence JSON so the FE surfaces it.
     */
    umbrellaResolutions?: ReadonlyMap<
      number,
      { resolved_category: string; needs_human_review: boolean; reasoning?: string }
    >;
  }): Promise<string[]> {
    const { documentId, claimId, sections, pages, pagePhashes, pageDhashes, umbrellaResolutions } = args;
    if (sections.length === 0) return [];

    // Build a page_number → text map for fast slice-by-range lookup.
    const textByPage = new Map<number, string>();
    if (pages) {
      for (const pg of pages) textByPage.set(pg.page_number, pg.text ?? '');
    }

    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const s of sections) {
      // Compute content_text_hash for this section. Concatenate the
      // OCR text across every page in [page_start..page_end], normalize
      // (lowercase + strip-non-alnum + collapse-whitespace via
      // SectionDedupService.normalizeText), sha256. NULL when:
      //   - we have no `pages` argument (legacy call sites), OR
      //   - the normalized text is shorter than MIN_TEXT_LEN_FOR_DEDUP
      //     (pure-image sections; v2's perceptual hash will catch them).
      // The dedup service has the same MIN_TEXT_LEN guard, but doing it
      // here too avoids storing low-signal hashes that wouldn't be used
      // anyway.
      let textHash: string | null = null;
      if (pages && pages.length > 0) {
        const parts: string[] = [];
        for (let pn = s.page_start; pn <= s.page_end; pn++) {
          const t = textByPage.get(pn);
          if (t) parts.push(t);
        }
        const combined = parts.join('\n');
        const normalized = SectionDedupService.normalizeText(combined);
        if (normalized.length >= MIN_TEXT_LEN_FOR_DEDUP_PERSIST) {
          textHash = createHash('sha256').update(normalized).digest('hex');
        }
      }

      // Slice the per-page pHash + dHash arrays by this section's range.
      // NULL entries mean rendering/hashing failed for that page → the
      // section gets a hash array that may contain fewer entries than
      // its page count, OR is NULL entirely if no pages had hashes.
      let phashArr: string[] | null = null;
      let dhashArr: string[] | null = null;
      if (pagePhashes && pageDhashes) {
        const collectedPh: string[] = [];
        const collectedDh: string[] = [];
        for (let pn = s.page_start; pn <= s.page_end; pn++) {
          const idx = pn - 1; // pagePhashes is 0-indexed
          const ph = pagePhashes[idx] ?? null;
          const dh = pageDhashes[idx] ?? null;
          if (ph) collectedPh.push(ph);
          if (dh) collectedDh.push(dh);
        }
        if (collectedPh.length > 0) phashArr = collectedPh;
        if (collectedDh.length > 0) dhashArr = collectedDh;
      }

      // H12: pre-stamp extracted_fields with needs_human_review when the
      // umbrella sub-classifier couldn't resolve to a specific code. The
      // extractor's "no_field_schema" path uses COALESCE so it preserves
      // our stamp; if the section's category got resolved to a specific
      // sub-category (xray_reports etc.) we leave extracted_fields NULL
      // and let the extractor's normal path populate it.
      const umbrellaRes = umbrellaResolutions?.get(s.page_start);
      const preStampedExtractedFields = umbrellaRes?.needs_human_review
        ? JSON.stringify({
            _meta: {
              needs_human_review: true,
              umbrella_category_unresolved: true,
              reason: 'umbrella_category_unresolved',
              original_category: INVESTIGATIONS_UMBRELLA_CODE,
              ...(umbrellaRes.reasoning ? { sub_classifier_reasoning: umbrellaRes.reasoning } : {}),
            },
          })
        : null;

      valuesSql.push(
        // 16 params per row (was 15, +1 for extracted_fields pre-stamp).
        // NOW() and 'auto' hard-coded.
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, NOW(), 'auto')`,
      );
      params.push(
        documentId,
        claimId,
        s.page_start,
        s.page_end,
        s.category,
        // classification_confidence: store the CLASSIFICATION confidence
        // (matches the column's downstream meaning under the v2 pipeline).
        // The boundary_confidence is tucked into the (unused-elsewhere)
        // extraction_confidence column as `{ _meta: { boundary_confidence } }`
        // — see persistBundleMetadata below if we want to surface it.
        Number(s.classification_confidence.toFixed(3)),
        BUNDLE_CLASSIFIER_VERSION, // segmenter_version
        BUNDLE_CLASSIFIER_VERSION, // classifier_version
        'claude',                  // classifier_provider
        'bundle',                  // classifier_model — distinguishes from 'standard' / 'standard+kb_hint'
        // extraction_confidence carries the boundary signal so an audit
        // can later compare bundle-classifier boundary calls to human
        // corrections. Keeps the existing columns untouched.
        // H12: when this section came back as umbrella 'investigations'
        // even after sub-classification, stamp needs_human_review so
        // the FE filter picks it up.
        (() => {
          const resolution = umbrellaResolutions?.get(s.page_start);
          const meta: Record<string, unknown> = {
            boundary_confidence: Number(s.boundary_confidence.toFixed(3)),
          };
          if (resolution?.needs_human_review) {
            meta.needs_human_review = true;
            meta.umbrella_category_unresolved = true;
            if (resolution.reasoning) meta.reasoning = resolution.reasoning;
          }
          return JSON.stringify({ _meta: meta });
        })(),
        // content_text_hash — NULL when text was too sparse to dedup
        // confidently (pure-image sections), populated when the
        // normalized text crosses the threshold. SectionDedupService
        // uses this to group cross-document duplicates.
        textHash,
        // content_phash_array / content_dhash_array — per-page
        // perceptual hashes. Layer 5 dedup uses these to catch the
        // "same image embedded in different containers" case that file
        // sha256 + OCR text hash both miss. NULL when render failed.
        phashArr,
        dhashArr,
        // H12: pre-stamped needs_human_review payload (or NULL when the
        // section resolved cleanly to a sub-category).
        preStampedExtractedFields,
      );
    }

    const insertSql = `
      INSERT INTO hospital.document_sections
        (document_id, claim_id, page_start, page_end,
         category, classification_confidence,
         segmenter_version, classifier_version,
         classifier_provider, classifier_model,
         extraction_confidence, content_text_hash,
         content_phash_array, content_dhash_array,
         extracted_fields,
         phash_computed_at, status)
      VALUES
        ${valuesSql.join(',\n        ')}
      RETURNING id
    `;

    // Tx: clear stale auto sections, then insert fresh. Keeping the
    // delete + insert in the same tx means a concurrent reader either
    // sees the OLD complete set or the NEW complete set, never an
    // empty document. The delete's WHERE clause spares any user-
    // corrected rows so manual fixes survive re-runs.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const deleted = await client.query(
        `DELETE FROM hospital.document_sections
          WHERE document_id = $1
            AND status = 'auto'
          RETURNING id`,
        [documentId],
      );
      if ((deleted.rowCount ?? 0) > 0) {
        logger.info(
          {
            documentId,
            cleared: deleted.rowCount,
          },
          'docBundleClassifier: cleared stale auto sections before re-insert (Layer 2 dedup)',
        );
      }

      const res = await client.query<{ id: string }>(insertSql, params);
      await client.query('COMMIT');
      return res.rows.map((r) => r.id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Punt the document through the legacy segmenter path. Used when:
   *   - OCR text exceeds the soft input ceiling
   *   - LLM returns a malformed response
   *   - LLM-returned categories or page coverage fail validation
   *
   * The segmenter has its own idempotency, so calling it here is safe
   * even if a previous attempt already segmented the doc.
   */
  private async fallbackToSegmenter(
    documentId: string,
    claimId: string,
    hospitalId: string,
    s3Key: string,
    force: boolean,
  ): Promise<BundleClassifySectionResult> {
    const idemKey = createHash('sha256')
      .update(
        `${documentId}:segmenter:fallback:${force ? Date.now() : 'idem'}`,
      )
      .digest('hex')
      .slice(0, 32);
    try {
      await this.enqueueSegmenter(
        documentId,
        claimId,
        hospitalId,
        s3Key,
        idemKey,
      );
    } catch (err) {
      logger.error(
        { err, documentId },
        'docBundleClassifier: fallback enqueue failed — pipeline stalled for this doc',
      );
      // H7 (May 20, 2026): when the segmenter fallback ALSO fails to
      // enqueue, the doc is genuinely lost — neither pipeline owns it.
      // Write a __failed__ marker so the operator sees the silent drop.
      await this.writeFailedMarker({
        documentId,
        claimId,
        reason: `segmenter_fallback_enqueue_failed: ${(err as Error)?.message?.slice(0, 200) ?? 'unknown'}`,
        s3Key,
        extra: { stage: 'fallback_to_segmenter' },
      });
    }
    return {
      sectionIds: [],
      sectionCount: 0,
      shortCircuited: false,
      fellBack: true,
      costInr: 0,
      tokensUsed: 0,
    };
  }

  private async safeEnqueueExtractor(
    sectionId: string,
    claimId: string,
    hospitalId: string,
    force: boolean,
  ): Promise<void> {
    try {
      await this.enqueueExtractor(sectionId, claimId, hospitalId, force);
    } catch (err) {
      logger.warn(
        { err, sectionId },
        'docBundleClassifier: enqueueExtractor failed (reconciler will retry)',
      );
    }
  }

  private async loadCandidateCategories(): Promise<string[]> {
    const res = await this.pool.query<{ code: string }>(
      `SELECT code
         FROM hospital.master_options
        WHERE category = 'doc_category' AND is_active = true
        ORDER BY sort_order, code`,
    );
    if (res.rows.length === 0) {
      throw new Error(
        "docBundleClassifier: no doc_category codes in master_options — migration 028 not applied?",
      );
    }
    return res.rows.map((r) => r.code);
  }

  /**
   * Cache key for the LLM bridge LRU. Hash the page texts so identical
   * uploads (rare but happens with duplicate ipd_doc rows) hit the
   * cache. The version is included so bumping BUNDLE_CLASSIFIER_VERSION
   * invalidates.
   */
  private buildCacheKey(
    documentId: string,
    pages: { page_number: number; text: string }[],
  ): string {
    const h = createHash('sha256');
    h.update(documentId);
    h.update('::');
    h.update(BUNDLE_CLASSIFIER_VERSION);
    for (const p of pages) h.update(p.text ?? '');
    return `doc_bundle_classifier:${h.digest('hex').slice(0, 16)}`;
  }

  /**
   * H12 (May 20, 2026): re-prompt the LLM with a tight sub-category list
   * for a section that the primary bundle classifier labelled as the
   * umbrella 'investigations' code. Returns the resolved sub-category
   * (one of INVESTIGATIONS_SUB_CATEGORIES) or the umbrella itself when
   * the model declines to pick a specific code — in which case the
   * caller stamps needs_human_review on the section.
   *
   * Why a separate call instead of expanding the bundle prompt:
   *   - Per-section context is tighter and cheaper than re-running the
   *     whole bundle.
   *   - The bundle prompt is already long; adding a "if umbrella, pick
   *     sub" rule there bloats the system prompt and gives the model
   *     too many escape hatches.
   *   - We can use a lower tier (haiku) because the categorisation
   *     space is small (~25 codes) and the section is already isolated.
   */
  private async resolveInvestigationSubcategory(args: {
    section: BundleClassifierOutput['sections'][number];
    pages: ReadonlyArray<{ page_number: number; text: string; confidence?: number }>;
    claimId: string;
    hospitalId: string;
    documentId: string;
    /** Sub-category codes that actually exist in master_options. */
    validSubCategories: readonly string[];
  }): Promise<{ resolved_category: string; needs_human_review: boolean; reasoning?: string }> {
    const { section, pages, claimId, hospitalId, validSubCategories, documentId } = args;
    if (validSubCategories.length === 0) {
      // No sub-categories available (shouldn't happen with the live
      // taxonomy but defensive). Keep umbrella + flag.
      return {
        resolved_category: INVESTIGATIONS_UMBRELLA_CODE,
        needs_human_review: true,
        reasoning: 'no_valid_sub_categories_in_master_options',
      };
    }

    // Slice the section's pages out of the OCR result. Cap per-page text
    // so a multi-page investigation doesn't blow the prompt budget.
    const PAGE_CHAR_CAP = 3000;
    const sectionPages = pages
      .filter((p) => p.page_number >= section.page_start && p.page_number <= section.page_end)
      .map((p) => ({
        page_number: p.page_number,
        text: (p.text ?? '').slice(0, PAGE_CHAR_CAP),
      }));
    if (sectionPages.length === 0) {
      return {
        resolved_category: INVESTIGATIONS_UMBRELLA_CODE,
        needs_human_review: true,
        reasoning: 'no_pages_in_section_range',
      };
    }

    const subSchema = z.object({
      category: z.enum(validSubCategories as unknown as [string, ...string[]]),
      confidence: z.number().min(0).max(1),
      reasoning: z.preprocess(
        (v) => (typeof v === 'string' ? v.slice(0, 300) : ''),
        z.string().optional(),
      ),
    });

    const systemPrompt = `You are a sub-classifier for investigation reports in an Indian healthcare claim.
A previous classifier already determined this section is an "investigation" (the umbrella code), but the umbrella label has no extractor schema downstream — so the claim cannot be processed until you pick the SPECIFIC investigation type.
Pick ONE code from the candidate list. Use the most specific code that fits. If the content is genuinely ambiguous (e.g. a mixed-test report), pick the dominant test type. Do not invent codes.

Common confusions in Indian uploads:
- X-RAY plain radiograph (greyscale film images, often 2 views) → xray_reports
- CT scan (typed report with TECHNIQUE / FINDINGS / IMPRESSION sections, axial/coronal/sagittal references) → ct_scan_reports
- MRI (similar typed structure to CT but mentions T1/T2/FLAIR sequences) → mri_reports
- Ultrasound / Doppler (USG with measurements in mm, often 2D + colour Doppler) → ultrasound_reports
- Blood test / CBC / lipid / LFT / RFT with numerical values + reference ranges → blood_test_reports
- Urinalysis → urine_test_reports
- Microbial culture + sensitivity panel → culture_reports
- Histopathology specimen description + diagnosis → histopathology_reports
- Biopsy with tissue source → biopsy_reports
- Serology (HIV, HBsAg, HCV, RPR, etc.) → serology_reports
- 12-lead ECG → ecg
- Echocardiography (2D echo, EF, valves) → echo
- Treadmill / stress test → tmt_reports
- ABG (pH, PaO2, PaCO2, HCO3) → abg_reports

If pages contain MULTIPLE investigation types, pick the FIRST type by page order; the bundle classifier should have split them but didn't.

Respond with a single JSON object inside a fenced \`\`\`json block:
{
  "category": "<one of the candidate codes>",
  "confidence": 0.92,
  "reasoning": "Short justification, ≤300 chars."
}`;

    const pageBlocks = sectionPages
      .map((p) => `--- PAGE ${p.page_number} ---\n${p.text}`)
      .join('\n\n');

    const userPrompt = `Section to classify (pages ${section.page_start}-${section.page_end} of the original bundle).

Candidate sub-category codes (pick exactly one):
${validSubCategories.map((c) => `  - ${c}`).join('\n')}

OCR text for this section:

${pageBlocks}

Pick the single most specific code. Respond with the JSON object as specified.`;

    try {
      const out = await this.llm.extract<z.infer<typeof subSchema>>({
        systemPrompt,
        userPrompt,
        schema: subSchema as any,
        cacheKey: `investigations_subclassify:${documentId}:${section.page_start}:${section.page_end}`,
        promptVersion: 'invsub_v1',
        taskName: 'doc_investigations_subclassify',
        // Sub-classification is a tight problem; haiku is more than
        // enough and an order of magnitude cheaper than premium.
        tier: 'cheap' as any,
        claimId,
        hospitalId,
      });
      const cat = out.data.category;
      if (!validSubCategories.includes(cat) || cat === INVESTIGATIONS_UMBRELLA_CODE) {
        return {
          resolved_category: INVESTIGATIONS_UMBRELLA_CODE,
          needs_human_review: true,
          reasoning: `sub_classifier_picked_${cat}`,
        };
      }
      return {
        resolved_category: cat,
        needs_human_review: false,
        reasoning: out.data.reasoning,
      };
    } catch (err) {
      logger.warn(
        { err, documentId, page_start: section.page_start },
        'docBundleClassifier: investigations sub-classify LLM call failed',
      );
      return {
        resolved_category: INVESTIGATIONS_UMBRELLA_CODE,
        needs_human_review: true,
        reasoning: `sub_classifier_error: ${(err as Error)?.message?.slice(0, 200) ?? 'unknown'}`,
      };
    }
  }

  /**
   * H7 (May 20, 2026): write a per-doc `__failed__` marker row to
   * document_sections when every recovery path is exhausted. Idempotent
   * — upserts on (document_id, page_start, page_end) so re-running this
   * after an earlier marker is safe. Returns the section id or null when
   * the write itself fails (which we log but never throw on; the failure
   * is already terminal).
   *
   * The marker row carries:
   *   - category = '__failed__' (sentinel — see migration 062).
   *   - classification_confidence = 0.
   *   - status = 'failed' (filterable in the FE Documents tab).
   *   - extracted_fields = { error, s3_key, page_count, attempt, ... }
   *     so operators can see WHY the doc was dropped without grepping
   *     application logs.
   *
   * The row spans the WHOLE document (page_start=1, page_end=∞ effectively
   * — but we use 1..1 because we may not know the true page count when
   * OCR itself failed, and the FE only needs to know "this doc failed",
   * not which pages). Per-doc, not per-page (per the spec).
   *
   * NOTE: this is also called from the queue's final-failure hook. The
   * UPSERT pattern (on the page_start/page_end unique key from migration
   * 055) makes that safe — repeated calls are no-ops after the first.
   */
  async writeFailedMarker(args: {
    documentId: string;
    claimId: string;
    reason: string;
    s3Key?: string;
    pageCount?: number;
    attempt?: number;
    extra?: Record<string, unknown>;
  }): Promise<string | null> {
    const { documentId, claimId, reason, s3Key, pageCount, attempt, extra } = args;
    try {
      // Check for an existing __failed__ marker first so we don't
      // accumulate one per attempt. The unique constraint on
      // (document_id, page_start, page_end) would catch a duplicate but
      // we'd rather UPDATE the reason (latest failure context wins)
      // than rely on ON CONFLICT semantics + the existing schema's
      // partial constraint coverage.
      const existing = await this.pool.query<{ id: string }>(
        `SELECT id
           FROM hospital.document_sections
          WHERE document_id = $1
            AND category = $2
          LIMIT 1`,
        [documentId, FAILED_CATEGORY],
      );
      const payload = {
        error: reason,
        ...(s3Key ? { s3_key: s3Key } : {}),
        ...(pageCount != null ? { page_count: pageCount } : {}),
        ...(attempt != null ? { attempt } : {}),
        recorded_at: new Date().toISOString(),
        ...(extra ?? {}),
      };
      if (existing.rowCount && existing.rowCount > 0) {
        const sectionId = existing.rows[0]!.id;
        await this.pool.query(
          `UPDATE hospital.document_sections
              SET extracted_fields = $2::jsonb,
                  updated_at = NOW(),
                  status = 'failed'
            WHERE id = $1`,
          [sectionId, JSON.stringify(payload)],
        );
        logger.info(
          { documentId, sectionId, reason },
          'docBundleClassifier: H7 — updated existing __failed__ marker with latest reason',
        );
        return sectionId;
      }
      // No existing marker — clear any stale `auto` sections from a
      // prior partial run BEFORE inserting (mirrors persistBundle's
      // delete-then-insert semantics, scoped to the same document).
      // Status='corrected' rows are preserved — manual fixes survive.
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM hospital.document_sections
             WHERE document_id = $1
               AND status = 'auto'`,
          [documentId],
        );
        const ins = await client.query<{ id: string }>(
          `INSERT INTO hospital.document_sections
             (document_id, claim_id, page_start, page_end,
              category, classification_confidence,
              segmenter_version, classifier_version,
              classifier_provider, classifier_model,
              extracted_fields,
              status, created_at, updated_at)
           VALUES
             ($1, $2, 1, 1,
              $3, 0,
              $4, $4,
              'system', 'failed_marker',
              $5::jsonb,
              'failed', NOW(), NOW())
           RETURNING id`,
          [
            documentId,
            claimId,
            FAILED_CATEGORY,
            BUNDLE_CLASSIFIER_VERSION,
            JSON.stringify(payload),
          ],
        );
        await client.query('COMMIT');
        const sectionId = ins.rows[0]?.id ?? null;
        logger.warn(
          { documentId, claimId, reason, sectionId },
          'docBundleClassifier: H7 — wrote __failed__ marker row (last-resort visibility)',
        );
        return sectionId;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (writeErr) {
      logger.error(
        { writeErr, documentId, claimId, reason },
        'docBundleClassifier: H7 — writeFailedMarker itself failed (this should be very rare)',
      );
      return null;
    }
  }

  /** Magic-byte sniff identical to docSegmenter/docExtractor. */
  private isImageBuffer(buf: Buffer): boolean {
    if (buf.length < 4) return false;
    if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    )
      return true; // PNG
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
    if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) return true; // TIFF (LE)
    if (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00) return true; // TIFF (BE)
    // WebP: 'RIFF' (4 bytes) + size (4 bytes) + 'WEBP' (4 bytes). Diagnosed
    // on the Vahid claim — 4 surgical-discharge photos were uploaded with
    // mime_type='image/jpeg' but the underlying bytes were WebP (file
    // extensions .webp in the s3 path). Without this branch the bundle
    // classifier mis-routed them to the PDF OCR path, pdf-parse threw on
    // the RIFF header, Bull retried 3× and dead-lettered → docs stayed
    // forever without sections. iPhone Safari uploads, Chrome
    // screenshots, and several Android camera apps produce WebP by
    // default, so this is not Vahid-specific.
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
    )
      return true; // WebP
    return false;
  }
}

/** Default singleton, wired to the default pg pool + LLM bridge. */
export const docBundleClassifierService = new DocBundleClassifierService();
export default docBundleClassifierService;
