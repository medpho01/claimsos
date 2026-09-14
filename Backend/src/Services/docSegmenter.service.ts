/**
 * DocSegmenter Service — Sprint 3, Wave 2A.
 *
 * Takes a single uploaded PDF (typically a multi-document "claim packet" — a
 * stitched bundle of discharge slip + investigations + ICPs + final bill that
 * a hospital staffer scanned as one job) and proposes page-range boundaries
 * for the constituent documents.
 *
 * It does NOT classify (that's the DocClassifier worker, Lane B) and it does
 * NOT extract fields (that's DocExtractor, Wave 2B). Keeping these three
 * stages decoupled means:
 *
 *   - the segmenter prompt stays small (Haiku, cheap)
 *   - boundaries can be human-corrected before any classifier/extractor tokens
 *     are spent
 *   - the segmenter version can be bumped independently of classifier/extractor
 *     versions (the idempotency cache key includes segmenter_version so a
 *     re-run under a new version produces a fresh row set)
 *
 * Pipeline (`segmentDocument`):
 *
 *   1. Read every page: typed-PDF text where the page has a real text layer
 *      (free and exact), Claude Vision for the pages that are pixels. See
 *      `OcrService.extractTextFromPdf` and `ocrCallOpts` below — this call is
 *      DOCUMENT-scoped on purpose, so that every page the downstream
 *      per-section reads will see by vision was read by vision here too.
 *      Boundaries derived from a different transcription than the one the
 *      extractor later reads are boundaries for a document that doesn't exist.
 *   2. Build per-page summaries (first ~800 chars + OCR confidence).
 *   3. Pre-flight budget check via `costAccounting.checkBudget`. If the action
 *      is 'block', throw `LlmBudgetExceededError` BEFORE we hit Anthropic.
 *   4. Ask the LLM (Haiku, 'cheap' tier) for `{ sections: [{page_start,
 *      page_end, candidate_category, boundary_confidence}], confidence }`.
 *   5. Record the call's cost via `costAccounting.recordCall` (best effort —
 *      audit-only failure does not abort the parent op).
 *   6. INSERT one `document_sections` row per returned section with
 *      category=NULL (classifier will fill it later). The segmenter's boundary
 *      confidence is stored in `classification_confidence` initially; the
 *      classifier overwrites that field with the final category confidence.
 *   7. Dispatch one `doc_segmented` event (typed; carries section_ids).
 *   8. Enqueue one DocClassifier job per section (queue name 'doc-classifier',
 *      owned by Lane B — we only `.add()`).
 *
 * Idempotency: re-running segmentation on the same documentId at the same
 * SEGMENTER_VERSION short-circuits — we read back the existing rows and skip
 * the LLM call. Bumping SEGMENTER_VERSION invalidates that cache. This is the
 * same shape we use for any "expensive deterministic op that already wrote to
 * the DB" — the DB row IS the cache.
 */

import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import { fetchClaimStage } from './context/loader.js';
import { getLlmClient } from './llm/factory.js';
import { LlmBudgetExceededError } from './llm/LlmClient.js';
import costAccountingService, {
  claimHardLimitInr,
  type BudgetVerdict,
} from './costAccounting.service.js';
import ocrService, {
  OcrPausedError,
  type OcrExtractOpts,
  type OcrResult,
} from './ocr.service.js';
import {
  allUnreadable,
  isUnreadable,
  unreadablePagesOf,
  persistUnreadablePages,
} from './ocrUnreadable.js';
import { eventDispatcher } from './events/eventDispatcher.service.js';
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  CANONICAL_DOC_CATEGORIES,
  type PageSummary,
} from './llm/prompts/docSegmenter.v1.js';

/**
 * PageSummary plus the 076 unreadable marker.
 *
 * The marker is additive and carried locally rather than added to the prompt
 * module's own type: the prompt builder neither needs nor reads it, and the
 * segmenter is the only thing that must know which summaries are empty
 * BECAUSE THE PAGE WAS NEVER READ as opposed to empty because the page was
 * genuinely blank. Those two look identical in a text preview and mean
 * opposite things for a boundary.
 */
type SegmenterPageSummary = PageSummary & { unreadable?: boolean };

/**
 * Run statuses whose ledger / unreadable rows are still meaningful to write.
 * A terminal or superseded run's bookkeeping is closed; writing to it would
 * change an answer someone has already been given.
 */
const ACTIVE_FOR_LEDGER: ReadonlySet<string> = new Set(['queued', 'running']);

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * Version of the segmentation pipeline. Bumped whenever:
 *   - the prompt template changes (docSegmenter.v1.ts)
 *   - the canonical doc_category list changes
 *   - the segmentation algorithm/post-processing logic changes
 * The DB-side idempotency cache keys on (document_id, segmenter_version), so
 * a bump forces a re-run for any doc that hasn't been corrected yet.
 */
export const SEGMENTER_VERSION = 'v1';

const PROMPT_VERSION = 'docSegmenter.v1';
const TASK_NAME = 'doc_segmenter';
const PAGE_PREVIEW_CHARS = 800;
// Anthropic's stated "Haiku-friendly" payload size — beyond ~80 pages of dense
// text we'd want to chunk segmentation itself. Today's claim packets are
// well under this; we log and proceed rather than refuse outright.
const SOFT_PAGE_LIMIT = 80;

/**
 * Options for every OCR read this service makes.
 *
 * Two things are being declared, and both are load-bearing (2026-09-14):
 *
 *   1. `claimId` / `hospitalId` — this is a claim-attended operation. Passing
 *      no opts at all, which is what this service used to do, made
 *      ocr.service classify the call as UNATTENDED ingestion and cap it at 3
 *      vision pages. Boundaries for a 40-page bundle were therefore being
 *      derived from Tesseract text for pages 4-40. The ids also attribute the
 *      vision spend to the right claim in hospital.llm_cost_log instead of
 *      leaving orphan rows.
 *
 *   2. `visionBudgetScope: 'document'` — the buffer we hand ocr.service is the
 *      WHOLE bundle, not one section of it, and the boundaries we derive from
 *      it are consumed by docClassifier/docExtractor, which re-read those same
 *      pages as per-section slices under the section budget of 8. A fixed
 *      bundle-level budget therefore means the two passes read different
 *      pages with different engines: the boundaries describe a transcription
 *      nothing downstream ever sees. Document scope makes the bundle budget
 *      the document's own pixel-page count, so every page a section read will
 *      see by vision was also seen by vision here.
 *
 * Deliberately NOT set: forceVisionAllPages. A page with a real typed text
 * layer is read from that layer in BOTH passes (the test is a pure function of
 * the page bytes), which is free, exact and already coherent.
 */
function ocrCallOpts(claimId: string, hospitalId: string): OcrExtractOpts {
  return {
    claimId,
    hospitalId,
    attended: true,
    visionBudgetScope: 'document',
  };
}

/**
 * Sniff magic bytes to decide if a buffer is an image (JPEG / PNG / TIFF / GIF
 * / WebP). Images take the "single section" fast path — no PDF parsing, no
 * LLM segmenter call. PDF files (starting with "%PDF") fall through to the
 * normal pdf-parse + Tesseract path.
 */
function isImageBuffer(buf: Buffer): boolean {
  if (!buf || buf.length < 4) return false;
  // JPEG: 0xFF 0xD8 0xFF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 0x89 0x50 0x4E 0x47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // TIFF: II*\0 or MM\0*
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) return true;
  // GIF: GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // WebP: RIFF????WEBP
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Zod schema — LLM response shape
// ────────────────────────────────────────────────────────────────────────────

const SectionSchema = z.object({
  page_start: z.number().int().positive(),
  page_end: z.number().int().positive(),
  candidate_category: z.enum(CANONICAL_DOC_CATEGORIES as unknown as [string, ...string[]]),
  boundary_confidence: z.number().min(0).max(1),
});

const SegmenterResponseSchema = z.object({
  sections: z.array(SectionSchema).min(1),
  confidence: z.number().min(0).max(1).optional(),
});

type SegmenterResponse = z.infer<typeof SegmenterResponseSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Public input/output
// ────────────────────────────────────────────────────────────────────────────

export interface SegmentDocumentInput {
  documentId: string;
  claimId: string;
  hospitalId: string;
  buffer: Buffer;
}

export interface SegmentDocumentResult {
  sectionIds: string[];
  pagesProcessed: number;
  /** Cumulative INR cost of this invocation's LLM calls (0 on idempotent short-circuit). */
  costInr: number;
  /** True when we returned existing rows without spending any new tokens. */
  shortCircuited: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Section enqueue hook (Lane B will wire the real queue; for tests we expose
// an override). Keeping this as a function-pointer avoids pulling the
// docClassifier queue file in here — that file doesn't exist yet, and
// importing it would create a circular boot-order surprise.
// ────────────────────────────────────────────────────────────────────────────

export type EnqueueClassifierFn = (job: {
  sectionId: string;
  documentId: string;
  claimId: string;
  hospitalId: string;
}) => Promise<void>;

/**
 * Default no-op enqueue. Replaced by Lane B (or by tests) via
 * `setClassifierEnqueue`. We log so missing wiring is obvious in dev.
 */
let enqueueClassifier: EnqueueClassifierFn = async (job) => {
  logger.warn(
    { sectionId: job.sectionId, documentId: job.documentId },
    'docSegmenter: no docClassifier queue wired (using no-op)'
  );
};

export function setClassifierEnqueue(fn: EnqueueClassifierFn): void {
  enqueueClassifier = fn;
}

// ────────────────────────────────────────────────────────────────────────────
// Pool-injectable so tests can pass a stub. Mirrors EventDispatcher's pattern.
// ────────────────────────────────────────────────────────────────────────────

type Queryable = Pick<Pool, 'query'> | PoolClient;

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

export class DocSegmenterService {
  private readonly pool: Queryable;

  // Injected so tests can swap. Production callers should use the singleton
  // exported at the bottom of this file.
  constructor(pool: Queryable = defaultPool) {
    this.pool = pool;
  }

  async segmentDocument(input: SegmentDocumentInput): Promise<SegmentDocumentResult> {
    const { documentId, claimId, hospitalId, buffer } = input;

    // 1. Idempotency check — already segmented at the current version?
    const existing = await this.findExistingSections(documentId);
    if (existing.length > 0) {
      logger.info(
        { documentId, claimId, sectionCount: existing.length, segmenterVersion: SEGMENTER_VERSION },
        'docSegmenter: short-circuit (existing rows at this version)'
      );
      return {
        sectionIds: existing,
        pagesProcessed: 0,
        costInr: 0,
        shortCircuited: true,
      };
    }

    // 2. Pre-flight budget check. Strictly fail BEFORE any LLM call so we
    //    don't burn tokens we'd then have to refuse.
    //
    //    ORDERING (NEW-3, 2026-09-14). This check used to sit at step 3 —
    //    AFTER `ocrService.extractTextFromPdf` — while its own comment claimed
    //    it ran before the LLM call. That was true when OCR meant Tesseract.
    //    Since the vision-first flip, OCR *is* an LLM call (one Anthropic call
    //    per pixel page, the single most expensive step in this service), so
    //    the check was running after the spend it was meant to gate. The other
    //    three callers of this pattern — docClassifier, docExtractor,
    //    docBundleClassifier — all order it correctly; this one was the
    //    outlier. It now sits above BOTH OCR paths, image and PDF.
    //
    //    Note this gate is about the claim's REASONING budget. The OCR read
    //    below has its own rupee bound applied INSIDE the read (see
    //    costAccounting.getOcrReadAllowanceInr), because a pre-flight verdict
    //    cannot bound the call it authorises — it degrades pages to Tesseract
    //    rather than throwing.
    //    THE runId ARGUMENT IS LOAD-BEARING, NOT TELEMETRY. `checkBudget`
    //    reads the run's approved budget — and can therefore only ever return
    //    'pause_for_consent' — when it is given a run id. Without it the
    //    segmenter spent against the static operator caps alone and the
    //    number the user approved bound nothing at all. Resolved once and
    //    reused for the cost-log stamp at step 6.
    const activeRunId = await this.resolveActiveRunId(claimId);
    const verdict = await costAccountingService.checkBudget(
      claimId,
      hospitalId,
      undefined,
      { runId: activeRunId },
    );

    //    'pause_for_consent' PARKS, it does not spend and it does not throw.
    //    This arm is not optional garnish: `action` is a WIDENING union and
    //    this method previously handled ONLY 'block', so a verdict of
    //    'pause_for_consent' fell straight through to the OCR + segmenter
    //    calls below and spent the money the pause exists to withhold.
    //    Threading runId in without this arm would have made that worse, not
    //    better — it would newly PRODUCE the verdict and still ignore it.
    //
    //    It must not throw, either: LlmBudgetExceededError here would burn
    //    Bull's three retries against a run that is deliberately waiting on a
    //    person, and the document would dead-letter unsegmented. We return
    //    zero sections instead. Nothing downstream is enqueued (the classify
    //    fan-out is driven by the section rows we do not create), the ingest
    //    phase is marked blocked, and resume re-runs it from the top — the
    //    same shape as the all-unreadable exit below.
    if (verdict.action === 'pause_for_consent') {
      await this.pauseRunForConsent(documentId, claimId, verdict);
      return { sectionIds: [], pagesProcessed: 0, costInr: 0, shortCircuited: false };
    }

    if (verdict.action === 'block') {
      throw new LlmBudgetExceededError(
        // We don't know whether the block came from the claim or the hospital
        // dimension without inspecting verdict.reason — default to 'claim' and
        // surface the verdict's reason on the message via the error super().
        verdict.claimSpendInr !== undefined &&
        verdict.claimSpendInr >= claimHardLimitInr()
          ? 'claim'
          : 'hospital_daily',
        verdict.claimSpendInr ?? verdict.hospitalDailySpendInr ?? 0,
        verdict.hospitalDailyCapInr ?? claimHardLimitInr(),
        { claimId, hospitalId }
      );
    }

    // 2a. Image fast path (JPEG/PNG). A single scanned image is by
    //     definition a single-page document — no boundary detection, no
    //     LLM segmenter call needed. We OCR via Tesseract directly and
    //     emit one section spanning page 1. Saves ~₹0.20-0.30 per image
    //     and avoids feeding a non-PDF buffer to pdf-parse.
    if (isImageBuffer(buffer)) {
      try {
        const page = await ocrService.extractTextFromImage(
          buffer,
          ocrCallOpts(claimId, hospitalId),
        );
        // ─── §C.3.2 rule 4 — an unreadable single-page image IS the
        // "all unreadable" case. One page, and we do not have it. Emitting a
        // section here would create a row the extractor must then skip, and
        // a UI entry that claims a document was processed when nothing was
        // read. Record it and return zero sections instead.
        if (isUnreadable(page as any)) {
          logger.warn(
            { documentId, claimId, reason: (page as any).unreadableReason },
            'docSegmenter: image is unreadable — emitting zero sections and flagging the document',
          );
          await this.recordAllUnreadable(documentId, claimId, {
            pages: [page],
            totalPages: 1,
            avgConfidence: 0,
            processedAtMs: 0,
            fileHash: '',
            engineVersions: {},
          } as OcrResult);
          return {
            sectionIds: [],
            pagesProcessed: 1,
            costInr: 0,
            shortCircuited: false,
          };
        }
        const sectionIds = await this.insertSections({
          documentId,
          claimId,
          sections: [
            {
              page_start: 1,
              page_end: 1,
              candidate_category: null,
              boundary_confidence: page.confidence,
            } as any,
          ],
        });
        try {
          await eventDispatcher.dispatch({
            kind: 'doc_segmented',
            claimId,
            hospitalId,
            payload: {
              document_id: documentId,
              section_ids: sectionIds,
              segmenter_version: SEGMENTER_VERSION,
            },
            idempotencyKey: `doc_segmented:${documentId}:${SEGMENTER_VERSION}`,
          });
        } catch (err) {
          logger.error(
            { err, documentId, claimId },
            'docSegmenter (image fast path): doc_segmented dispatch failed'
          );
        }
        for (const sectionId of sectionIds) {
          try {
            await enqueueClassifier({ sectionId, documentId, claimId, hospitalId });
          } catch (err) {
            logger.warn({ err, sectionId, documentId }, 'docSegmenter: classifier enqueue failed');
          }
        }
        logger.info(
          { documentId, claimId, pageConfidence: page.confidence },
          'docSegmenter: image fast path — single section created'
        );
        return {
          sectionIds,
          pagesProcessed: 1,
          costInr: 0,
          shortCircuited: false,
        };
      } catch (err) {
        logger.error(
          { err, documentId, claimId },
          'docSegmenter: image OCR failed; rethrowing for retry'
        );
        throw err;
      }
    }

    // 2b. PDF path — OCR gives per-page text + confidence cheaply
    //     (typed-PDF where possible, Tesseract on scans). LLM never sees
    //     the raw PDF; it sees text previews.
    const ocr: OcrResult = await ocrService.extractTextFromPdf(
      buffer,
      ocrCallOpts(claimId, hospitalId),
    );
    // The one case where the bundle-level read and the later per-section reads
    // are guaranteed to disagree about which engine read which page: the
    // document had more pixel pages than OCR_VISION_MAX_PAGES_DOCUMENT. Not
    // fatal — the boundaries are still usable — but it must not be silent,
    // because every downstream oddity traceable to it looks like a prompt bug.
    //
    //    Three codes, three different knobs (2026-09-14): the page ceiling, the
    //    rupee allowance, and the wall-clock budget can each demote tail pages
    //    to Tesseract. None of them is fatal — segmentation still runs on the
    //    text it has — but none of them may be silent either.
    const clampWarnings = (ocr.warnings ?? []).filter((w) =>
      [
        'vision_document_budget_clamped',
        'vision_cost_budget_clamped',
        'vision_latency_budget_clamped',
      ].includes(w),
    );
    if (clampWarnings.length > 0) {
      logger.warn(
        { documentId, claimId, totalPages: ocr.totalPages, clampWarnings },
        'docSegmenter: the bundle vision read was clamped — boundaries for the ' +
          'affected pages come from Tesseract text while the extractor may read ' +
          'them via vision. See the OCR log for the page numbers and the knob ' +
          '(OCR_VISION_MAX_PAGES_DOCUMENT / CLAIM_OCR_HARD_LIMIT_INR / ' +
          'OCR_VISION_LATENCY_BUDGET_MS).',
      );
    }
    // ─── §C.3.2 rule 3 — nothing to segment ─────────────────────────────
    // Two distinct facts, one response: a zero-page parse, and a document
    // where every page came back unreadable. In both cases there is no text
    // to infer a boundary from, and inventing one would put a section
    // boundary at a page nobody has read.
    //
    // We return WITHOUT throwing. A throw here dead-letters the document
    // through Bull's retries and takes the rest of the run's documents with
    // it; the whole point of this round is that one blocked document does not
    // stop the run.
    if (ocr.totalPages === 0 || ocr.pages.length === 0 || allUnreadable(ocr)) {
      const everyPageUnreadable = allUnreadable(ocr);
      logger.warn(
        {
          documentId,
          claimId,
          total_pages: ocr.totalPages,
          all_unreadable: everyPageUnreadable,
        },
        everyPageUnreadable
          ? 'docSegmenter: every page is unreadable — emitting zero sections and flagging the document'
          : 'docSegmenter: PDF has zero pages — nothing to segment',
      );
      if (everyPageUnreadable) {
        await this.recordAllUnreadable(documentId, claimId, ocr);
      }
      return { sectionIds: [], pagesProcessed: 0, costInr: 0, shortCircuited: false };
    }
    if (ocr.totalPages > SOFT_PAGE_LIMIT) {
      logger.warn(
        { documentId, totalPages: ocr.totalPages, softLimit: SOFT_PAGE_LIMIT },
        'docSegmenter: large PDF — single-call segmentation may be costly'
      );
    }

    // 4. Build the LLM input — page summaries only, never the raw PDF.
    //    (The budget pre-flight is at step 2, above the OCR read — see the
    //    ORDERING note there. It used to live here, after the read.)
    // ─── §C.3.2 rule 1 — ONE SUMMARY PER PAGE, always ──────────────────
    // An unreadable page's summary is the empty string plus an explicit
    // marker. It is not dropped: the summaries are positional evidence for
    // page-numbered boundaries, and removing one renumbers everything after
    // it. It is not given placeholder prose either — the segmenter prompt
    // reasons about content, and marker text is not content.
    const pageSummaries: SegmenterPageSummary[] = ocr.pages.map((p) => ({
      pageNumber: p.pageNumber,
      textPreview: isUnreadable(p)
        ? ''
        : (p.text || '').slice(0, PAGE_PREVIEW_CHARS),
      confidence: p.confidence,
      ...(isUnreadable(p) ? { unreadable: true } : {}),
    }));
    const unreadableForRun = unreadablePagesOf(ocr);
    if (unreadableForRun.length > 0) {
      await this.persistUnreadableForRun(documentId, claimId, unreadableForRun);
    }

    // 5. Call the LLM. cacheKey includes documentId so an accidental retry
    //    within the LRU's 5-min window collapses to a single billed call.
    const llm = getLlmClient();
    let llmResult;
    try {
      llmResult = await llm.extract<SegmenterResponse>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(pageSummaries),
        schema: SegmenterResponseSchema,
        promptVersion: PROMPT_VERSION,
        taskName: TASK_NAME,
        tier: 'cheap',
        claimId,
        hospitalId,
        cacheKey: `doc_segmenter:${documentId}:${SEGMENTER_VERSION}`,
      });
    } catch (err) {
      // Best-effort cost record on failure — we may have been billed for
      // partial tokens. The LlmClient itself doesn't record on failure, so
      // we don't double-count.
      logger.error(
        { err, documentId, claimId, taskName: TASK_NAME },
        'docSegmenter: LLM extract failed'
      );
      throw err;
    }

    // 6. Record cost in llm_cost_log (best-effort; never aborts the parent op).
    await costAccountingService.recordCall({
      claimId,
      hospitalId,
      // Stamped so getRunSpendInr attributes this row to THIS run rather than
      // to "all claim spend since the run was triggered" — the fallback that
      // otherwise charges a superseded run's tail against the current run's
      // approved budget and makes the pause card's number wrong.
      runId: activeRunId,
      task: TASK_NAME,
      provider: llmResult.provider,
      model: llmResult.model,
      promptVersion: PROMPT_VERSION,
      tokensInputUncached: llmResult.tokensInputUncached,
      tokensInputCached: llmResult.tokensInputCached,
      tokensOutput: llmResult.tokensOutput,
      latencyMs: llmResult.latencyMs,
      costInr: llmResult.costInr,
      succeeded: true,
    });

    // 7. Validate boundaries cover the whole doc & sort by page_start.
    const sections = this.absorbUnreadableBoundaries(
      this.normalizeSections(llmResult.data.sections, ocr.totalPages),
      new Set(unreadableForRun.map((u) => u.pageNumber)),
      ocr.totalPages,
    );

    // 8. Persist one row per section. We do this in a single multi-row insert
    //    for atomicity — if any one row fails the whole set is rolled back
    //    so we don't leave a half-segmented document on the floor.
    const sectionIds = await this.insertSections({
      documentId,
      claimId,
      sections,
    });

    // 9. Fire the typed doc_segmented event. Idempotency key derived from
    //    (documentId, segmenter_version) so a duplicate dispatch collapses.
    try {
      await eventDispatcher.dispatch({
        kind: 'doc_segmented',
        claimId,
        hospitalId,
        payload: {
          document_id: documentId,
          section_ids: sectionIds,
          segmenter_version: SEGMENTER_VERSION,
        },
        idempotencyKey: `doc_segmented:${documentId}:${SEGMENTER_VERSION}`,
      });
    } catch (err) {
      // Eventing failure shouldn't undo the segmentation we already
      // committed. The classifier worker still has rows to operate on; the
      // event-driven dossier projection just won't update until the next
      // event for this claim.
      logger.error(
        { err, documentId, claimId },
        'docSegmenter: doc_segmented dispatch failed (rows persisted, event lost)'
      );
    }

    // 10. Enqueue classifier jobs — one per section.
    for (const sectionId of sectionIds) {
      try {
        await enqueueClassifier({ sectionId, documentId, claimId, hospitalId });
      } catch (err) {
        logger.warn(
          { err, sectionId, documentId },
          'docSegmenter: classifier enqueue failed (will need manual re-run)'
        );
      }
    }

    return {
      sectionIds,
      pagesProcessed: ocr.totalPages,
      costInr: llmResult.costInr,
      shortCircuited: false,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  private async findExistingSections(documentId: string): Promise<string[]> {
    const res = await this.pool.query<{ id: string }>(
      `SELECT id
         FROM hospital.document_sections
        WHERE document_id = $1 AND segmenter_version = $2
        ORDER BY page_start ASC`,
      [documentId, SEGMENTER_VERSION]
    );
    return res.rows.map((r) => r.id);
  }

  /**
   * Sort sections by page_start. We deliberately do NOT auto-correct gaps or
   * overlaps here — if the LLM produced a malformed segmentation we'd rather
   * surface that as a low overall confidence on the dossier and let a human
   * fix it via the correction UI. We DO truncate page_end to totalPages so a
   * model hallucinating a page that doesn't exist doesn't poison the row.
   */
  private normalizeSections(
    raw: SegmenterResponse['sections'],
    totalPages: number
  ): SegmenterResponse['sections'] {
    const sorted = [...raw].sort((a, b) => a.page_start - b.page_start);
    return sorted.map((s) => ({
      ...s,
      page_end: Math.min(s.page_end, totalPages),
      page_start: Math.min(s.page_start, totalPages),
    }));
  }

  /**
   * §C.3.2 rule 2 — an unreadable page may NOT, on its own, open or close a
   * section boundary. It is absorbed into whichever section spans it.
   *
   * The argument is short: a boundary inferred from a page nobody read is a
   * fabricated boundary. The model is looking at an empty summary; "empty"
   * reads like a separator sheet, and a separator sheet reads like "a new
   * document starts here". That inference is plausible, unfalsifiable, and
   * wrong often enough to matter — it splits one bill into two sections, each
   * of which then extracts half a total.
   *
   * Concretely: any section whose ENTIRE page range is unreadable is merged
   * into its neighbour (the preceding one where possible, since sections run
   * forward), and a section that merely STARTS on an unreadable page has its
   * start pulled back to the previous section's end + 1 only when that would
   * close a gap. Sections spanning a mix of readable and unreadable pages are
   * left exactly as the model produced them: those boundaries rest on pages
   * that were genuinely read.
   */
  private absorbUnreadableBoundaries(
    sections: SegmenterResponse['sections'],
    unreadable: Set<number>,
    totalPages: number,
  ): SegmenterResponse['sections'] {
    if (unreadable.size === 0 || sections.length <= 1) return sections;

    const isWhollyUnreadable = (s: {
      page_start?: number;
      page_end?: number;
    }): boolean => {
      const start = Number(s.page_start ?? 0);
      const end = Number(s.page_end ?? 0);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        return false;
      }
      for (let p = start; p <= end; p++) {
        if (!unreadable.has(p)) return false;
      }
      return true;
    };

    const out: SegmenterResponse['sections'] = [];
    let absorbed = 0;
    for (const s of sections) {
      if (out.length > 0 && isWhollyUnreadable(s)) {
        // Merge forward into the previous section rather than emitting a
        // section made entirely of pages nobody read.
        const prev = out[out.length - 1]!;
        prev.page_end = Math.min(Math.max(prev.page_end, s.page_end), totalPages);
        absorbed++;
        continue;
      }
      out.push({ ...s });
    }

    // A leading wholly-unreadable section (nothing before it to merge into)
    // is absorbed into the section that follows.
    if (out.length > 1 && isWhollyUnreadable(out[0]!)) {
      const first = out.shift()!;
      out[0]!.page_start = Math.max(1, Math.min(first.page_start, out[0]!.page_start));
      absorbed++;
    }

    if (absorbed > 0) {
      logger.info(
        { absorbed, unreadable_pages: [...unreadable].sort((a, b) => a - b) },
        'docSegmenter: absorbed section boundaries that rested only on unreadable pages',
      );
    }
    return out;
  }

  /**
   * The id of the claim's run, when one is genuinely in flight.
   *
   * Returns null for a terminal, superseded or paused run: attributing spend
   * to a run that is not running would charge it against a budget nobody is
   * watching, and would let `checkBudget` pause a run that is already parked.
   * A null degrades the budget check to the static operator caps, which is
   * correct for a document being segmented with no run behind it.
   */
  private async resolveActiveRunId(claimId: string): Promise<string | null> {
    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claimId);
      if (!run) return null;
      return run.status === 'queued' || run.status === 'running' ? run.id : null;
    } catch {
      return null;
    }
  }

  /**
   * The run's approved budget is spent before this document was segmented.
   * Park the ingest phase and pause the run. Never throws — the caller
   * returns zero sections, and resume re-runs ingest for this document from
   * the top (nothing was written, so there is nothing to reconcile).
   */
  private async pauseRunForConsent(
    documentId: string,
    claimId: string,
    verdict: BudgetVerdict,
  ): Promise<void> {
    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claimId);
      if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
      const spend = await claimAiRunService
        .getRunSpend(run)
        .catch(() => ({ totalInr: 0 }) as any);
      const remaining = await claimAiRunService
        .computeProjectedRemainingInr(run)
        .catch(() => 0);
      await claimAiRunService.pauseForConsent({
        run_id: run.id,
        claim_id: claimId,
        spend_inr: spend.totalInr ?? 0,
        projected_remaining_inr: remaining,
      });
      const { default: ledger } = await import('./docPhaseLedger.service.js');
      await ledger
        .blockPhase(documentId, run.id, 'ingest', 'run_budget_exhausted')
        .catch(() => {});
      logger.warn(
        {
          documentId,
          claimId,
          run_id: run.id,
          reason: verdict.reason,
          run_spend_inr: verdict.runSpendInr,
          approved_budget_inr: verdict.runApprovedBudgetInr,
        },
        'docSegmenter: run budget exhausted — run paused for consent, ingest phase blocked, zero sections emitted',
      );
    } catch (err) {
      logger.error(
        { err, documentId, claimId },
        'docSegmenter: pauseForConsent failed — the run may keep spending; investigate',
      );
    }
  }

  /**
   * Record this document's unreadable pages against the claim's current run,
   * so they reach the end-of-run decision. No run cursor (legacy or
   * unattended path) means nothing to record against, and we say nothing.
   */
  private async persistUnreadableForRun(
    documentId: string,
    claimId: string,
    pages: ReturnType<typeof unreadablePagesOf>,
  ): Promise<void> {
    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claimId);
      if (!run || !ACTIVE_FOR_LEDGER.has(run.status)) return;
      await persistUnreadablePages({
        run_id: run.id,
        doc_id: documentId,
        phase: 'ingest',
        pages,
      });
    } catch (err) {
      logger.debug(
        { err, documentId, claimId },
        'docSegmenter: unreadable persist failed (non-fatal)',
      );
    }
  }

  /**
   * §C.3.2 rule 3 — the whole document was unreadable. Persist the pages,
   * fail both ledger phases for this doc, and let the run carry on with the
   * other documents.
   */
  private async recordAllUnreadable(
    documentId: string,
    claimId: string,
    ocr: OcrResult,
  ): Promise<void> {
    const pages = unreadablePagesOf(ocr);
    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claimId);
      if (!run || !ACTIVE_FOR_LEDGER.has(run.status)) return;
      await persistUnreadablePages({
        run_id: run.id,
        doc_id: documentId,
        phase: 'ingest',
        pages,
      });
      const { default: ledger } = await import('./docPhaseLedger.service.js');
      await ledger.failPhase(documentId, run.id, 'ingest', 'all_pages_unreadable');
      await ledger.failPhase(documentId, run.id, 'classify', 'all_pages_unreadable');
    } catch (err) {
      logger.warn(
        { err, documentId, claimId },
        'docSegmenter: all-unreadable bookkeeping failed (non-fatal)',
      );
    }
  }

  private async insertSections(args: {
    documentId: string;
    claimId: string;
    sections: SegmenterResponse['sections'];
  }): Promise<string[]> {
    const { documentId, claimId, sections } = args;
    if (sections.length === 0) return [];

    // Build a multi-row VALUES clause. We rely on pg parameter expansion
    // rather than a CTE to keep the SQL readable.
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const s of sections) {
      valuesSql.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, 'auto')`
      );
      params.push(
        documentId,
        claimId,
        s.page_start,
        s.page_end,
        // boundary confidence goes into classification_confidence — see the
        // migration comment for why.
        Number(s.boundary_confidence.toFixed(3)),
        SEGMENTER_VERSION
      );
    }

    const sql = `
      INSERT INTO hospital.document_sections
        (document_id, claim_id, page_start, page_end,
         classification_confidence, segmenter_version, status)
      VALUES
        ${valuesSql.join(',\n        ')}
      RETURNING id
    `;
    const res = await this.pool.query<{ id: string }>(sql, params);

    // M2: best-effort stage stamp on the legacy fallback path. Same semantics
    // as the bundle classifier — the claim's current stage; never blocks.
    const stage = await fetchClaimStage(claimId, this.pool).catch(() => null);
    if (stage) {
      try {
        await this.pool.query(
          `UPDATE hospital.document_sections SET stage = $1
            WHERE document_id = $2 AND status = 'auto'`,
          [stage, documentId],
        );
      } catch (stampErr) {
        logger.warn({ stampErr, documentId }, 'docSegmenter: stage stamp failed (non-fatal)');
      }
    }

    return res.rows.map((r) => r.id);
  }
}

/** Singleton wired to the default pg pool. Most callers want this. */
export const docSegmenterService = new DocSegmenterService();
export default docSegmenterService;
