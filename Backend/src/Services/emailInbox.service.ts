import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import apiError from '../Utils/errorHandler.util.js';

/**
 * Email Inbox Service
 *
 * Reads inbound emails attached to an IPD for the FE timeline + the
 * unmatched-emails ops queue + the failed-outbox monitor.
 */

class EmailInboxService {
  /**
   * All inbound emails matched to a given IPD — for the IPD detail page's
   * notifications tab.
   */
  async getInboxForIpd(ipdId: string, hospitalId: string) {
    const res = await pool.query(
      `SELECT
         ei.id, ei.received_at, ei.from_address, ei.subject, ei.body_text,
         ei.classification, ei.match_method, ei.gmail_message_id,
         ei.matched_submission_id,
         ei.attachments
       FROM hospital.emails_inbound ei
       WHERE ei.hospital_id = $1
         AND ei.matched_ipd_id = $2
       ORDER BY ei.received_at DESC`,
      [hospitalId, ipdId]
    );

    // Enrich attachments so the FE has multiple ways to render them:
    //   - proxy_url: authenticated backend stream of the bytes. This is the
    //     primary mechanism the chat thumbnails use (mirrors Patient Documents).
    //     Works regardless of bucket ACL or CloudFront key state.
    //   - view_url: CloudFront-signed → raw-S3 fallback. Kept for inline
    //     <img> tags where Authorization headers can't be attached.
    //
    // The proxy_url depends on the attachment having been auto-mirrored into
    // ipd_doc (savePatientDocsFromInbound). We join by (ipd_id, s3_key) to
    // recover the doc id without changing the JSONB shape on emails_inbound.
    const { default: S3Service } = await import('./s3.service.js');
    const allKeys: string[] = [];
    for (const row of res.rows) {
      for (const a of (row.attachments as any[] | null) ?? []) {
        if (a?.s3_key) allKeys.push(a.s3_key);
      }
    }
    let s3KeyToDocId = new Map<string, string>();
    if (allKeys.length > 0) {
      const docRes = await pool.query(
        `SELECT id, s3_key FROM hospital.ipd_doc WHERE ipd_id = $1 AND s3_key = ANY($2::text[])`,
        [ipdId, allKeys]
      );
      s3KeyToDocId = new Map(docRes.rows.map(r => [r.s3_key as string, r.id as string]));
    }
    for (const row of res.rows) {
      const atts = (row.attachments as any[] | null) ?? [];
      row.attachments = await Promise.all(atts.map(async a => {
        const docId = a?.s3_key ? s3KeyToDocId.get(a.s3_key) : undefined;
        return {
          ...a,
          ipd_doc_id: docId ?? null,
          proxy_url: docId ? `/api/v2/uploads/proxy/${docId}` : null,
          view_url: a?.s3_key ? await S3Service.getViewUrl(a.s3_key) : null,
        };
      }));
    }
    return res.rows;
  }

  /**
   * Ops queue: emails that couldn't be auto-matched. Sorted oldest-first
   * so ops works through the backlog.
   */
  async getUnmatchedQueue(hospitalId: string, limit = 100) {
    const res = await pool.query(
      `SELECT
         ei.id, ei.received_at, ei.from_address, ei.subject, ei.body_text,
         ei.processed_at, ei.attachments
       FROM hospital.emails_inbound ei
       WHERE ei.hospital_id = $1
         AND ei.needs_ops_review = TRUE
         AND ei.matched_ipd_id IS NULL
       ORDER BY ei.received_at ASC
       LIMIT $2`,
      [hospitalId, limit]
    );
    return res.rows;
  }

  /**
   * Manually link an unmatched email to an IPD (ops action).
   */
  async manuallyLink(inboundId: string, ipdId: string, hospitalId: string, userId: string) {
    // Look up the hospital_panel + most recent submission for this IPD
    const ctx = await pool.query(
      `SELECT i.hospital_panel_id,
              (SELECT id FROM hospital.insurance_submissions ps
                 WHERE ps.ipd_id = i.id AND ps.hospital_id = i.hospital_id
                 ORDER BY ps.drafted_at DESC LIMIT 1) AS submission_id
         FROM hospital.ipds i
        WHERE i.id = $1 AND i.hospital_id = $2`,
      [ipdId, hospitalId]
    );
    if ((ctx.rowCount ?? 0) === 0) {
      throw new apiError(404, 'IPD not found');
    }
    const { hospital_panel_id, submission_id } = ctx.rows[0]!;

    const upd = await pool.query(
      `UPDATE hospital.emails_inbound
          SET matched_ipd_id = $1,
              matched_submission_id = $2,
              hospital_panel_id = $3,
              match_method = 'manual',
              needs_ops_review = FALSE,
              processed_at = NOW()
        WHERE id = $4 AND hospital_id = $5
        RETURNING id, matched_ipd_id, matched_submission_id`,
      [ipdId, submission_id, hospital_panel_id, inboundId, hospitalId]
    );
    if ((upd.rowCount ?? 0) === 0) {
      throw new apiError(404, 'inbound email not found for hospital');
    }

    logger.info({ inboundId, ipdId, hospitalId, userId }, 'inbound email manually linked');

    // Enqueue notification dispatch with retry (A8) — same Bull queue as
    // the auto-match path uses.
    try {
      const { default: inboundNotificationQueue } = await import(
        '../Workers/inboundNotification.queue.js'
      );
      await inboundNotificationQueue.add({ inboundId });
    } catch (err) {
      logger.warn({ err, inboundId }, 'inboundNotification enqueue failed after manual link; falling back inline');
      try {
        const { default: dispatcher } = await import('./notificationDispatch.service.js');
        await dispatcher.dispatchInboundRevert(inboundId);
      } catch (fallbackErr) {
        logger.error({ err: fallbackErr, inboundId }, 'inline dispatch fallback also failed');
      }
    }

    return upd.rows[0];
  }

  /**
   * Outbox monitor: emails stuck in 'queued' or 'failed' state. Used by
   * the Outbox Monitor admin UI.
   */
  async getOutboxIssues(hospitalId: string, limit = 100) {
    const res = await pool.query(
      `SELECT
         eo.id, eo.status, eo.failure_reason, eo.attempts,
         eo.subject, eo.to_addresses, eo.queued_at, eo.sent_at,
         eo.insurance_submission_id, eo.ipd_id
       FROM hospital.emails_outbound eo
       WHERE eo.hospital_id = $1
         AND eo.status IN ('queued', 'failed')
         AND (
              (eo.status = 'queued' AND eo.queued_at < NOW() - INTERVAL '5 minutes')
           OR (eo.status = 'failed')
         )
       ORDER BY eo.queued_at DESC
       LIMIT $2`,
      [hospitalId, limit]
    );
    return res.rows;
  }

  /**
   * Retry a failed outbound email (ops action). Sets status back to
   * 'queued' so the outbox worker picks it up again.
   */
  async retryOutbound(emailOutboundId: string, hospitalId: string) {
    const res = await pool.query(
      `UPDATE hospital.emails_outbound
          SET status = 'queued',
              failure_reason = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND hospital_id = $2
          AND status = 'failed'
        RETURNING id`,
      [emailOutboundId, hospitalId]
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new apiError(404, 'failed outbound email not found');
    }
    // Best-effort enqueue
    try {
      const { default: outbox } = await import('../Workers/emailOutbox.queue.js');
      await outbox.add({ emailOutboundId, idempotencyKey: `retry:${emailOutboundId}:${Date.now()}` });
    } catch (err) {
      logger.warn({ err, emailOutboundId }, 'retry enqueue failed; poll fallback will pick up');
    }
    return res.rows[0];
  }
}

export default new EmailInboxService();
