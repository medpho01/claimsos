/**
 * Claim Harmoniser Worker — Wave 7
 *
 * Consumes jobs of the shape:
 *   { claim_id, hospital_id, force? }
 *
 * and runs HarmonisationService.harmonise on them. The service itself
 * does dossier_state_hash caching so a no-op re-run is ~free — the
 * Bull-level dedup via jobId is the second layer.
 *
 * Why a queue (vs inline call from intelligenceOrchestrator):
 *   - Harmonisation hits Sonnet. We don't want a UI-triggered
 *     "analyze this claim" to block on a ~6-10s LLM call when the
 *     dossier rebuild + adjudication run can return in ~200ms.
 *   - Bursts of doc-uploads → segmentations → extractions can fan
 *     into multiple "harmonise this claim" enqueues; Bull's
 *     jobId-based dedup coalesces them into one run.
 *
 * Retry policy:
 *   - 3 attempts × exponential backoff with a 60s base. Sonnet calls
 *     are expensive and slow — we don't want to retry quickly on a
 *     transient failure. 60s → 120s → 240s gives the provider's
 *     5xx storms time to clear and leaves token waste minimal.
 *
 * Concurrency:
 *   - 2. Sonnet is expensive (~₹1/call). The hospital-level cost cap
 *     enforces the macro budget, but at the worker level we also want
 *     to throttle so a backfill across hundreds of claims doesn't
 *     drain the daily cap in minutes. Bump after we have steady-state
 *     telemetry on llm_cost_log.
 *
 * RUN_WORKERS gating mirrors the other Wave workers — the API container
 * imports this module to enqueue jobs but RUN_WORKERS=false suppresses
 * processor registration.
 */

import Queue from 'bull';

import { logger } from '../Utils/logger.js';
import harmonisationService from '../Services/harmonisation.service.js';

export interface ClaimHarmoniserJob {
  claim_id: string;
  hospital_id: string;
  force?: boolean;
}

// ────────────────────────────────────────────────────────────────────────
// Stub queue — keeps the API container alive when Redis isn't reachable.
// ────────────────────────────────────────────────────────────────────────

const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue(): Queue.Queue<ClaimHarmoniserJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<ClaimHarmoniserJob>('claim-harmoniser', {
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
      // 60s base — Sonnet calls are ~₹1/run, so we wait long between
      // retries to give transient provider issues time to clear.
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 200,
      removeOnFail: 1000,
    },
  });

  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn(
        '[claim-harmoniser] Redis not available — harmonisation deferred until reconnect.',
      );
    }
  });

  return q;
}

const queue = createQueue();

// ────────────────────────────────────────────────────────────────────────
// Processor
// ────────────────────────────────────────────────────────────────────────

async function processJob(job: Queue.Job<ClaimHarmoniserJob>): Promise<void> {
  const { claim_id, hospital_id, force } = job.data;
  if (!claim_id || !hospital_id) {
    logger.warn(
      { jobData: job.data },
      'claimHarmoniser: malformed job (missing claim_id/hospital_id), skipping',
    );
    return;
  }

  logger.info(
    {
      claim_id,
      hospital_id,
      force: force === true,
      attempt: job.attemptsMade + 1,
    },
    'claimHarmoniser: starting',
  );

  const row = await harmonisationService.harmonise({
    claim_id,
    hospital_id,
    force: force === true,
  });

  logger.info(
    {
      claim_id,
      status: row.status,
      cost_inr: row.cost_inr,
      tokens_used: row.tokens_used,
      dossier_state_hash: row.dossier_state_hash,
    },
    'claimHarmoniser: complete',
  );
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

export interface EnqueueOpts {
  force?: boolean;
  /**
   * Override the deduplication jobId. By default we coalesce all
   * non-forced enqueues for a given claim under a single jobId
   * (`harmonise:<claim_id>`) so bursts of upstream events collapse.
   * Forced enqueues use a wall-clock-suffixed id so a user-triggered
   * regen doesn't get swallowed by an in-flight idempotent job.
   */
  idempotencyKey?: string;
}

/**
 * Enqueue a harmonisation job. Coalesces by jobId — multiple
 * non-forced enqueues for the same claim collapse into a single
 * processing attempt.
 */
export async function enqueueClaimHarmonisation(
  claim_id: string,
  hospital_id: string,
  opts: EnqueueOpts = {},
): Promise<void> {
  if (!claim_id || !hospital_id) {
    logger.warn({ claim_id, hospital_id }, 'enqueueClaimHarmonisation: ids required');
    return;
  }
  const force = opts.force === true;
  const jobId =
    opts.idempotencyKey ??
    (force ? `harmonise:force:${claim_id}:${Date.now()}` : `harmonise:${claim_id}`);
  try {
    await queue.add(
      { claim_id, hospital_id, force },
      { jobId },
    );
  } catch (err) {
    logger.warn(
      { err, claim_id, hospital_id, force },
      'claimHarmoniser: enqueue failed (caller should retry once Redis is back)',
    );
  }
}

export function startClaimHarmoniserWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('claimHarmoniser worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<ClaimHarmoniserJob>).process(2, async (job) => {
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
          'claimHarmoniser: job failed',
        );
        throw err; // let Bull retry per policy
      }
    });
    logger.info(
      'claimHarmoniser worker started (3 attempts × exponential backoff @ 60s, concurrency=2)',
    );
  }
}

// Auto-start preserves the single-container backward compatibility used by
// the rest of the worker fleet. RUN_WORKERS=false on the API container
// suppresses processor registration.
startClaimHarmoniserWorker();

export default queue;
