/**
 * Email Intelligence Service — Sprint 4, Wave 2C
 *
 * Turns an inbound insurer email + its attachments into a *draft*
 * interpretation that a human reviewer applies (or rejects). The LLM never
 * touches a claim directly — every effect funnels through this service,
 * gets recorded in hospital.email_intelligence_drafts, and is gated by a
 * human's apply action which emits ai_draft_applied for Wave 3 consumers
 * (adjudication engine, action engine) to react to.
 *
 * Pipeline shape (processInboundEmail):
 *   1. Idempotency probe: if a draft with (inbound_email_id, prompt_version)
 *      already exists, return it without re-calling the LLM. The UNIQUE
 *      index on the pair makes this race-safe — even concurrent invocations
 *      converge on a single draft.
 *   2. OCR all PDF attachments via OcrService. Per-page text is concatenated
 *      and labelled. Image-only attachments would need image OCR — out of
 *      scope for v1; the worker simply skips them with a warning.
 *   3. classify → LlmClient.classify against the v1 classifier prompt.
 *      Returns one of master_options(insurer_outcome) codes plus 'other' /
 *      'unknown'. Confidence is captured.
 *   4. extract  → branch on category:
 *        - approved / partially_approved / enhancement_approved /
 *          enhancement_partial → ApprovalExtraction
 *        - queried / follow_up                                  → QueryExtraction
 *        - rejected / withdrawn                                 → RejectionExtraction
 *        - other / unknown                                      → no extract call;
 *          the draft is stored with extracted_payload=null and the human
 *          picks the right outcome at apply time.
 *   5. Persist a row in email_intelligence_drafts. On UNIQUE conflict (race
 *      with a concurrent invocation) return the existing draft.
 *   6. Record both LLM calls to costAccounting.recordCall.
 *   7. Dispatch ai_draft_created so the cockpit timeline reflects the draft.
 *
 * Failure handling:
 *   - LlmSchemaValidationError on either the classify or the extract path
 *     → we still create a draft row with status='extraction_failed',
 *       extracted_payload=null, and raw_response populated for debugging.
 *       PHI hygiene: raw_response is ONLY persisted on failure rows.
 *   - LlmBudgetExceededError, network errors, etc. → same handling. Failure
 *     rows are visible in the ops queue alongside successful pending_review
 *     drafts so the reviewer can decide whether to retry manually or fall
 *     back to manual classification.
 *
 * Out of scope (Wave 3+):
 *   - Actually updating the claim (writing approval_amount to ipds, raising
 *     query rows, transitioning stage). applyDraft just flips the status
 *     and emits ai_draft_applied; downstream consumers do the real work.
 *   - Vision fallback for scanned attachments below OCR confidence.
 *   - Re-processing under a new prompt version on demand (the UNIQUE
 *     constraint allows multiple drafts per email under different prompt
 *     versions, but nothing in this file actively triggers that — the
 *     worker only ever uses EMAIL_INTEL_VERSION).
 */

import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import costAccounting from './costAccounting.service.js';
import { eventDispatcher } from './events/eventDispatcher.service.js';
import {
  getLlmClient,
} from './llm/factory.js';
import {
  LlmSchemaValidationError,
  type LlmAttachment,
  type LlmClient,
} from './llm/LlmClient.js';
import OcrServiceSingleton, { OcrService } from './ocr.service.js';
import {
  EXTRACTION_SCHEMA_BY_CATEGORY,
  INSURER_OUTCOME_CATEGORIES,
  type InsurerOutcomeCategory,
} from './llm/schemas/emailIntelligence.js';
import * as classifierPrompt from './llm/prompts/emailClassifier.v1.js';
import * as approvalPrompt from './llm/prompts/emailExtractor.approval.v1.js';
import * as queryPrompt from './llm/prompts/emailExtractor.query.v1.js';
import * as rejectionPrompt from './llm/prompts/emailExtractor.rejection.v1.js';

// ─── Public constants ─────────────────────────────────────────────────────

/**
 * Bumped whenever ANY of the prompts in Services/llm/prompts/email*.v*.ts
 * changes meaningfully (different system prompt wording, different output
 * keys, different category list). The (inbound_email_id, prompt_version)
 * UNIQUE on email_intelligence_drafts means re-processing under a new
 * version sits alongside prior drafts rather than overwriting them.
 *
 * If the prompts diverge between classifier and extractors, this version
 * is the *intersection* — the version recorded in the cost log per call
 * is the per-prompt version (classifierPrompt.PROMPT_VERSION etc.). This
 * shared version is what the draft row stores for idempotency.
 */
export const EMAIL_INTEL_VERSION = 'v1';

// ─── Types ────────────────────────────────────────────────────────────────

export interface ProcessInboundEmailInput {
  inboundEmailId: string;
  claimId: string | null;
  hospitalId: string;
  body: string;
  attachments: Array<{ filename: string; buffer: Buffer; mime: string }>;
}

export interface ProcessInboundEmailResult {
  draftId: string;
  category: string;
  costInr: number;
  /** True when the draft already existed (idempotent re-run). */
  deduped: boolean;
  /** True for extraction_failed rows. The caller may want to surface a warning. */
  failed: boolean;
}

export interface ApplyDraftOpts {
  appliedBy: string;
  /**
   * Reviewer overrides at apply time. Each top-level key is a JSON-pointer-
   * like path into the draft's extracted_payload; values that differ from
   * the AI's value are written to email_intelligence_corrections. Pass an
   * empty object (or undefined) to apply the draft as-is.
   */
  fieldOverrides?: Record<string, unknown>;
}

export interface RejectDraftOpts {
  rejectedBy: string;
  reason: string;
}

type Queryable = Pool | PoolClient | Pick<Pool, 'query'>;

// Internal — what the LLM bridge calls bookkeep on each call.
interface LlmCallMeta {
  provider: string;
  model: string;
  tokensUsed: number;
  latencyMs: number;
  costInr: number;
  rawResponse?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────

export class EmailIntelligenceService {
  // Constructor injection so tests can swap the pool / LLM / OCR / dispatcher
  // without having to monkey-patch defaults.
  constructor(
    private readonly pool: Queryable = defaultPool,
    private readonly llm: LlmClient = getLlmClient(),
    private readonly ocr: OcrService = OcrServiceSingleton,
    private readonly dispatcher = eventDispatcher,
    private readonly cost = costAccounting,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // processInboundEmail
  // ────────────────────────────────────────────────────────────────────────

  async processInboundEmail(
    input: ProcessInboundEmailInput,
  ): Promise<ProcessInboundEmailResult> {
    const { inboundEmailId, claimId, hospitalId } = input;

    // (a) Idempotency probe BEFORE any LLM work. A worker retry on a
    //     transient failure must not spend tokens twice.
    const existing = await this.findExistingDraft(inboundEmailId, EMAIL_INTEL_VERSION);
    if (existing) {
      logger.debug(
        { inboundEmailId, draftId: existing.id, status: existing.status },
        'emailIntelligence: idempotent return — draft already exists',
      );
      return {
        draftId: existing.id,
        category: existing.category,
        costInr: Number(existing.cost_inr ?? 0),
        deduped: true,
        failed: existing.status === 'extraction_failed',
      };
    }

    // (b) OCR attachments. PDF only; images are skipped with a warning.
    //     A failure on one attachment doesn't abort the whole pipeline —
    //     we still want to classify the email body.
    const attachmentTexts = await this.ocrAttachments(input.attachments);

    // (c) Classify. Any failure here goes straight to the extraction_failed
    //     branch — we don't have a category to drive the extractor.
    let classifyMeta: LlmCallMeta | null = null;
    let category: InsurerOutcomeCategory | null = null;
    let classifierConfidence = 0;
    let classifyRaw = '';

    try {
      const classifyRes = await this.llm.classify({
        systemPrompt: classifierPrompt.SYSTEM_PROMPT,
        userPrompt: classifierPrompt.buildUserPrompt(input.body, attachmentTexts),
        categories: INSURER_OUTCOME_CATEGORIES,
        promptVersion: classifierPrompt.PROMPT_VERSION,
        taskName: classifierPrompt.TASK_NAME,
        claimId: claimId ?? undefined,
        hospitalId,
        documents: this.attachmentTextsToLlmDocs(attachmentTexts),
      });
      category = classifyRes.category as InsurerOutcomeCategory;
      classifierConfidence = classifyRes.confidence;
      classifyMeta = {
        provider: 'anthropic',
        // classify() doesn't currently surface the resolved model in its
        // result; record what the bridge used. The cost log is keyed off
        // the per-call cost return, which the bridge does compute.
        model: 'unknown',
        tokensUsed: 0,
        latencyMs: 0,
        costInr: classifyRes.costInr,
      };
      await this.recordCost(
        claimId,
        hospitalId,
        classifierPrompt.TASK_NAME,
        classifierPrompt.PROMPT_VERSION,
        classifyMeta,
        true,
        null,
      );
    } catch (err) {
      classifyRaw =
        err instanceof LlmSchemaValidationError ? err.rawResponse : String((err as Error)?.message ?? err);
      logger.warn(
        { err, inboundEmailId, taskName: classifierPrompt.TASK_NAME },
        'emailIntelligence: classify failed — recording extraction_failed draft',
      );
      // Best-effort cost record for the failed call. We don't know the
      // exact spend; record 0 so the row exists for audit and bump a
      // counter via the error_message field.
      await this.recordCost(
        claimId,
        hospitalId,
        classifierPrompt.TASK_NAME,
        classifierPrompt.PROMPT_VERSION,
        { provider: 'anthropic', model: 'unknown', tokensUsed: 0, latencyMs: 0, costInr: 0 },
        false,
        (err as Error)?.message ?? 'classify_failed',
      );
      return this.persistFailedDraft({
        inboundEmailId,
        claimId,
        category: 'unknown',
        classifierConfidence: 0,
        rawResponse: classifyRaw,
      });
    }

    // (d) Extract (only for categories with a payload schema). For 'other'
    //     and 'unknown' we skip the extract call entirely — the reviewer
    //     picks the real outcome at apply time.
    let extractedPayload: unknown = null;
    let extractMeta: LlmCallMeta | null = null;

    const extractSchema = EXTRACTION_SCHEMA_BY_CATEGORY[category];
    if (extractSchema) {
      const { systemPrompt, userPrompt, taskName, promptVersion } =
        this.extractorForCategory(category, input.body, attachmentTexts);

      try {
        const extractRes = await this.llm.extract({
          systemPrompt,
          userPrompt,
          schema: extractSchema as z.ZodSchema<unknown>,
          documents: this.attachmentTextsToLlmDocs(attachmentTexts),
          promptVersion,
          taskName,
          claimId: claimId ?? undefined,
          hospitalId,
        });
        extractedPayload = extractRes.data;
        extractMeta = {
          provider: extractRes.provider,
          model: extractRes.model,
          tokensUsed:
            extractRes.tokensInputUncached +
            extractRes.tokensInputCached +
            extractRes.tokensOutput,
          latencyMs: extractRes.latencyMs,
          costInr: extractRes.costInr,
        };
        await this.recordCost(
          claimId,
          hospitalId,
          taskName,
          promptVersion,
          extractMeta,
          true,
          null,
        );
      } catch (err) {
        const raw =
          err instanceof LlmSchemaValidationError ? err.rawResponse : String((err as Error)?.message ?? err);
        logger.warn(
          { err, inboundEmailId, category, taskName },
          'emailIntelligence: extract failed — recording extraction_failed draft',
        );
        await this.recordCost(
          claimId,
          hospitalId,
          taskName,
          promptVersion,
          { provider: 'anthropic', model: 'unknown', tokensUsed: 0, latencyMs: 0, costInr: 0 },
          false,
          (err as Error)?.message ?? 'extract_failed',
        );
        return this.persistFailedDraft({
          inboundEmailId,
          claimId,
          category,
          classifierConfidence,
          rawResponse: raw,
          classifierCostInr: classifyMeta?.costInr ?? 0,
        });
      }
    }

    // (e) Persist the happy-path draft. ON CONFLICT DO NOTHING covers the
    //     race where two workers processed the same email in parallel —
    //     the loser's INSERT no-ops and a follow-up SELECT returns the
    //     winner's row.
    const totalCostInr = (classifyMeta?.costInr ?? 0) + (extractMeta?.costInr ?? 0);
    const totalTokens = (extractMeta?.tokensUsed ?? 0); // classify tokens not exposed
    const totalLatency =
      (classifyMeta?.latencyMs ?? 0) + (extractMeta?.latencyMs ?? 0);

    const insertRes = await this.pool.query<{
      id: string;
      inserted: boolean;
    }>(
      `
      WITH ins AS (
        INSERT INTO hospital.email_intelligence_drafts
          (inbound_email_id, claim_id, category, classifier_confidence,
           extracted_payload, llm_provider, llm_model, prompt_version,
           tokens_used, latency_ms, cost_inr, status, raw_response)
        VALUES
          ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, 'pending_review', NULL)
        ON CONFLICT (inbound_email_id, prompt_version) DO NOTHING
        RETURNING id
      )
      SELECT id, TRUE AS inserted FROM ins
      UNION ALL
      SELECT id, FALSE AS inserted
        FROM hospital.email_intelligence_drafts
       WHERE inbound_email_id = $1
         AND prompt_version = $8
         AND NOT EXISTS (SELECT 1 FROM ins)
      LIMIT 1
      `,
      [
        inboundEmailId,
        claimId,
        category,
        classifierConfidence,
        JSON.stringify(extractedPayload),
        extractMeta?.provider ?? classifyMeta?.provider ?? 'anthropic',
        extractMeta?.model ?? null,
        EMAIL_INTEL_VERSION,
        totalTokens,
        totalLatency,
        totalCostInr,
      ],
    );

    const row = insertRes.rows[0];
    if (!row) {
      // Should be impossible given the UNION ALL fallback; surface loudly.
      throw new Error(
        `emailIntelligence: INSERT returned no row for inbound_email_id=${inboundEmailId}`,
      );
    }
    const draftId = row.id;
    const deduped = !row.inserted;

    if (deduped) {
      // Race winner already dispatched the event; don't double-fire.
      logger.info(
        { inboundEmailId, draftId, category },
        'emailIntelligence: insert lost race, returning winning draft',
      );
      return {
        draftId,
        category,
        costInr: totalCostInr,
        deduped: true,
        failed: false,
      };
    }

    // (f) Dispatch ai_draft_created. claim_id may be null for unmatched
    //     emails — in that case we skip the dispatch because the event
    //     dispatcher requires a claim_id.
    if (claimId) {
      try {
        await this.dispatcher.dispatch({
          kind: 'ai_draft_created',
          claimId,
          hospitalId,
          payload: {
            draft_id: draftId,
            kind: `email_intelligence.${category}`,
            confidence: classifierConfidence,
            llm_provider: extractMeta?.provider ?? classifyMeta?.provider ?? 'anthropic',
            llm_model: extractMeta?.model ?? 'unknown',
            tokens_used: totalTokens,
            cost_inr: totalCostInr,
          },
          idempotencyKey: `ai_draft_created:${draftId}`,
        });
      } catch (err) {
        // Event dispatch failure is non-fatal for the draft — the row is
        // already persisted and the cockpit will surface it on its next
        // query. Log so we notice.
        logger.warn(
          { err, draftId, claimId },
          'emailIntelligence: ai_draft_created dispatch failed (draft persisted)',
        );
      }
    }

    return { draftId, category, costInr: totalCostInr, deduped: false, failed: false };
  }

  // ────────────────────────────────────────────────────────────────────────
  // applyDraft
  // ────────────────────────────────────────────────────────────────────────

  async applyDraft(draftId: string, opts: ApplyDraftOpts): Promise<void> {
    // 1. Load the current draft (we need extracted_payload + claim_id +
    //    hospital_id for corrections and the event).
    const existing = await this.pool.query<{
      id: string;
      claim_id: string | null;
      inbound_email_id: string;
      extracted_payload: unknown;
      status: string;
    }>(
      `SELECT d.id, d.claim_id, d.inbound_email_id, d.extracted_payload, d.status
         FROM hospital.email_intelligence_drafts d
        WHERE d.id = $1`,
      [draftId],
    );
    if ((existing.rowCount ?? 0) === 0) {
      throw new Error(`emailIntelligence.applyDraft: draft ${draftId} not found`);
    }
    const row = existing.rows[0]!;
    if (row.status === 'applied') {
      // Idempotent: already applied. No-op, no event re-fire.
      logger.info({ draftId }, 'emailIntelligence.applyDraft: already applied, no-op');
      return;
    }
    if (row.status !== 'pending_review') {
      throw new Error(
        `emailIntelligence.applyDraft: draft ${draftId} not in pending_review (status=${row.status})`,
      );
    }

    // 2. Compute corrections — every (path, value) in fieldOverrides whose
    //    value differs from what the AI suggested at the same path.
    const overrides = opts.fieldOverrides ?? {};
    const corrections: Array<{
      path: string;
      ai: unknown;
      human: unknown;
    }> = [];
    for (const [path, humanVal] of Object.entries(overrides)) {
      const aiVal = readPath(row.extracted_payload, path);
      if (!deepEqual(aiVal, humanVal)) {
        corrections.push({ path, ai: aiVal, human: humanVal });
      }
    }

    // 3. Apply + write corrections. We do this in a transaction so a
    //    partial apply (status flipped, corrections row missing) never
    //    happens. The dispatcher event lives OUTSIDE the transaction —
    //    submission_events has its own write path and we'd rather have
    //    a successful apply with a missing event than the reverse.
    const claimIdForEvent: string | null = row.claim_id;
    if (typeof (this.pool as any).connect === 'function') {
      const client = await (this.pool as Pool).connect();
      try {
        await client.query('BEGIN');
        await this.markApplied(client, draftId, opts.appliedBy);
        await this.persistCorrections(client, draftId, corrections, opts.appliedBy);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else {
      // Test path: pool stub without .connect(). Run statements directly.
      await this.markApplied(this.pool, draftId, opts.appliedBy);
      await this.persistCorrections(this.pool, draftId, corrections, opts.appliedBy);
    }

    // 4. Dispatch ai_draft_applied. claim_id is required by the event
    //    schema; unmatched-email drafts (claim_id IS NULL) skip the
    //    dispatch — downstream Wave 3 consumers operate per-claim and
    //    have nothing to react to without one.
    if (claimIdForEvent) {
      try {
        await this.dispatcher.dispatch({
          kind: 'ai_draft_applied',
          claimId: claimIdForEvent,
          actorUserId: opts.appliedBy,
          payload: {
            draft_id: draftId,
            applied_by: opts.appliedBy,
            field_overrides: overrides,
          },
          idempotencyKey: `ai_draft_applied:${draftId}`,
        });
      } catch (err) {
        logger.warn(
          { err, draftId },
          'emailIntelligence.applyDraft: dispatch failed (draft is applied)',
        );
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // rejectDraft
  // ────────────────────────────────────────────────────────────────────────

  async rejectDraft(draftId: string, opts: RejectDraftOpts): Promise<void> {
    const existing = await this.pool.query<{
      id: string;
      claim_id: string | null;
      status: string;
    }>(
      `SELECT id, claim_id, status
         FROM hospital.email_intelligence_drafts
        WHERE id = $1`,
      [draftId],
    );
    if ((existing.rowCount ?? 0) === 0) {
      throw new Error(`emailIntelligence.rejectDraft: draft ${draftId} not found`);
    }
    const row = existing.rows[0]!;
    if (row.status === 'rejected') {
      logger.info({ draftId }, 'emailIntelligence.rejectDraft: already rejected, no-op');
      return;
    }
    if (row.status !== 'pending_review' && row.status !== 'extraction_failed') {
      throw new Error(
        `emailIntelligence.rejectDraft: draft ${draftId} not rejectable (status=${row.status})`,
      );
    }

    await this.pool.query(
      `UPDATE hospital.email_intelligence_drafts
          SET status = 'rejected',
              reviewed_by = $2,
              reviewed_at = NOW(),
              rejection_reason = $3
        WHERE id = $1`,
      [draftId, opts.rejectedBy, opts.reason],
    );

    if (row.claim_id) {
      try {
        await this.dispatcher.dispatch({
          kind: 'ai_draft_rejected',
          claimId: row.claim_id,
          actorUserId: opts.rejectedBy,
          payload: {
            draft_id: draftId,
            rejected_by: opts.rejectedBy,
            reason: opts.reason,
          },
          idempotencyKey: `ai_draft_rejected:${draftId}`,
        });
      } catch (err) {
        logger.warn(
          { err, draftId },
          'emailIntelligence.rejectDraft: dispatch failed (draft is rejected)',
        );
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  private async findExistingDraft(
    inboundEmailId: string,
    promptVersion: string,
  ): Promise<{
    id: string;
    category: string;
    status: string;
    cost_inr: string | null;
  } | null> {
    const res = await this.pool.query(
      `SELECT id, category, status, cost_inr
         FROM hospital.email_intelligence_drafts
        WHERE inbound_email_id = $1 AND prompt_version = $2
        LIMIT 1`,
      [inboundEmailId, promptVersion],
    );
    return (res.rowCount ?? 0) > 0 ? (res.rows[0] as any) : null;
  }

  private async ocrAttachments(
    attachments: ProcessInboundEmailInput['attachments'],
  ): Promise<Array<{ filename: string; text: string }>> {
    const out: Array<{ filename: string; text: string }> = [];
    for (const att of attachments) {
      if (att.mime !== 'application/pdf') {
        // Image OCR + non-PDF mimes are out of scope for v1. We still keep
        // the filename in the prompt so the model knows something was there.
        out.push({ filename: att.filename, text: '(non-PDF attachment skipped)' });
        continue;
      }
      try {
        const result = await this.ocr.extractTextFromPdf(att.buffer);
        const joined = result.pages.map((p) => p.text).join('\n\n');
        out.push({ filename: att.filename, text: joined });
      } catch (err) {
        logger.warn(
          { err, filename: att.filename },
          'emailIntelligence.ocrAttachments: OCR failed for attachment',
        );
        out.push({ filename: att.filename, text: '(OCR failed)' });
      }
    }
    return out;
  }

  /**
   * We pass attachment text via the *user prompt* (inlined by the prompt
   * builders), NOT as LlmAttachment documents — the OCR text is already
   * plain English and embedding it as a text-block "document" would just
   * eat more uncached tokens for no gain. Returning an empty array here
   * is deliberate; the function exists so a future v2 can flip to
   * document blocks (e.g. native PDF support) without touching the
   * branch logic.
   */
  private attachmentTextsToLlmDocs(
    _attachmentTexts: Array<{ filename: string; text: string }>,
  ): LlmAttachment[] {
    return [];
  }

  private extractorForCategory(
    category: InsurerOutcomeCategory,
    body: string,
    attachmentTexts: Array<{ filename: string; text: string }>,
  ): {
    systemPrompt: string;
    userPrompt: string;
    taskName: string;
    promptVersion: string;
  } {
    switch (category) {
      case 'approved':
      case 'partially_approved':
      case 'enhancement_approved':
      case 'enhancement_partial':
        return {
          systemPrompt: approvalPrompt.SYSTEM_PROMPT,
          userPrompt: approvalPrompt.buildUserPrompt(body, attachmentTexts),
          taskName: approvalPrompt.TASK_NAME,
          promptVersion: approvalPrompt.PROMPT_VERSION,
        };
      case 'queried':
      case 'follow_up':
        return {
          systemPrompt: queryPrompt.SYSTEM_PROMPT,
          userPrompt: queryPrompt.buildUserPrompt(body, attachmentTexts),
          taskName: queryPrompt.TASK_NAME,
          promptVersion: queryPrompt.PROMPT_VERSION,
        };
      case 'rejected':
      case 'withdrawn':
        return {
          systemPrompt: rejectionPrompt.SYSTEM_PROMPT,
          userPrompt: rejectionPrompt.buildUserPrompt(body, attachmentTexts),
          taskName: rejectionPrompt.TASK_NAME,
          promptVersion: rejectionPrompt.PROMPT_VERSION,
        };
      default:
        // 'other' / 'unknown' fall through with no extraction; callers
        // check EXTRACTION_SCHEMA_BY_CATEGORY before calling this.
        throw new Error(
          `emailIntelligence.extractorForCategory: no extractor for category '${category}'`,
        );
    }
  }

  private async recordCost(
    claimId: string | null,
    hospitalId: string,
    task: string,
    promptVersion: string,
    meta: LlmCallMeta,
    succeeded: boolean,
    errorMessage: string | null,
  ): Promise<void> {
    await this.cost.recordCall({
      claimId,
      hospitalId,
      task,
      provider: meta.provider,
      model: meta.model,
      promptVersion,
      tokensInputUncached: meta.tokensUsed, // best-effort: classify doesn't split
      tokensInputCached: 0,
      tokensOutput: 0,
      latencyMs: meta.latencyMs,
      costInr: meta.costInr,
      succeeded,
      errorMessage,
    });
  }

  private async persistFailedDraft(args: {
    inboundEmailId: string;
    claimId: string | null;
    category: string;
    classifierConfidence: number;
    rawResponse: string;
    classifierCostInr?: number;
  }): Promise<ProcessInboundEmailResult> {
    // Truncate raw_response to keep PHI-laden text bounded. 10 KB is more
    // than enough to debug an LLM JSON-shape failure but not enough to
    // hoard whole letters in the failure column.
    const RAW_MAX = 10_000;
    const truncatedRaw = (args.rawResponse ?? '').slice(0, RAW_MAX);
    const costInr = args.classifierCostInr ?? 0;

    const insertRes = await this.pool.query<{ id: string; inserted: boolean }>(
      `
      WITH ins AS (
        INSERT INTO hospital.email_intelligence_drafts
          (inbound_email_id, claim_id, category, classifier_confidence,
           extracted_payload, llm_provider, llm_model, prompt_version,
           tokens_used, latency_ms, cost_inr, status, raw_response)
        VALUES
          ($1, $2, $3, $4, NULL, 'anthropic', 'unknown', $5, 0, 0, $6,
           'extraction_failed', $7)
        ON CONFLICT (inbound_email_id, prompt_version) DO NOTHING
        RETURNING id
      )
      SELECT id, TRUE AS inserted FROM ins
      UNION ALL
      SELECT id, FALSE AS inserted
        FROM hospital.email_intelligence_drafts
       WHERE inbound_email_id = $1 AND prompt_version = $5
         AND NOT EXISTS (SELECT 1 FROM ins)
      LIMIT 1
      `,
      [
        args.inboundEmailId,
        args.claimId,
        args.category,
        args.classifierConfidence,
        EMAIL_INTEL_VERSION,
        costInr,
        truncatedRaw,
      ],
    );

    const row = insertRes.rows[0];
    if (!row) {
      throw new Error(
        `emailIntelligence: failed-draft INSERT returned no row for inbound_email_id=${args.inboundEmailId}`,
      );
    }
    return {
      draftId: row.id,
      category: args.category,
      costInr,
      deduped: !row.inserted,
      failed: true,
    };
  }

  private async markApplied(
    db: Queryable,
    draftId: string,
    appliedBy: string,
  ): Promise<void> {
    await db.query(
      `UPDATE hospital.email_intelligence_drafts
          SET status = 'applied',
              reviewed_by = $2,
              reviewed_at = NOW(),
              applied_at = NOW()
        WHERE id = $1
          AND status = 'pending_review'`,
      [draftId, appliedBy],
    );
  }

  private async persistCorrections(
    db: Queryable,
    draftId: string,
    corrections: Array<{ path: string; ai: unknown; human: unknown }>,
    correctedBy: string,
  ): Promise<void> {
    for (const c of corrections) {
      await db.query(
        `INSERT INTO hospital.email_intelligence_corrections
           (draft_id, field_path, ai_value, human_value, corrected_by)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
        [
          draftId,
          c.path,
          JSON.stringify(c.ai ?? null),
          JSON.stringify(c.human ?? null),
          correctedBy,
        ],
      );
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve a JSON-pointer-like dotted path against a payload. Numeric
 * segments index arrays; everything else indexes objects. Missing
 * intermediate nodes return undefined rather than throwing — callers use
 * the result to compute (ai vs human) deltas, and a missing AI value is
 * a legitimate correction.
 */
export function readPath(payload: unknown, path: string): unknown {
  if (payload === null || payload === undefined) return undefined;
  if (!path) return payload;
  const segs = path.split('.');
  let cur: any = payload;
  for (const seg of segs) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

// Re-export schema types for FE / controllers that want strong typing
// without reaching into the llm/schemas module directly.
export type {
  ApprovalExtraction as EmailApprovalPayload,
  QueryExtraction as EmailQueryPayload,
  RejectionExtraction as EmailRejectionPayload,
} from './llm/schemas/emailIntelligence.js';

// Convenience singleton for hot-path callers (the worker uses this).
const singleton = new EmailIntelligenceService();
export default singleton;
