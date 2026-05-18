import { Request, Response } from 'express';
import { pool } from '../DB/db.js';
import emailIntelligenceService from '../Services/emailIntelligence.service.js';
import { logger } from '../Utils/logger.js';

/**
 * AI Drafts Controller — Sprint 4, Wave 2C
 *
 * Endpoints surfaced by aiDrafts.routes.ts:
 *
 *   GET    /api/claims/:id/ai-drafts?status=pending_review
 *   POST   /api/ai-drafts/:id/apply        body: { fieldOverrides? }
 *   POST   /api/ai-drafts/:id/reject       body: { reason }
 *
 * Routes are NOT mounted in index.ts yet — the integration sprint wires
 * them once the FE cockpit is ready to render the pending-drafts panel.
 */

const ALLOWED_LIST_STATUSES = new Set([
  'pending_review',
  'applied',
  'rejected',
  'expired',
  'superseded',
  'extraction_failed',
]);

export const listDraftsForClaim = async (req: Request, res: Response) => {
  try {
    const { id: claimId } = req.params;
    const status = (req.query?.status as string) ?? 'pending_review';

    if (!claimId) {
      return res.status(400).json({ success: false, error: 'claim id required' });
    }
    if (!ALLOWED_LIST_STATUSES.has(status)) {
      return res.status(400).json({
        success: false,
        error: `invalid status '${status}'`,
      });
    }

    const result = await pool.query(
      `SELECT
         d.id,
         d.inbound_email_id,
         d.claim_id,
         d.category,
         d.classifier_confidence,
         d.extracted_payload,
         d.llm_provider,
         d.llm_model,
         d.prompt_version,
         d.tokens_used,
         d.latency_ms,
         d.cost_inr,
         d.status,
         d.reviewed_by,
         d.reviewed_at,
         d.applied_at,
         d.rejection_reason,
         d.created_at
       FROM hospital.email_intelligence_drafts d
       WHERE d.claim_id = $1
         AND d.status = $2
       ORDER BY d.created_at DESC`,
      [claimId, status],
    );

    return res
      .status(200)
      .json({ success: true, data: result.rows, message: 'ai-drafts fetched' });
  } catch (err: any) {
    logger.error({ err }, 'listDraftsForClaim failed');
    return res
      .status(err.statusCode || 500)
      .json({ success: false, error: err.message });
  }
};

export const applyDraft = async (req: Request, res: Response) => {
  try {
    const { id: draftId } = req.params;
    const userId = req.user?.id;
    if (!draftId) {
      return res.status(400).json({ success: false, error: 'draft id required' });
    }
    if (!userId) {
      return res.status(401).json({ success: false, error: 'unauthenticated' });
    }

    const fieldOverrides =
      req.body?.fieldOverrides && typeof req.body.fieldOverrides === 'object'
        ? (req.body.fieldOverrides as Record<string, unknown>)
        : undefined;

    await emailIntelligenceService.applyDraft(draftId, {
      appliedBy: userId,
      ...(fieldOverrides ? { fieldOverrides } : {}),
    });

    return res
      .status(200)
      .json({ success: true, data: { id: draftId }, message: 'draft applied' });
  } catch (err: any) {
    logger.error({ err }, 'applyDraft failed');
    return res
      .status(err.statusCode || 500)
      .json({ success: false, error: err.message });
  }
};

export const rejectDraft = async (req: Request, res: Response) => {
  try {
    const { id: draftId } = req.params;
    const userId = req.user?.id;
    const reason = req.body?.reason;
    if (!draftId) {
      return res.status(400).json({ success: false, error: 'draft id required' });
    }
    if (!userId) {
      return res.status(401).json({ success: false, error: 'unauthenticated' });
    }
    if (!reason || typeof reason !== 'string') {
      return res
        .status(400)
        .json({ success: false, error: 'reason (string) required in body' });
    }

    await emailIntelligenceService.rejectDraft(draftId, {
      rejectedBy: userId,
      reason,
    });

    return res
      .status(200)
      .json({ success: true, data: { id: draftId }, message: 'draft rejected' });
  } catch (err: any) {
    logger.error({ err }, 'rejectDraft failed');
    return res
      .status(err.statusCode || 500)
      .json({ success: false, error: err.message });
  }
};
