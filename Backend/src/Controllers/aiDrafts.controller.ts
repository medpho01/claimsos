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
         d.created_at,
         -- Source-of-truth email the extraction was derived from. Surfaced so
         -- the reviewer can open the exact insurer message + attachments
         -- (the "proof") before applying the AI suggestion.
         CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', e.id,
           'gmail_message_id', e.gmail_message_id,
           'gmail_thread_id', e.gmail_thread_id,
           'from', e.from_address,
           'subject', e.subject,
           'received_at', e.received_at,
           'body', LEFT(COALESCE(e.body_text, ''), 4000),
           'attachments', COALESCE(e.attachments, '[]'::jsonb),
           'classification', e.classification
         ) END AS source_email
       FROM hospital.email_intelligence_drafts d
       LEFT JOIN hospital.emails_inbound e ON e.id = d.inbound_email_id
       WHERE d.claim_id = $1
         AND d.status = $2
       ORDER BY d.created_at DESC`,
      [claimId, status],
    );

    // Enrich each source email's attachments with a presigned view URL so the
    // reviewer can see the actual sanction letter (the document of record) in
    // the draft drawer — the amount is read from the attached letter, not the
    // email body. Mirrors emailInbox.service's enrichment. Best-effort: a
    // failed presign just yields view_url=null and the FE falls back to a
    // "open" link.
    const { default: S3Service } = await import('../Services/s3.service.js');
    await Promise.all(
      result.rows.map(async (row: any) => {
        const atts = row?.source_email?.attachments;
        if (!Array.isArray(atts) || atts.length === 0) return;
        row.source_email.attachments = await Promise.all(
          atts.map(async (a: any) => ({
            ...a,
            view_url: a?.s3_key
              ? await S3Service.getViewUrl(a.s3_key).catch(() => null)
              : null,
          })),
        );
      }),
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
