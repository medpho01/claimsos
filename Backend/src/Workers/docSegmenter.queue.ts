import Queue from 'bull';
import { logger } from '../Utils/logger.js';
import s3Service from '../Services/s3.service.js';
import {
  docSegmenterService,
  setClassifierEnqueue,
  SEGMENTER_VERSION,
} from '../Services/docSegmenter.service.js';

/**
 * DocSegmenter Worker — Sprint 3, Wave 2A.
 *
 * Consumes { documentId, claimId, hospitalId, s3_key } jobs:
 *   1. Pulls the PDF buffer from S3 (we don't ship buffers through Redis —
 *      they're megabytes; the s3_key is the durable handle).
 *   2. Invokes DocSegmenterService.segmentDocument, which writes
 *      document_sections rows, dispatches the doc_segmented event, and
 *      enqueues classifier jobs.
 *
 * Retry policy:
 *   - 3 attempts, exponential backoff with a 30s base. The LLM is the typical
 *     failure mode here — a brief 5xx storm on Anthropic resolves within a
 *     minute, so 30s/60s/120s gives us coverage without hammering the
 *     provider. Idempotency in the service layer (segmenter_version cache)
 *     makes retries cheap when the prior attempt got far enough to persist.
 *
 * Concurrency:
 *   - 2. LLM-bound work. Higher concurrency just bunches up at Anthropic's
 *     rate-limit and increases the chance of a 429 cascade. Bump only after
 *     we have per-task rate-limit telemetry on llm_cost_log.
 *
 * Classifier enqueue:
 *   - DocSegmenterService.enqueueClassifier defaults to a no-op (Lane B owns
 *     the docClassifier queue and hasn't landed yet). At process startup we
 *     wire in a Bull-backed enqueuer pointing at the 'doc-classifier' queue
 *     name. When Lane B's queue file is imported by the worker container,
 *     both producers (us) and the consumer (them) connect to the same queue.
 *
 * RUN_WORKERS gating mirrors claimDossierProjector.queue.ts: the API
 * container imports this module to enqueue jobs but RUN_WORKERS=false
 * suppresses processor registration.
 */

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface SegmenterJob {
  documentId: string;
  claimId: string;
  hospitalId: string;
  s3_key: string;
}

interface ClassifierJob {
  sectionId: string;
  documentId: string;
  claimId: string;
  hospitalId: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Stub queue — keeps the API container alive when Redis isn't reachable.
// Same shape as the existing claimDossierProjector.queue.ts stub.
// ────────────────────────────────────────────────────────────────────────────

const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue<T>(name: string): Queue.Queue<T> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<T>(name, {
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
      attempts: 3,
      // 30s base — LLM transient failures need a wait. 30s → 60s → 120s.
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 200,
      removeOnFail: 1000,
    },
  });

  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn(
        `[${name}] Redis not available — jobs deferred until reconnect.`
      );
    }
  });

  return q;
}

// Our own queue (consumer + producer).
const queue = createQueue<SegmenterJob>('doc-segmenter');

// Producer-only handle to the classifier queue. Lane B will own the consumer
// (process function) in their own file. We just need .add() here.
const classifierQueue = createQueue<ClassifierJob>('doc-classifier');

// Wire the service's enqueue hook to the classifier queue. This runs at module
// load — once segmenter.queue is imported, every segmentation will enqueue
// classifier jobs against the shared queue name.
//
// IMPORTANT: the classifier worker (docClassifier.queue.ts) expects
// snake_case keys { section_id, claim_id, hospital_id }. The segmenter
// service speaks camelCase internally — we translate here so both sides
// can stay in their own idiom.
setClassifierEnqueue(async (job) => {
  try {
    await classifierQueue.add(
      {
        section_id: job.sectionId,
        claim_id: job.claimId,
        hospital_id: job.hospitalId,
      } as any,
      {
        // Section-id is unique; we use it as the jobId so accidental double-
        // enqueue (e.g. retry after partial success) dedupes at the queue level.
        jobId: `classify:${job.sectionId}`,
      }
    );
  } catch (err) {
    logger.warn(
      { err, sectionId: job.sectionId, documentId: job.documentId },
      'docSegmenter: classifier .add() failed (will need manual re-run)'
    );
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Job processor
// ────────────────────────────────────────────────────────────────────────────

async function processJob(job: Queue.Job<SegmenterJob>): Promise<void> {
  const { documentId, claimId, hospitalId, s3_key } = job.data;
  if (!documentId || !claimId || !hospitalId || !s3_key) {
    logger.warn({ jobData: job.data }, 'docSegmenter: malformed job, skipping');
    return;
  }

  logger.info(
    { documentId, claimId, hospitalId, s3_key, attempt: job.attemptsMade + 1 },
    'docSegmenter: starting'
  );

  // 1. Pull the PDF buffer from S3. We do NOT ship buffers through Redis —
  //    s3_key is the durable handle.
  let buffer: Buffer;
  try {
    buffer = await s3Service.download(s3_key);
  } catch (err) {
    logger.error({ err, s3_key, documentId }, 'docSegmenter: S3 download failed');
    throw err; // let Bull retry per policy
  }

  // 2. Hand to the service. Service is idempotent at (documentId, version),
  //    so a retry after partial success is a cheap re-read.
  const result = await docSegmenterService.segmentDocument({
    documentId,
    claimId,
    hospitalId,
    buffer,
  });

  logger.info(
    {
      documentId,
      claimId,
      pagesProcessed: result.pagesProcessed,
      sectionCount: result.sectionIds.length,
      costInr: result.costInr,
      shortCircuited: result.shortCircuited,
      segmenterVersion: SEGMENTER_VERSION,
    },
    'docSegmenter: complete'
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Enqueue a segmentation job. Callers MUST have already persisted the
 * underlying ipd_doc row (i.e. the document upload is committed) — the worker
 * pulls the PDF from S3 by key, so the row's s3_key must be valid.
 *
 * `idempotencyKey` becomes the Bull jobId, so a double-enqueue collapses to a
 * single processing attempt. Callers typically pass a hash of (documentId,
 * SEGMENTER_VERSION).
 */
export async function enqueueDocSegmentation(
  documentId: string,
  claimId: string,
  hospitalId: string,
  s3_key: string,
  idempotencyKey: string
): Promise<void> {
  try {
    await queue.add(
      { documentId, claimId, hospitalId, s3_key },
      { jobId: idempotencyKey }
    );
  } catch (err) {
    logger.warn(
      { err, documentId, claimId, idempotencyKey },
      'docSegmenter: enqueue failed (caller should retry once Redis is back)'
    );
  }
}

export function startDocSegmenterWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('docSegmenter worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<SegmenterJob>).process(2, async (job) => {
      try {
        await processJob(job);
      } catch (err) {
        logger.error(
          {
            err,
            jobId: job.id,
            jobData: job.data,
            attempt: job.attemptsMade,
          },
          'docSegmenter: job failed'
        );
        throw err; // let Bull retry per policy
      }
    });
    logger.info(
      'docSegmenter worker started (3 attempts × exponential backoff @ 30s, concurrency=2)'
    );
  }
}

// Auto-start preserves the single-container backward compatibility used by the
// rest of the worker fleet. RUN_WORKERS=false on the API container suppresses
// processor registration.
startDocSegmenterWorker();

export default queue;
