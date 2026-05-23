import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

/**
 * SubmissionEvents helper — thin wrapper for INSERTing into
 * hospital.submission_events. Used by:
 *   - insuranceSubmission.service.send()    (drafted / queued / replayed)
 *   - emailOutbox.queue.processOne()        (sending / sent / failed)
 *   - emailMatching.service.match()         (inbound_matched / unmatched)
 *   - notificationDispatch.service          (notification_sent / failed)
 *   - The PUT /ipds/:id/stage endpoint      (stage_changed)
 *
 * Best-effort: a write failure here MUST NOT break the parent operation.
 * The audit log is for observability, not the source of truth for state.
 */

export type SubmissionEventType =
  | 'drafted'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'replayed'
  | 'stage_changed'
  | 'inbound_matched'
  | 'inbound_unmatched'
  | 'notification_sent'
  | 'notification_failed';

interface RecordParams {
  insuranceSubmissionId: string;
  ipdId?: string | null;
  hospitalId: string;
  eventType: SubmissionEventType;
  payload?: Record<string, unknown>;
  actor?: string | null;
}

export async function recordSubmissionEvent(params: RecordParams): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO hospital.submission_events
         (insurance_submission_id, ipd_id, hospital_id, event_type, payload, actor)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        params.insuranceSubmissionId,
        params.ipdId ?? null,
        params.hospitalId,
        params.eventType,
        JSON.stringify(params.payload ?? {}),
        params.actor ?? 'system',
      ]
    );
  } catch (err) {
    // Never throw — audit log failures must not break the parent op.
    logger.warn(
      { err, ...params },
      'submission_events: insert failed (audit-only, parent op unaffected)'
    );
  }
}

/**
 * Variant for stage_changed events that aren't tied to a specific submission
 * (just an IPD-level change). Inserts a row with a NULL-looking submission
 * reference using a sentinel — but submission_events.insurance_submission_id
 * is NOT NULL. So instead we look up the most recent submission for the IPD
 * and attach to that, or skip if none exists.
 */
export async function recordIpdStageChange(params: {
  ipdId: string;
  hospitalId: string;
  fromStage: string | null;
  toStage: string | null;
  actor: string | null;
}): Promise<void> {
  try {
    const submission = await pool.query<{ id: string }>(
      `SELECT id FROM hospital.insurance_submissions
        WHERE ipd_id = $1 AND hospital_id = $2
        ORDER BY drafted_at DESC LIMIT 1`,
      [params.ipdId, params.hospitalId]
    );
    if ((submission.rowCount ?? 0) === 0) {
      // No submission yet — stage change recorded only on IPD.updated_at.
      // When the first submission is created later, that submission gets a
      // 'drafted' event; the stage history before that can be inferred from
      // ipds.updated_at if needed.
      return;
    }
    await recordSubmissionEvent({
      insuranceSubmissionId: submission.rows[0]!.id,
      ipdId: params.ipdId,
      hospitalId: params.hospitalId,
      eventType: 'stage_changed',
      payload: { from: params.fromStage, to: params.toStage },
      actor: params.actor,
    });
  } catch (err) {
    logger.warn({ err, ...params }, 'submission_events: stage change record failed');
  }
}
