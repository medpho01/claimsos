/**
 * ReasoningAgent Service — Sprint 4, Wave 4C
 *
 * Wraps the LLM call that synthesises rules + KB patterns + episodic
 * cases into a single grounded verdict for an adjudication report.
 *
 * Lifecycle:
 *   1. Caller (AdjudicationEngine.enrichWithIntelligence) decides — by
 *      heuristic — whether to invoke us. We do NOT run on every claim.
 *   2. We build a compact dossier summary (reusing the Wave 4B summary
 *      builder if available, else our own).
 *   3. We call LlmClient.extract with tier='premium' (Sonnet). The
 *      system prompt is heavily cached (cache_control set in
 *      claudeClient.ts) so steady-state cost per call is dominated by
 *      the variable user prompt + output tokens.
 *   4. We record the call to costAccounting.recordCall — the LLM bridge
 *      does NOT auto-record (verified vs. claudeClient.ts and the
 *      emailIntelligence.service.ts pattern); every consumer is
 *      responsible for its own row in llm_cost_log.
 *   5. We return the validated output, the INR cost, and whether the
 *      'standard' tier escalated (always false here — we request
 *      'premium' directly).
 *
 * Cost expectations (steady state, with prompt cache warm):
 *   - System prompt (~2.5k tokens) cached → ~₹0.06 input
 *   - User prompt (~2k uncached tokens) → ~₹0.50 input
 *   - Output (~500 tokens) → ~₹0.62 output
 *   - Total per call ≈ ₹0.80-1.00 on Sonnet 4.
 *
 * NOT called on every adjudication — the AdjudicationEngine heuristic
 * (warnings >= 2 OR contradicting KB matches OR explicit useReasoning
 * flag) ensures we only fire when the rules-only answer is ambiguous.
 *
 * Coupling to Wave 4A (KB) and Wave 4B (episodic): we depend on their
 * RESULT shapes but not on their *services* — the AdjudicationEngine
 * passes already-retrieved kb_matches and episodic_cases into reason().
 * If 4B has shipped a `summariseDossier` helper we try to import it for
 * a richer summary; otherwise we fall back to our own ~60-line builder
 * in `prompts/reasoningAgent.v1.ts`. Both lanes can land in any order.
 */

import { createHash } from 'crypto';

import { logger } from '../Utils/logger.js';
import costAccounting from './costAccounting.service.js';
import type { ClaimDossier } from './claimDossierProjector.service.js';
import { getLlmClient } from './llm/factory.js';
import type { LlmClient } from './llm/LlmClient.js';
import {
  ReasoningAgentOutput,
  type ReasoningAgentOutputT,
} from './llm/schemas/reasoningAgent.js';
import {
  PROMPT_VERSION,
  TASK_NAME,
  SYSTEM_PROMPT,
  buildCompactDossier,
  buildUserPrompt,
  type CompactRuleEvaluation,
  type CompactKbMatch,
  type CompactEpisodicCase,
} from './llm/prompts/reasoningAgent.v1.js';

// ─── Versioning ──────────────────────────────────────────────────────────
// Bump when the prompt OR the schema changes in a way that invalidates
// stored reasoning outputs. The adjudication_reports row carries this
// version stamp via reasoning_version (Wave 4C migration; not in scope
// here — for now the engine writes the agent's narrative to .reasoning
// and the version is implicit in the report's engine_version).
export const REASONING_AGENT_VERSION = 'v1';

// ─── Public types ────────────────────────────────────────────────────────

export interface ReasoningAgentInput {
  claim_id: string;
  hospital_id: string;
  dossier: ClaimDossier;
  target_stage: string;
  /**
   * Rule evaluation as returned by RulesEngine.evaluate (Wave 3A). We
   * type it as the compact shape the prompt builder needs — callers can
   * pass the full RuleEvaluationResult since it's a subset.
   */
  rule_evaluation: CompactRuleEvaluation;
  /** Top-K matched patterns from KbPatternMatcher (Wave 4A). */
  kb_matches: CompactKbMatch[];
  /** Top-K retrieved similar cases from EpisodicMemory (Wave 4B). */
  episodic_cases: CompactEpisodicCase[];
}

export interface ReasoningAgentResult {
  output: ReasoningAgentOutputT;
  costInr: number;
  tierEscalated: boolean;
}

export interface ReasoningAgentDeps {
  llm?: LlmClient;
  cost?: typeof costAccounting;
  /**
   * Optional override for the dossier-summary builder. Wave 4B owns the
   * canonical summariser — we'll try to dynamic-import it at call time;
   * if 4B hasn't merged yet (or if a test wants to lock in a fixed
   * summary), pass it explicitly here.
   */
  summariseDossier?: (dossier: ClaimDossier) => string;
}

// ─── Compute deterministic cache key ─────────────────────────────────────
// LRU cache in claudeClient is keyed on (cacheKey, promptVersion). We
// build a content-addressed key from the inputs so two identical calls
// in the same 5-min window dedupe to a single Sonnet hit.
//
// Exported for test parity — the test asserts the same inputs produce the
// same key.
export function computeReasoningCacheKey(args: {
  dossier_state_hash?: string;
  rules_signature: string;
  kb_signature: string;
  episodic_signature: string;
  target_stage: string;
}): string {
  const material = JSON.stringify({
    dossier_state_hash: args.dossier_state_hash ?? null,
    rules_signature: args.rules_signature,
    kb_signature: args.kb_signature,
    episodic_signature: args.episodic_signature,
    target_stage: args.target_stage,
    prompt_version: PROMPT_VERSION,
  });
  return createHash('sha256').update(material).digest('hex');
}

function signatureOf(value: unknown): string {
  // Stable signature for a list — order matters (top-K is ordered), but
  // we lock in JSON.stringify on a normalised projection. Used so the
  // cache key flips when kb/episodic results change.
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function rulesSignature(re: CompactRuleEvaluation): string {
  const projection = {
    score: Math.round((re.readiness_score ?? 0) * 1000) / 1000,
    blocking: (re.blocking_gaps ?? []).map((g) => g.rule_id ?? g.rule_key ?? '?'),
    warnings: (re.warnings ?? []).map((w) => w.rule_id ?? w.rule_key ?? '?'),
  };
  return signatureOf(projection);
}

function kbSignature(matches: CompactKbMatch[]): string {
  return signatureOf(matches.map((m) => `${m.id}:${m.confidence ?? 0}`));
}

function episodicSignature(cases: CompactEpisodicCase[]): string {
  return signatureOf(cases.map((c) => `${c.claim_id}:${c.similarity.toFixed(3)}`));
}

// ─── Lazy import of Wave 4B summariser ───────────────────────────────────
// Wave 4B may or may not have shipped a `summariseDossier` export when
// this file runs. We try once, cache the result (positive or negative),
// and fall back to buildCompactDossier from the prompt module.
let cachedSummariser: ((d: ClaimDossier) => string) | null | undefined =
  undefined;
async function lazyLoadEpisodicSummariser(): Promise<
  ((d: ClaimDossier) => string) | null
> {
  if (cachedSummariser !== undefined) return cachedSummariser;
  try {
    const mod: any = await import('./episodicMemory.service.js');
    // Two plausible export names — Wave 4B's PR thread suggested either.
    const fn = mod.summariseDossier ?? mod.buildDossierSummary ?? null;
    cachedSummariser = typeof fn === 'function' ? fn : null;
  } catch {
    cachedSummariser = null;
  }
  return cachedSummariser;
}

// Test-only escape hatch.
export function __setEpisodicSummariserForTests(
  fn: ((d: ClaimDossier) => string) | null
): void {
  cachedSummariser = fn;
}

// ─── Service ─────────────────────────────────────────────────────────────

export class ReasoningAgent {
  private readonly llm: LlmClient | null;
  private readonly cost: typeof costAccounting;
  private readonly summariseDossierOverride:
    | ((d: ClaimDossier) => string)
    | null;

  constructor(deps: ReasoningAgentDeps = {}) {
    // llm is loaded lazily on first call so the module imports cheaply
    // (factory pulls in the Anthropic SDK).
    this.llm = deps.llm ?? null;
    this.cost = deps.cost ?? costAccounting;
    this.summariseDossierOverride = deps.summariseDossier ?? null;
  }

  private getLlm(): LlmClient {
    return this.llm ?? getLlmClient();
  }

  async reason(input: ReasoningAgentInput): Promise<ReasoningAgentResult> {
    // (a) Build dossier summary. Order of preference:
    //     1. caller-provided override (deps.summariseDossier)
    //     2. Wave 4B's summariseDossier (if exported)
    //     3. local buildCompactDossier helper
    let summary: string;
    if (this.summariseDossierOverride) {
      summary = this.summariseDossierOverride(input.dossier);
    } else {
      const fn = await lazyLoadEpisodicSummariser();
      summary = fn ? fn(input.dossier) : buildCompactDossier(input.dossier);
    }

    // (b) Build the user prompt.
    const userPrompt = buildUserPrompt({
      dossierSummary: summary,
      ruleEvaluation: input.rule_evaluation,
      kbMatches: input.kb_matches,
      episodicCases: input.episodic_cases,
      targetStage: input.target_stage,
    });

    // (c) Cache key — content-addressed.
    const cacheKey = computeReasoningCacheKey({
      rules_signature: rulesSignature(input.rule_evaluation),
      kb_signature: kbSignature(input.kb_matches),
      episodic_signature: episodicSignature(input.episodic_cases),
      target_stage: input.target_stage,
    });

    // (d) Call Sonnet via the LLM bridge. extract() handles JSON
    //     parsing, Zod validation, and throws LlmSchemaValidationError
    //     on bad output — we let it propagate so the AdjudicationEngine
    //     can decide whether to fall back to rules-only.
    const llm = this.getLlm();
    const result = await llm.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      schema: ReasoningAgentOutput,
      tier: 'premium',
      promptVersion: PROMPT_VERSION,
      taskName: TASK_NAME,
      claimId: input.claim_id,
      hospitalId: input.hospital_id,
      cacheKey,
    });

    // (e) Record cost. The LLM bridge does NOT auto-record (per the
    //     emailIntelligence pattern), so we do it here. Best-effort —
    //     recordCall swallows its own errors.
    await this.cost.recordCall({
      claimId: input.claim_id,
      hospitalId: input.hospital_id,
      task: TASK_NAME,
      provider: result.provider,
      model: result.model,
      promptVersion: PROMPT_VERSION,
      tokensInputUncached: result.tokensInputUncached,
      tokensInputCached: result.tokensInputCached,
      tokensOutput: result.tokensOutput,
      latencyMs: result.latencyMs,
      costInr: result.costInr,
      succeeded: true,
      errorMessage: null,
    });

    logger.debug(
      {
        claim_id: input.claim_id,
        target_stage: input.target_stage,
        verdict: result.data.readiness_verdict,
        approval_probability: result.data.predicted_outcome.approval_probability,
        cost_inr: result.costInr,
        tier_escalated: result.tierEscalated,
      },
      'reasoningAgent.reason: ok'
    );

    return {
      output: result.data,
      costInr: result.costInr,
      tierEscalated: result.tierEscalated,
    };
  }
}

// ─── Default singleton ───────────────────────────────────────────────────
// Lazy llm wiring; cost service is the module default. Controllers /
// adjudication engine import this directly.
export default new ReasoningAgent();
