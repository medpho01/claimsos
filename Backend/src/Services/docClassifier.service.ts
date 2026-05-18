/**
 * Sprint 5 / Wave 2B — Document Section Classifier
 *
 * Consumes one hospital.document_sections row produced by the segmenter
 * (Wave 2A), runs OCR on just the section's pages, asks the LLM bridge to
 * pick one of the 21 master_options('doc_category') codes, persists the
 * verdict back to the row, emits a `section_classified` event, and enqueues
 * the extractor for the same section.
 *
 * Design notes:
 *
 * 1. Per-section OCR — the segmenter does not (yet) persist per-page text to
 *    S3, so the classifier re-fetches the source PDF, slices out just the
 *    pages in [page_start..page_end] with pdf-lib, and hands the slice to
 *    OcrService. This is cheap because:
 *      - pdf-parse / Tesseract run only on the bytes we hand them; the
 *        cost is proportional to section size, not document size.
 *      - OcrService LRU-caches by buffer hash so multiple sections of the
 *        same document don't re-OCR shared bytes (well, they do — the
 *        slices differ — but each slice is cached individually).
 *
 * 2. Truncation — discharge summaries and ICPs can run to thousands of
 *    tokens; we truncate the section text to a ~3k-token (~12k-char)
 *    budget before sending. The first 12k characters contain the heading
 *    and structured field block in every category we've inspected; the
 *    body that follows is repetitive narrative which adds noise more than
 *    signal for category-discrimination. The extractor (separate service)
 *    does NOT truncate as aggressively because it needs the body.
 *
 * 3. Idempotency — if document_sections.classifier_version already equals
 *    CLASSIFIER_VERSION for this row, short-circuit and return the stored
 *    verdict. Re-running across a CLASSIFIER_VERSION bump is the standard
 *    way to roll a new prompt.
 *
 * 4. Tier — standard. Haiku does the work for the cheap-and-cheerful 95%
 *    of sections; the bridge auto-escalates to Sonnet when self-rated
 *    confidence < 0.7. Cost target: ₹0.05-0.10 per classification (Haiku),
 *    ₹0.30-0.60 on escalation.
 */

import type { Pool } from 'pg';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import defaultS3Service from './s3.service.js';
import defaultOcrService from './ocr.service.js';
import costAccountingService from './costAccounting.service.js';
import { eventDispatcher as defaultEventDispatcher } from './events/eventDispatcher.service.js';
import { getLlmClient } from './llm/factory.js';
import { LlmBudgetExceededError } from './llm/LlmClient.js';
import {
  DOC_CLASSIFIER_SYSTEM_PROMPT,
  buildDocClassifierUserPrompt,
  CLASSIFIER_PROMPT_VERSION,
} from './llm/prompts/docClassifier.v1.js';

/**
 * Bump CLASSIFIER_VERSION when prompt, candidate-list source, or the
 * persisted shape changes. Existing rows are NOT auto-reclassified; a
 * separate backfill job re-enqueues sections whose classifier_version
 * is older than this constant.
 */
export const CLASSIFIER_VERSION = 'v1';

const SECTION_TEXT_MAX_CHARS = 12_000; // ≈ 3k tokens at 4 chars/token.

export interface ClassifySectionInput {
  sectionId: string;
  claimId: string;
  hospitalId: string;
}

export interface ClassifySectionResult {
  category: string;
  confidence: number;
  costInr: number;
  tierEscalated: boolean;
}

interface SectionRow {
  id: string;
  document_id: string;
  page_start: number;
  page_end: number;
  classifier_version: string | null;
  category: string | null;
  classification_confidence: number | null;
  s3_key: string;
}

/**
 * Optional dependencies bag for tests and alternate wiring. Production
 * callers should construct with no args (or the default singleton); tests
 * inject stubs for ocr/s3/event/llm.
 */
export interface DocClassifierDeps {
  pool?: Pick<Pool, 'query'>;
  llm?: ReturnType<typeof getLlmClient>;
  s3?: Pick<typeof defaultS3Service, 'download'>;
  ocr?: Pick<typeof defaultOcrService, 'extractTextFromPdf'>;
  events?: Pick<typeof defaultEventDispatcher, 'dispatch'>;
  costAccounting?: Pick<typeof costAccountingService, 'checkBudget'>;
  enqueueExtractor?: (sectionId: string, claimId: string, hospitalId: string) => Promise<void>;
}

export class DocClassifierService {
  private readonly pool: Pick<Pool, 'query'>;
  private readonly llm: ReturnType<typeof getLlmClient>;
  private readonly s3: Pick<typeof defaultS3Service, 'download'>;
  private readonly ocr: Pick<typeof defaultOcrService, 'extractTextFromPdf'>;
  private readonly events: Pick<typeof defaultEventDispatcher, 'dispatch'>;
  private readonly costAccounting: Pick<typeof costAccountingService, 'checkBudget'>;
  private readonly enqueueExtractor: (
    sectionId: string,
    claimId: string,
    hospitalId: string,
  ) => Promise<void>;

  constructor(deps: DocClassifierDeps = {}) {
    this.pool = deps.pool ?? defaultPool;
    // Lazy: getLlmClient() reads env, which may not be set in tests that
    // never touch the LLM. We only call it if the test didn't override.
    this.llm = deps.llm ?? getLlmClient();
    this.s3 = deps.s3 ?? defaultS3Service;
    this.ocr = deps.ocr ?? defaultOcrService;
    this.events = deps.events ?? defaultEventDispatcher;
    this.costAccounting = deps.costAccounting ?? costAccountingService;
    this.enqueueExtractor =
      deps.enqueueExtractor ??
      (async (sectionId, claimId, hospitalId) => {
        // Lazy import to avoid pulling Bull into the service test surface.
        const mod = await import('../Workers/docExtractor.queue.js');
        await mod.enqueueDocExtraction(sectionId, claimId, hospitalId);
      });
  }

  async classifySection(input: ClassifySectionInput): Promise<ClassifySectionResult> {
    const { sectionId, claimId, hospitalId } = input;

    // 1. Load section + parent document s3_key. The exact parent table is
    //    determined by Wave 2A's migration 032; we try the two shapes that
    //    are on the table (a dedicated `documents` table or the existing
    //    `hospital_documents` table). The COALESCE in the JOIN handles both.
    const sectionRow = await this.loadSection(sectionId);
    if (!sectionRow) {
      throw new Error(`docClassifier: section ${sectionId} not found`);
    }

    // 2. Idempotency: if this version has already run on this row, return
    //    the stored verdict. The extractor enqueue ALSO short-circuits if
    //    the section already has a category, so a duplicate enqueue is
    //    cheap.
    if (
      sectionRow.classifier_version === CLASSIFIER_VERSION &&
      sectionRow.category
    ) {
      logger.info(
        { sectionId, classifier_version: CLASSIFIER_VERSION, category: sectionRow.category },
        'docClassifier: idempotent short-circuit (version matches)',
      );
      // Even on short-circuit, make sure the extractor sees this section.
      // The extractor itself is idempotent on extractor_version.
      await this.safeEnqueueExtractor(sectionId, claimId, hospitalId);
      return {
        category: sectionRow.category,
        confidence: Number(sectionRow.classification_confidence ?? 1),
        costInr: 0,
        tierEscalated: false,
      };
    }

    // 3. Budget pre-flight. We rely on the LLM bridge to also enforce, but
    //    checking here lets us throw a clean LlmBudgetExceededError before
    //    paying the OCR cost on a section we'll never classify.
    const verdict = await this.costAccounting.checkBudget(claimId, hospitalId);
    if (verdict.action === 'block') {
      throw new LlmBudgetExceededError(
        verdict.claimUnderLimit ? 'hospital_daily' : 'claim',
        verdict.claimUnderLimit
          ? (verdict.hospitalDailySpendInr ?? 0)
          : (verdict.claimSpendInr ?? 0),
        verdict.claimUnderLimit
          ? (verdict.hospitalDailyCapInr ?? 0)
          : 15,
        { claimId, hospitalId },
      );
    }

    // 4. Fetch source PDF and slice to the section's pages.
    const slicedPdf = await this.fetchAndSlicePdf(
      sectionRow.s3_key,
      sectionRow.page_start,
      sectionRow.page_end,
    );

    // 5. OCR the slice. We don't allow vision fallback here — the
    //    classifier is supposed to be cheap; if OCR is poor we degrade to
    //    a low-confidence category and let escalation handle it.
    const ocr = await this.ocr.extractTextFromPdf(slicedPdf);
    const sectionText = this.joinAndTruncate(ocr.pages.map((p) => p.text));
    const pagesContext = `Section spans pages ${sectionRow.page_start}-${sectionRow.page_end} of the parent document (this slice is ${ocr.totalPages} page${ocr.totalPages === 1 ? '' : 's'}, avg OCR confidence ${ocr.avgConfidence.toFixed(2)}).`;

    // 6. Resolve the candidate category list at runtime from master_options
    //    so a new doc_category code added to the ontology auto-flows in
    //    without a code change.
    const candidateCategories = await this.loadCandidateCategories();

    // 7. Call the bridge. classify() handles tier escalation, cost logging,
    //    and category-list validation internally. The bridge does not
    //    currently surface a cacheKey for classify (only for extract); if
    //    we observe duplicate classify calls for identical text we'll add
    //    one as a follow-up.
    const llmResult = await this.llm.classify({
      systemPrompt: DOC_CLASSIFIER_SYSTEM_PROMPT,
      userPrompt: buildDocClassifierUserPrompt({
        sectionText,
        pagesContext,
        candidateCategories,
      }),
      categories: candidateCategories,
      promptVersion: CLASSIFIER_PROMPT_VERSION,
      taskName: 'doc_classify',
      tier: 'standard',
      claimId,
      hospitalId,
    });

    // 9. Cost accounting: the LLM bridge (providers/claudeClient.ts)
    //    already records every call to llm_cost_log against this
    //    (claimId, hospitalId) — we do NOT double-record here. If you
    //    change provider behaviour to stop auto-recording, add an
    //    explicit costAccountingService.recordCall in this block.

    // 10. Persist verdict back to document_sections. We trust the bridge
    //     to have returned a category that IS in the candidate list, and
    //     we still defensively-check before writing — an off-list value
    //     would be a bridge bug.
    if (!candidateCategories.includes(llmResult.category)) {
      throw new Error(
        `docClassifier: bridge returned off-list category '${llmResult.category}' for section ${sectionId}`,
      );
    }

    await this.persistVerdict(
      sectionId,
      llmResult.category,
      llmResult.confidence,
    );

    // 11. Emit the typed event. Idempotency key = (sectionId, version) so
    //     a retried classify doesn't double-emit.
    try {
      await this.events.dispatch({
        kind: 'section_classified',
        claimId,
        hospitalId,
        payload: {
          section_id: sectionId,
          category: llmResult.category,
          confidence: llmResult.confidence,
          classifier_version: CLASSIFIER_VERSION,
        },
        idempotencyKey: `section_classified:${sectionId}:${CLASSIFIER_VERSION}`,
      });
    } catch (err) {
      // Event-emit failure is not fatal — the row is persisted and a
      // catch-up projector can re-emit. Log loudly.
      logger.warn({ err, sectionId }, 'docClassifier: event dispatch failed (non-fatal)');
    }

    // 12. Enqueue the extractor. Best-effort — if Bull is down the
    //     extractor catch-up scheduler (out of scope here) will pick it up.
    await this.safeEnqueueExtractor(sectionId, claimId, hospitalId);

    // tierEscalated is not directly exposed on LlmClassifyResult — infer
    // it by inspecting the cost: an escalated call costs noticeably more
    // than a single Haiku call. This is a soft heuristic, NOT relied on
    // for correctness; the cost-log row records the true model.
    const tierEscalated = (llmResult.costInr ?? 0) > 0.5;

    return {
      category: llmResult.category,
      confidence: llmResult.confidence,
      costInr: llmResult.costInr,
      tierEscalated,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  private async loadSection(sectionId: string): Promise<SectionRow | null> {
    // Wave 2A's `hospital.document_sections` rows reference a parent doc
    // by document_id. The parent table may be `hospital.documents` (new
    // in 2A) or fall back to the legacy `hospital.hospital_documents`.
    // Try the new table first; if its s3_key is NULL fall through to the
    // legacy join. This keeps the classifier working through the wave
    // cutover without coupling to migration timing.
    const sql = `
      SELECT
        ds.id,
        ds.document_id,
        ds.page_start,
        ds.page_end,
        ds.classifier_version,
        ds.category,
        ds.classification_confidence,
        COALESCE(d.s3_key, hd.s3_key) AS s3_key
      FROM hospital.document_sections ds
      LEFT JOIN hospital.documents d ON d.id = ds.document_id
      LEFT JOIN hospital.hospital_documents hd ON hd.id = ds.document_id
      WHERE ds.id = $1
      LIMIT 1
    `;
    try {
      const res = await this.pool.query<SectionRow>(sql, [sectionId]);
      const row = res.rows[0];
      if (!row || !row.s3_key) return null;
      return row;
    } catch (err: any) {
      // If `hospital.documents` doesn't exist (Wave 2A not yet applied in
      // this env), Postgres throws 42P01. Retry against the legacy table
      // only so dev/test envs without Wave 2A still work.
      if (String(err?.code) === '42P01') {
        logger.warn({ err: err.message }, 'docClassifier: hospital.documents missing, falling back to hospital_documents only');
        const fallback = await this.pool.query<SectionRow>(
          `SELECT ds.id, ds.document_id, ds.page_start, ds.page_end,
                  ds.classifier_version, ds.category, ds.classification_confidence,
                  hd.s3_key AS s3_key
             FROM hospital.document_sections ds
             JOIN hospital.hospital_documents hd ON hd.id = ds.document_id
            WHERE ds.id = $1
            LIMIT 1`,
          [sectionId],
        );
        return fallback.rows[0] ?? null;
      }
      throw err;
    }
  }

  private async fetchAndSlicePdf(
    s3Key: string,
    pageStart: number,
    pageEnd: number,
  ): Promise<Buffer> {
    const fullPdf = await this.s3.download(s3Key);

    // Lazy import pdf-lib so we don't pay its parse cost on cold start of
    // services that never touch a PDF.
    const { PDFDocument } = await import('pdf-lib');
    const src = await PDFDocument.load(fullPdf);
    const total = src.getPageCount();

    // Clamp defensively. The segmenter SHOULD produce in-range page numbers
    // (1-indexed); if it ever doesn't, log + clamp rather than throwing.
    const start = Math.max(1, Math.min(pageStart, total));
    const end = Math.max(start, Math.min(pageEnd, total));
    if (start !== pageStart || end !== pageEnd) {
      logger.warn(
        { pageStart, pageEnd, start, end, total, s3Key },
        'docClassifier: clamped out-of-range page range from segmenter',
      );
    }

    const dst = await PDFDocument.create();
    const indices: number[] = [];
    for (let i = start - 1; i <= end - 1; i++) indices.push(i);
    const copied = await dst.copyPages(src, indices);
    for (const p of copied) dst.addPage(p);
    const bytes = await dst.save();
    return Buffer.from(bytes);
  }

  private joinAndTruncate(pages: string[]): string {
    const joined = pages.join('\n\n--- page break ---\n\n').trim();
    if (joined.length <= SECTION_TEXT_MAX_CHARS) return joined;
    // Keep the first SECTION_TEXT_MAX_CHARS — the heading + first body
    // page carries the strongest category signal.
    return joined.slice(0, SECTION_TEXT_MAX_CHARS) + '\n... [truncated]';
  }

  private async loadCandidateCategories(): Promise<string[]> {
    const res = await this.pool.query<{ code: string }>(
      `SELECT code
         FROM hospital.master_options
        WHERE category = 'doc_category'
        ORDER BY sort_order, code`,
    );
    if (res.rows.length === 0) {
      throw new Error(
        "docClassifier: no doc_category codes in master_options — migration 028 not applied?",
      );
    }
    return res.rows.map((r) => r.code);
  }

  private async persistVerdict(
    sectionId: string,
    category: string,
    confidence: number,
  ): Promise<void> {
    // Provider/model are recorded by the LLM bridge in llm_cost_log; we
    // duplicate provider + a marker model name on the section row so a
    // FE/ops user can see at-a-glance "this came from Claude / Haiku" on
    // the dossier without joining cost logs. The bridge's classify() does
    // not return the model name, so we stamp 'claude:standard' as a
    // marker — the precise model id lives in the cost log.
    const sql = `
      UPDATE hospital.document_sections
         SET category = $2,
             classification_confidence = $3,
             classifier_provider = 'claude',
             classifier_model = 'standard',
             classifier_version = $4,
             updated_at = NOW()
       WHERE id = $1
       RETURNING classifier_model
    `;
    const res = await this.pool.query<{ classifier_model: string }>(sql, [
      sectionId,
      category,
      confidence,
      CLASSIFIER_VERSION,
    ]);
    if ((res.rowCount ?? 0) === 0) {
      throw new Error(`docClassifier: UPDATE returned no row for section ${sectionId}`);
    }
  }

  private async safeEnqueueExtractor(
    sectionId: string,
    claimId: string,
    hospitalId: string,
  ): Promise<void> {
    try {
      await this.enqueueExtractor(sectionId, claimId, hospitalId);
    } catch (err) {
      logger.warn(
        { err, sectionId },
        'docClassifier: enqueueExtractor failed (catch-up scheduler will retry)',
      );
    }
  }
}

/**
 * Lazy singleton — convenient default for production callers. Constructing
 * eagerly at module-import would call getLlmClient() during test imports,
 * which would try to read ANTHROPIC_API_KEY from env. Tests should
 * construct their own `new DocClassifierService({ ... })` with stubs.
 */
let _singleton: DocClassifierService | null = null;
const docClassifierService = {
  classifySection: (input: ClassifySectionInput) => {
    if (!_singleton) _singleton = new DocClassifierService();
    return _singleton.classifySection(input);
  },
};
export default docClassifierService;
