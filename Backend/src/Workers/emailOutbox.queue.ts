import Queue from 'bull';
import { pool } from '../DB/db.js';
import gmailSendService from '../Services/gmailSend.service.js';
import { logger } from '../Utils/logger.js';
import { recordSubmissionEvent } from '../Services/submissionEvents.service.js';

/**
 * Email Outbox Worker
 *
 * Consumes emails_outbound rows with status='queued' and sends them via
 * the hospital's authenticated Gmail account. On success, captures the
 * Message-Id + Thread-Id for downstream threading. On failure, marks the
 * row 'failed' with a reason — retried per Bull retry policy.
 *
 * Two trigger paths:
 *   1. Direct enqueue: insuranceSubmission.service.send() calls .add() with
 *      the email_outbound_id after committing the row.
 *   2. Poll fallback: a scheduled job (registered separately) picks up
 *      any rows still in 'queued' state older than 30s — guards against
 *      enqueue-after-commit race conditions or queue dropouts.
 */

interface EmailOutboxJob {
  emailOutboundId: string;
  idempotencyKey: string;
}

// Stub queue for environments without Redis (mirrors notification.queue.ts pattern)
const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue(): Queue.Queue<EmailOutboxJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<EmailOutboxJob>('email-outbox', {
    redis: {
      host: url.hostname,
      port: parseInt(url.port || '6379'),
      retryStrategy: (times: number) => {
        if (times >= 1) return null;
        return 500;
      },
      enableOfflineQueue: false,
    } as any,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn('[EmailOutbox] Redis not available — outbox disabled until reconnect.');
    }
  });

  // Processor registration moved into startWorker() so the API container
  // (RUN_WORKERS=false) can import this module to .add() jobs without also
  // consuming them. Only the worker container actually processes.

  return q;
}

async function processOne(emailOutboundId: string): Promise<{ status: string; reason?: string }> {
  const startedAt = Date.now();

  // Claim the row atomically (status queued → sending). Idempotency:
  // if another worker already grabbed it, skip.
  const claimRes = await pool.query(
    `UPDATE hospital.emails_outbound
       SET status = 'sending',
           attempts = attempts + 1,
           updated_at = NOW()
     WHERE id = $1 AND status IN ('queued', 'failed')
     RETURNING id, hospital_id, ipd_id, hospital_panel_id, insurance_submission_id,
               to_addresses, cc_addresses, from_address, reply_to,
               subject, body_text, body_html, attachments,
               in_reply_to, references_header, gmail_thread_id`,
    [emailOutboundId]
  );

  if ((claimRes.rowCount ?? 0) === 0) {
    logger.info({ emailOutboundId }, 'emailOutbox: row not claimable (already sent or in flight)');
    return { status: 'skipped', reason: 'not_claimable' };
  }

  const row = claimRes.rows[0]!;

  try {
    const attachments = Array.isArray(row.attachments)
      ? row.attachments.map((a: any) => ({
          filename: a.filename,
          s3Key: a.s3_key,
          mimeType: a.mime_type ?? 'application/octet-stream',
        }))
      : [];

    const result = await gmailSendService.send({
      hospitalId: row.hospital_id,
      fromAddress: row.from_address,
      to: row.to_addresses ?? [],
      cc: row.cc_addresses ?? [],
      replyTo: row.reply_to,
      subject: row.subject,
      bodyText: row.body_text,
      bodyHtml: row.body_html,
      attachments,
      inReplyTo: row.in_reply_to,
      references: row.references_header,
      threadId: row.gmail_thread_id,
    });

    // Persist gmail identifiers + mark sent (in one transaction)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE hospital.emails_outbound
           SET status = 'sent',
               sent_at = NOW(),
               gmail_message_id = $1,
               gmail_thread_id = $2,
               failure_reason = NULL,
               updated_at = NOW()
         WHERE id = $3`,
        [result.gmailMessageId, result.gmailThreadId, emailOutboundId]
      );

      // Cascade status to the parent preauth_submission if linked
      if (row.insurance_submission_id) {
        await client.query(
          `UPDATE hospital.insurance_submissions
             SET status = 'sent',
                 sent_at = COALESCE(sent_at, NOW()),
                 updated_at = NOW()
           WHERE id = $1 AND status IN ('drafted', 'failed')`,
          [row.insurance_submission_id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const elapsedMs = Date.now() - startedAt;
    logger.info(
      {
        emailOutboundId,
        gmailMessageId: result.gmailMessageId,
        gmailThreadId: result.gmailThreadId,
        elapsedMs,
      },
      'emailOutbox: sent successfully'
    );

    // Audit log: sent (A2)
    if (row.insurance_submission_id) {
      await recordSubmissionEvent({
        insuranceSubmissionId: row.insurance_submission_id,
        ipdId: row.ipd_id,
        hospitalId: row.hospital_id,
        eventType: 'sent',
        payload: {
          gmail_message_id: result.gmailMessageId,
          gmail_thread_id: result.gmailThreadId,
          elapsed_ms: elapsedMs,
          email_outbound_id: emailOutboundId,
        },
        actor: 'worker',
      });
    }

    return { status: 'sent' };
  } catch (err) {
    const reason = (err as Error).message;
    logger.error({ err, emailOutboundId }, 'emailOutbox: send failed');
    await pool.query(
      `UPDATE hospital.emails_outbound
         SET status = 'failed',
             failure_reason = $1,
             updated_at = NOW()
       WHERE id = $2`,
      [reason, emailOutboundId]
    );
    // Also mark the submission as failed (one retry left in Bull; recovery is manual)
    if (row.insurance_submission_id) {
      await pool.query(
        `UPDATE hospital.insurance_submissions
           SET status = 'failed', updated_at = NOW()
         WHERE id = $1 AND status IN ('drafted', 'sending')`,
        [row.insurance_submission_id]
      );
      // Audit log: failed (A2)
      await recordSubmissionEvent({
        insuranceSubmissionId: row.insurance_submission_id,
        ipdId: row.ipd_id,
        hospitalId: row.hospital_id,
        eventType: 'failed',
        payload: { failure_reason: reason, email_outbound_id: emailOutboundId },
        actor: 'worker',
      });
    }
    throw err;     // let Bull retry per policy
  }
}

/**
 * Poll fallback: scans for emails_outbound stuck in 'queued' for >30s and
 * re-enqueues them. Runs every minute. Cheap (single indexed query).
 *
 * Also rescues rows orphaned in 'sending' for >5 minutes — that happens when
 * a worker picks up a row, calls the Gmail API, and the process dies before
 * the row transitions to 'sent' or 'failed' (typical cause: backend restart
 * mid-send). We reset such rows to 'queued' first; the same poll iteration
 * (or the next one) then re-enqueues them through the regular path.
 */
async function pollAndDispatch(queue: Queue.Queue<EmailOutboxJob> | typeof stubQueue) {
  try {
    // 1) Rescue stranded 'sending' rows.
    const stranded = await pool.query(
      `UPDATE hospital.emails_outbound
          SET status = 'queued'
        WHERE status = 'sending'
          AND queued_at < NOW() - INTERVAL '5 minutes'
        RETURNING id`
    );
    if (stranded.rowCount && stranded.rowCount > 0) {
      logger.warn({ count: stranded.rowCount }, 'emailOutbox poll: rescued stranded sending rows');
    }

    // 2) Re-enqueue all rows that have been 'queued' for >30s.
    const rows = await pool.query(
      `SELECT id, idempotency_key
         FROM hospital.emails_outbound
        WHERE status = 'queued'
          AND queued_at < NOW() - INTERVAL '30 seconds'
        LIMIT 50`
    );
    for (const row of rows.rows) {
      await queue.add({ emailOutboundId: row.id, idempotencyKey: row.idempotency_key });
    }
    if (rows.rowCount && rows.rowCount > 0) {
      logger.info({ count: rows.rowCount }, 'emailOutbox poll: re-enqueued stuck rows');
    }
  } catch (err) {
    logger.error({ err }, 'emailOutbox poll failed');
  }
}

const queue = createQueue();

/**
 * Register the Bull processor and start the poll-fallback loop.
 * Gated by RUN_WORKERS so the API container (RUN_WORKERS=false) can import
 * this module to enqueue jobs without also consuming them; the dedicated
 * worker container runs this side of the code path.
 *
 * Default behaviour (RUN_WORKERS unset): run workers. Backward-compatible
 * with the original single-process setup.
 */
export function startEmailOutboxWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('emailOutbox worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<EmailOutboxJob>).process(async (job: Queue.Job<EmailOutboxJob>) => {
      return processOne(job.data.emailOutboundId);
    });
  }
  setInterval(() => pollAndDispatch(queue), 60 * 1000).unref();
  logger.info('emailOutbox worker started (processor + 60s poll fallback)');
}

// Auto-start when imported (preserves the prior behaviour). Index.ts can
// disable via RUN_WORKERS=false on the API container.
startEmailOutboxWorker();

export default queue;
