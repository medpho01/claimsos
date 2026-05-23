import { Request, Response } from 'express';

import harmonisationService from '../Services/harmonisation.service.js';
import { enqueueClaimHarmonisation } from '../Workers/claimHarmoniser.queue.js';
import { logger } from '../Utils/logger.js';

/**
 * Harmonisation Controller — Wave 7
 *
 *   GET    /api/v1/claims/:claimId/harmonised
 *     → latest harmonised episode row for the claim. 404 when no
 *       harmonisation has ever been run.
 *
 *   POST   /api/v1/claims/:claimId/harmonised/regenerate
 *     → enqueue a forced re-harmonisation (superadmin only). Returns
 *       202 Accepted; the worker picks up the job and writes
 *       claim_harmonised_episodes async.
 *
 *   POST   /api/v1/claims/:claimId/harmonised/corrections
 *     body: { json_path, human_value, reason? }
 *     → write a human correction at the JSONPath, patch the episode
 *       JSONB in place, log the correction row. Synchronous: returns
 *       the patched row.
 *
 * Errors follow the existing controller pattern (success + data | error
 * + status). "no dossier" → 404, malformed JSONPath → 400.
 */

/** GET /api/v1/claims/:claimId/harmonised */
export const getHarmonisedEpisode = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    if (!claimId) {
      return res
        .status(400)
        .json({ success: false, error: 'claim id (path) required' });
    }
    const row = await harmonisationService.getEpisode(claimId);
    if (!row) {
      return res.status(404).json({
        success: false,
        error: `No harmonised episode for claim ${claimId}`,
      });
    }
    res.status(200).json({
      success: true,
      data: row,
      message: 'harmonised episode loaded',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'harmonisation: getEpisode failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to load harmonised episode',
    });
  }
};

/** POST /api/v1/claims/:claimId/harmonised/regenerate */
export const regenerateHarmonisedEpisode = async (
  req: Request,
  res: Response,
) => {
  try {
    const claimId = req.params.claimId;
    if (!claimId) {
      return res
        .status(400)
        .json({ success: false, error: 'claim id (path) required' });
    }
    // The body may carry hospital_id explicitly (admin tools) — if not,
    // we look it up from ipds. The worker hits the LLM, so we want a
    // valid hospital_id for cost-cap enforcement.
    const body = (req.body ?? {}) as { hospital_id?: string };
    const hospitalId = body.hospital_id;
    if (!hospitalId) {
      return res.status(400).json({
        success: false,
        error:
          'hospital_id (body) required for regenerate — needed for cost cap enforcement',
      });
    }
    await enqueueClaimHarmonisation(claimId, hospitalId, { force: true });
    res.status(202).json({
      success: true,
      data: { claim_id: claimId, hospital_id: hospitalId, force: true },
      message: 'harmonisation regen enqueued',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'harmonisation: regenerate failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to enqueue harmonisation regen',
    });
  }
};

/** POST /api/v1/claims/:claimId/harmonised/corrections */
export const applyHarmonisationCorrection = async (
  req: Request,
  res: Response,
) => {
  try {
    const claimId = req.params.claimId;
    if (!claimId) {
      return res
        .status(400)
        .json({ success: false, error: 'claim id (path) required' });
    }
    const body = (req.body ?? {}) as {
      json_path?: string;
      human_value?: unknown;
      reason?: string;
    };
    if (!body.json_path || typeof body.json_path !== 'string') {
      return res
        .status(400)
        .json({ success: false, error: 'json_path (body, string) required' });
    }
    if (!('human_value' in body)) {
      return res.status(400).json({
        success: false,
        error: 'human_value (body) required (pass null for explicit delete)',
      });
    }
    // Caller's user id is on req.user from checkAuth.
    const correctedBy = (req as any).user?.id ?? null;
    if (!correctedBy) {
      return res
        .status(401)
        .json({ success: false, error: 'Authenticated user required' });
    }
    await harmonisationService.applyCorrection(
      claimId,
      body.json_path,
      body.human_value,
      correctedBy,
      body.reason,
    );
    const row = await harmonisationService.getEpisode(claimId);
    res.status(200).json({
      success: true,
      data: row,
      message: `correction applied at ${body.json_path}`,
    });
  } catch (error: any) {
    logger.error({ err: error }, 'harmonisation: applyCorrection failed');
    const status =
      typeof error.message === 'string' && error.message.startsWith('invalid json_path')
        ? 400
        : typeof error.message === 'string' &&
          error.message.startsWith('harmonisation: no episode')
        ? 404
        : error.statusCode || 500;
    res.status(status).json({
      success: false,
      error: error.message || 'Failed to apply correction',
    });
  }
};
