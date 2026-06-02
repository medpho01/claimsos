// =============================================================================
// M7 — human-in-the-loop feedback on adjudication hypotheses.
//
// Reviewers record granular, per-layer feedback with root-cause attribution.
// Two read views: per-claim history, and a rule-override summary that surfaces
// which rules reviewers most often disagree with — the calibration signal for
// over-strict required-doc rules (the ~53% request_doc finding).
// =============================================================================

import { pool as defaultPool } from '../../DB/db.js';

export interface Queryable {
  query(text: string, params?: any[]): Promise<{ rows: any[] }>;
}

export type FeedbackLayer = 'documents' | 'content' | 'rules' | 'readiness';
export type Verdict = 'agree' | 'disagree' | 'correct';
export type RootCause = 'documents' | 'content' | 'rules' | 'context' | 'none';

export interface FeedbackInput {
  claimId: string;
  stage?: string | null;
  layer: FeedbackLayer;
  /** rule_id / doc category / field path the feedback is about. */
  targetRef?: string | null;
  verdict: Verdict;
  /** where the error actually originated (so corrections route correctly). */
  rootCause?: RootCause | null;
  correctedValue?: unknown;
  reviewerId?: string | null;
  notes?: string | null;
}

export async function recordFeedback(fb: FeedbackInput, db: Queryable = defaultPool): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO hospital.claim_hypothesis_feedback
       (claim_id, stage, layer, target_ref, verdict, root_cause, corrected_value, reviewer_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     RETURNING id`,
    [
      fb.claimId,
      fb.stage ?? '',
      fb.layer,
      fb.targetRef ?? null,
      fb.verdict,
      fb.rootCause ?? null,
      fb.correctedValue != null ? JSON.stringify(fb.correctedValue) : null,
      fb.reviewerId ?? null,
      fb.notes ?? null,
    ],
  );
  return rows[0].id as string;
}

export async function getFeedback(claimId: string, db: Queryable = defaultPool): Promise<any[]> {
  const { rows } = await db.query(
    `SELECT id, stage, layer, target_ref, verdict, root_cause, corrected_value, reviewer_id, notes, created_at
       FROM hospital.claim_hypothesis_feedback
      WHERE claim_id = $1
      ORDER BY created_at DESC`,
    [claimId],
  );
  return rows;
}

/**
 * Which rules reviewers most often disagree with — the rule-calibration signal.
 * A high disagreement rate on a rule == "this rule is probably over-strict /
 * wrong" and is the candidate for tuning or demotion.
 */
export async function ruleOverrideSummary(db: Queryable = defaultPool): Promise<any[]> {
  const { rows } = await db.query(
    `SELECT target_ref AS rule_id,
            count(*) FILTER (WHERE verdict = 'disagree') AS disagreements,
            count(*) AS total_feedback
       FROM hospital.claim_hypothesis_feedback
      WHERE layer = 'rules' AND target_ref IS NOT NULL
      GROUP BY target_ref
      HAVING count(*) FILTER (WHERE verdict = 'disagree') > 0
      ORDER BY disagreements DESC`,
  );
  return rows;
}
