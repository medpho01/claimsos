import { Request, Response } from 'express';
import emailInboxService from '../Services/emailInbox.service.js';
import { logger } from '../Utils/logger.js';

/**
 *   GET    /api/v1/ipds/:ipdId/emails-inbound
 *   GET    /api/v1/hospitals/:hospitalId/emails-inbound/unmatched
 *   POST   /api/v1/emails-inbound/:inboundId/manual-link
 *   GET    /api/v1/hospitals/:hospitalId/emails-outbound/issues
 *   POST   /api/v1/emails-outbound/:emailOutboundId/retry
 */

export const getIpdInbound = async (req: Request, res: Response) => {
  try {
    const { ipdId } = req.params;
    const hospitalId = (req.query?.hospital_id ?? '') as string;
    if (!ipdId || !hospitalId) {
      return res
        .status(400)
        .json({ success: false, error: 'ipdId (path) and hospital_id (query) required' });
    }
    const rows = await emailInboxService.getInboxForIpd(ipdId, hospitalId);
    res.status(200).json({ success: true, data: rows, message: 'inbound emails fetched' });
  } catch (error: any) {
    logger.error({ err: error }, 'getIpdInbound failed');
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

export const getUnmatchedQueue = async (req: Request, res: Response) => {
  try {
    const { hospitalId } = req.params;
    if (!hospitalId) {
      return res.status(400).json({ success: false, error: 'hospitalId required' });
    }
    const rows = await emailInboxService.getUnmatchedQueue(hospitalId);
    res.status(200).json({ success: true, data: rows, message: 'unmatched queue fetched' });
  } catch (error: any) {
    logger.error({ err: error }, 'getUnmatchedQueue failed');
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

export const manuallyLinkInbound = async (req: Request, res: Response) => {
  try {
    const { inboundId } = req.params;
    const hospitalId = req.body?.hospital_id;
    const ipdId = req.body?.ipd_id;
    const userId = req.user?.id ?? '';
    if (!inboundId || !hospitalId || !ipdId) {
      return res.status(400).json({
        success: false,
        error: 'inboundId (path), hospital_id + ipd_id (body) required',
      });
    }
    const result = await emailInboxService.manuallyLink(inboundId, ipdId, hospitalId, userId);
    res.status(200).json({ success: true, data: result, message: 'inbound email linked' });
  } catch (error: any) {
    logger.error({ err: error }, 'manuallyLinkInbound failed');
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

export const getOutboxIssues = async (req: Request, res: Response) => {
  try {
    const { hospitalId } = req.params;
    if (!hospitalId) {
      return res.status(400).json({ success: false, error: 'hospitalId required' });
    }
    const rows = await emailInboxService.getOutboxIssues(hospitalId);
    res.status(200).json({ success: true, data: rows, message: 'outbox issues fetched' });
  } catch (error: any) {
    logger.error({ err: error }, 'getOutboxIssues failed');
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

export const retryOutbound = async (req: Request, res: Response) => {
  try {
    const { emailOutboundId } = req.params;
    const hospitalId = req.body?.hospital_id;
    if (!emailOutboundId || !hospitalId) {
      return res
        .status(400)
        .json({ success: false, error: 'emailOutboundId (path) + hospital_id (body) required' });
    }
    const result = await emailInboxService.retryOutbound(emailOutboundId, hospitalId);
    res.status(200).json({ success: true, data: result, message: 'queued for retry' });
  } catch (error: any) {
    logger.error({ err: error }, 'retryOutbound failed');
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};
