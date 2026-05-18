/**
 * Sprint 5 / Wave 2B — Document Extractor Worker
 *
 * Bull-backed queue that runs DocExtractorService.extractSection() on
 * sections that have a category set. Enqueued by the classifier worker
 * (or a reconciler) one job per section.
 *
 * Same patterns as docClassifier.queue.ts — see comments there for
 * stub-queue, retry, RUN_WORKERS gating rationale.
 */

import Queue from 'bull';
import { logger } from '../Utils/logger.js';
import { DocExtractorService } from '../Services/docExtractor.service.js';

interface DocExtractorJob {
  section_id: string;
  claim_id: string;
  hospital_id: string;
}

const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue(): Queue.Queue<DocExtractorJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<DocExtractorJob>('doc-extractor', {
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
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 200,
      removeOnFail: 1000,
    },
  });

  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn(
        '[DocExtractor] Redis not available — extractions deferred until reconnect.',
      );
    }
  });

  return q;
}

const queue = createQueue();

let serviceInstance: DocExtractorService | null = null;
function getService(): DocExtractorService {
  if (!serviceInstance) serviceInstance = new DocExtractorService();
  return serviceInstance;
}

async function processJob(job: Queue.Job<DocExtractorJob>): Promise<{
  field_count: number;
  cost_inr: number;
  tier_escalated: boolean;
}> {
  const { section_id, claim_id, hospital_id } = job.data;
  if (!section_id || !claim_id || !hospital_id) {
    logger.warn(
      { jobData: job.data },
      'docExtractor worker: malformed job, skipping',
    );
    return { field_count: 0, cost_inr: 0, tier_escalated: false };
  }

  const result = await getService().extractSection({
    sectionId: section_id,
    claimId: claim_id,
    hospitalId: hospital_id,
  });
  logger.info(
    {
      section_id,
      claim_id,
      field_count: Object.keys(result.fields).length,
      cost_inr: result.costInr,
      tier_escalated: result.tierEscalated,
    },
    'docExtractor worker: section extracted',
  );
  return {
    field_count: Object.keys(result.fields).length,
    cost_inr: result.costInr,
    tier_escalated: result.tierEscalated,
  };
}

export async function enqueueDocExtraction(
  sectionId: string,
  claimId: string,
  hospitalId: string,
): Promise<void> {
  try {
    await queue.add(
      { section_id: sectionId, claim_id: claimId, hospital_id: hospitalId },
      {
        jobId: `extract:${sectionId}`,
      },
    );
  } catch (err) {
    logger.warn(
      { err, sectionId, claimId },
      'docExtractor: enqueue failed (will be picked up by reconciler)',
    );
  }
}

export function startDocExtractorWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('docExtractor worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<DocExtractorJob>).process(4, async (job) => {
      try {
        return await processJob(job);
      } catch (err) {
        logger.error(
          { err, jobId: job.id, jobData: job.data, attempt: job.attemptsMade },
          'docExtractor worker: job failed',
        );
        throw err;
      }
    });
    logger.info(
      'docExtractor worker started (3 attempts × exponential backoff, concurrency=4)',
    );
  }
}

startDocExtractorWorker();

export default queue;
