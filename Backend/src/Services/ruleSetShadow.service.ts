/**
 * Shadow Lab — run a DRAFT rule pack against past claims before it goes live.
 *
 * This is the gate that makes handing the rule engine to a superadmin safe. A
 * rule authored through a form is a guess until it has met real data; this
 * turns the guess into a measurement, and it is free to run because the
 * deterministic evaluators make no model calls.
 *
 * WHAT IT ANSWERS
 *   - Is the readiness score sane across a cohort, or does everything score 20?
 *   - Which rules fire, and how often? A rule firing on 95% of claims is
 *     miscalibrated, not strict.
 *   - What CHANGES versus the pack currently live? That is the promotion
 *     decision, and it is invisible without a side-by-side.
 *
 * WHAT IT DOES NOT DO
 *   It never decides. `passed` records that the run completed, not that the
 *   numbers are acceptable. Encoding a threshold would invite someone to tune
 *   a draft until it cleared the threshold rather than until it was right.
 *
 * SEMANTIC RULES ARE SKIPPED ON PURPOSE. LLM_COHERENCE and EVIDENCE_CHECK make
 * billed calls; replaying them across a few hundred claims would cost real
 * money every time somebody tweaks a draft. They are counted and reported as
 * not-evaluated so the gap is visible rather than silently scored as passes.
 */

import { pool as defaultPool } from '../DB/db.js';
import type { Pool } from 'pg';
import { evaluateRules, summarizeReadiness } from './rules/engine.js';
import { SEMANTIC_KINDS } from './rules/types.js';
import type { Rule, RuleContext } from './rules/types.js';

export interface ShadowCohort {
  from?: string | null;
  to?: string | null;
  insurer_code?: string | null;
  hospital_id?: string | null;
  limit?: number;
}

export interface ShadowResults {
  claims_evaluated: number;
  semantic_rules_skipped: number;
  readiness_distribution: Record<string, number>;
  rule_fire_rates: Array<{ rule_id: string; fired: number; rate: number; severity: string }>;
  delta_vs_live: {
    live_rule_set_id: string | null;
    mean_readiness_draft: number | null;
    mean_readiness_live: number | null;
    newly_blocking: string[];
    no_longer_blocking: string[];
  };
  sample: Array<{ claim_id: string; readiness: number; blocking: string[] }>;
}

/** Cap a cohort so a careless "all claims" cannot run for minutes. */
const MAX_COHORT = 500;
const DEFAULT_COHORT = 100;

export class RuleSetShadowService {
  constructor(private readonly pool: Pool = defaultPool as Pool) {}

  /** Rows from insurance_rules mapped into the pure engine's Rule shape. */
  private async loadRules(ruleSetUuid: string): Promise<{ rules: Rule[]; semanticSkipped: number }> {
    const { rows } = await this.pool.query(
      `SELECT rule_id, kind, validation_logic, severity, impact, mandatory,
              min_confidence, failure_message
         FROM hospital.insurance_rules
        WHERE rule_set_id = $1 AND enabled = true
        ORDER BY order_index, rule_id`,
      [ruleSetUuid],
    );

    let semanticSkipped = 0;
    const rules: Rule[] = [];
    for (const r of rows as any[]) {
      // A legacy row with no `kind` predates the evaluator registry and the
      // pure engine cannot dispatch it. Counted with the semantic skips so the
      // report never implies more coverage than it has.
      if (!r.kind || SEMANTIC_KINDS.has(r.kind)) {
        semanticSkipped += 1;
        continue;
      }
      rules.push({
        ruleId: r.rule_id,
        kind: r.kind,
        params: (r.validation_logic ?? {}) as Record<string, unknown>,
        severity: r.severity,
        impact: r.impact,
        mandatory: r.mandatory,
        minConfidence: r.min_confidence == null ? undefined : Number(r.min_confidence),
        failureMessage: r.failure_message ?? undefined,
      });
    }
    return { rules, semanticSkipped };
  }

  /**
   * Build a rule context from a stored harmonised episode.
   *
   * Reads only persisted facts — no extraction, no model call. That is what
   * makes a shadow run free and repeatable.
   */
  private buildContext(episode: any, sections: any[]): RuleContext {
    const fieldsByCategory: Record<string, Record<string, unknown>> = {};
    const presentCategories: string[] = [];
    const names: Array<{ value: string; sourceDocType: string }> = [];
    const datedDocs: Array<{ docType: string; date: string | null }> = [];

    for (const s of sections) {
      if (!s.category) continue;
      presentCategories.push(s.category);
      const f = (s.extracted_fields ?? {}) as Record<string, unknown>;
      fieldsByCategory[s.category] = f;

      for (const key of ['patient_name', 'full_name', 'holder_name', 'name', 'beneficiary_name']) {
        const v = f[key];
        if (typeof v === 'string' && v.trim()) {
          names.push({ value: v.trim(), sourceDocType: s.category });
          break;
        }
      }
      const date = (f.bill_date ?? f.document_date ?? f.consultation_date ?? null) as string | null;
      datedDocs.push({ docType: s.category, date });
    }

    return {
      stage: episode?.claim_stage ?? null,
      presentCategories: [...new Set(presentCategories)],
      fieldsByCategory,
      names,
      datedDocs,
      anchors: {
        admission: episode?.admission_date ?? null,
        discharge: episode?.discharge_date ?? null,
      },
    };
  }

  /** Claims in the cohort that have a harmonised episode to evaluate. */
  private async selectCohort(cohort: ShadowCohort) {
    const limit = Math.min(cohort.limit ?? DEFAULT_COHORT, MAX_COHORT);
    const params: unknown[] = [];
    const where: string[] = ['e.episode IS NOT NULL'];

    if (cohort.from) { params.push(cohort.from); where.push(`i.created_at >= $${params.length}`); }
    if (cohort.to) { params.push(cohort.to); where.push(`i.created_at <= $${params.length}`); }
    if (cohort.hospital_id) { params.push(cohort.hospital_id); where.push(`i.hospital_id = $${params.length}`); }

    params.push(limit);
    const { rows } = await this.pool.query(
      `SELECT i.id AS claim_id, i.stage AS claim_stage,
              i.admission_date, i.discharge_date
         FROM hospital.ipds i
         JOIN hospital.claim_harmonised_episodes e ON e.claim_id = i.id
        WHERE ${where.join(' AND ')}
        ORDER BY i.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows as any[];
  }

  private async sectionsFor(claimId: string) {
    const { rows } = await this.pool.query(
      `SELECT category, extracted_fields
         FROM hospital.document_sections
        WHERE claim_id = $1`,
      [claimId],
    );
    return rows as any[];
  }

  /**
   * Run a draft over a cohort and record the result.
   *
   * Always writes a row, success or failure — a run that errored is itself
   * information, and silently discarding it would let someone retry until the
   * error went away without anyone noticing it had happened.
   */
  async run(ruleSetId: string, cohort: ShadowCohort, runBy?: string) {
    const { rows: setRows } = await this.pool.query(
      'SELECT * FROM hospital.insurer_rule_sets WHERE rule_set_id = $1',
      [ruleSetId],
    );
    const set = setRows[0];
    if (!set) throw new Error(`unknown rule set: ${ruleSetId}`);

    const { rows: runRows } = await this.pool.query(
      `INSERT INTO hospital.rule_set_shadow_runs
         (rule_set_id, tested_version, cohort, run_by)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [ruleSetId, set.version, JSON.stringify(cohort), runBy ?? null],
    );
    const runId = runRows[0].id;

    try {
      const { rules, semanticSkipped } = await this.loadRules(set.id);
      const claims = await this.selectCohort(cohort);

      const liveSet = await this.findLiveCounterpart(set);
      const liveRules = liveSet ? (await this.loadRules(liveSet.id)).rules : [];

      const buckets: Record<string, number> = { '0-24': 0, '25-49': 0, '50-74': 0, '75-89': 0, '90-100': 0 };
      const fired: Record<string, { fired: number; severity: string }> = {};
      const sample: ShadowResults['sample'] = [];
      let draftTotal = 0;
      let liveTotal = 0;
      const draftBlocking = new Set<string>();
      const liveBlocking = new Set<string>();

      for (const claim of claims) {
        const sections = await this.sectionsFor(claim.claim_id);
        const ctx = this.buildContext(claim, sections);

        const results = evaluateRules(rules, ctx);
        const readiness = summarizeReadiness(results);
        draftTotal += readiness.score;

        const bucket =
          readiness.score < 25 ? '0-24' :
          readiness.score < 50 ? '25-49' :
          readiness.score < 75 ? '50-74' :
          readiness.score < 90 ? '75-89' : '90-100';
        buckets[bucket] += 1;

        for (const r of results) {
          if (r.status !== 'FAIL') continue;
          fired[r.ruleId] ??= { fired: 0, severity: r.severity };
          fired[r.ruleId].fired += 1;
        }
        readiness.blocking.forEach((id) => draftBlocking.add(id));

        if (liveRules.length) {
          const liveRes = evaluateRules(liveRules, ctx);
          const liveReadiness = summarizeReadiness(liveRes);
          liveTotal += liveReadiness.score;
          liveReadiness.blocking.forEach((id) => liveBlocking.add(id));
        }

        if (sample.length < 20) {
          sample.push({ claim_id: claim.claim_id, readiness: readiness.score, blocking: readiness.blocking });
        }
      }

      const n = claims.length;
      const results: ShadowResults = {
        claims_evaluated: n,
        semantic_rules_skipped: semanticSkipped,
        readiness_distribution: buckets,
        rule_fire_rates: Object.entries(fired)
          .map(([rule_id, v]) => ({
            rule_id, fired: v.fired, severity: v.severity,
            rate: n ? Math.round((v.fired / n) * 100) / 100 : 0,
          }))
          .sort((a, b) => b.fired - a.fired),
        delta_vs_live: {
          live_rule_set_id: liveSet?.rule_set_id ?? null,
          mean_readiness_draft: n ? Math.round(draftTotal / n) : null,
          mean_readiness_live: liveRules.length && n ? Math.round(liveTotal / n) : null,
          newly_blocking: [...draftBlocking].filter((id) => !liveBlocking.has(id)),
          no_longer_blocking: [...liveBlocking].filter((id) => !draftBlocking.has(id)),
        },
        sample,
      };

      await this.pool.query(
        `UPDATE hospital.rule_set_shadow_runs
            SET claims_evaluated = $2, results = $3, passed = TRUE, finished_at = NOW()
          WHERE id = $1`,
        [runId, n, JSON.stringify(results)],
      );

      // Only a COMPLETED run arms the promotion gate, and any later edit
      // clears it again (see ruleSetAuthoring.invalidateShadow).
      await this.pool.query(
        'UPDATE hospital.insurer_rule_sets SET last_shadow_run_id = $2 WHERE rule_set_id = $1',
        [ruleSetId, runId],
      );

      return { run_id: runId, ...results };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.pool.query(
        `UPDATE hospital.rule_set_shadow_runs
            SET error = $2, passed = FALSE, finished_at = NOW() WHERE id = $1`,
        [runId, message],
      );
      throw err;
    }
  }

  /** The live pack this draft would replace, for the side-by-side. */
  private async findLiveCounterpart(set: any) {
    const lineage = set.cloned_from ?? set.rule_set_id;
    const { rows } = await this.pool.query(
      `SELECT * FROM hospital.insurer_rule_sets
        WHERE status = 'live'
          AND COALESCE(cloned_from, rule_set_id) = COALESCE($1::varchar, rule_set_id)
          AND rule_set_id <> $2
        LIMIT 1`,
      [lineage, set.rule_set_id],
    );
    return rows[0] ?? null;
  }

  async history(ruleSetId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, tested_version, cohort, claims_evaluated, passed, error,
              results, run_by, started_at, finished_at
         FROM hospital.rule_set_shadow_runs
        WHERE rule_set_id = $1 ORDER BY started_at DESC LIMIT 20`,
      [ruleSetId],
    );
    return rows;
  }
}

export default new RuleSetShadowService();
