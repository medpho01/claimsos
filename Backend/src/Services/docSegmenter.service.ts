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
 *   1. OCR every page (cheap: typed-PDF text where available, Tesseract on
 *      scans). See `OcrService.extractTextFromPdf`.
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
import { getLlmClient } from './llm/factory.js';
import { LlmBudgetExceededError } from './llm/LlmClient.js';
import costAccountingService from './costAccounting.service.js';
import ocrService, { type OcrResult } from './ocr.service.js';
import { eventDispatcher } from './events/eventDispatcher.service.js';
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  CANONICAL_DOC_CATEGORIES,
  type PageSummary,
} from './llm/prompts/docSegmenter.v1.js';

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

    // 2a. Image fast path (JPEG/PNG). A single scanned image is by
    //     definition a single-page document — no boundary detection, no
    //     LLM segmenter call needed. We OCR via Tesseract directly and
    //     emit one section spanning page 1. Saves ~₹0.20-0.30 per image
    //     and avoids feeding a non-PDF buffer to pdf-parse.
    if (isImageBuffer(buffer)) {
      try {
        const page = await ocrService.extractTextFromImage(buffer);
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
    const ocr: OcrResult = await ocrService.extractTextFromPdf(buffer);
    if (ocr.totalPages === 0 || ocr.pages.length === 0) {
      logger.warn(
        { documentId, claimId },
        'docSegmenter: PDF has zero pages — nothing to segment'
      );
      return { sectionIds: [], pagesProcessed: 0, costInr: 0, shortCircuited: false };
    }
    if (ocr.totalPages > SOFT_PAGE_LIMIT) {
      logger.warn(
        { documentId, totalPages: ocr.totalPages, softLimit: SOFT_PAGE_LIMIT },
        'docSegmenter: large PDF — single-call segmentation may be costly'
      );
    }

    // 3. Pre-flight budget check. Strictly fail BEFORE the LLM call so we
    //    don't burn tokens we'd then have to refuse.
    const verdict = await costAccountingService.checkBudget(claimId, hospitalId);
    if (verdict.action === 'block') {
      throw new LlmBudgetExceededError(
        // We don't know whether the block came from the claim or the hospital
        // dimension without inspecting verdict.reason — default to 'claim' and
        // surface the verdict's reason on the message via the error super().
        verdict.claimSpendInr !== undefined &&
        verdict.claimSpendInr >= 15 /* CLAIM_HARD_LIMIT_INR */
          ? 'claim'
          : 'hospital_daily',
        verdict.claimSpendInr ?? verdict.hospitalDailySpendInr ?? 0,
        verdict.hospitalDailyCapInr ?? 15,
        { claimId, hospitalId }
      );
    }

    // 4. Build the LLM input — page summaries only, never the raw PDF.
    const pageSummaries: PageSummary[] = ocr.pages.map((p) => ({
      pageNumber: p.pageNumber,
      textPreview: (p.text || '').slice(0, PAGE_PREVIEW_CHARS),
      confidence: p.confidence,
    }));

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
    const sections = this.normalizeSections(
      llmResult.data.sections,
      ocr.totalPages
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
    return res.rows.map((r) => r.id);
  }
}

/** Singleton wired to the default pg pool. Most callers want this. */
export const docSegmenterService = new DocSegmenterService();
export default docSegmenterService;
