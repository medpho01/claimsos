import Anthropic from '@anthropic-ai/sdk';
import { LRUCache } from 'lru-cache';
import { ZodError } from 'zod';
import { logger } from '../../../Utils/logger.js';
import { acquireLlmSlot } from '../../../Utils/llmConcurrency.js';
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

/**
 * The dated snapshot ids Anthropic actually returns on `response.model` for
 * the two aliases above. We SEND the alias; the API answers with the dated
 * id it resolved the alias to. Both spellings must price identically — see
 * `normalizeModelId` for the incident this caused.
 */
const HAIKU_DATED = 'claude-haiku-4-5-20251001';
const SONNET_DATED = 'claude-sonnet-4-5-20250929';

const DATE_SUFFIX_RE = /-(\d{8})$/;

/**
 * Map an Anthropic-returned model id to its COST_TABLE key. Strips a trailing
 * `-YYYYMMDD` date stamp and lowercases.
 *
 * ─── WHY THIS EXISTS (the Sonnet mispricing, found 2026-09-14) ─────────────
 *
 * `runExtract` / `classify` price the call on `response.model ?? model` — the
 * id the PROVIDER reports, not the one we sent, which is the right choice
 * (an alias can resolve to a snapshot we did not pick). But the id the
 * provider reports is DATED: we send 'claude-sonnet-4-5', it answers
 * 'claude-sonnet-4-5-20250929'. COST_TABLE was keyed only on the alias, so
 * the exact-key lookup in `computeCostInr` MISSED on every single real call
 * and silently took the unknown-model branch, which charges HAIKU rates.
 *
 * Sonnet is 3.75x Haiku on both input ($3 vs $0.80/M) and output ($15 vs
 * $4/M), so every Sonnet call — which is essentially all reasoning spend —
 * was recorded at 1/3.75 of its true cost. Measured on one tiled dense-A4
 * itemised extraction: ₹2.21 recorded vs ₹8.30 true.
 *
 * That number is not cosmetic. It is the number `llm_cost_log` stores, which
 * is the number `costAccounting.getClaimSpendInr` sums, which is the number
 * `checkBudget` enforces EVERY cap against — per-claim, per-hospital, and now
 * the per-run approved budget. Every limit in the system was being enforced
 * against a figure 3.75x too small.
 *
 * The unit tests missed it for exactly one reason: they mocked
 * `response.model` as the ALIAS, which is the one spelling that happened to
 * hit the table. The test suite now mocks the DATED id (the shape the API
 * really returns) and asserts the 3.75x relationship directly.
 *
 * Exported so tests can assert on it, and so any future lookup keyed on a
 * model id normalises through one place rather than re-deriving the rule.
 */
export function normalizeModelId(model: string): string {
  if (!model) return model;
  return String(model).trim().toLowerCase().replace(DATE_SUFFIX_RE, '');
}

// USD per 1M tokens. Order: input (uncached) / output / cached_input.
// cached_input is what Anthropic charges for tokens that hit the prompt
// cache; ~10x cheaper than uncached input — this is the whole reason we
// put effort into stabilising system prompts.
//
// BOTH SPELLINGS ARE KEYED DELIBERATELY. `computeCostInr` normalises before
// its second lookup, so the dated rows are strictly redundant — which is the
// point: if the normaliser is ever bypassed, refactored, or handed an id
// shape it does not recognise, the dated ids still price correctly instead of
// silently falling through to Haiku rates.
const COST_TABLE: Record<string, { input: number; output: number; cachedInput: number }> = {
  // claude-haiku-4-5: $0.80/M in, $4/M out, $0.08/M cached.
  [HAIKU]: { input: 0.8, output: 4, cachedInput: 0.08 },
  // claude-sonnet-4-5: $3/M in, $15/M out, $0.30/M cached.
  [SONNET]: { input: 3, output: 15, cachedInput: 0.3 },
  [HAIKU_DATED]: { input: 0.8, output: 4, cachedInput: 0.08 },
  [SONNET_DATED]: { input: 3, output: 15, cachedInput: 0.3 },
};

// Spot rate for cost reporting. The platform shows INR everywhere; we
// convert at a fixed rate to keep the unit cost stable across the month
// (we re-true-up against the actual Anthropic bill quarterly). Adjust
// if the rupee moves materially; small fluctuations don't matter for
// budget-warning purposes.
const USD_TO_INR_RATE = 83;

// Confidence threshold below which the 'standard' tier escalates Haiku -> Sonnet.
const ESCALATION_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Output-token ceilings.
 *
 * Anthropic bills per OUTPUT token, not per max_tokens, so raising a ceiling
 * costs nothing unless the model actually writes more. The hospital cost
 * guard (costAccounting.checkBudget) is the macro backstop against a runaway
 * generation. What a ceiling that is too LOW costs is correctness: the model
 * is cut off mid-JSON and the response is either unparseable (a loud failure)
 * or — worse — a table with rows silently missing.
 *
 * 8192 is the floor because Haiku 4.5's hard output ceiling is 8k; a cheap
 * tier call must never ask for more than the API allows.
 */
const MAX_TOKENS_DEFAULT = 8192;
/** Sonnet/Opus support far more; 16k is what the long-payload tasks need. */
const MAX_TOKENS_LONG_OUTPUT = 16384;

/**
 * Tasks whose payload is an arbitrary-length LIST rather than a fixed bag of
 * scalars, and which therefore overrun 8192 on a real document:
 *
 *  - claim_harmonisation — the full canonical medical episode JSON (30+
 *    sections, clinical timeline, document lineage).
 *  - pipelinev2.page_read — a faithful page transcription (up to 20000 chars
 *    ≈ 5-7k tokens) PLUS the structured facts/dates/identity object.
 *  - doc_extract.* — itemised-bill extraction. lineItems.buildLineItemsPromptBlock
 *    instructs the model "if the table runs to more than 120 rows, still emit
 *    every row"; a 120-row line_items array with 12 keys per row is ~10-14k
 *    output tokens on its own. Asking for every row under an 8192 ceiling is
 *    an instruction to overrun, after which Zod rejects the payload and the
 *    section fails — the exact loop this ceiling raise closes.
 */
function isLongOutputTask(taskName: string): boolean {
  if (!taskName) return false;
  if (taskName === 'claim_harmonisation') return true;
  if (taskName === 'pipelinev2.page_read') return true;
  // docExtractor names its calls `doc_extract.<category>`.
  if (taskName === 'doc_extract' || taskName.startsWith('doc_extract.')) return true;
  return false;
}

function isPremiumModel(model: string): boolean {
  return /sonnet|opus/i.test(model);
}

/**
 * Per-task output ceiling. The long-output ceiling is granted only on the
 * premium (Sonnet/Opus) tier — Haiku 4.5 rejects a max_tokens above its own
 * 8k limit, so a cheap-tier truncation escalates or quarantines rather than
 * silently overrunning the API. claim_harmonisation is unconditional because
 * it is premium by construction and has been shipping at 16384.
 *
 * Exported for tests and for callers that want to size a prompt against the
 * budget it will actually be given.
 */
export function resolveMaxOutputTokens(taskName: string, model: string): number {
  if (taskName === 'claim_harmonisation') return MAX_TOKENS_LONG_OUTPUT;
  if (!isPremiumModel(model)) return MAX_TOKENS_DEFAULT;
  return isLongOutputTask(taskName) ? MAX_TOKENS_LONG_OUTPUT : MAX_TOKENS_DEFAULT;
}

/**
 * Thrown when the provider stopped generating because it hit max_tokens.
 *
 * It extends LlmSchemaValidationError deliberately: every existing caller
 * already catches that type and treats it as "the model's output is not
 * usable", which is exactly the right handling. The subclass exists so a
 * caller that WANTS to distinguish "the model wrote nonsense" from "the model
 * was cut off, retry with a bigger budget or fewer rows" can do so with an
 * instanceof, and so the log line names the real cause.
 *
 * A truncated structured response must NEVER be treated as complete: the JSON
 * that comes back is missing whatever the model had not written yet, and the
 * common failure is not an exception but a line_items array that parses
 * cleanly with its tail rows absent.
 */
export class LlmResponseTruncatedError extends LlmSchemaValidationError {
  /** Discriminator for callers that branch on truncation. Always true. */
  readonly truncated = true as const;
  /** The max_tokens the call was issued with. */
  readonly maxTokens: number;
  /** Output tokens the model actually produced before being cut off. */
  readonly tokensOutput: number;
  constructor(
    phase: 'extract' | 'classify',
    taskName: string,
    promptVersion: string,
    rawResponse: string,
    maxTokens: number,
    tokensOutput: number
  ) {
    super(
      `claude ${phase}: response truncated at max_tokens=${maxTokens} ` +
        `(task=${taskName}, output_tokens=${tokensOutput}) — the payload is INCOMPLETE ` +
        'and must not be treated as a complete result',
      rawResponse,
      taskName,
      promptVersion,
      new Error('stop_reason=max_tokens')
    );
    this.name = 'LlmResponseTruncatedError';
    this.maxTokens = maxTokens;
    this.tokensOutput = tokensOutput;
  }
}

/** True when the provider cut the response off at the output ceiling. */
function wasTruncated(response: any): boolean {
  return response?.stop_reason === 'max_tokens';
}

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
  // Exact key first (covers both the alias and the dated snapshot, which are
  // both in the table), then the normalised key (covers a dated snapshot we
  // have not enumerated yet — a new Sonnet release must not silently price as
  // Haiku just because we shipped before Anthropic did).
  const rates = COST_TABLE[model] ?? COST_TABLE[normalizeModelId(model)];
  if (!rates) {
    // Fall back to Haiku rates if Anthropic returns a model id we don't
    // know about (e.g. they ship a new snapshot under a name our normaliser
    // does not reduce to a known key).
    //
    // THIS IS AN ERROR, NOT A WARNING. A silent 3.75x under-report is not a
    // degraded log line, it is a corrupted ledger: everything downstream of
    // llm_cost_log (getClaimSpendInr, getRunSpendInr, checkBudget, every
    // per-claim / per-hospital / per-run cap and the user's approved budget)
    // is then enforced against a wrong figure, and the first symptom is an
    // overspend nobody can see. It stayed a warn for months and nobody looked.
    logger.error(
      { model, normalized: normalizeModelId(model) },
      'claudeClient: UNPRICED MODEL — cost is being recorded at Haiku rates and ' +
        'every budget cap is now enforced against a wrong figure. Add this model ' +
        'id to COST_TABLE.'
    );
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
    // maxRetries: SDK retries 429/500/503/529 + network errors with exponential
    // backoff + jitter (honours Retry-After). timeout: hard per-call ceiling so
    // a stuck request can't pin a worker. Previously both unset (no app-level
    // retry; 10-min default timeout).
    this.client = client ?? new Anthropic({ maxRetries: 4, timeout: 90_000 });
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

    // Output-token cap — see resolveMaxOutputTokens for the full rationale.
    // Long-payload tasks (harmonisation, page reads, itemised doc_extract)
    // get 16384 on the premium tier; everything else, and everything on
    // Haiku, stays at 8192.
    const maxTokensForTask = resolveMaxOutputTokens(opts.taskName, model);

    let response: any;
    // Acquire a global LLM concurrency slot BEFORE the network call so
    // bumped queue concurrencies (Tier 1.1) can't combine across queues
    // to exceed the Anthropic account RPM/TPM ceiling. Per-process FIFO,
    // pool-split by model class (haiku vs sonnet) so cheap traffic isn't
    // starved behind expensive harmoniser calls. Released in finally so
    // every exit path (success, schema-validation throw, network throw)
    // gives the slot back; idempotent if called twice.
    const releaseLlmSlot = await acquireLlmSlot(model);
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
    } finally {
      releaseLlmSlot();
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

    // TRUNCATION CHECK — before the JSON is even looked at.
    //
    // stop_reason is the ONLY reliable signal that the model finished. A
    // response cut off at the output ceiling is usually unparseable (the
    // brace scan below finds no balanced object) and reports itself as "no
    // JSON found", which sends an operator hunting for a prompt bug that is
    // not there. Worse is the case where it DOES parse: the model closed the
    // object early, or the schema's arrays are all optional, and a line_items
    // table with its tail rows missing validates cleanly and is stored as a
    // complete bill. Neither outcome may be treated as a complete extraction,
    // so truncation fails the call loudly with its own error type.
    if (wasTruncated(response)) {
      const outTokens = Number(response?.usage?.output_tokens ?? 0);
      logger.error(
        {
          taskName: opts.taskName,
          model,
          promptVersion: opts.promptVersion,
          max_tokens: maxTokensForTask,
          tokens_output: outTokens,
          raw_len: rawResponse.length,
        },
        'claudeClient: extract response hit max_tokens — the structured payload is INCOMPLETE'
      );
      throw new LlmResponseTruncatedError(
        'extract',
        opts.taskName,
        opts.promptVersion,
        rawResponse,
        maxTokensForTask,
        outTokens
      );
    }

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
    // Same global concurrency slot as extract() above — see comment there.
    const releaseLlmSlot = await acquireLlmSlot(model);
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
    } finally {
      releaseLlmSlot();
    }

    const latencyMs = Date.now() - started;

    const rawResponse = Array.isArray(response?.content)
      ? response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
      : '';

    // Same truncation rule as extract(): a classification cut off at the
    // 512-token ceiling has an incomplete JSON object, and "invalid category"
    // is a misleading way to report that.
    if (wasTruncated(response)) {
      const outTokens = Number(response?.usage?.output_tokens ?? 0);
      logger.error(
        {
          taskName: opts.taskName,
          model,
          promptVersion: opts.promptVersion,
          max_tokens: 512,
          tokens_output: outTokens,
        },
        'claudeClient: classify response hit max_tokens — the category JSON is INCOMPLETE'
      );
      throw new LlmResponseTruncatedError(
        'classify',
        opts.taskName,
        opts.promptVersion,
        rawResponse,
        512,
        outTokens
      );
    }

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
      // Cost-accounting passthrough. The bridge computes these but does NOT
      // write llm_cost_log itself — the calling service records the call
      // (see docClassifier / docBundleClassifier). Mirrors runExtract().
      tokensInputUncached: usage.inputUncached,
      tokensInputCached: usage.inputCached,
      tokensOutput: usage.output,
      latencyMs,
      provider: this.provider,
      model: resolvedModel,
    };
  }
}

// Exports for tests and consumers that want the constants.
export const __MODELS__ = { HAIKU, SONNET, HAIKU_DATED, SONNET_DATED };
export const __COSTS__ = {
  COST_TABLE,
  USD_TO_INR_RATE,
  ESCALATION_CONFIDENCE_THRESHOLD,
  // Exposed so the test suite can assert the normalisation rule directly,
  // rather than only observing it through a priced call.
  normalizeModelId,
  computeCostInr,
};
export const __TOKEN_LIMITS__ = { MAX_TOKENS_DEFAULT, MAX_TOKENS_LONG_OUTPUT };
// Test-only: hand to the test to flush state between cases.
export function __resetLruCacheForTests(): void {
  lru.clear();
}
