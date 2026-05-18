import Queue from 'bull';
import emailIntelligenceService from '../Services/emailIntelligence.service.js';
import S3Service from '../Services/s3.service.js';
import { logger } from '../Utils/logger.js';

/**
 * Email Intelligence Worker — Sprint 4, Wave 2C
 *
 * Consumes a job per inbound email and runs it through the email
 * intelligence pipeline (OCR → classify → extract → persist draft →
 * dispatch ai_draft_created).
 *
 * Wiring expectations (NOT done in this PR — that's the integration
 * sprint's job): the inbound matcher / inbox service calls
 * `enqueueEmailIntelligence(...)` once an email is persisted and (where
 * applicable) matched to a claim. The job payload carries the inbound
 * row id, the resolved claim_id (nullable), the hospital, the body text,
 * and an array of S3 keys for any attachments — the worker fetches the
 * attachment bytes itself from S3 so the queue payload stays small (Bull
 * stores payloads in Redis).
 *
 * Concurrency / retries:
 *   - Concurrency 3 per worker process. LLM-bound, not CPU-bound; the
 *     bottleneck is provider latency (~2-5s/call). Three in-flight calls
 *     per worker keeps Redis happy without saturating Anthropic rate
 *     limits at typical fleet sizes.
 *   - 3 attempts with exponential backoff. The service itself is
 *     idempotent on (inbound_email_id, prompt_version), so a retry after
 *     a transient OCR / network error is safe — the second attempt either
 *     returns the existing draft or completes the work the first attempt
 *     bailed on.
 *
 * RUN_WORKERS gating: the API container imports this module to enqueue
 * jobs but must NOT consume them. Setting RUN_WORKERS=false on the API
 * container skips the .process() registration; the dedicated worker
 * container (RUN_WORKERS unset / =true) processes.
 */

export const QUEUE_NAME = 'email-intelligence';
export const QUEUE_CONCURRENCY = 3;

export interface EmailIntelligenceJob {
  inboundEmailId: string;
  claimId: string | null;
  hospitalId: string;
  body: string;
  /**
   * S3 keys for any PDF / image attachments. The worker downloads each
   * key into a Buffer and passes them to processInboundEmail. Filename
   * + mime travel inline (Bull payload) because S3 metadata round-trips
   * cost more than the few hundred bytes of inline strings.
   */
  s3AttachmentKeys: Array<{
    s3Key: string;
    filename: string;
    mime: string;
  }>;
}

// Stub queue mirrors the pattern used by emailOutbox.queue.ts — keeps
// `import` cheap in environments without Redis (local CLI tools, tests).
const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue(): Queue.Queue<EmailIntelligenceJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<EmailIntelligenceJob>(QUEUE_NAME, {
    redis: {
      host: url.hostname,
      port: parseInt(url.port || '6379'),
      retryStrategy: (times: number) => {
        if (times >= 3) return null;
        return Math.min(times * 200, 1000);
      },
      enableOfflineQueue: false,
    } as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn(
        '[EmailIntelligence] Redis not available — intelligence pipeline paused.',
      );
    }
  });

  return q;
}

const queue = createQueue();

async function fetchAttachments(
  keys: EmailIntelligenceJob['s3AttachmentKeys'],
): Promise<Array<{ filename: string; buffer: Buffer; mime: string }>> {
  const out: Array<{ filename: string; buffer: Buffer; mime: string }> = [];
  for (const k of keys) {
    try {
      const buffer = await S3Service.download(k.s3Key);
      out.push({ filename: k.filename, buffer, mime: k.mime });
    } catch (err) {
      // A failed attachment download isn't a job failure — we still want
      // to classify the email body. Log and continue.
      logger.warn(
        { err, s3Key: k.s3Key, filename: k.filename },
        'emailIntelligence worker: attachment download failed, continuing without it',
      );
    }
  }
  return out;
}

async function processOne(job: Queue.Job<EmailIntelligenceJob>) {
  const { inboundEmailId, claimId, hospitalId, body, s3AttachmentKeys } = job.data;

  logger.info(
    {
      inboundEmailId,
      claimId,
      hospitalId,
      attachmentCount: s3AttachmentKeys?.length ?? 0,
      attempt: job.attemptsMade + 1,
    },
    'emailIntelligence worker: processing job',
  );

  const attachments = await fetchAttachments(s3AttachmentKeys ?? []);
  const result = await emailIntelligenceService.processInboundEmail({
    inboundEmailId,
    claimId,
    hospitalId,
    body: body ?? '',
    attachments,
  });

  logger.info(
    {
      inboundEmailId,
      draftId: result.draftId,
      category: result.category,
      deduped: result.deduped,
      failed: result.failed,
      costInr: result.costInr,
    },
    'emailIntelligence worker: job complete',
  );
  return result;
}

/**
 * Register the processor. Skipped when RUN_WORKERS=false (API container
 * can still .add() jobs from importable enqueueEmailIntelligence below).
 */
export function startEmailIntelligenceWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('emailIntelligence worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<EmailIntelligenceJob>).process(QUEUE_CONCURRENCY, async (job) => {
      return processOne(job);
    });
    logger.info(
      { concurrency: QUEUE_CONCURRENCY },
      'emailIntelligence worker started',
    );
  }
}

/**
 * Enqueue a job. Safe to call from the API container — the .add() path
 * doesn't need a registered processor in this process.
 */
export async function enqueueEmailIntelligence(
  payload: EmailIntelligenceJob,
): Promise<void> {
  try {
    await queue.add(payload, {
      // jobId keyed on inbound_email_id — Bull de-dupes within the
      // retention window, so a re-enqueue of the same inbound email
      // before the previous attempt finishes is a no-op. The service-
      // level idempotency handles the case where the previous attempt
      // *already* finished.
      jobId: `email-intel:${payload.inboundEmailId}`,
    });
  } catch (err) {
    logger.warn(
      { err, inboundEmailId: payload.inboundEmailId },
      'enqueueEmailIntelligence failed (caller should fall back to inline or retry)',
    );
    throw err;
  }
}

// Auto-start when imported — matches emailOutbox.queue.ts behaviour. The
// API container disables via RUN_WORKERS=false.
startEmailIntelligenceWorker();

export default queue;
