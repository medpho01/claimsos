/**
 * Rules Engine v2 (Wave 8 — Sprint Intelligence Layer)
 *
 * Evaluates a claim's harmonised medical episode (Wave 7's
 * hospital.claim_harmonised_episodes.episode JSONB) against the
 * insurer-specific rule set resolved from hospital.insurer_rule_sets.
 *
 * Key contracts:
 *   - SKIP path: when the harmonised episode is absent (Wave 7 hasn't run
 *     yet), every applicable rule comes back with status=SKIP and a clear
 *     note. The endpoint stays useful for FE.
 *   - Rule-set resolution: most-specific match wins among (insurer_code +
 *     treatment + specialty). Ties broken by status='live' > status='draft'
 *     and then created_at DESC.
 *   - Persistence: per-rule UPSERT into hospital.claim_rule_evaluations
 *     keyed on (claim_id, rule_set_id, rule_id). Re-evaluation overwrites.
 *
 * v2 deliberately runs ALONGSIDE the Wave 3A rulesEngine.service (which
 * gates document presence). They speak to different surfaces.
 *
 * Cost: zero LLM calls; pure SQL + in-process evaluation.
 *
 * Dependencies (consumers must install):
 *   - `jsonpath-plus`   resolves JSONPath expressions against the episode.
 *   - `expr-eval`        sandboxed arithmetic for CALCULATION rules.
 *
 * Both are injected through the constructor `deps` to keep tests hermetic.
 * The production composition root (`rulesEngineV2.ts` default export) wires
 * the real packages.
 */

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import {
  resolveCustomFunction,
  CUSTOM_FUNCTIONS,
  type CustomFunctionContext,
  type CustomFunctionServices,
} from './rules/customFunctions/index.js';

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export const RULES_V2_VERSION = 'v1';

export type RuleStatus = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';
export type RuleSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface RuleEvaluation {
  rule_id: string;
  rule_name: string;
  category: string;
  severity: RuleSeverity;
  impact: string;
  status: RuleStatus;
  evidence: any;
  message: string | null;
  deduction_estimate: number | null;
  remediation_guidance: string | null;
  required_documents: string[];
  query_template: string | null;
}

export interface RulesV2Result {
  rule_set_id: string | null;
  rule_set_name: string | null;
  total_rules: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  critical_failures: number;
  /**
   * 0-100 when a rule pack was evaluated. **null when no rule pack
   * matched** — distinguishes "everything passed" (100) from "we have
   * nothing to evaluate against" (null). FE should render the null
   * case as a pending/unknown state rather than a misleading 100% green.
   */
  readiness_score: number | null;
  /**
   * True iff a rule pack was matched and evaluated for this claim.
   * False when emptyResult() was returned because no rule_set fits
   * (insurer × treatment × specialty combo unseeded), or when the
   * matched rule_set has zero rules. FE keys off this flag rather than
   * having to special-case readiness_score===null.
   */
  applicable: boolean;
  /**
   * Mirror of `!applicable` for the FE — `RulesPanel.tsx` already has a
   * "No insurer rule set configured for this claim" branch keyed on this
   * field, but the backend never populated it. Emitted true when no rule
   * pack matched the claim's insurer × treatment × specialty combo.
   */
  no_match?: boolean;
  evaluations: RuleEvaluation[];
  /** Set when the harmonised episode hasn't been generated yet, or when no rule pack matched. */
  note?: string;
}

export interface PoolLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export type JsonPathFn = (path: string, json: any) => any[];
export interface ExprEvaluator {
  /** Evaluate `formula` with `context` bound (free names). */
  evaluate: (formula: string, context: Record<string, unknown>) => number;
}

export interface RulesEngineV2Deps {
  pool?: PoolLike;
  jsonpath?: JsonPathFn;
  expr?: ExprEvaluator;
  /** Override custom-fn registry (tests). */
  customFunctions?: Record<string, (typeof CUSTOM_FUNCTIONS)[keyof typeof CUSTOM_FUNCTIONS]>;
}

// ────────────────────────────────────────────────────────────────────────────
// Internal row shapes
// ────────────────────────────────────────────────────────────────────────────

interface RuleSetRow {
  id: string;
  rule_set_id: string;
  rule_set_name: string;
  insurer_code: string | null;
  applicable_treatments: string[];
  applicable_specialties: string[];
}

interface RuleRow {
  id: string;
  rule_id: string;
  rule_name: string;
  category: string;
  severity: RuleSeverity;
  impact: string;
  mandatory: boolean;
  validation_logic: any;
  failure_message: string | null;
  remediation_guidance: string | null;
  required_documents: string[];
  estimated_deduction_amount: number | null;
  query_template: string | null;
  order_index: number;
}

interface ClaimContext {
  claim_id: string;
  hospital_id: string | null;
  insurer_code: string | null;
  episode_type: string | null;
  specialties: string[];
  episode: any | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Operators
// ────────────────────────────────────────────────────────────────────────────

function applyOperator(operator: string | undefined, actual: any, expected: any): boolean {
  if (!operator) return false;
  switch (operator) {
    case 'EQUALS':                 return actual === expected;
    case 'NOT_EQUALS':             return actual !== expected;
    case 'GREATER_THAN':           return Number(actual) > Number(expected);
    case 'LESS_THAN':              return Number(actual) < Number(expected);
    case 'GREATER_THAN_OR_EQUAL':  return Number(actual) >= Number(expected);
    case 'LESS_THAN_OR_EQUAL':     return Number(actual) <= Number(expected);
    case 'BETWEEN': {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const n = Number(actual);
      return n >= Number(expected[0]) && n <= Number(expected[1]);
    }
    case 'NOT_BETWEEN': {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const n = Number(actual);
      return n < Number(expected[0]) || n > Number(expected[1]);
    }
    case 'IN':           return Array.isArray(expected) && expected.includes(actual);
    case 'NOT_IN':       return Array.isArray(expected) && !expected.includes(actual);
    case 'EXISTS':       return actual !== null && actual !== undefined && !(Array.isArray(actual) && actual.length === 0);
    case 'NOT_EXISTS':   return actual === null || actual === undefined || (Array.isArray(actual) && actual.length === 0);
    case 'CONTAINS':
      if (Array.isArray(actual)) return actual.includes(expected);
      if (typeof actual === 'string') return actual.includes(String(expected));
      return false;
    case 'NOT_CONTAINS':
      if (Array.isArray(actual)) return !actual.includes(expected);
      if (typeof actual === 'string') return !actual.includes(String(expected));
      return false;
    case 'MATCHES_PATTERN':
      try {
        return new RegExp(String(expected)).test(String(actual ?? ''));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Engine
// ────────────────────────────────────────────────────────────────────────────

export class RulesEngineV2 {
  private readonly pool: PoolLike;
  private readonly jsonpath: JsonPathFn | null;
  private readonly expr: ExprEvaluator | null;
  private readonly customFunctions: Record<string, any>;

  constructor(deps: RulesEngineV2Deps = {}) {
    this.pool = deps.pool ?? (defaultPool as unknown as PoolLike);
    this.jsonpath = deps.jsonpath ?? null;
    this.expr = deps.expr ?? null;
    this.customFunctions = { ...CUSTOM_FUNCTIONS, ...(deps.customFunctions ?? {}) };
  }

  async evaluate(claim_id: string): Promise<RulesV2Result> {
    const ctx = await this.loadClaimContext(claim_id);

    const ruleSet = await this.resolveRuleSet(ctx);
    if (!ruleSet) {
      return this.emptyResult({
        rule_set_id: null,
        rule_set_name: null,
        note: 'no applicable rule set for this claim',
      });
    }

    const rules = await this.loadRules(ruleSet.id);
    if (rules.length === 0) {
      return this.emptyResult({
        rule_set_id: ruleSet.rule_set_id,
        rule_set_name: ruleSet.rule_set_name,
        note: 'rule set has no enabled rules',
      });
    }

    // Harmonised episode absent → SKIP every rule with a clear note.
    if (!ctx.episode) {
      const evals: RuleEvaluation[] = rules.map((r) => this.toRuleEvaluation(r, {
        status: 'SKIP',
        evidence: { reason: 'harmonised episode not yet generated' },
        message: 'harmonised episode not yet generated',
      }));
      const persisted = await this.persistEvaluations(claim_id, ruleSet, evals);
      return this.summarise(ruleSet, persisted, 'harmonised episode not yet generated');
    }

    const evaluations: RuleEvaluation[] = [];
    for (const rule of rules) {
      const outcome = await this.evaluateRule(rule, ruleSet, ctx);
      evaluations.push(this.toRuleEvaluation(rule, outcome));
    }
    const persisted = await this.persistEvaluations(claim_id, ruleSet, evaluations);
    return this.summarise(ruleSet, persisted);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Loaders
  // ────────────────────────────────────────────────────────────────────────

  private async loadClaimContext(claim_id: string): Promise<ClaimContext> {
    // Panel/insurer is carried by the claim_dossiers projection (one row per
    // claim, projected by Wave 2 claimDossierProjector). Wave 7's
    // hospital.claim_harmonised_episodes table holds the harmonised episode
    // JSONB. If either table is absent (e.g. Wave 7 not yet deployed) we fall
    // back to a minimal ipds lookup so the engine can still SKIP rules.
    const sql = `
      SELECT
        i.id                                          AS claim_id,
        i.hospital_id                                 AS hospital_id,
        COALESCE(p.code, p.name, NULL)                AS insurer_code,
        che.episode                                   AS episode
        FROM hospital.ipds i
        LEFT JOIN hospital.claim_dossiers cd ON cd.claim_id = i.id
        LEFT JOIN hospital.panels p ON p.id = cd.current_panel_id
        LEFT JOIN hospital.claim_harmonised_episodes che ON che.claim_id = i.id
       WHERE i.id = $1
       LIMIT 1`;

    let row: any | null = null;
    try {
      const r = await this.pool.query(sql, [claim_id]);
      row = r.rows?.[0] ?? null;
    } catch (err) {
      // Most likely cause: claim_harmonised_episodes table doesn't exist yet
      // (Wave 7 migration hasn't landed). Fall back to a dossier-only lookup.
      logger?.warn?.(
        '[rulesEngineV2] harmonised episode join failed, falling back: ' +
          (err instanceof Error ? err.message : String(err))
      );
      try {
        const r2 = await this.pool.query(
          `SELECT i.id AS claim_id, i.hospital_id,
                  COALESCE(p.code, p.name, NULL) AS insurer_code,
                  NULL::jsonb AS episode
             FROM hospital.ipds i
             LEFT JOIN hospital.claim_dossiers cd ON cd.claim_id = i.id
             LEFT JOIN hospital.panels p ON p.id = cd.current_panel_id
            WHERE i.id = $1 LIMIT 1`,
          [claim_id]
        );
        row = r2.rows?.[0] ?? null;
      } catch (err2) {
        logger?.warn?.(
          '[rulesEngineV2] fallback ipds lookup failed: ' +
            (err2 instanceof Error ? err2.message : String(err2))
        );
        row = null;
      }
    }

    if (!row) {
      return {
        claim_id,
        hospital_id: null,
        insurer_code: null,
        episode_type: null,
        specialties: [],
        episode: null,
      };
    }

    const episode = row.episode ?? null;
    const episode_type = episode?.meta?.episode_type ?? null;
    const specialties: string[] = [];
    const spec = episode?.hospital_context?.specialty ?? episode?.meta?.episode_subtype;
    if (typeof spec === 'string') specialties.push(spec.toUpperCase());
    if (Array.isArray(episode?.hospital_context?.specialties)) {
      for (const s of episode.hospital_context.specialties) {
        if (typeof s === 'string') specialties.push(s.toUpperCase());
      }
    }

    return {
      claim_id,
      hospital_id: row.hospital_id ?? null,
      insurer_code: row.insurer_code ?? null,
      episode_type,
      specialties: Array.from(new Set(specialties)),
      episode,
    };
  }

  /**
   * Most-specific resolution. We pull every candidate that overlaps on
   * insurer_code (or has insurer_code NULL), then score them in JS:
   *   score = (treatment match ? 2 : 0) + count(specialty overlap)
   *           + (insurer_code exact ? 1 : 0)
   *   require treatment match OR 'ALL' in applicable_treatments.
   *   require non-empty specialty overlap OR empty applicable_specialties.
   */
  private async resolveRuleSet(ctx: ClaimContext): Promise<RuleSetRow | null> {
    const result = await this.pool.query(
      `SELECT id, rule_set_id, rule_set_name, insurer_code,
              applicable_treatments, applicable_specialties, status, created_at
         FROM hospital.insurer_rule_sets
        WHERE status = 'live'
          AND (insurer_code IS NULL OR $1::text IS NULL OR insurer_code = $1)
        ORDER BY created_at DESC`,
      [ctx.insurer_code]
    );
    const candidates = result.rows ?? [];
    const episodeType = (ctx.episode_type ?? '').toUpperCase();
    const specs = new Set(ctx.specialties.map((s) => s.toUpperCase()));

    let best: { row: RuleSetRow; score: number } | null = null;
    for (const row of candidates) {
      const treatments: string[] = (row.applicable_treatments ?? []).map((s: string) => s.toUpperCase());
      const specialties: string[] = (row.applicable_specialties ?? []).map((s: string) => s.toUpperCase());

      const treatmentMatch =
        treatments.includes('ALL') || (episodeType && treatments.includes(episodeType));
      const specialtyOverlap = specialties.filter((s) => specs.has(s));
      const specialtyMatch =
        specialties.length === 0 || specialtyOverlap.length > 0;

      if (!treatmentMatch || !specialtyMatch) continue;

      const score =
        (treatmentMatch ? 2 : 0) +
        specialtyOverlap.length +
        (row.insurer_code && ctx.insurer_code && row.insurer_code === ctx.insurer_code ? 1 : 0);
      if (!best || score > best.score) best = { row, score };
    }
    if (!best) return null;
    const r = best.row;
    return {
      id: r.id,
      rule_set_id: r.rule_set_id,
      rule_set_name: r.rule_set_name,
      insurer_code: r.insurer_code,
      applicable_treatments: r.applicable_treatments ?? [],
      applicable_specialties: r.applicable_specialties ?? [],
    };
  }

  private async loadRules(ruleSetUuid: string): Promise<RuleRow[]> {
    const r = await this.pool.query(
      `SELECT id, rule_id, rule_name, category, severity, impact, mandatory,
              validation_logic, failure_message, remediation_guidance,
              required_documents, estimated_deduction_amount, query_template,
              order_index
         FROM hospital.insurance_rules
        WHERE rule_set_id = $1 AND enabled = true
        ORDER BY order_index ASC, rule_id ASC`,
      [ruleSetUuid]
    );
    return (r.rows ?? []).map((row) => ({
      ...row,
      required_documents: row.required_documents ?? [],
    })) as RuleRow[];
  }

  // ────────────────────────────────────────────────────────────────────────
  // Per-rule evaluation
  // ────────────────────────────────────────────────────────────────────────

  private async evaluateRule(
    rule: RuleRow,
    ruleSet: RuleSetRow,
    ctx: ClaimContext
  ): Promise<{ status: RuleStatus; evidence: any; message: string | null }> {
    const logic = rule.validation_logic ?? {};
    const logicType: string = String(logic.logic_type ?? '').toUpperCase();

    try {
      switch (logicType) {
        case 'SIMPLE_COMPARISON':
        case 'RANGE_CHECK':
        case 'PATTERN_MATCH': {
          const values = this.resolveJsonPath(logic.json_path, ctx.episode);
          const actual = unwrapSingle(values);
          const passed = applyOperator(logic.operator, actual, logic.expected_value);
          return passed
            ? { status: 'PASS', evidence: { actual }, message: null }
            : {
                status: 'FAIL',
                evidence: { actual, expected: logic.expected_value, operator: logic.operator },
                message: rule.failure_message,
              };
        }
        case 'EXISTENCE_CHECK': {
          const values = this.resolveJsonPath(logic.json_path, ctx.episode);
          const op = logic.operator ?? 'EXISTS';
          const passed = applyOperator(op, values, logic.expected_value);
          return passed
            ? { status: 'PASS', evidence: { matches: values.length }, message: null }
            : {
                status: 'FAIL',
                evidence: { matches: values.length, json_path: logic.json_path },
                message: rule.failure_message,
              };
        }
        case 'CALCULATION': {
          if (!this.expr) {
            return {
              status: 'ERROR',
              evidence: { reason: 'expression evaluator not configured' },
              message: 'CALCULATION rules require the expr-eval evaluator',
            };
          }
          const value = this.expr.evaluate(String(logic.calculation_formula ?? ''), {
            episode: ctx.episode,
            $: ctx.episode,
          });
          const passed = applyOperator(logic.operator ?? 'LESS_THAN_OR_EQUAL', value, logic.expected_value);
          return passed
            ? { status: 'PASS', evidence: { value }, message: null }
            : {
                status: 'FAIL',
                evidence: { value, expected: logic.expected_value, formula: logic.calculation_formula },
                message: rule.failure_message,
              };
        }
        case 'LOOKUP_TABLE': {
          const ref = String(logic.lookup_table_ref ?? '');
          if (!ref) {
            return { status: 'ERROR', evidence: { reason: 'lookup_table_ref missing' }, message: null };
          }
          const values = this.resolveJsonPath(logic.json_path, ctx.episode);
          const actual = unwrapSingle(values);
          // The catalog is restricted to two known refs to keep this safe:
          //   master_options(category=<x>,code=<actual>)
          //   insurer_los_benchmarks(rule_set_id=<self>,procedure_code=<actual>)
          if (ref.startsWith('master_options:')) {
            const category = ref.slice('master_options:'.length);
            const r = await this.pool.query(
              `SELECT code FROM hospital.master_options WHERE category = $1 AND code = $2 LIMIT 1`,
              [category, actual]
            );
            const exists = (r.rows?.length ?? 0) > 0;
            return exists
              ? { status: 'PASS', evidence: { actual }, message: null }
              : { status: 'FAIL', evidence: { actual, category }, message: rule.failure_message };
          }
          return {
            status: 'ERROR',
            evidence: { reason: `unknown lookup_table_ref '${ref}'` },
            message: null,
          };
        }
        case 'COMPLEX_CONDITION':
        case 'CUSTOM': {
          const fnName: string | undefined = logic.custom_function;
          const fn = fnName ? this.customFunctions[fnName] ?? resolveCustomFunction(fnName) : null;
          if (!fn) {
            return {
              status: 'ERROR',
              evidence: { reason: `custom function '${fnName ?? '<unset>'}' not registered` },
              message: null,
            };
          }
          const services: CustomFunctionServices = { pool: this.pool as any };
          const ruleContext: CustomFunctionContext = {
            rule: {
              rule_id: rule.rule_id,
              rule_name: rule.rule_name,
              category: rule.category,
              severity: rule.severity,
              impact: rule.impact,
              validation_logic: rule.validation_logic,
              estimated_deduction_amount: rule.estimated_deduction_amount,
              required_documents: rule.required_documents,
            },
            rule_set: {
              id: ruleSet.id,
              rule_set_id: ruleSet.rule_set_id,
              insurer_code: ruleSet.insurer_code,
            },
            hospital_id: ctx.hospital_id,
            claim_id: ctx.claim_id,
          };
          const out = await fn(ctx.episode, ruleContext, services);
          return { status: out.status, evidence: out.evidence, message: out.message ?? rule.failure_message };
        }
        default:
          return {
            status: 'ERROR',
            evidence: { reason: `unknown logic_type '${logic.logic_type}'` },
            message: null,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.error?.(`[rulesEngineV2] rule ${rule.rule_id} errored: ${message}`);
      return { status: 'ERROR', evidence: { error: message }, message };
    }
  }

  private resolveJsonPath(path: string | undefined, json: any): any[] {
    if (!path) return [];
    if (!this.jsonpath) {
      // Defer hard failure to the rule's status; if a rule needs JSONPath
      // and no evaluator is wired, surface ERROR rather than silently FAIL.
      throw new Error('JSONPath evaluator not configured (deps.jsonpath missing)');
    }
    const out = this.jsonpath(path, json);
    return Array.isArray(out) ? out : out == null ? [] : [out];
  }

  // ────────────────────────────────────────────────────────────────────────
  // Persistence + summary
  // ────────────────────────────────────────────────────────────────────────

  private toRuleEvaluation(
    rule: RuleRow,
    outcome: { status: RuleStatus; evidence: any; message: string | null }
  ): RuleEvaluation {
    return {
      rule_id: rule.rule_id,
      rule_name: rule.rule_name,
      category: rule.category,
      severity: rule.severity,
      impact: rule.impact,
      status: outcome.status,
      evidence: outcome.evidence ?? null,
      message: outcome.message ?? rule.failure_message,
      deduction_estimate:
        outcome.status === 'FAIL' && rule.estimated_deduction_amount != null
          ? Number(rule.estimated_deduction_amount)
          : null,
      remediation_guidance: rule.remediation_guidance,
      required_documents: rule.required_documents ?? [],
      query_template: rule.query_template,
    };
  }

  private async persistEvaluations(
    claim_id: string,
    ruleSet: RuleSetRow,
    evals: RuleEvaluation[]
  ): Promise<RuleEvaluation[]> {
    for (const e of evals) {
      try {
        await this.pool.query(
          `INSERT INTO hospital.claim_rule_evaluations
            (claim_id, rule_set_id, rule_id, status, severity, impact,
             evidence, message, deduction_estimate, evaluated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW())
           ON CONFLICT (claim_id, rule_set_id, rule_id) DO UPDATE
             SET status = EXCLUDED.status,
                 severity = EXCLUDED.severity,
                 impact = EXCLUDED.impact,
                 evidence = EXCLUDED.evidence,
                 message = EXCLUDED.message,
                 deduction_estimate = EXCLUDED.deduction_estimate,
                 evaluated_at = NOW()`,
          [
            claim_id,
            ruleSet.id,
            e.rule_id,
            e.status,
            e.severity,
            e.impact,
            JSON.stringify(e.evidence ?? null),
            e.message,
            e.deduction_estimate,
          ]
        );
      } catch (err) {
        logger?.warn?.(
          `[rulesEngineV2] persist failed for rule ${e.rule_id}: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
    }
    return evals;
  }

  private summarise(
    ruleSet: RuleSetRow,
    evaluations: RuleEvaluation[],
    note?: string
  ): RulesV2Result {
    let passed = 0,
      failed = 0,
      skipped = 0,
      errored = 0,
      critical_failures = 0;
    let score = 100;
    for (const e of evaluations) {
      if (e.status === 'PASS') passed++;
      else if (e.status === 'SKIP') skipped++;
      else if (e.status === 'ERROR') errored++;
      else if (e.status === 'FAIL') {
        failed++;
        if (e.impact === 'WARNING') continue;
        switch (e.severity) {
          case 'CRITICAL':
            critical_failures++;
            score -= 25;
            break;
          case 'HIGH':
            score -= 10;
            break;
          case 'MEDIUM':
            score -= 5;
            break;
          case 'LOW':
            score -= 2;
            break;
          default:
            break;
        }
      }
    }
    score = Math.max(0, Math.min(100, score));
    const result: RulesV2Result = {
      rule_set_id: ruleSet.rule_set_id,
      rule_set_name: ruleSet.rule_set_name,
      total_rules: evaluations.length,
      passed,
      failed,
      skipped,
      errored,
      critical_failures,
      readiness_score: score,
      // A rule pack was matched AND it had >0 rules → applicable=true.
      // (Zero-rule packs go through emptyResult() above and get
      // applicable=false. Guard here belt-and-braces in case of a
      // future code path that calls this with an empty evaluations
      // list — those should also report as "not applicable".)
      applicable: evaluations.length > 0,
      evaluations,
    };
    if (note) result.note = note;
    return result;
  }

  private emptyResult(opts: {
    rule_set_id: string | null;
    rule_set_name: string | null;
    note?: string;
  }): RulesV2Result {
    // CRITICAL: do NOT return readiness_score=100 here. emptyResult() is
    // returned when there's no rule pack to evaluate against (or the
    // matched pack has zero rules) — that is NOT the same as
    // "evaluated → everything passed". Returning 100 made the FE Rules
    // panel show a misleading green badge for claims that had no
    // applicable insurer rule pack seeded. Use null + applicable=false
    // so the UI can render a "Pending — no rule pack matched" state.
    return {
      rule_set_id: opts.rule_set_id,
      rule_set_name: opts.rule_set_name,
      total_rules: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      errored: 0,
      critical_failures: 0,
      readiness_score: null,
      applicable: false,
      no_match: true,
      evaluations: [],
      ...(opts.note ? { note: opts.note } : {}),
    };
  }
}

function unwrapSingle(values: any[]): any {
  if (!values || values.length === 0) return undefined;
  if (values.length === 1) return values[0];
  return values;
}

// ────────────────────────────────────────────────────────────────────────────
// Composition root
// ────────────────────────────────────────────────────────────────────────────
//
// The production engine wires `jsonpath-plus` and `expr-eval` at construction.
// Both are imported via `import()` so a missing package surfaces a clear
// runtime error (instead of a hard top-level crash) before any rule that
// actually needs them is evaluated. Tests bypass this by constructing
// `new RulesEngineV2({ pool, jsonpath, expr })` directly.

let _singleton: RulesEngineV2 | null = null;
export async function getRulesEngineV2(): Promise<RulesEngineV2> {
  if (_singleton) return _singleton;
  let jsonpath: JsonPathFn | undefined;
  let expr: ExprEvaluator | undefined;
  try {
    const mod: any = await import('jsonpath-plus');
    const JSONPath = mod.JSONPath ?? mod.default?.JSONPath ?? mod.default;
    jsonpath = (path: string, json: any) => JSONPath({ path, json, wrap: true });
  } catch (err) {
    logger?.warn?.('[rulesEngineV2] jsonpath-plus not installed; JSONPath rules will ERROR');
  }
  try {
    const mod: any = await import('expr-eval');
    const Parser = mod.Parser ?? mod.default?.Parser;
    if (Parser) {
      const parser = new Parser();
      expr = { evaluate: (formula, context) => parser.parse(formula).evaluate(context) };
    }
  } catch (err) {
    logger?.warn?.('[rulesEngineV2] expr-eval not installed; CALCULATION rules will ERROR');
  }
  _singleton = new RulesEngineV2({ jsonpath, expr });
  return _singleton;
}

export default RulesEngineV2;
