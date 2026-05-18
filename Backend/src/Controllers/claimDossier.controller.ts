import { Request, Response } from 'express';
import claimDossierService from '../Services/claimDossier.service.js';
import { logger } from '../Utils/logger.js';

/**
 * Claim Dossier Controller
 *
 *   GET    /api/v1/claims/:id/dossier         → read the projection
 *   POST   /api/v1/claims/:id/dossier/rebuild → admin-only full replay
 *
 * The dossier is a JSONB-heavy denormalised view — the API surface stays thin
 * because the projector does the heavy lifting. Errors follow the existing
 * controller pattern (success + data | error message + appropriate status).
 */

/** GET /api/v1/claims/:id/dossier */
export const getDossier = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.id;
    if (!claimId) {
      return res
        .status(400)
        .json({ success: false, error: 'claim id (path) required' });
    }
    const dossier = await claimDossierService.getDossier(claimId);
    if (!dossier) {
      return res
        .status(404)
        .json({ success: false, error: `No dossier projection for claim ${claimId}` });
    }
    res.status(200).json({ success: true, data: dossier, message: 'dossier loaded' });
  } catch (error: any) {
    logger.error({ err: error }, 'claim dossier read failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to load claim dossier',
    });
  }
};

/** POST /api/v1/claims/:id/dossier/rebuild */
export const rebuildDossier = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.id;
    if (!claimId) {
      return res
        .status(400)
        .json({ success: false, error: 'claim id (path) required' });
    }
    const dossier = await claimDossierService.rebuildFromEvents(claimId);
    res.status(200).json({
      success: true,
      data: dossier,
      message: `rebuilt dossier from events (version=${dossier.version})`,
    });
  } catch (error: any) {
    logger.error({ err: error }, 'claim dossier rebuild failed');
    const status =
      typeof error.message === 'string' && error.message.includes('not found')
        ? 404
        : error.statusCode || 500;
    res.status(status).json({
      success: false,
      error: error.message || 'Failed to rebuild claim dossier',
    });
  }
};
