/**
 * Adjudication Engine Worker — Sprint 3, Wave 3B
 *
 * Consumes jobs of the shape:
 *   { claim_id, target_stage?, trigger: 'dossier_changed' | 'manual' | 'periodic' }
 *
 * and runs AdjudicationEngine.run on them. The engine itself does its own
 * caching (dossier_state_hash) so a no-op re-run is cheap — but we still
 * apply a Bull-level dedup using job.id = claim_id to coalesce bursts of
 * dossier_changed events into a single run.
 *
 * Why this isn't called inline from the projector:
 *   - Adjudication is heavier than a projection write (rules + future
 *     KB/LLM passes). We don't want a single doc upload to block on a
 *     full re-evaluation; enqueue + return is correct.
 *   - Multiple events in quick succession (segmentation → classification →
 *     extraction all firing within seconds) should fold into one re-run,
 *     not three. The 5-second delay below + jobId=claim_id dedup achieves
 *     that without us having to write a Redis lock by hand.
 *
 * Retry policy: 3 attempts × exponential backoff (same as the dossier
 * projector). Adjudication is idempotent (cache hit on retry returns the
 * already-written row).
 *
 * RUN_WORKERS gating: same convention as claimDossierProjector.queue.ts —
 * the API container imports this module to enqueue, the worker container
 * registers the processor. RUN_WORKERS=false suppresses the processor.
 */

import Queue from 'bull';

import { logger } from '../Utils/logger.js';
import adjudicationEngine from '../Services/adjudicationEngine.service.js';

export type AdjudicationTrigger = 'dossier_changed' | 'manual' | 'periodic';

export interface AdjudicationJob {
  claim_id: string;
  target_stage?: string;
  trigger: AdjudicationTrigger;
}

// How long we delay 'dossier_changed' jobs before processing — gives
// burst-y projection updates time to coalesce. A later job with the
// same jobId (= claim_id) replaces this one in Bull's delayed set,
// so the newest enqueue wins.
const DEBOUNCE_MS = 5000;

const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue(): Queue.Queue<AdjudicationJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<AdjudicationJob>('adjudication-engine', {
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
        '[AdjudicationEngine] Redis not available — adjudication runs deferred until reconnect.',
      );
    }
  });

  return q;
}

const queue = createQueue();

// ────────────────────────────────────────────────────────────────────────
// Processor
// ────────────────────────────────────────────────────────────────────────

async function processJob(job: Queue.Job<AdjudicationJob>): Promise<void> {
  const { claim_id, target_stage, trigger } = job.data;
  if (!claim_id) {
    logger.warn(
      { jobData: job.data },
      'adjudicationEngine: malformed job (no claim_id), skipping',
    );
    return;
  }

  // 'manual' jobs respect force=true so a UI replay actually re-evaluates;
  // dossier_changed/periodic respect the cache.
  const force = trigger === 'manual';

  const report = await adjudicationEngine.run({
    claim_id,
    target_stage,
    force,
  });

  logger.info(
    {
      claim_id,
      trigger,
      report_id: report.id,
      readiness: report.readiness_score,
      bucket: report.readiness_bucket,
      action: report.recommended_action,
    },
    'adjudicationEngine: run complete',
  );
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Enqueue an adjudication run for a claim. The job id is keyed on
 * (claim_id, trigger) so multiple in-flight dossier_changed bursts coalesce
 * into one run, while a manual replay can still queue alongside an
 * already-pending dossier_changed job.
 *
 * For 'dossier_changed' we apply a DEBOUNCE_MS delay — Bull's delayed-job
 * mechanism + the deterministic jobId means a newer enqueue overwrites the
 * older delayed job and we only run once at the tail of the burst.
 */
export async function enqueueAdjudication(
  claim_id: string,
  target_stage?: string,
  trigger: AdjudicationTrigger = 'dossier_changed',
): Promise<void> {
  if (!claim_id) {
    logger.warn(
      { claim_id, trigger },
      'enqueueAdjudication: claim_id required',
    );
    return;
  }
  try {
    const jobId = `${trigger}:${claim_id}`;
    const opts: Queue.JobOptions = {
      jobId,
    };
    if (trigger === 'dossier_changed') {
      opts.delay = DEBOUNCE_MS;
    }
    await queue.add({ claim_id, target_stage, trigger }, opts);
  } catch (err) {
    logger.warn(
      { err, claim_id, target_stage, trigger },
      'adjudicationEngine: enqueue failed (will be retried by upstream trigger)',
    );
  }
}

export function startAdjudicationEngineWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info(
      'adjudicationEngine worker NOT started (RUN_WORKERS=false)',
    );
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<AdjudicationJob>).process(5, async (job) => {
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
          'adjudicationEngine: job failed',
        );
        throw err; // let Bull retry per policy
      }
    });
    logger.info(
      'adjudicationEngine worker started (3 attempts × exponential backoff, concurrency=5)',
    );
  }
}

// Auto-start preserves the single-container backward compatibility used by
// the rest of the worker fleet. RUN_WORKERS=false on the API container
// suppresses processor registration.
startAdjudicationEngineWorker();

export default queue;
