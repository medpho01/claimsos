import { Request, Response } from 'express';

import { actionEngine } from '../Services/actionEngine.service.js';
import { logger } from '../Utils/logger.js';

/**
 * Claim Actions Controller — Sprint 3, Wave 3C
 *
 * Endpoints surfaced by claimActions.routes.ts:
 *
 *   GET    /api/claim-actions?status=&user_id=&claim_id=  → list
 *   POST   /api/claim-actions/:id/ack    body: { response? }
 *   POST   /api/claim-actions/:id/decline body: { reason }
 *
 * Routes are NOT mounted in src/index.ts yet — see the integration TODO
 * on claimActions.routes.ts. Mount only once hospital-membership access
 * control is wired (current handlers trust the authenticated caller).
 */

const ALLOWED_LIST_STATUSES = new Set([
  'pending',
  'dispatched',
  'acked',
  'declined',
  'expired',
  'failed',
  'all',
]);

export const listActions = async (req: Request, res: Response) => {
  try {
    const userId = (req.query.user_id as string | undefined)?.trim();
    const claimId = (req.query.claim_id as string | undefined)?.trim();
    const status = ((req.query.status as string | undefined) ?? 'pending').trim();

    if (!ALLOWED_LIST_STATUSES.has(status)) {
      return res.status(400).json({
        success: false,
        error: `invalid status filter: ${status}`,
      });
    }

    if (!userId && !claimId) {
      return res.status(400).json({
        success: false,
        error: 'one of user_id or claim_id is required',
      });
    }

    const rows = claimId
      ? await actionEngine.listForClaim(claimId, { status })
      : await actionEngine.listForUser(userId!, { status });

    return res.json({ success: true, data: rows });
  } catch (err) {
    logger.error({ err }, 'listActions failed');
    return res
      .status(500)
      .json({ success: false, error: (err as Error)?.message ?? 'unknown error' });
  }
};

export const ackAction = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ackedBy = (req as any).user?.id ?? (req as any).user?.userId;
    if (!ackedBy) {
      return res
        .status(401)
        .json({ success: false, error: 'unauthenticated' });
    }
    const response = req.body?.response;
    await actionEngine.ackAction(id, ackedBy, response);
    return res.json({ success: true });
  } catch (err) {
    const message = (err as Error)?.message ?? 'unknown error';
    // ackAction throws when the row isn't ackable — return 409 not 500.
    if (message.includes('not in an ackable state')) {
      return res.status(409).json({ success: false, error: message });
    }
    logger.error({ err }, 'ackAction failed');
    return res.status(500).json({ success: false, error: message });
  }
};

export const declineAction = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const declinedBy = (req as any).user?.id ?? (req as any).user?.userId;
    if (!declinedBy) {
      return res
        .status(401)
        .json({ success: false, error: 'unauthenticated' });
    }
    const reason = (req.body?.reason as string | undefined)?.trim();
    if (!reason) {
      return res
        .status(400)
        .json({ success: false, error: 'reason is required' });
    }
    await actionEngine.declineAction(id, declinedBy, reason);
    return res.json({ success: true });
  } catch (err) {
    const message = (err as Error)?.message ?? 'unknown error';
    if (message.includes('not in a declinable state')) {
      return res.status(409).json({ success: false, error: message });
    }
    logger.error({ err }, 'declineAction failed');
    return res.status(500).json({ success: false, error: message });
  }
};
