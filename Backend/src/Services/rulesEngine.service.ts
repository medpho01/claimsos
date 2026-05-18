/**
 * Rules Engine Service (Sprint 3, Wave 3A)
 *
 * Evaluates whether a claim's current dossier satisfies the configurable
 * `hospital.stage_requirements` rules for a given target stage. Produces a
 * readiness verdict plus structured gap / warning / info lists.
 *
 * Inputs:
 *   - claim_id (canonical IPD id)
 *   - target_stage (master_options code for ipd_stage)
 *   - dossier_snapshot: trimmed view of the projection — current panel /
 *     insurer ids and the doc_sections_by_category map. The caller (typically
 *     the controller) reads this from the claim_dossiers projection.
 *   - optional procedure_code / diagnosis_class to drive scoped rules.
 *
 * Output:
 *   - readiness_score (0..100), ready (bool)
 *   - blocking_gaps / warnings / info
 *   - evaluated_rules (every applicable rule + whether it matched/passed)
 *   - scope_resolution (counts of rules applied per scope class)
 *
 * Scoring:
 *   readiness_score = clamp(0, 100, 100 - 25*blocking_count - 5*warning_count)
 *   ready = blocking_count == 0
 *
 * Concerns / TBDs:
 *   - Insurer scoping currently FK's to panels(id) — no separate insurer
 *     table exists yet (migration 035 notes this; flag if you find one).
 *   - required_fields check is v1: any section of an allowed_categories
 *     bucket having every listed field_key present in its extracted_fields.
 *     Richer cross-category aggregation can land later.
 */

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface RequiredFieldSpec {
  field_key: string;
  allowed_categories?: string[];
}

export interface RuleEvaluationInput {
  claim_id: string;
  target_stage: string;
  dossier_snapshot: {
    current_panel_id: string | null;
    current_insurer_id: string | null;
    /** Map of doc_category -> array of section ids present on the claim. */
    doc_sections_by_category: Record<string, string[]>;
  };
  /** Optional explicit context for richer scoping. */
  procedure_code?: string;
  diagnosis_class?: string;
}

export interface BlockingGap {
  rule_key: string;
  rule_id: string;
  required_doc_category?: string;
  required_fields?: RequiredFieldSpec[] | null;
  message: string;
  severity: 'blocking';
}

export interface RuleWarning {
  rule_key: string;
  rule_id: string;
  required_doc_category?: string;
  required_fields?: RequiredFieldSpec[] | null;
  message: string;
  severity: 'warning';
}

export interface RuleInfo {
  rule_key: string;
  rule_id: string;
  message: string;
}

export interface EvaluatedRule {
  rule_id: string;
  rule_key: string;
  matched: boolean;
  passed: boolean;
}

export interface ScopeResolution {
  global_rules_applied: number;
  panel_rules_applied: number;
  insurer_rules_applied: number;
  procedure_rules_applied: number;
  diagnosis_rules_applied: number;
}

export interface RuleEvaluationResult {
  ready: boolean;
  readiness_score: number;
  blocking_gaps: BlockingGap[];
  warnings: RuleWarning[];
  info: RuleInfo[];
  evaluated_rules: EvaluatedRule[];
  scope_resolution: ScopeResolution;
}

// ────────────────────────────────────────────────────────────────────────────
// Internal types
// ────────────────────────────────────────────────────────────────────────────

interface StageRequirementRow {
  id: string;
  rule_key: string;
  target_stage: string;
  required_doc_category: string | null;
  required_fields: RequiredFieldSpec[] | null;
  severity: 'blocking' | 'warning' | 'info';
  scope_global: boolean;
  scope_panel_id: string | null;
  scope_insurer_id: string | null;
  scope_procedure_code: string | null;
  scope_diagnosis_class: string | null;
  version: number;
}

interface ExtractedFieldsRow {
  category: string;
  extracted_fields: Record<string, unknown> | null;
}

/**
 * Pool surface we depend on — narrowed for testability so a mock can satisfy
 * it without importing pg.
 */
export interface PoolLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface RulesEngineDeps {
  pool?: PoolLike;
}

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

export class RulesEngine {
  private pool: PoolLike;

  constructor(deps: RulesEngineDeps = {}) {
    this.pool = deps.pool ?? (defaultPool as unknown as PoolLike);
  }

  /**
   * Evaluate all applicable rules for (claim_id, target_stage) against the
   * provided dossier snapshot. Pure read; no writes.
   */
  async evaluate(input: RuleEvaluationInput): Promise<RuleEvaluationResult> {
    const rules = await this.loadApplicableRules(input.target_stage);
    const inScope = rules.filter((r) => this.ruleAppliesInScope(r, input));

    const scopeResolution: ScopeResolution = {
      global_rules_applied: 0,
      panel_rules_applied: 0,
      insurer_rules_applied: 0,
      procedure_rules_applied: 0,
      diagnosis_rules_applied: 0,
    };
    for (const r of inScope) {
      if (r.scope_global) scopeResolution.global_rules_applied++;
      if (r.scope_panel_id) scopeResolution.panel_rules_applied++;
      if (r.scope_insurer_id) scopeResolution.insurer_rules_applied++;
      if (r.scope_procedure_code) scopeResolution.procedure_rules_applied++;
      if (r.scope_diagnosis_class) scopeResolution.diagnosis_rules_applied++;
    }

    // Only fetch extracted_fields when at least one in-scope rule needs them.
    const needsFields = inScope.some(
      (r) => Array.isArray(r.required_fields) && r.required_fields.length > 0
    );
    const sectionFields = needsFields
      ? await this.loadExtractedFields(input.claim_id)
      : [];

    const blocking_gaps: BlockingGap[] = [];
    const warnings: RuleWarning[] = [];
    const info: RuleInfo[] = [];
    const evaluated_rules: EvaluatedRule[] = [];

    for (const rule of inScope) {
      const passed = this.ruleSatisfied(rule, input, sectionFields);
      evaluated_rules.push({
        rule_id: rule.id,
        rule_key: rule.rule_key,
        matched: true,
        passed,
      });

      if (rule.severity === 'info') {
        // Info rules surface only when they "match" (we always include them
        // here since the in-scope filter is the match). They don't impact
        // readiness regardless of passed/failed.
        info.push({
          rule_id: rule.id,
          rule_key: rule.rule_key,
          message: this.buildMessage(rule, passed),
        });
        continue;
      }

      if (passed) continue;

      if (rule.severity === 'blocking') {
        blocking_gaps.push({
          rule_id: rule.id,
          rule_key: rule.rule_key,
          required_doc_category: rule.required_doc_category ?? undefined,
          required_fields: rule.required_fields ?? null,
          message: this.buildMessage(rule, false),
          severity: 'blocking',
        });
      } else {
        warnings.push({
          rule_id: rule.id,
          rule_key: rule.rule_key,
          required_doc_category: rule.required_doc_category ?? undefined,
          required_fields: rule.required_fields ?? null,
          message: this.buildMessage(rule, false),
          severity: 'warning',
        });
      }
    }

    const readiness_score = clamp(
      0,
      100,
      100 - blocking_gaps.length * 25 - warnings.length * 5
    );

    const result: RuleEvaluationResult = {
      ready: blocking_gaps.length === 0,
      readiness_score,
      blocking_gaps,
      warnings,
      info,
      evaluated_rules,
      scope_resolution: scopeResolution,
    };

    logger.info(
      {
        claim_id: input.claim_id,
        target_stage: input.target_stage,
        evaluated: evaluated_rules.length,
        blocking: blocking_gaps.length,
        warnings: warnings.length,
        readiness_score,
      },
      'rules_engine.evaluate'
    );

    return result;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Data loaders
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Load every active, currently-effective rule for the target stage. Scope
   * filtering happens in code so callers can see exactly which rules were
   * skipped vs. applied (no opaque WHERE pruning).
   */
  private async loadApplicableRules(
    target_stage: string
  ): Promise<StageRequirementRow[]> {
    const res = await this.pool.query(
      `SELECT id, rule_key, target_stage,
              required_doc_category, required_fields,
              severity,
              scope_global, scope_panel_id, scope_insurer_id,
              scope_procedure_code, scope_diagnosis_class,
              version
         FROM hospital.stage_requirements
        WHERE target_stage = $1
          AND active = true
          AND effective_from <= NOW()
          AND (effective_to IS NULL OR effective_to > NOW())
        ORDER BY severity DESC, rule_key ASC`,
      [target_stage]
    );

    return (res.rows ?? []).map((r: any) => ({
      id: r.id,
      rule_key: r.rule_key,
      target_stage: r.target_stage,
      required_doc_category: r.required_doc_category ?? null,
      required_fields: this.normaliseRequiredFields(r.required_fields),
      severity: r.severity,
      scope_global: !!r.scope_global,
      scope_panel_id: r.scope_panel_id ?? null,
      scope_insurer_id: r.scope_insurer_id ?? null,
      scope_procedure_code: r.scope_procedure_code ?? null,
      scope_diagnosis_class: r.scope_diagnosis_class ?? null,
      version: r.version ?? 1,
    }));
  }

  /**
   * Load every reviewed/extracted section for the claim with its category +
   * extracted_fields JSONB. We join through ipd_doc so we always see all
   * sections on the claim, regardless of upload batch. Sections without a
   * category yet are excluded (they can't satisfy a category-scoped check).
   */
  private async loadExtractedFields(claim_id: string): Promise<ExtractedFieldsRow[]> {
    const res = await this.pool.query(
      `SELECT ds.category, ds.extracted_fields
         FROM hospital.document_sections ds
         JOIN hospital.ipd_doc d ON d.id = ds.document_id
        WHERE d.ipd_id = $1
          AND ds.category IS NOT NULL`,
      [claim_id]
    );
    return (res.rows ?? []).map((r: any) => ({
      category: r.category,
      extracted_fields:
        r.extracted_fields && typeof r.extracted_fields === 'object'
          ? r.extracted_fields
          : null,
    }));
  }

  // ──────────────────────────────────────────────────────────────────────
  // Pure logic
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Scope cascade. A rule applies iff every scope dimension it declares
   * matches the claim's context. Global rules always apply.
   *
   * Note: scope is conjunctive within a rule (panel_id AND diagnosis_class
   * both must match if both are set). Disjunction across scopes is achieved
   * by authoring multiple rule rows sharing the same rule_key.
   */
  private ruleAppliesInScope(
    rule: StageRequirementRow,
    input: RuleEvaluationInput
  ): boolean {
    if (rule.scope_global) {
      // Global rules apply regardless of other scope fields. But if a global
      // rule also pins a panel/diagnosis, treat as additional gate.
      // Continue to per-dimension checks below.
    }

    if (
      rule.scope_panel_id &&
      rule.scope_panel_id !== input.dossier_snapshot.current_panel_id
    ) {
      return false;
    }
    if (
      rule.scope_insurer_id &&
      rule.scope_insurer_id !== input.dossier_snapshot.current_insurer_id
    ) {
      return false;
    }
    if (
      rule.scope_procedure_code &&
      rule.scope_procedure_code !== input.procedure_code
    ) {
      return false;
    }
    if (
      rule.scope_diagnosis_class &&
      rule.scope_diagnosis_class !== input.diagnosis_class
    ) {
      return false;
    }

    // If none of scope_global / panel / insurer / procedure / diagnosis are
    // set we'd have rejected the row at insert time via the CHECK constraint.
    // So at this point: either global=true OR at least one dimension matched.
    if (
      !rule.scope_global &&
      !rule.scope_panel_id &&
      !rule.scope_insurer_id &&
      !rule.scope_procedure_code &&
      !rule.scope_diagnosis_class
    ) {
      return false;
    }
    return true;
  }

  /**
   * Does the dossier satisfy the rule? A rule is satisfied when EVERY
   * declared expectation is met:
   *   - required_doc_category: at least one section of that category exists.
   *   - required_fields: at least one section in an allowed category has
   *     all listed field_keys present in extracted_fields.
   *
   * v1 semantics: required_fields is tolerant — "present" means the field
   * key exists and is non-empty. Type/format validation is out of scope.
   */
  private ruleSatisfied(
    rule: StageRequirementRow,
    input: RuleEvaluationInput,
    sectionFields: ExtractedFieldsRow[]
  ): boolean {
    if (rule.required_doc_category) {
      const sections =
        input.dossier_snapshot.doc_sections_by_category[rule.required_doc_category];
      if (!sections || sections.length === 0) return false;
    }

    if (Array.isArray(rule.required_fields) && rule.required_fields.length > 0) {
      const fieldsOk = rule.required_fields.every((spec) =>
        this.fieldSatisfied(spec, sectionFields)
      );
      if (!fieldsOk) return false;
    }

    return true;
  }

  private fieldSatisfied(
    spec: RequiredFieldSpec,
    sectionFields: ExtractedFieldsRow[]
  ): boolean {
    const allowed = Array.isArray(spec.allowed_categories) && spec.allowed_categories.length > 0
      ? new Set(spec.allowed_categories)
      : null;
    for (const sf of sectionFields) {
      if (allowed && !allowed.has(sf.category)) continue;
      const v = sf.extracted_fields?.[spec.field_key];
      if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) {
        return true;
      }
    }
    return false;
  }

  private buildMessage(rule: StageRequirementRow, passed: boolean): string {
    if (passed) {
      return `Rule ${rule.rule_key} satisfied`;
    }
    if (rule.required_doc_category && Array.isArray(rule.required_fields) && rule.required_fields.length > 0) {
      return `Rule ${rule.rule_key}: missing document '${rule.required_doc_category}' or required fields`;
    }
    if (rule.required_doc_category) {
      return `Rule ${rule.rule_key}: missing required document '${rule.required_doc_category}'`;
    }
    if (Array.isArray(rule.required_fields)) {
      const keys = rule.required_fields.map((f) => f.field_key).join(', ');
      return `Rule ${rule.rule_key}: missing required field(s) [${keys}]`;
    }
    return `Rule ${rule.rule_key} not satisfied`;
  }

  private normaliseRequiredFields(raw: any): RequiredFieldSpec[] | null {
    if (raw == null) return null;
    let value: any = raw;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(value)) return null;
    const out: RequiredFieldSpec[] = [];
    for (const item of value) {
      if (item && typeof item === 'object' && typeof item.field_key === 'string') {
        out.push({
          field_key: item.field_key,
          allowed_categories: Array.isArray(item.allowed_categories)
            ? item.allowed_categories.filter((s: any) => typeof s === 'string')
            : undefined,
        });
      }
    }
    return out;
  }
}

function clamp(min: number, max: number, n: number): number {
  return Math.max(min, Math.min(max, n));
}

export default new RulesEngine();
