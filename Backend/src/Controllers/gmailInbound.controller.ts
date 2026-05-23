import { Request, Response } from 'express';
import gmailInboundService from '../Services/gmailInbound.service.js';
import { runOnce as runGmailPollCycle } from '../Workers/gmailPoll.queue.js';
import { logger } from '../Utils/logger.js';

/**
 * Gmail Inbound Controller (polling mode)
 *
 *   POST /api/v1/hospitals/:hospitalId/gmail-poll/now      — force-poll one hospital
 *   POST /api/v1/admin/gmail-poll/run-cycle                — superadmin: trigger one full cycle
 *
 * Pub/Sub push endpoint has been removed — inbound is now driven by the
 * gmailPoll.queue Bull cron worker (default every 120s).
 */

/** POST /api/v1/hospitals/:hospitalId/gmail-poll/now */
export const forcePollHospital = async (req: Request, res: Response) => {
  try {
    const { hospitalId } = req.params;
    if (!hospitalId) {
      return res.status(400).json({ success: false, error: 'hospitalId required' });
    }
    const result = await gmailInboundService.pollHospital(hospitalId);
    res.status(200).json({
      success: true,
      data: result,
      message: 'gmail poll completed',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'forcePollHospital failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to poll gmail',
    });
  }
};

/** POST /api/v1/admin/gmail-poll/run-cycle */
export const runFullPollCycle = async (_req: Request, res: Response) => {
  try {
    const result = await runGmailPollCycle();
    res.status(200).json({
      success: true,
      data: result,
      message: 'gmail poll cycle complete',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'runFullPollCycle failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to run poll cycle',
    });
  }
};
