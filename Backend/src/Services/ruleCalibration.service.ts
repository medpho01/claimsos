/**
 * Rule calibration — the learning loop.
 *
 * Joins what each rule DID (claim_rule_evaluations) to what reviewers SAID
 * about it (claim_hypothesis_feedback, migration 070) and reports the one
 * number that decides a rule's fate:
 *
 *     this rule fires on 60% of claims, and reviewers disagree 80% of the time
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * A readiness score is only useful while people believe it. An over-strict
 * rule does not announce itself — it quietly produces findings reviewers learn
 * to dismiss, and within a few weeks the whole panel is being scrolled past,
 * including the findings that were right. By then the product has failed
 * silently and nobody filed a bug.
 *
 * So disagreement is treated as a first-class signal rather than noise, and
 * migration 070's per-layer `root_cause` is what makes it actionable: it
 * separates "the extraction was wrong" (fix the model) from "the rule is
 * wrong" (fix the rule) from "the context was wrong" (fix the resolver). A
 * bare thumbs-down cannot tell you which, so it cannot tell you what to do.
 */

import { pool as defaultPool } from '../DB/db.js';
import type { Pool } from 'pg';

export interface RuleCalibration {
  rule_id: string;
  rule_name: string | null;
  severity: string | null;
  rule_set_id: string | null;
  evaluated: number;
  fired: number;
  fire_rate: number;
  feedback_count: number;
  agreed: number;
  disagreed: number;
  /** null when nobody has reviewed it — NOT zero. See the note below. */
  agreement_rate: number | null;
  root_causes: Record<string, number>;
  verdict: 'healthy' | 'over_strict' | 'never_fires' | 'unreviewed' | 'watch';
}

/** A rule firing on almost everything is miscalibrated, not strict. */
const OVER_FIRING = 0.9;
/** Below this, reviewers are overruling the rule more often than not. */
const POOR_AGREEMENT = 0.5;
/** Too few reviews to draw any conclusion from. */
const MIN_FEEDBACK = 5;

export class RuleCalibrationService {
  constructor(private readonly pool: Pool = defaultPool as Pool) {}

  /**
   * Per-rule behaviour over a window.
   *
   * LEFT JOIN from evaluations to feedback: a rule nobody has reviewed must
   * still appear, flagged `unreviewed`. Dropping it would hide exactly the
   * rules that most need looking at.
   */
  async calibration(days = 90): Promise<RuleCalibration[]> {
    const { rows } = await this.pool.query(
      `WITH evals AS (
         SELECT e.rule_id,
                e.rule_set_id,
                count(*)::int                                    AS evaluated,
                count(*) FILTER (WHERE e.status = 'FAIL')::int    AS fired,
                max(e.severity)                                   AS severity
           FROM hospital.claim_rule_evaluations e
          WHERE e.evaluated_at >= NOW() - ($1 || ' days')::interval
          GROUP BY e.rule_id, e.rule_set_id
       ),
       fb AS (
         -- Feedback on the RULES layer only; target_ref carries the rule_id
         -- (migration 070 indexes it exactly this way).
         SELECT f.target_ref                                        AS rule_id,
                count(*)::int                                       AS feedback_count,
                count(*) FILTER (WHERE f.verdict = 'agree')::int     AS agreed,
                count(*) FILTER (WHERE f.verdict <> 'agree')::int    AS disagreed,
                jsonb_object_agg(COALESCE(f.root_cause, 'unspecified'), c)
                  FILTER (WHERE f.root_cause IS NOT NULL)            AS root_causes
           FROM (
             SELECT target_ref, verdict, root_cause, count(*) OVER (
                      PARTITION BY target_ref, root_cause) AS c
               FROM hospital.claim_hypothesis_feedback
              WHERE layer = 'rules'
                AND created_at >= NOW() - ($1 || ' days')::interval
                AND target_ref IS NOT NULL
           ) f
          GROUP BY f.target_ref
       )
       SELECT e.rule_id,
              r.rule_name,
              e.severity,
              s.rule_set_id                                   AS rule_set_id,
              e.evaluated, e.fired,
              COALESCE(fb.feedback_count, 0)                  AS feedback_count,
              COALESCE(fb.agreed, 0)                          AS agreed,
              COALESCE(fb.disagreed, 0)                       AS disagreed,
              COALESCE(fb.root_causes, '{}'::jsonb)           AS root_causes
         FROM evals e
         LEFT JOIN fb ON fb.rule_id = e.rule_id
         LEFT JOIN hospital.insurance_rules r
                ON r.rule_set_id = e.rule_set_id AND r.rule_id = e.rule_id
         LEFT JOIN hospital.insurer_rule_sets s ON s.id = e.rule_set_id
        ORDER BY e.fired DESC, e.evaluated DESC`,
      [String(days)],
    );

    return (rows as any[]).map((r) => {
      const evaluated = Number(r.evaluated) || 0;
      const fired = Number(r.fired) || 0;
      const feedback = Number(r.feedback_count) || 0;
      const agreed = Number(r.agreed) || 0;

      const fireRate = evaluated ? fired / evaluated : 0;
      // null, not 0. Zero would sort an unreviewed rule alongside one every
      // reviewer has rejected, which is the opposite of the truth.
      const agreementRate = feedback ? agreed / feedback : null;

      let verdict: RuleCalibration['verdict'] = 'healthy';
      if (feedback >= MIN_FEEDBACK && agreementRate !== null && agreementRate < POOR_AGREEMENT) {
        verdict = 'over_strict';
      } else if (evaluated > 0 && fired === 0) {
        verdict = 'never_fires';
      } else if (fireRate >= OVER_FIRING && evaluated >= MIN_FEEDBACK) {
        verdict = 'watch';
      } else if (feedback === 0) {
        verdict = 'unreviewed';
      }

      return {
        rule_id: r.rule_id,
        rule_name: r.rule_name ?? null,
        severity: r.severity ?? null,
        rule_set_id: r.rule_set_id ?? null,
        evaluated,
        fired,
        fire_rate: Math.round(fireRate * 100) / 100,
        feedback_count: feedback,
        agreed,
        disagreed: Number(r.disagreed) || 0,
        agreement_rate: agreementRate === null ? null : Math.round(agreementRate * 100) / 100,
        root_causes: r.root_causes ?? {},
        verdict,
      };
    });
  }

  /**
   * Where the errors actually originate, across all feedback.
   *
   * This is the number that decides where engineering effort goes: if most
   * disagreement roots in `content`, the extraction needs work and no amount
   * of rule tuning helps. If it roots in `rules`, the opposite.
   */
  async rootCauseSummary(days = 90) {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(root_cause, 'unspecified') AS root_cause,
              layer,
              count(*)::int AS n
         FROM hospital.claim_hypothesis_feedback
        WHERE created_at >= NOW() - ($1 || ' days')::interval
          AND verdict <> 'agree'
        GROUP BY 1, 2
        ORDER BY n DESC`,
      [String(days)],
    );
    return rows;
  }

  /** Recent disagreements, so a rule's verdict can be spot-checked. */
  async recentDisagreements(ruleId?: string, limit = 25) {
    const params: unknown[] = [];
    let where = "layer = 'rules' AND verdict <> 'agree'";
    if (ruleId) { params.push(ruleId); where += ` AND target_ref = $${params.length}`; }
    params.push(Math.min(limit, 100));

    const { rows } = await this.pool.query(
      `SELECT claim_id, stage, target_ref AS rule_id, verdict, root_cause, notes, created_at
         FROM hospital.claim_hypothesis_feedback
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  }
}

export default new RuleCalibrationService();
