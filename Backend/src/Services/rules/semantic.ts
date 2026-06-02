// =============================================================================
// M6 — semantic rule evaluators (LLM-backed). Async, makes real Claude calls in
// the worker env. Kept OUT of the pure sync engine so the deterministic
// adjudicator stays runnable on hosts without the Anthropic SDK: the LLM client
// is LAZY-imported only when a semantic rule actually fires (and is injectable
// for unit tests). EVIDENCE_CHECK (vision) is stubbed for now (M6b).
//
// Interpret-only (OD5): produces a PASS/FAIL/SKIP signal with cited reasoning;
// never an auto hold/file. Respects the per-claim ₹15 cap (extract pre-checks
// budget; spend is recorded via costAccounting — CRIT-2 pattern).
// =============================================================================

import type { EvalResult, Rule } from './types.js';
import type { LlmClient } from '../llm/LlmClient.js';
import type { RecordCallInput } from '../costAccounting.service.js';
import { SYSTEM_PROMPT, buildUserPrompt, COHERENCE_PROMPT_VERSION } from '../llm/prompts/ruleCoherence.v1.js';
import { CoherenceVerdictSchema } from '../llm/schemas/coherenceVerdict.js';

export interface SemanticContext {
  fieldsByCategory: Record<string, Record<string, unknown>>;
  episode: any;
}

export interface SemanticDeps {
  /** Injected for tests; otherwise lazily resolved via llm/factory. */
  llm?: LlmClient;
  /** Injected for tests; otherwise lazily resolved via costAccounting. */
  recordCall?: (input: RecordCallInput) => Promise<void>;
  claimId?: string;
  hospitalId?: string;
}

function res(
  rule: Rule,
  status: EvalResult['status'],
  confidence: number,
  message: string,
  evidence?: Record<string, unknown>,
): EvalResult {
  return {
    ruleId: rule.ruleId,
    kind: rule.kind,
    status,
    severity: rule.severity,
    impact: rule.impact,
    confidence,
    message,
    ...(evidence ? { evidence } : {}),
  };
}

function asStr(x: unknown, d = ''): string {
  return typeof x === 'string' ? x : d;
}

function getPath(obj: any, path: string): unknown {
  return path.split('.').reduce((o: any, k: string) => (o == null ? undefined : o[k]), obj);
}

function collectSources(raw: unknown, sctx: SemanticContext): Array<{ label: string; text: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; text: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const fromCategory = typeof s.fromCategory === 'string' ? s.fromCategory : null;
    const fromEpisodePath = typeof s.fromEpisodePath === 'string' ? s.fromEpisodePath : null;
    const label = asStr(s.label, fromCategory ?? fromEpisodePath ?? 'source');
    let text = '';
    if (fromCategory && sctx.fieldsByCategory[fromCategory]) {
      text = JSON.stringify(sctx.fieldsByCategory[fromCategory]);
    } else if (fromEpisodePath) {
      const v = getPath(sctx.episode, fromEpisodePath);
      text = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    }
    out.push({ label, text });
  }
  return out;
}

export async function evaluateSemanticRule(rule: Rule, sctx: SemanticContext, deps: SemanticDeps = {}): Promise<EvalResult> {
  if (rule.kind === 'EVIDENCE_CHECK') {
    return res(rule, 'SKIP', 1, 'EVIDENCE_CHECK (vision) not yet implemented (M6b)');
  }
  if (rule.kind !== 'LLM_COHERENCE') {
    return res(rule, 'ERROR', 0, `not a semantic rule kind: ${String(rule.kind)}`);
  }

  const sources = collectSources(rule.params.sources, sctx);
  if (sources.length === 0 || sources.every((s) => !s.text)) {
    return res(rule, 'SKIP', 1, 'no content available to assess coherence');
  }

  // Lazy-resolve the LLM client so importing this module never pulls the
  // Anthropic SDK on hosts that lack it.
  let llm = deps.llm;
  if (!llm) {
    try {
      const factory = await import('../llm/factory.js');
      llm = factory.getLlmClient();
    } catch {
      return res(rule, 'SKIP', 1, 'LLM client unavailable — semantic rules run only in the worker env');
    }
  }

  const question = asStr(rule.params.question, 'Are these documents mutually consistent?');
  const taskName = `rule_coherence.${rule.ruleId}`;
  let result;
  try {
    result = await llm.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(question, sources),
      schema: CoherenceVerdictSchema,
      tier: 'standard',
      promptVersion: COHERENCE_PROMPT_VERSION,
      taskName,
      ...(deps.claimId ? { claimId: deps.claimId } : {}),
      ...(deps.hospitalId ? { hospitalId: deps.hospitalId } : {}),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'LlmBudgetExceededError') {
      return res(rule, 'SKIP', 1, 'LLM budget exceeded — semantic check skipped');
    }
    return res(rule, 'ERROR', 0, 'LLM coherence call failed: ' + (err instanceof Error ? err.message : String(err)));
  }

  // Record spend (CRIT-2 pattern), best-effort.
  const record =
    deps.recordCall ??
    (async (input: RecordCallInput) => {
      try {
        const ca = await import('../costAccounting.service.js');
        await ca.default.recordCall(input);
      } catch {
        /* audit-only — never blocks */
      }
    });
  await record({
    claimId: deps.claimId ?? null,
    hospitalId: deps.hospitalId ?? null,
    task: taskName,
    provider: result.provider,
    model: result.model,
    promptVersion: COHERENCE_PROMPT_VERSION,
    tokensInputUncached: result.tokensInputUncached,
    tokensInputCached: result.tokensInputCached,
    tokensOutput: result.tokensOutput,
    latencyMs: result.latencyMs,
    costInr: result.costInr,
    succeeded: true,
  }).catch(() => undefined);

  const v = result.data;
  const confidence = typeof v.confidence === 'number' ? v.confidence : result.confidence;
  const evidence = { question, sources: sources.map((s) => s.label), coheres: v.coheres, reasoning: v.reasoning };

  // OD4 abstention: a low-confidence semantic verdict abstains (SKIP) rather
  // than asserting PASS/FAIL.
  if (rule.minConfidence != null && confidence < rule.minConfidence) {
    return res(rule, 'SKIP', confidence, `abstained (confidence ${confidence} < min ${rule.minConfidence})`, evidence);
  }
  return res(rule, v.coheres ? 'PASS' : 'FAIL', confidence, v.reasoning || (v.coheres ? 'coherent' : 'inconsistent'), evidence);
}
