import { Request, Response } from 'express';

import adjudicationEngine from '../Services/adjudicationEngine.service.js';
import { enqueueAdjudication } from '../Workers/adjudicationEngine.queue.js';
import { logger } from '../Utils/logger.js';

/**
 * Adjudication Controller — Sprint 3, Wave 3B
 *
 *   GET    /api/claims/:id/adjudication          → latest report
 *   GET    /api/claims/:id/adjudication/history  → ordered history
 *   POST   /api/claims/:id/adjudication/run      → run synchronously
 *
 * The POST route runs the engine inline (force/no-force depending on body)
 * rather than enqueueing — the typical caller is a human in the cockpit who
 * wants a fresh opinion *right now* and can wait the few hundred ms the
 * rules engine takes. For background batch re-evaluations, callers use
 * enqueueAdjudication directly.
 *
 * Errors follow the existing controller pattern (success + data | error +
 * status). "no dossier" is mapped to 404.
 */

/** GET /api/claims/:id/adjudication */
export const getLatestAdjudication = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.id;
    if (!claimId) {
      return res
        .status(400)
        .json({ success: false, error: 'claim id (path) required' });
    }
    const targetStage = (req.query.target_stage as string | undefined) || undefined;
    const report = await adjudicationEngine.getLatest(claimId, targetStage);
    if (!report) {
      return res.status(404).json({
        success: false,
        error: `No adjudication report for claim ${claimId}`,
      });
    }
    res
      .status(200)
      .json({ success: true, data: report, message: 'latest report loaded' });
  } catch (error: any) {
    logger.error({ err: error }, 'adjudication: getLatest failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to load adjudication report',
    });
  }
};

/** GET /api/claims/:id/adjudication/history */
export const getAdjudicationHistory = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.id;
    if (!claimId) {
      return res
        .status(400)
        .json({ success: false, error: 'claim id (path) required' });
    }
    const targetStage =
      (req.query.target_stage as string | undefined) || undefined;
    const limitRaw = req.query.limit as string | undefined;
    const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 50) : 50;

    const reports = await adjudicationEngine.getHistory(claimId, {
      limit,
      target_stage: targetStage,
    });
    res.status(200).json({
      success: true,
      data: reports,
      message: `history loaded (${reports.length})`,
    });
  } catch (error: any) {
    logger.error({ err: error }, 'adjudication: getHistory failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to load adjudication history',
    });
  }
};

/** POST /api/claims/:id/adjudication/run */
export const runAdjudication = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.id;
    if (!claimId) {
      return res
        .status(400)
        .json({ success: false, error: 'claim id (path) required' });
    }
    const body = (req.body ?? {}) as { target_stage?: string; force?: boolean };
    const report = await adjudicationEngine.run({
      claim_id: claimId,
      target_stage: body.target_stage,
      force: body.force === true,
    });
    res.status(200).json({
      success: true,
      data: report,
      message: `adjudication run (action=${report.recommended_action}, readiness=${report.readiness_score})`,
    });
  } catch (error: any) {
    logger.error({ err: error }, 'adjudication: run failed');
    const status =
      typeof error.message === 'string' &&
      error.message.startsWith('no dossier')
        ? 404
        : error.statusCode || 500;
    res.status(status).json({
      success: false,
      error: error.message || 'Failed to run adjudication',
    });
  }
};

/**
 * Optional — enqueue (vs run synchronously). Not mounted by default; kept
 * here for the integration sprint to expose when batch operations need it.
 */
export const enqueueAdjudicationRun = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.id;
    if (!claimId) {
      return res
        .status(400)
        .json({ success: false, error: 'claim id (path) required' });
    }
    const body = (req.body ?? {}) as { target_stage?: string };
    await enqueueAdjudication(claimId, body.target_stage, 'manual');
    res.status(202).json({
      success: true,
      data: { claim_id: claimId, target_stage: body.target_stage ?? null },
      message: 'adjudication enqueued',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'adjudication: enqueue failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to enqueue adjudication',
    });
  }
};
