/**
 * Review Queue Controller (iter7 Stage 7).
 *
 *   GET    /api/v1/review-queue                — list flagged claims
 *   GET    /api/v1/review-queue/:claimId       — full detail for one
 *   POST   /api/v1/review-queue/:claimId/disposition
 *
 * Superadmin only.
 */
import type { Request, Response } from 'express';
import {
  listFlaggedClaims,
  getFlaggedClaim,
  dispositionSection,
} from '../Services/reviewQueue.service.js';
import { enqueueClaimHarmonisation } from '../Workers/claimHarmoniser.queue.js';
import { logger } from '../Utils/logger.js';
import { pool } from '../DB/db.js';

/** GET /api/v1/review-queue?limit=&offset=&hospital_id= */
export const listReviewQueue = async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const hospital_id = typeof req.query.hospital_id === 'string'
      ? req.query.hospital_id : undefined;
    const data = await listFlaggedClaims({ limit, offset, hospital_id });
    return res.status(200).json({ success: true, data });
  } catch (e: any) {
    logger.error({ err: e }, 'reviewQueue: list failed');
    return res.status(500).json({ success: false, error: e?.message ?? 'internal error' });
  }
};

/** GET /api/v1/review-queue/:claimId */
export const getReviewQueueClaim = async (req: Request, res: Response) => {
  try {
    const { claimId } = req.params;
    if (!claimId) return res.status(400).json({ success: false, error: 'claimId required' });
    const data = await getFlaggedClaim(claimId);
    if (!data) return res.status(404).json({ success: false, error: 'no flagged claim by that id' });
    return res.status(200).json({ success: true, data });
  } catch (e: any) {
    logger.error({ err: e }, 'reviewQueue: detail failed');
    return res.status(500).json({ success: false, error: e?.message ?? 'internal error' });
  }
};

/**
 * POST /api/v1/review-queue/:claimId/disposition
 * Body: { section_id, flag_type, action: 'accept' | 'reject' | 'correct',
 *         reason?, correction?: { json_path, human_value } }
 *
 * On 'reject' we also enqueue a harmoniser regenerate so the freshly
 * dropped section is reflected in a new episode. 'correct' is
 * handled the same way — the harmonisation_corrections row is
 * picked up by harmonise() on the next regen.
 */
export const dispositionReviewQueueSection = async (
  req: Request,
  res: Response,
) => {
  try {
    const { claimId } = req.params;
    if (!claimId) return res.status(400).json({ success: false, error: 'claimId required' });
    const { section_id, flag_type, action, reason, correction } = req.body ?? {};
    if (!section_id || typeof section_id !== 'string')
      return res.status(400).json({ success: false, error: 'section_id required' });
    if (!flag_type || typeof flag_type !== 'string')
      return res.status(400).json({ success: false, error: 'flag_type required' });
    if (!['accept', 'reject', 'correct'].includes(action))
      return res.status(400).json({ success: false, error: 'action must be accept|reject|correct' });

    const user_id = (req as any).user?.id;
    if (!user_id) return res.status(401).json({ success: false, error: 'auth required' });

    const out = await dispositionSection({
      claim_id: claimId,
      section_id,
      flag_type,
      action,
      user_id,
      reason,
      correction,
    });

    // Trigger fresh harmonisation when the underlying data changed.
    if (action === 'reject' || action === 'correct') {
      // Need hospital_id for the queue payload
      const r = await pool.query<{ hospital_id: string }>(
        `SELECT hospital_id FROM hospital.ipds WHERE id = $1`,
        [claimId],
      );
      const hospital_id = r.rows[0]?.hospital_id;
      if (hospital_id) {
        await enqueueClaimHarmonisation(claimId, hospital_id, {
          force: true,
          reason: `review-queue ${action} by ${user_id}`,
        });
      }
    }

    return res.status(200).json({ success: true, data: out });
  } catch (e: any) {
    logger.error({ err: e }, 'reviewQueue: disposition failed');
    return res.status(500).json({ success: false, error: e?.message ?? 'internal error' });
  }
};
