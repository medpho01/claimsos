/**
 * Sprint 5 / Wave 2B — Document Classifier Worker
 *
 * Bull-backed queue that runs DocClassifierService.classifySection() on
 * sections produced by the segmenter (Wave 2A). Each job is one section.
 *
 * Enqueue points:
 *   - Wave 2A's segmenter, after it commits the section rows.
 *   - A reconciler (out of scope for Wave 2B) that picks up sections
 *     where classifier_version is NULL or behind CLASSIFIER_VERSION.
 *
 * Retry policy: 3 attempts with exponential backoff. The service itself
 * is idempotent on (section_id, CLASSIFIER_VERSION), so retries are
 * cheap; failed jobs land in Bull's failed set for ops triage.
 *
 * Concurrency: 4 — enough to keep one node busy without overwhelming the
 * Anthropic rate limits when we also have the extractor running. Bump
 * once we have hospital-level throttling on top.
 *
 * RUN_WORKERS gating: the API container imports this module only for the
 * enqueue helper; setting RUN_WORKERS=false on that container suppresses
 * the processor registration so we don't double-process.
 */

import Queue from 'bull';
import { logger } from '../Utils/logger.js';
import { DocClassifierService } from '../Services/docClassifier.service.js';

interface DocClassifierJob {
  section_id: string;
  claim_id: string;
  hospital_id: string;
  /**
   * When true, bypass the classifier's version-based idempotency check —
   * the service will re-run the LLM call even if the row already has a
   * category at the current CLASSIFIER_VERSION. Corrections (status='corrected')
   * are still protected by their own guard.
   *
   * Set by the intelligence orchestrator when /analyze is called with
   * force=true (the user-facing "Re-run AI Analysis" button).
   */
  force?: boolean;
}

// Stub queue mirrors the pattern from claimDossierProjector.queue.ts —
// when Redis is unreachable on the API container, .add() is a no-op so
// the calling request doesn't 500. The reconciler picks up the gap.
const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue(): Queue.Queue<DocClassifierJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<DocClassifierJob>('doc-classifier', {
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
        '[DocClassifier] Redis not available — classifications deferred until reconnect.',
      );
    }
  });

  return q;
}

const queue = createQueue();

// Service is lazy-constructed so import order issues (factory needs env)
// don't bite us on module load. We keep a single instance per worker
// process so the LLM bridge's LRU + the cost accounting connection are
// shared across jobs.
let serviceInstance: DocClassifierService | null = null;
function getService(): DocClassifierService {
  if (!serviceInstance) serviceInstance = new DocClassifierService();
  return serviceInstance;
}

async function processJob(job: Queue.Job<DocClassifierJob>): Promise<{
  category: string;
  confidence: number;
  cost_inr: number;
  tier_escalated: boolean;
}> {
  const { section_id, claim_id, hospital_id, force } = job.data;
  if (!section_id || !claim_id || !hospital_id) {
    logger.warn(
      { jobData: job.data },
      'docClassifier worker: malformed job, skipping',
    );
    // Don't throw — this is a permanent failure; throwing would just burn
    // the 3 retry attempts before landing in failed/.
    return {
      category: '',
      confidence: 0,
      cost_inr: 0,
      tier_escalated: false,
    };
  }

  const result = await getService().classifySection({
    sectionId: section_id,
    claimId: claim_id,
    hospitalId: hospital_id,
    force: force === true,
  });
  logger.info(
    {
      section_id,
      claim_id,
      category: result.category,
      confidence: result.confidence,
      cost_inr: result.costInr,
      tier_escalated: result.tierEscalated,
    },
    'docClassifier worker: section classified',
  );
  return {
    category: result.category,
    confidence: result.confidence,
    cost_inr: result.costInr,
    tier_escalated: result.tierEscalated,
  };
}

export async function enqueueDocClassification(
  sectionId: string,
  claimId: string,
  hospitalId: string,
  force = false,
): Promise<void> {
  try {
    await queue.add(
      {
        section_id: sectionId,
        claim_id: claimId,
        hospital_id: hospitalId,
        force,
      },
      {
        // De-dup at the Bull level via the job id. A second enqueue with
        // the same id is ignored by Bull, so a noisy upstream caller
        // doesn't pile up duplicate work.
        //
        // Force re-runs append `:force:<ts>` so the de-dup doesn't drop
        // the new job. We deliberately don't carry idempotency across a
        // forced re-run — the user clicked "Re-run" explicitly.
        jobId: force ? `classify:${sectionId}:force:${Date.now()}` : `classify:${sectionId}`,
      },
    );
  } catch (err) {
    logger.warn(
      { err, sectionId, claimId },
      'docClassifier: enqueue failed (will be picked up by reconciler)',
    );
  }
}

export function startDocClassifierWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('docClassifier worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<DocClassifierJob>).process(4, async (job) => {
      try {
        return await processJob(job);
      } catch (err) {
        logger.error(
          { err, jobId: job.id, jobData: job.data, attempt: job.attemptsMade },
          'docClassifier worker: job failed',
        );
        throw err; // Bull retry per policy
      }
    });
    logger.info(
      'docClassifier worker started (3 attempts × exponential backoff, concurrency=4)',
    );
  }
}

startDocClassifierWorker();

export default queue;
