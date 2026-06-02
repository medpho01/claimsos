/**
 * Stage-aware Adjudication Controller (M7 part 2).
 * Distinct from the legacy Wave-3B `adjudication.controller` (different engine).
 *
 *   GET  /api/v1/claims/:claimId/stage-adjudication            latest hypotheses (or ?run=true)
 *   POST /api/v1/claims/:claimId/stage-adjudication/evaluate   run the stage-aware adjudicator
 *   POST /api/v1/claims/:claimId/stage-adjudication/feedback   record reviewer feedback (HITL)
 *   GET  /api/v1/claims/:claimId/stage-adjudication/feedback   feedback history for a claim
 *   GET  /api/v1/stage-adjudication/feedback-summary           rule-override (calibration) signal
 */

import type { Request, Response } from 'express';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import { adjudicateClaim, getClaimReview } from '../Services/adjudication/stageAwareAdjudicator.service.js';
import {
  recordFeedback,
  getFeedback,
  ruleOverrideSummary,
  type FeedbackLayer,
  type Verdict,
  type RootCause,
} from '../Services/adjudication/feedback.service.js';

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const getAdjudication = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    if (!claimId) return res.status(400).json({ success: false, error: 'claimId required' });
    if (req.query.run === 'true' || req.query.run === '1') {
      const result = await adjudicateClaim(claimId);
      return res.json({ success: true, data: { ...result, source: 'fresh' } });
    }
    const { rows } = await pool.query(
      `SELECT stage, layer1_documents, layer2_content, layer3_rules, layer4_readiness, resolver_version, updated_at
         FROM hospital.claim_hypothesis
        WHERE claim_id = $1
        ORDER BY updated_at DESC`,
      [claimId],
    );
    return res.json({ success: true, data: { hypotheses: rows, source: 'persisted' } });
  } catch (err) {
    logger?.error?.('[stageAdjudication.getAdjudication] ' + msg(err));
    return res.status(500).json({ success: false, error: 'failed to get adjudication' });
  }
};

export const evaluate = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    if (!claimId) return res.status(400).json({ success: false, error: 'claimId required' });
    const result = await adjudicateClaim(claimId);
    return res.json({ success: true, data: result });
  } catch (err) {
    logger?.error?.('[stageAdjudication.evaluate] ' + msg(err));
    return res.status(500).json({ success: false, error: 'failed to evaluate adjudication' });
  }
};

export const postFeedback = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!claimId || !b.layer || !b.verdict) {
      return res.status(400).json({ success: false, error: 'claimId, layer and verdict are required' });
    }
    const id = await recordFeedback({
      claimId,
      stage: (b.stage as string) ?? null,
      layer: b.layer as FeedbackLayer,
      targetRef: (b.targetRef as string) ?? null,
      verdict: b.verdict as Verdict,
      rootCause: (b.rootCause as RootCause) ?? null,
      correctedValue: b.correctedValue,
      reviewerId: ((req as any).user?.id as string) ?? (b.reviewerId as string) ?? null,
      notes: (b.notes as string) ?? null,
    });
    return res.json({ success: true, data: { id } });
  } catch (err) {
    logger?.error?.('[stageAdjudication.postFeedback] ' + msg(err));
    return res.status(500).json({ success: false, error: 'failed to record feedback' });
  }
};

export const getFeedbackForClaim = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    if (!claimId) return res.status(400).json({ success: false, error: 'claimId required' });
    return res.json({ success: true, data: await getFeedback(claimId) });
  } catch (err) {
    logger?.error?.('[stageAdjudication.getFeedbackForClaim] ' + msg(err));
    return res.status(500).json({ success: false, error: 'failed to get feedback' });
  }
};

export const getFeedbackSummary = async (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await ruleOverrideSummary() });
  } catch (err) {
    logger?.error?.('[stageAdjudication.getFeedbackSummary] ' + msg(err));
    return res.status(500).json({ success: false, error: 'failed to get feedback summary' });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/claims/:claimId/stage-adjudication/review
// Returns everything a reviewer needs in one payload:
//   - resolved context (stage, scheme, insurer, case_type)
//   - harmonised episode (the structured medical output)
//   - per-document extracted content
//   - adjudication hypotheses + per-rule outcomes
//   - all feedback recorded so far
// ────────────────────────────────────────────────────────────────────────────
export const getReview = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    if (!claimId) return res.status(400).json({ success: false, error: 'claimId required' });
    const data = await getClaimReview(claimId);
    return res.json({ success: true, data });
  } catch (err) {
    logger?.error?.('[stageAdjudication.getReview] ' + msg(err));
    return res.status(500).json({ success: false, error: 'failed to get claim review' });
  }
};
