import type { z } from 'zod';

/**
 * Sprint 4 — LLM Bridge
 *
 * Provider-agnostic interface for structured LLM extraction and classification
 * tasks inside ClaimOS (Indian healthcare claims platform).
 *
 * Why a thin interface (and not just "call the SDK directly"):
 *   1. We need to swap providers without rewriting every call site. Today
 *      Anthropic Claude (Haiku for cheap, Sonnet for hard); tomorrow maybe
 *      a Bedrock-hosted Claude, a Gemini fallback, or a self-hosted model
 *      for PHI-sensitive paths.
 *   2. Every call must be metered. The contract guarantees the
 *      provider implementation returns enough info (token counts, latency,
 *      cost in INR) for `costAccounting.service` to write to llm_cost_log.
 *   3. Zod-validated outputs are non-negotiable. LLMs hallucinate fields;
 *      a downstream consumer expecting `policy_number: string` cannot be
 *      handed `undefined`. The interface enforces a schema for `extract`
 *      and a fixed category list for `classify`.
 *   4. Tiering is part of the contract, not an implementation detail.
 *      Most ClaimOS tasks (claim classification, attribute extraction from
 *      a short letter, pre-auth field mapping) are cheap-tier Haiku work.
 *      Hard tasks (extracting a 30-page discharge summary, parsing an
 *      adjudication letter with contradictory sections) escalate to
 *      premium-tier Sonnet. The "standard" tier auto-escalates Haiku ->
 *      Sonnet when confidence is low, and the result reports
 *      `tierEscalated: true` so the caller can decide whether to surface
 *      a "manual review" flag.
 *
 * This file is interface-only. Implementations live in ./providers/*.
 */

export type LlmTier = 'cheap' | 'standard' | 'premium';

/**
 * An attachment to send alongside the prompt — typically a discharge
 * summary PDF, a scanned letter image, or an OCR text dump. The provider
 * adapter is responsible for encoding this in whatever shape its API
 * accepts (Anthropic: document blocks for PDFs, image blocks for images,
 * text blocks for text).
 *
 * `data` is a Buffer for binary inputs (PDF, image) and a string for text.
 * `mime` is required so the adapter doesn't have to sniff the buffer.
 */
export interface LlmAttachment {
  kind: 'pdf' | 'image' | 'text';
  data: Buffer | string;
  mime: string;
}

/**
 * Options for a structured-extraction call. The output is parsed and
 * validated against `schema` before being returned — if validation fails
 * the provider throws LlmSchemaValidationError, never a silent partial.
 */
export interface LlmExtractOpts<T> {
  /**
   * System prompt — the persona / task framing. Long, mostly stable across
   * calls; this is what gets prompt-cached (Anthropic ephemeral cache).
   * Put high-signal, repeated context here (e.g. the SOP, the schema
   * description, the few-shot examples).
   */
  systemPrompt: string;

  /**
   * User prompt — the per-call instruction and inputs. Short, varies per
   * call; not cached.
   */
  userPrompt: string;

  /**
   * Zod schema the extracted JSON must conform to. The provider parses the
   * model's response, finds the JSON, and runs `schema.parse()`. On failure
   * throws LlmSchemaValidationError with the raw response in `cause`.
   */
  schema: z.ZodSchema<T>;

  /**
   * Optional binary or text documents to include with the prompt.
   */
  documents?: LlmAttachment[];

  /**
   * Optional cache key for the in-process LRU. When the same (cacheKey,
   * promptVersion) pair is seen again within the LRU window the cached
   * result is returned without a network call. This is a soft cache — it
   * doesn't replace Anthropic's server-side prompt cache, it just dedupes
   * truly identical re-runs (e.g. a retry after a transient downstream
   * failure).
   */
  cacheKey?: string;

  /**
   * Version of the prompt template. Bumped whenever the prompt changes
   * meaningfully. Goes into llm_cost_log so we can A/B compare prompt
   * versions on cost, latency, and downstream success rates.
   */
  promptVersion: string;

  /**
   * Short identifier for the calling task (e.g. 'attr_extract.policy_number',
   * 'discharge_summary.parse', 'inbound_classifier'). Used for log
   * aggregation and per-task spend reporting.
   */
  taskName: string;

  /**
   * Tier preference. Default: 'standard' (Haiku, auto-escalate to Sonnet
   * if confidence < 0.7).
   */
  tier?: LlmTier;

  /**
   * Optional claim/IPD identifier for cost accounting. When present, the
   * call is recorded against this claim's spend budget; over budget calls
   * throw LlmBudgetExceededError before hitting the provider.
   */
  claimId?: string;

  /**
   * Optional hospital identifier for cost accounting. When present, the
   * call is recorded against this hospital's daily/monthly budget.
   */
  hospitalId?: string;
}

/**
 * Result of a structured-extraction call.
 *
 * `data` — already validated against the schema. Safe to consume.
 * `confidence` — model's self-reported 0..1. Adapters that can't get this
 *   from the model emit 1.0 (i.e. "we have nothing better than the
 *   schema-validation pass").
 * `rawResponse` — full untouched model text. Stored on extraction-failure
 *   audit rows; not normally persisted on success.
 * tokens / cost / latency — for cost accounting.
 * `tierEscalated` — true if `standard` was requested and the call upgraded
 *   from Haiku to Sonnet mid-flight due to low confidence.
 */
export interface LlmExtractResult<T> {
  data: T;
  confidence: number;
  rawResponse: string;
  tokensInputUncached: number;
  tokensInputCached: number;
  tokensOutput: number;
  latencyMs: number;
  provider: string;
  model: string;
  costInr: number;
  tierEscalated: boolean;
}

/**
 * Options for a classification call. Categories are a closed list; the
 * adapter prompts the model to pick exactly one and validates the answer
 * against the list before returning. Anything off-list throws
 * LlmSchemaValidationError.
 */
export interface LlmClassifyOpts {
  systemPrompt: string;
  userPrompt: string;
  categories: readonly string[];
  documents?: LlmAttachment[];
  promptVersion: string;
  taskName: string;
  tier?: LlmTier;
  claimId?: string;
  hospitalId?: string;
}

export interface LlmClassifyResult {
  category: string;
  confidence: number;
  reasoning: string;
  costInr: number;
}

export interface LlmClient {
  extract<T>(opts: LlmExtractOpts<T>): Promise<LlmExtractResult<T>>;
  classify(opts: LlmClassifyOpts): Promise<LlmClassifyResult>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────

/**
 * Thrown when tier escalation is requested but disallowed (e.g. premium
 * tier already, or a budget guard blocks the upgrade). Adapters use this
 * to differentiate from a generic Error so callers can decide whether to
 * surface a "needs manual review" UX or just fall through.
 */
export class LlmTierEscalationError extends Error {
  readonly fromTier: LlmTier;
  readonly toTier: LlmTier;
  readonly reason: string;
  constructor(fromTier: LlmTier, toTier: LlmTier, reason: string, cause?: unknown) {
    super(`tier escalation blocked: ${fromTier} -> ${toTier} (${reason})`);
    this.name = 'LlmTierEscalationError';
    this.fromTier = fromTier;
    this.toTier = toTier;
    this.reason = reason;
    if (cause !== undefined) (this as any).cause = cause;
  }
}

/**
 * Thrown when a call would exceed either the per-claim hard limit
 * (₹15 / claim by default) or the hospital's daily/monthly cap. Throws
 * BEFORE the provider is called — no tokens are spent.
 */
export class LlmBudgetExceededError extends Error {
  readonly scope: 'claim' | 'hospital_daily' | 'hospital_monthly';
  readonly currentInr: number;
  readonly limitInr: number;
  readonly claimId?: string;
  readonly hospitalId?: string;
  constructor(
    scope: 'claim' | 'hospital_daily' | 'hospital_monthly',
    currentInr: number,
    limitInr: number,
    ids: { claimId?: string; hospitalId?: string } = {}
  ) {
    super(
      `llm budget exceeded for ${scope}: ₹${currentInr.toFixed(2)} of ₹${limitInr.toFixed(2)}`
    );
    this.name = 'LlmBudgetExceededError';
    this.scope = scope;
    this.currentInr = currentInr;
    this.limitInr = limitInr;
    if (ids.claimId) this.claimId = ids.claimId;
    if (ids.hospitalId) this.hospitalId = ids.hospitalId;
  }
}

/**
 * Thrown when the model's response cannot be parsed/validated against the
 * caller's Zod schema. `cause` carries the underlying ZodError (or
 * SyntaxError on bad JSON); `rawResponse` carries the model's untouched
 * output for forensic logging.
 */
export class LlmSchemaValidationError extends Error {
  readonly rawResponse: string;
  readonly promptVersion: string;
  readonly taskName: string;
  constructor(message: string, raw: string, taskName: string, promptVersion: string, cause?: unknown) {
    super(message);
    this.name = 'LlmSchemaValidationError';
    this.rawResponse = raw;
    this.promptVersion = promptVersion;
    this.taskName = taskName;
    if (cause !== undefined) (this as any).cause = cause;
  }
}
