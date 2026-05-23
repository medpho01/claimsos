import Anthropic from '@anthropic-ai/sdk';
import { LRUCache } from 'lru-cache';
import { ZodError } from 'zod';
import { logger } from '../../../Utils/logger.js';
import {
  LlmClient,
  LlmExtractOpts,
  LlmExtractResult,
  LlmClassifyOpts,
  LlmClassifyResult,
  LlmAttachment,
  LlmTier,
  LlmSchemaValidationError,
  LlmTierEscalationError,
} from '../LlmClient.js';

/**
 * Claude provider for the LLM Bridge.
 *
 * Written against @anthropic-ai/sdk v0.30+ which exposes:
 *   - client.messages.create({ model, system, messages, max_tokens })
 *   - system prompt as a string OR an array of content blocks (the array
 *     form is needed for cache_control)
 *   - usage: { input_tokens, output_tokens, cache_creation_input_tokens,
 *     cache_read_input_tokens }
 *
 * SDK note (and a real source of pain): Anthropic's TS SDK has had several
 * shape changes between v0.20, v0.25, v0.30. If we end up on a different
 * version, the call sites are localised to this file. The interface
 * (LlmClient) is what every other file consumes.
 *
 * Caching strategy: we put cache_control on the LAST block of the system
 * prompt. Anthropic caches everything up to (and including) the marked
 * block, so a long stable system prompt gets cached and we pay
 * cached_input rates on it from the second call onwards. The user prompt
 * varies per call and is never cached.
 *
 * Cost rates (USD, per million tokens) — current as of 2026-05 from
 * Anthropic's published pricing. Update if pricing moves; numbers feed
 * directly into hospital cost reporting so accuracy matters.
 */

// Model identifiers. As of May 2026 Anthropic retired the `-latest`
// alias scheme; we now pin to specific generation slugs. If a future
// model bumps the major version, update both lines + COST_TABLE keys.
const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-4-5';

// USD per 1M tokens. Order: input (uncached) / output / cached_input.
// cached_input is what Anthropic charges for tokens that hit the prompt
// cache; ~10x cheaper than uncached input — this is the whole reason we
// put effort into stabilising system prompts.
const COST_TABLE: Record<string, { input: number; output: number; cachedInput: number }> = {
  // claude-3-5-haiku: $0.80/M in, $4/M out, $0.08/M cached.
  [HAIKU]: { input: 0.8, output: 4, cachedInput: 0.08 },
  // claude-sonnet-4: $3/M in, $15/M out, $0.30/M cached.
  [SONNET]: { input: 3, output: 15, cachedInput: 0.3 },
};

// Spot rate for cost reporting. The platform shows INR everywhere; we
// convert at a fixed rate to keep the unit cost stable across the month
// (we re-true-up against the actual Anthropic bill quarterly). Adjust
// if the rupee moves materially; small fluctuations don't matter for
// budget-warning purposes.
const USD_TO_INR_RATE = 83;

// Confidence threshold below which the 'standard' tier escalates Haiku -> Sonnet.
const ESCALATION_CONFIDENCE_THRESHOLD = 0.7;

// LRU cache for verbatim re-runs. 500 entries x ~10KB = ~5MB; bounded.
// TTL of 5 minutes — long enough to dedupe accidental retry storms, short
// enough that legitimate re-evaluations (e.g. after a fix) hit the model.
const lru = new LRUCache<string, LlmExtractResult<unknown>>({
  max: 500,
  ttl: 5 * 60 * 1000,
});

function tierToModel(tier: LlmTier): string {
  switch (tier) {
    case 'cheap':
      return HAIKU;
    case 'premium':
      return SONNET;
    case 'standard':
    default:
      return HAIKU; // standard starts at Haiku, may escalate
  }
}

/**
 * Compute INR cost for a single call. cached input is billed at the
 * cached rate; everything else at the base rate.
 */
function computeCostInr(
  model: string,
  tokensInputUncached: number,
  tokensInputCached: number,
  tokensOutput: number
): number {
  const rates = COST_TABLE[model];
  if (!rates) {
    // Fall back to Haiku rates if Anthropic returns a model id we don't
    // know about (e.g. they ship a new snapshot before we update the
    // table). Log loudly so we notice in observability.
    logger.warn({ model }, 'claudeClient: unknown model in cost table, falling back to Haiku rates');
    const fallback = COST_TABLE[HAIKU]!;
    return roundInr(
      ((tokensInputUncached * fallback.input) +
        (tokensInputCached * fallback.cachedInput) +
        (tokensOutput * fallback.output)) /
        1_000_000 *
        USD_TO_INR_RATE
    );
  }
  const usd =
    ((tokensInputUncached * rates.input) +
      (tokensInputCached * rates.cachedInput) +
      (tokensOutput * rates.output)) /
    1_000_000;
  return roundInr(usd * USD_TO_INR_RATE);
}

function roundInr(n: number): number {
  // 4 decimal places — matches NUMERIC(10,4) in llm_cost_log.
  return Math.round(n * 10000) / 10000;
}

/**
 * Convert our LlmAttachment to Anthropic content blocks.
 * - 'pdf'   -> document block, base64-encoded
 * - 'image' -> image block, base64-encoded
 * - 'text'  -> text block, inline
 */
function attachmentsToContent(attachments: LlmAttachment[] | undefined): any[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map((a) => {
    if (a.kind === 'text') {
      return {
        type: 'text',
        text: typeof a.data === 'string' ? a.data : a.data.toString('utf8'),
      };
    }
    const b64 = Buffer.isBuffer(a.data) ? a.data.toString('base64') : Buffer.from(a.data).toString('base64');
    if (a.kind === 'image') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: a.mime, data: b64 },
      };
    }
    // pdf
    return {
      type: 'document',
      source: { type: 'base64', media_type: a.mime, data: b64 },
    };
  });
}

/**
 * Pull JSON out of a model response. Tries (in order):
 *   1. The first ```json ... ``` fenced block (preferred — what we
 *      explicitly ask the model to emit).
 *   2. The first balanced { ... } substring (fallback for models that
 *      ignore the fence instruction).
 * Returns null if neither yields parseable JSON.
 */
function extractJson(raw: string): unknown | null {
  // 1. Fenced block.
  const fence = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  // 2. First balanced object. We do a simple brace-depth scan rather than
  // a regex (regex can't match balanced braces reliably). Strings are
  // tracked so braces inside string literals don't confuse the counter.
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * The system prompt is sent as a one-element array with cache_control on
 * the (single) block. This is the simplest shape that activates Anthropic
 * prompt caching. If we ever want to split prompt + few-shots into two
 * cached layers, this is where the array would grow.
 */
function buildSystemBlocks(systemPrompt: string): any[] {
  return [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

interface NormalisedUsage {
  inputUncached: number;
  inputCached: number;
  output: number;
}

/**
 * Anthropic's usage object has changed shape across SDK versions. We pull
 * out the numbers defensively rather than trusting any one field name.
 */
function normaliseUsage(usage: any): NormalisedUsage {
  const inputCached = Number(usage?.cache_read_input_tokens ?? 0);
  const cacheCreated = Number(usage?.cache_creation_input_tokens ?? 0);
  // input_tokens in modern SDKs = uncached, non-cache-creation tokens.
  // Cache creation tokens are billed at input rate too (Anthropic charges
  // ~25% premium for cache writes, but for budgeting we lump them in).
  const inputUncached = Number(usage?.input_tokens ?? 0) + cacheCreated;
  const output = Number(usage?.output_tokens ?? 0);
  return { inputUncached, inputCached, output };
}

export class ClaudeClient implements LlmClient {
  private client: Anthropic;
  readonly provider = 'anthropic';

  constructor(client?: Anthropic) {
    // Allow injection for tests; default reads ANTHROPIC_API_KEY from env.
    this.client = client ?? new Anthropic();
  }

  async extract<T>(opts: LlmExtractOpts<T>): Promise<LlmExtractResult<T>> {
    const tier = opts.tier ?? 'standard';
    const cacheLookupKey = opts.cacheKey ? `${opts.cacheKey}::${opts.promptVersion}` : null;

    if (cacheLookupKey) {
      const hit = lru.get(cacheLookupKey);
      if (hit) {
        logger.debug(
          { taskName: opts.taskName, cacheKey: opts.cacheKey, promptVersion: opts.promptVersion },
          'claudeClient: LRU cache hit'
        );
        return hit as LlmExtractResult<T>;
      }
    }

    // First attempt at the tier-mapped model.
    const initialModel = tierToModel(tier);
    let result = await this.runExtract<T>(opts, initialModel, false);

    // Standard tier escalation: low confidence -> retry on Sonnet.
    if (
      tier === 'standard' &&
      initialModel === HAIKU &&
      result.confidence < ESCALATION_CONFIDENCE_THRESHOLD
    ) {
      logger.info(
        {
          taskName: opts.taskName,
          confidence: result.confidence,
          threshold: ESCALATION_CONFIDENCE_THRESHOLD,
        },
        'claudeClient: standard-tier escalating Haiku -> Sonnet'
      );
      try {
        const escalated = await this.runExtract<T>(opts, SONNET, true);
        // Cost is cumulative — we paid for both calls.
        escalated.costInr = roundInr(escalated.costInr + result.costInr);
        result = escalated;
      } catch (err) {
        // If escalation itself fails, surface a tier-escalation error so
        // the caller can choose to fall back to the Haiku result (which
        // is still in `result` from the first attempt) or treat as fatal.
        throw new LlmTierEscalationError('standard', 'premium', 'sonnet retry failed', err);
      }
    }

    if (cacheLookupKey) {
      lru.set(cacheLookupKey, result);
    }
    return result;
  }

  /**
   * Single call against a specific model. Used by extract() for both the
   * initial call and the optional escalation call.
   */
  private async runExtract<T>(
    opts: LlmExtractOpts<T>,
    model: string,
    isEscalation: boolean
  ): Promise<LlmExtractResult<T>> {
    const started = Date.now();

    const userContent: any[] = [
      ...attachmentsToContent(opts.documents),
      { type: 'text', text: opts.userPrompt },
    ];

    // Output-token cap. The harmoniser (task=claim_harmonisation) produces
    // the richest output — a full canonical medical episode JSON with
    // clinical timeline, financial breakdown, document index, and
    // supporting_documents lineage. With dedup populating real data
    // across 30+ canonical sections, the response routinely exceeds the
    // legacy 4096-token cap and gets truncated mid-JSON. Sonnet 4.5
    // supports up to 64k output tokens; Haiku 4.5 up to 8k. We pick a
    // task-aware ceiling: 16k for harmonisation (premium tier, Sonnet),
    // 8k for everything else (covers the largest extraction payloads
    // without bloating cost-cap visibility).
    //
    // Anthropic bills per OUTPUT token, not per max_tokens — so raising
    // the ceiling is free unless the model actually writes more. The
    // hospital cost guard (costAccounting.checkBudget) is the macro
    // backstop against runaway generations.
    const maxTokensForTask =
      opts.taskName === 'claim_harmonisation' ? 16384 : 8192;

    let response: any;
    try {
      response = await this.client.messages.create({
        model,
        max_tokens: maxTokensForTask,
        system: buildSystemBlocks(opts.systemPrompt) as any,
        messages: [{ role: 'user', content: userContent }],
      });
    } catch (err) {
      logger.error(
        { err, taskName: opts.taskName, model, promptVersion: opts.promptVersion },
        'claudeClient: provider call failed'
      );
      throw err;
    }

    const latencyMs = Date.now() - started;

    // Extract text from the response content array. Anthropic returns
    // an array of blocks (text, tool_use, etc.); for extraction we only
    // care about the joined text blocks.
    const rawResponse = Array.isArray(response?.content)
      ? response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
      : '';

    const parsed = extractJson(rawResponse);
    if (parsed === null) {
      throw new LlmSchemaValidationError(
        `claude extract: no JSON found in response (task=${opts.taskName})`,
        rawResponse,
        opts.taskName,
        opts.promptVersion,
        new SyntaxError('no parseable JSON object in model response')
      );
    }

    let validated: T;
    try {
      validated = opts.schema.parse(parsed);
    } catch (zerr) {
      throw new LlmSchemaValidationError(
        `claude extract: zod validation failed (task=${opts.taskName}): ${(zerr as ZodError).message}`,
        rawResponse,
        opts.taskName,
        opts.promptVersion,
        zerr
      );
    }

    // Optional `confidence` field on the parsed object; default 1.0 when
    // absent. We don't make this part of the caller's schema because
    // every task would have to remember to include it; we just look at
    // the parsed JSON ourselves.
    const confidenceRaw =
      (parsed && typeof parsed === 'object' && 'confidence' in (parsed as any))
        ? Number((parsed as any).confidence)
        : 1;
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 1;

    const usage = normaliseUsage(response?.usage);
    const resolvedModel = response?.model ?? model;
    const costInr = computeCostInr(
      resolvedModel,
      usage.inputUncached,
      usage.inputCached,
      usage.output
    );

    return {
      data: validated,
      confidence,
      rawResponse,
      tokensInputUncached: usage.inputUncached,
      tokensInputCached: usage.inputCached,
      tokensOutput: usage.output,
      latencyMs,
      provider: this.provider,
      model: resolvedModel,
      costInr,
      tierEscalated: isEscalation,
    };
  }

  /**
   * Classification: model is asked to return JSON of shape
   *   { category: string, confidence: number, reasoning: string }
   * Anything off-categories throws LlmSchemaValidationError.
   */
  async classify(opts: LlmClassifyOpts): Promise<LlmClassifyResult> {
    const tier = opts.tier ?? 'standard';
    const model = tierToModel(tier);
    const started = Date.now();

    const sys =
      opts.systemPrompt +
      '\n\nRespond with a single JSON object inside a ```json fence with keys: ' +
      '"category" (must be exactly one of: ' +
      opts.categories.map((c) => JSON.stringify(c)).join(', ') +
      '), "confidence" (0..1), "reasoning" (1-2 sentences).';

    const userContent: any[] = [
      ...attachmentsToContent(opts.documents),
      { type: 'text', text: opts.userPrompt },
    ];

    let response: any;
    try {
      response = await this.client.messages.create({
        model,
        max_tokens: 512,
        system: buildSystemBlocks(sys) as any,
        messages: [{ role: 'user', content: userContent }],
      });
    } catch (err) {
      logger.error(
        { err, taskName: opts.taskName, model, promptVersion: opts.promptVersion },
        'claudeClient: classify call failed'
      );
      throw err;
    }

    const latencyMs = Date.now() - started;

    const rawResponse = Array.isArray(response?.content)
      ? response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
      : '';

    const parsed: any = extractJson(rawResponse);
    if (
      !parsed ||
      typeof parsed.category !== 'string' ||
      !opts.categories.includes(parsed.category)
    ) {
      throw new LlmSchemaValidationError(
        `claude classify: invalid category in response (task=${opts.taskName})`,
        rawResponse,
        opts.taskName,
        opts.promptVersion
      );
    }
    const confidence = Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, Number(parsed.confidence)))
      : 1;

    const usage = normaliseUsage(response?.usage);
    const resolvedModel = response?.model ?? model;
    const costInr = computeCostInr(
      resolvedModel,
      usage.inputUncached,
      usage.inputCached,
      usage.output
    );

    logger.debug(
      { taskName: opts.taskName, latencyMs, costInr, model: resolvedModel },
      'claudeClient: classify ok'
    );

    return {
      category: parsed.category,
      confidence,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      costInr,
    };
  }
}

// Exports for tests and consumers that want the constants.
export const __MODELS__ = { HAIKU, SONNET };
export const __COSTS__ = { COST_TABLE, USD_TO_INR_RATE, ESCALATION_CONFIDENCE_THRESHOLD };
// Test-only: hand to the test to flush state between cases.
export function __resetLruCacheForTests(): void {
  lru.clear();
}
