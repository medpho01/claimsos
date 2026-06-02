// =============================================================================
// M3 — pure rules engine: dispatch by kind, apply the OD4 abstention gate,
// and summarize readiness. No IO. The live fold (load rules from the DB →
// build RuleContext from the fact ledger → persist) is the M5 integration.
// =============================================================================

import {
  evaluateDocumentPresence,
  evaluateFuzzyName,
  evaluateRequiredFields,
  evaluateTemporalWindow,
} from './evaluators.js';
import type { EvalResult, Rule, RuleContext, Severity } from './types.js';

const FAIL_PENALTY: Record<Severity, number> = {
  CRITICAL: 25,
  HIGH: 10,
  MEDIUM: 5,
  LOW: 2,
  INFO: 0,
};

/** Evaluate one rule, then apply the OD4 abstention gate: a deterministic
 *  result below the rule's min_confidence is forced to SKIP (never auto
 *  PASS/FAIL). */
export function evaluateRule(rule: Rule, ctx: RuleContext): EvalResult {
  let res: EvalResult;
  switch (rule.kind) {
    case 'DOCUMENT_PRESENCE':
      res = evaluateDocumentPresence(rule, ctx);
      break;
    case 'REQUIRED_FIELDS':
      res = evaluateRequiredFields(rule, ctx);
      break;
    case 'FUZZY_NAME':
      res = evaluateFuzzyName(rule, ctx);
      break;
    case 'TEMPORAL_WINDOW':
      res = evaluateTemporalWindow(rule, ctx);
      break;
    default:
      return {
        ruleId: rule.ruleId,
        kind: rule.kind,
        status: 'ERROR',
        severity: rule.severity,
        impact: rule.impact,
        confidence: 0,
        message: `unknown rule kind: ${String(rule.kind)}`,
      };
  }
  if (rule.minConfidence != null && res.status !== 'ERROR' && res.confidence < rule.minConfidence) {
    return {
      ...res,
      status: 'SKIP',
      message: `abstained (confidence ${res.confidence} < min ${rule.minConfidence}): ${res.message}`,
    };
  }
  return res;
}

export function evaluateRules(rules: Rule[], ctx: RuleContext): EvalResult[] {
  return rules.map((r) => evaluateRule(r, ctx));
}

export interface ReadinessSummary {
  score: number; // 0..100
  blocking: string[]; // ruleIds of CRITICAL/HIGH failures
  warnings: string[]; // ruleIds of MEDIUM/LOW failures
  errored: string[]; // ruleIds that errored
}

/** Aggregate per-rule outcomes into a readiness score + actionable buckets.
 *  Interpret-only: this never decides hold/file — it produces a signal the
 *  decision layer consumes (FROZEN_CONTRACTS OD5). */
export function summarizeReadiness(results: EvalResult[]): ReadinessSummary {
  let score = 100;
  const blocking: string[] = [];
  const warnings: string[] = [];
  const errored: string[] = [];
  for (const r of results) {
    if (r.status === 'ERROR') {
      errored.push(r.ruleId);
      continue;
    }
    if (r.status !== 'FAIL') continue;
    score -= FAIL_PENALTY[r.severity];
    if (r.severity === 'CRITICAL' || r.severity === 'HIGH') blocking.push(r.ruleId);
    else warnings.push(r.ruleId);
  }
  return { score: Math.max(0, score), blocking, warnings, errored };
}
