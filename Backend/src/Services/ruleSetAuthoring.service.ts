/**
 * Rule set authoring — the write side of the rules engine.
 *
 * `rulesV2.controller` already reads insurer_rule_sets; this owns the edits a
 * Finclarity superadmin makes through the UI, and the guard rails that make
 * delegating them safe.
 *
 * THE THREE RULES
 *
 * 1. A LIVE set is never edited in place. Clone → edit the draft → shadow →
 *    promote. Editing live would change how every in-flight claim is judged
 *    mid-flight, with no diff and nothing to revert to.
 *
 * 2. Promotion requires a PASSED shadow run that POSTDATES the last edit. Not
 *    advisory. A rule authored blind is a guess, and the cost of a wrong guess
 *    is a claim held while the 3-hour discharge clock runs.
 *
 * 3. Every promotion snapshots the whole pack. The snapshot is JSONB, not
 *    foreign keys, so it reproduces exactly what was live — including rows
 *    since deleted.
 */

import { pool as defaultPool } from '../DB/db.js';
import type { Pool } from 'pg';

export type RuleSetStatus = 'draft' | 'live' | 'deprecated';

export interface RuleSetSummary {
  id: string;
  rule_set_id: string;
  rule_set_name: string;
  version: string;
  status: RuleSetStatus;
  insurer_code: string | null;
  applicable_schemes: string[];
  applicable_routes: string[];
  applicable_stages: string[];
  applicable_case_types: string[];
  applicable_treatments: string[];
  applicable_specialties: string[];
  rule_count: number;
  updated_at: string;
  last_shadow_run_id: string | null;
  cloned_from: string | null;
}

/** Kinds the pure engine dispatches on. Mirrors Services/rules/types.ts —
 *  which is the frozen registry (FROZEN_CONTRACTS OD4), so this list must not
 *  drift from it. */
export const RULE_KINDS = [
  'DOCUMENT_PRESENCE',
  'REQUIRED_FIELDS',
  'FUZZY_NAME',
  'TEMPORAL_WINDOW',
  'LLM_COHERENCE',
  'EVIDENCE_CHECK',
] as const;

/** Kinds that make a billed model call. Surfaced so the editor can warn. */
export const SEMANTIC_KINDS = new Set(['LLM_COHERENCE', 'EVIDENCE_CHECK']);

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const CATEGORIES = [
  'POLICY_ELIGIBILITY', 'DOCUMENT_COMPLETENESS', 'CLINICAL_APPROPRIATENESS',
  'FINANCIAL_LIMITS', 'PROCEDURAL_COMPLIANCE', 'TEMPORAL_VALIDITY',
];
const IMPACTS = ['CLAIM_REJECTION', 'DEDUCTION', 'QUERY', 'WARNING', 'INFO'];

export class RuleSetAuthoringService {
  constructor(private readonly pool: Pool = defaultPool as Pool) {}

  async list(filter: { status?: RuleSetStatus; insurer?: string } = {}): Promise<RuleSetSummary[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.status) { params.push(filter.status); where.push(`s.status = $${params.length}`); }
    if (filter.insurer) { params.push(filter.insurer); where.push(`s.insurer_code = $${params.length}`); }

    const { rows } = await this.pool.query(
      `SELECT s.*, COALESCE(r.n, 0)::int AS rule_count
         FROM hospital.insurer_rule_sets s
         LEFT JOIN (
           SELECT rule_set_id, count(*) AS n
             FROM hospital.insurance_rules GROUP BY rule_set_id
         ) r ON r.rule_set_id = s.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY s.status, s.rule_set_name`,
      params,
    );
    return rows as RuleSetSummary[];
  }

  async get(ruleSetId: string): Promise<any | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM hospital.insurer_rule_sets WHERE rule_set_id = $1',
      [ruleSetId],
    );
    if (!rows[0]) return null;
    const set = rows[0];

    const [rules, docs, limits, los] = await Promise.all([
      this.pool.query(
        'SELECT * FROM hospital.insurance_rules WHERE rule_set_id = $1 ORDER BY order_index, rule_id',
        [set.id],
      ),
      this.pool.query(
        'SELECT * FROM hospital.insurer_document_requirements WHERE rule_set_id = $1 ORDER BY document_type',
        [set.id],
      ),
      this.pool.query(
        'SELECT * FROM hospital.insurer_financial_limits WHERE rule_set_id = $1 ORDER BY limit_kind',
        [set.id],
      ),
      this.pool.query(
        'SELECT * FROM hospital.insurer_los_benchmarks WHERE rule_set_id = $1 ORDER BY procedure_code',
        [set.id],
      ),
    ]);

    return {
      ...set,
      rules: rules.rows,
      document_requirements: docs.rows,
      financial_limits: limits.rows,
      los_benchmarks: los.rows,
    };
  }

  /**
   * Clone a pack into a new draft. The main authoring path: starting from a
   * working pack beats a blank form, and it keeps the live one untouched.
   */
  async clone(sourceRuleSetId: string, newRuleSetId: string, newName: string, by?: string) {
    const source = await this.get(sourceRuleSetId);
    if (!source) throw new Error(`unknown rule set: ${sourceRuleSetId}`);

    const client = await (this.pool as any).connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO hospital.insurer_rule_sets
           (rule_set_id, rule_set_name, version, insurer_code,
            applicable_treatments, applicable_specialties,
            applicable_schemes, applicable_routes, applicable_stages, applicable_case_types,
            status, created_by, updated_by, cloned_from)
         VALUES ($1,$2,'1.0',$3,$4,$5,$6,$7,$8,$9,'draft',$10,$10,$11)
         RETURNING *`,
        [
          newRuleSetId, newName, source.insurer_code,
          source.applicable_treatments, source.applicable_specialties,
          source.applicable_schemes, source.applicable_routes,
          source.applicable_stages, source.applicable_case_types,
          by ?? null, sourceRuleSetId,
        ],
      );
      const newSet = rows[0];

      // Copy children. Explicit column lists rather than SELECT *: a new column
      // on the source table would otherwise be copied blindly, including one
      // that should not be (an id, a timestamp, a provenance field).
      await client.query(
        `INSERT INTO hospital.insurance_rules
           (rule_set_id, rule_id, rule_name, rule_description, category, severity,
            impact, enabled, mandatory, validation_logic, failure_message,
            remediation_guidance, required_documents, estimated_deduction_amount,
            query_template, order_index, kind, min_confidence)
         SELECT $1, rule_id, rule_name, rule_description, category, severity,
                impact, enabled, mandatory, validation_logic, failure_message,
                remediation_guidance, required_documents, estimated_deduction_amount,
                query_template, order_index, kind, min_confidence
           FROM hospital.insurance_rules WHERE rule_set_id = $2`,
        [newSet.id, source.id],
      );
      await client.query(
        `INSERT INTO hospital.insurer_document_requirements
           (rule_set_id, document_type, required_when, mandatory, quality_requirements, stage)
         SELECT $1, document_type, required_when, mandatory, quality_requirements, stage
           FROM hospital.insurer_document_requirements WHERE rule_set_id = $2`,
        [newSet.id, source.id],
      );
      await client.query(
        `INSERT INTO hospital.insurer_financial_limits (rule_set_id, limit_kind, config)
         SELECT $1, limit_kind, config
           FROM hospital.insurer_financial_limits WHERE rule_set_id = $2`,
        [newSet.id, source.id],
      );

      await client.query('COMMIT');
      return newSet;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private assertDraft(set: any) {
    if (set.status === 'live') {
      throw new Error(
        'a live rule set cannot be edited in place — clone it, edit the draft, shadow-run it, then promote',
      );
    }
  }

  /** Update the set's own fields (scope, name). Draft only. */
  async updateSet(ruleSetId: string, patch: Record<string, unknown>, by?: string) {
    const set = await this.get(ruleSetId);
    if (!set) throw new Error(`unknown rule set: ${ruleSetId}`);
    this.assertDraft(set);

    const allowed = [
      'rule_set_name', 'insurer_code', 'effective_from', 'effective_till',
      'applicable_treatments', 'applicable_specialties',
      'applicable_schemes', 'applicable_routes', 'applicable_stages', 'applicable_case_types',
    ];
    const sets: string[] = [];
    const params: unknown[] = [ruleSetId];
    for (const key of allowed) {
      if (!(key in patch)) continue;
      params.push(patch[key]);
      sets.push(`${key} = $${params.length}`);
    }
    if (!sets.length) return set;
    params.push(by ?? null);
    sets.push(`updated_by = $${params.length}`);
    sets.push('updated_at = NOW()');

    // Any edit invalidates a prior shadow run: the thing that was tested no
    // longer exists. Clearing it here is what makes the promotion gate honest.
    sets.push('last_shadow_run_id = NULL');

    const { rows } = await this.pool.query(
      `UPDATE hospital.insurer_rule_sets SET ${sets.join(', ')}
        WHERE rule_set_id = $1 RETURNING *`,
      params,
    );
    return rows[0];
  }

  /** Create or update one rule inside a draft pack. */
  async upsertRule(ruleSetId: string, rule: Record<string, any>, by?: string) {
    const set = await this.get(ruleSetId);
    if (!set) throw new Error(`unknown rule set: ${ruleSetId}`);
    this.assertDraft(set);

    if (!rule.rule_id || !rule.rule_name) {
      throw new Error('rule_id and rule_name are required');
    }
    if (rule.kind && !RULE_KINDS.includes(rule.kind)) {
      throw new Error(`unknown rule kind: ${rule.kind} (allowed: ${RULE_KINDS.join(', ')})`);
    }
    if (rule.severity && !SEVERITIES.includes(rule.severity)) {
      throw new Error(`unknown severity: ${rule.severity}`);
    }
    if (rule.category && !CATEGORIES.includes(rule.category)) {
      throw new Error(`unknown category: ${rule.category}`);
    }
    if (rule.impact && !IMPACTS.includes(rule.impact)) {
      throw new Error(`unknown impact: ${rule.impact}`);
    }
    if (rule.min_confidence != null) {
      const c = Number(rule.min_confidence);
      if (!(c >= 0 && c <= 1)) throw new Error('min_confidence must be between 0 and 1');
    }

    const { rows } = await this.pool.query(
      `INSERT INTO hospital.insurance_rules
         (rule_set_id, rule_id, rule_name, rule_description, category, severity,
          impact, enabled, mandatory, validation_logic, failure_message,
          remediation_guidance, required_documents, order_index, kind, min_confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (rule_set_id, rule_id) DO UPDATE SET
         rule_name = EXCLUDED.rule_name,
         rule_description = EXCLUDED.rule_description,
         category = EXCLUDED.category,
         severity = EXCLUDED.severity,
         impact = EXCLUDED.impact,
         enabled = EXCLUDED.enabled,
         mandatory = EXCLUDED.mandatory,
         validation_logic = EXCLUDED.validation_logic,
         failure_message = EXCLUDED.failure_message,
         remediation_guidance = EXCLUDED.remediation_guidance,
         required_documents = EXCLUDED.required_documents,
         order_index = EXCLUDED.order_index,
         kind = EXCLUDED.kind,
         min_confidence = EXCLUDED.min_confidence
       RETURNING *`,
      [
        set.id, rule.rule_id, rule.rule_name, rule.rule_description ?? null,
        rule.category ?? 'DOCUMENT_COMPLETENESS', rule.severity ?? 'MEDIUM',
        rule.impact ?? 'QUERY', rule.enabled !== false, rule.mandatory === true,
        JSON.stringify(rule.validation_logic ?? rule.params ?? {}),
        rule.failure_message ?? null, rule.remediation_guidance ?? null,
        rule.required_documents ?? [], rule.order_index ?? 999,
        rule.kind ?? null, rule.min_confidence ?? null,
      ],
    );

    await this.invalidateShadow(ruleSetId, by);
    return rows[0];
  }

  async deleteRule(ruleSetId: string, ruleId: string, by?: string) {
    const set = await this.get(ruleSetId);
    if (!set) throw new Error(`unknown rule set: ${ruleSetId}`);
    this.assertDraft(set);
    await this.pool.query(
      'DELETE FROM hospital.insurance_rules WHERE rule_set_id = $1 AND rule_id = $2',
      [set.id, ruleId],
    );
    await this.invalidateShadow(ruleSetId, by);
  }

  /** Any content change makes a prior shadow run meaningless. */
  private async invalidateShadow(ruleSetId: string, by?: string) {
    await this.pool.query(
      `UPDATE hospital.insurer_rule_sets
          SET last_shadow_run_id = NULL, updated_at = NOW(), updated_by = COALESCE($2, updated_by)
        WHERE rule_set_id = $1`,
      [ruleSetId, by ?? null],
    );
  }

  /**
   * Promote a draft to live.
   *
   * The gate: a passed shadow run that POSTDATES the last edit. Editing clears
   * `last_shadow_run_id`, so "shadow, then edit, then promote" cannot slip
   * through — which is the loophole a plain boolean flag would leave open.
   */
  async promote(ruleSetId: string, changeNote: string, by?: string) {
    const set = await this.get(ruleSetId);
    if (!set) throw new Error(`unknown rule set: ${ruleSetId}`);
    if (set.status === 'live') throw new Error('rule set is already live');
    if (!changeNote?.trim()) {
      throw new Error('a change note is required — "why does this claim have a hold?" must be answerable later');
    }
    if (!set.last_shadow_run_id) {
      throw new Error(
        'this draft has not been shadow-run since it was last edited. Run it against past claims before promoting.',
      );
    }

    const client = await (this.pool as any).connect();
    try {
      await client.query('BEGIN');

      // Supersede the current live pack for the same rule_set_id lineage.
      await client.query(
        `UPDATE hospital.insurer_rule_sets SET status = 'deprecated', updated_at = NOW()
          WHERE status = 'live' AND rule_set_id <> $1
            AND COALESCE(cloned_from, rule_set_id) = COALESCE($2::varchar, $1)`,
        [ruleSetId, set.cloned_from],
      );

      const { rows } = await client.query(
        `UPDATE hospital.insurer_rule_sets
            SET status = 'live', updated_at = NOW(), updated_by = $2
          WHERE rule_set_id = $1 RETURNING *`,
        [ruleSetId, by ?? null],
      );

      const snapshot = await this.get(ruleSetId);
      await client.query(
        `INSERT INTO hospital.insurer_rule_set_versions
           (rule_set_id, version, snapshot, change_note, changed_by, shadow_run_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (rule_set_id, version) DO NOTHING`,
        [ruleSetId, set.version, JSON.stringify(snapshot), changeNote.trim(), by ?? null, set.last_shadow_run_id],
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async versions(ruleSetId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, rule_set_id, version, change_note, changed_by, shadow_run_id, created_at
         FROM hospital.insurer_rule_set_versions
        WHERE rule_set_id = $1 ORDER BY created_at DESC`,
      [ruleSetId],
    );
    return rows;
  }
}

export default new RuleSetAuthoringService();
