/**
 * Pipeline v2 — Stage 1: Vision-native Page Reader service.
 *
 * Orchestrates ONE consolidated vision read per source page (see
 * prompts/pageReader.v1.ts + schemas/pageRead.ts). This is the stage that
 * removes the D1 root cause: instead of OCR → garbled text → classify/extract,
 * the model reads the page IMAGE directly and returns the full structured
 * PageRead.
 *
 * COST LEVER — Haiku-first, escalate to Sonnet on low LEGIBILITY
 * ─────────────────────────────────────────────────────────────
 * The economic premise of the redesign is that most pages are clean printed
 * text a cheap model reads perfectly, and only genuinely hard pages
 * (handwriting, low-contrast photos, heavy rotation) need the premium model.
 * So we read on the CHEAP tier first and re-read on PREMIUM only when the
 * cheap read reports low legibility. This is a different escalation signal
 * than the LlmClient's built-in confidence-based 'standard' escalation:
 * legibility ("can I physically read this page?") is the right trigger for a
 * vision read, whereas answer-confidence conflates readability with clinical
 * ambiguity.
 *
 * NOTE: the legacy docExtractor sends ALL vision calls straight to premium
 * (its comment predates a vision-capable cheap tier). v2 deliberately diverges
 * to capture the cost saving, and makes the first tier configurable so that if
 * the offline harness measures a high escalation rate on the benchmark corpus
 * we can flip the default to premium-first with a one-line change (or the
 * PIPELINEV2_PAGE_READ_FIRST_TIER env var) — no code edit at call sites.
 *
 * Because reads are wrapped by RecordReplayClient in the eval harness, each
 * page (and each tier) is paid for ONCE; subsequent runs replay for free.
 */

import { logger } from '../../Utils/logger.js';
import { getLlmClient } from '../llm/factory.js';
import {
  LlmClient,
  LlmAttachment,
  LlmTier,
  LlmBudgetExceededError,
  LlmSchemaValidationError,
} from '../llm/LlmClient.js';
import { PageReadSchema, PageRead } from '../llm/schemas/pageRead.js';
import {
  PAGE_READER_PROMPT_VERSION,
  PAGE_READER_SYSTEM_PROMPT,
  buildPageReaderUserPrompt,
  PageReaderContext,
} from '../llm/prompts/pageReader.v1.js';

/**
 * Below this legibility, a cheap (Haiku) read is re-attempted on the premium
 * (Sonnet) tier. is_legible=false always escalates regardless of the score.
 */
export const LEGIBILITY_ESCALATION_THRESHOLD = 0.6;

/** The tier the first read runs on. Overridable via env for harness tuning. */
const DEFAULT_FIRST_TIER: Extract<LlmTier, 'cheap' | 'premium'> =
  (process.env.PIPELINEV2_PAGE_READ_FIRST_TIER as 'cheap' | 'premium') === 'premium'
    ? 'premium'
    : 'cheap';

export interface PageImage {
  /** Raw image bytes — a Layer-B derived page render or a source image. */
  data: Buffer;
  /** MIME type, e.g. 'image/jpeg' | 'image/png' | 'image/webp'. */
  mime: string;
}

export interface ReadPageInput {
  image: PageImage;
  /** doc_category codes from master_options (live) — the doc_type candidate list. */
  candidateCategories: readonly string[];
  /** Optional provenance hint (label/page index). NEVER a date or identity source. */
  context?: PageReaderContext;
  /** Cost accounting / budget guard. */
  claimId?: string;
  hospitalId?: string;
  /**
   * Stable identifier for THIS page (e.g. `${sourceDocId}:${pageIndex}`). Used
   * as the in-process LRU cacheKey so a retry within the TTL is deduped. The
   * persistent record/replay key is content-addressed separately and does not
   * depend on this.
   */
  pageKey?: string;
  /** Override the first-read tier for this call (else DEFAULT_FIRST_TIER). */
  firstTier?: 'cheap' | 'premium';
}

export interface ReadPageResult {
  /** The validated structured read. */
  read: PageRead;
  /** Provider model id of the read that is returned. */
  model: string;
  /** Tier of the returned read. */
  tier: 'cheap' | 'premium';
  /** true when a low-legibility cheap read was re-read on the premium tier. */
  escalated: boolean;
  /** true when escalation was warranted but blocked (e.g. budget); read is the cheap one. */
  escalationBlocked: boolean;
  /** Total INR across BOTH calls if escalated (zero on a fully-replayed run). */
  costInr: number;
  /** true only if EVERY underlying call was served from the record/replay cache. */
  replayedFromCache: boolean;
  /** Sum of latency across the call(s) made. */
  latencyMs: number;
}

export interface PageReaderDeps {
  /** Inject a fake/decorated LlmClient in tests; defaults to the factory singleton. */
  llm?: LlmClient;
}

export class PageReaderService {
  private readonly llm: LlmClient;

  constructor(deps: PageReaderDeps = {}) {
    this.llm = deps.llm ?? getLlmClient();
  }

  async readPage(input: ReadPageInput): Promise<ReadPageResult> {
    const attachment: LlmAttachment = {
      kind: 'image',
      data: input.image.data,
      mime: input.image.mime,
    };
    const userPrompt = buildPageReaderUserPrompt({
      candidateCategories: input.candidateCategories,
      context: input.context,
    });

    const firstTier = input.firstTier ?? DEFAULT_FIRST_TIER;
    const first = await this.extractOnce(input, userPrompt, attachment, firstTier);

    // Escalate ONLY from cheap → premium, and only when the cheap read says it
    // could not read the page well. A premium first read is already the best
    // we have; an is_legible=false there means the page is genuinely unreadable
    // and Stage 2 will quarantine it (loud abstention) rather than re-spending.
    const needsEscalation =
      first.tier === 'cheap' &&
      (!first.read.is_legible ||
        first.read.legibility < LEGIBILITY_ESCALATION_THRESHOLD);

    if (!needsEscalation) return first;

    try {
      const second = await this.extractOnce(input, userPrompt, attachment, 'premium');
      logger.info(
        {
          taskName: 'pipelinev2.page_read',
          cheapLegibility: first.read.legibility,
          premiumLegibility: second.read.legibility,
          pageKey: input.pageKey,
        },
        'pageReader: escalated cheap→premium on low legibility',
      );
      return {
        ...second,
        escalated: true,
        // Total would-have-been spend across both legs; a replayed leg is ₹0.
        costInr: first.costInr + second.costInr,
        replayedFromCache: first.replayedFromCache && second.replayedFromCache,
        latencyMs: first.latencyMs + second.latencyMs,
      };
    } catch (err) {
      if (err instanceof LlmBudgetExceededError) {
        // Degraded read beats no read: keep the cheap one but flag the block so
        // downstream can lower trust / route to review.
        logger.warn(
          { pageKey: input.pageKey, scope: err.scope, claimId: input.claimId },
          'pageReader: premium escalation blocked by budget; keeping cheap read',
        );
        return { ...first, escalationBlocked: true };
      }
      throw err;
    }
  }

  /** One LLM read at a given tier. Surfaces schema-validation failures with context. */
  private async extractOnce(
    input: ReadPageInput,
    userPrompt: string,
    attachment: LlmAttachment,
    tier: 'cheap' | 'premium',
  ): Promise<ReadPageResult> {
    let result;
    try {
      result = await this.llm.extract<PageRead>({
        systemPrompt: PAGE_READER_SYSTEM_PROMPT,
        userPrompt,
        schema: PageReadSchema,
        documents: [attachment],
        promptVersion: PAGE_READER_PROMPT_VERSION,
        taskName: 'pipelinev2.page_read',
        tier,
        cacheKey: input.pageKey ? `${input.pageKey}:${tier}` : undefined,
        claimId: input.claimId,
        hospitalId: input.hospitalId,
      });
    } catch (err) {
      if (err instanceof LlmSchemaValidationError) {
        logger.error(
          {
            tier,
            pageKey: input.pageKey,
            rawResponse: err.rawResponse?.slice(0, 1000),
          },
          'pageReader: model output failed Zod validation',
        );
      }
      throw err;
    }

    return {
      read: result.data,
      model: result.model,
      tier,
      escalated: false,
      escalationBlocked: false,
      costInr: result.costInr,
      replayedFromCache: result.replayedFromCache === true,
      latencyMs: result.latencyMs,
    };
  }
}
