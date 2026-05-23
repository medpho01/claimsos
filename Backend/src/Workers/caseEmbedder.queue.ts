/**
 * Case Embedder Worker — Sprint 4, Wave 4B
 *
 * Consumes jobs of the shape:
 *   { claim_id: string, force?: boolean }
 *
 * and calls EpisodicMemory.embedClaim. The service itself is idempotent
 * (skips when source_state_hash unchanged), so a coarse Bull-level dedup
 * via jobId = claim_id is enough to coalesce bursts.
 *
 * Trigger points (NOT wired by this wave — Wave 4C handles integration):
 *   - On adjudication_run when the report meaningfully shifts (readiness
 *     bucket changed, recommended_action changed). Captures the "this
 *     claim's situation just moved" semantic.
 *   - On claim_closed (closure_outcome set). Terminal embedding — the
 *     case is done, lock in its summary as it left the system.
 *   - On operator-triggered "rebuild memory" admin action (force=true).
 *
 * Concurrency: 4 — Voyage rate limits are forgiving (~300 req/min on the
 * default tier) and most calls return in <1s. The embedder itself batches
 * up to 128 texts per call but we typically pass one summary per job.
 *
 * Retry: 3 attempts × exponential backoff. embedClaim's UPSERT means a
 * retry after a partial failure either re-runs cleanly or hits the
 * unchanged-hash short-circuit.
 *
 * RUN_WORKERS gating: same pattern as adjudicationEngine.queue —
 * the API container imports for enqueue, the worker container processes.
 */

import Queue from 'bull';

import { logger } from '../Utils/logger.js';

export const QUEUE_NAME = 'case-embedder';

export interface CaseEmbedJob {
  claim_id: string;
  /** Bypass the source_state_hash short-circuit. */
  force?: boolean;
}

const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue(): Queue.Queue<CaseEmbedJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<CaseEmbedJob>(QUEUE_NAME, {
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
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    },
  });

  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn(
        '[caseEmbedder] Redis not available — episodic memory updates paused.',
      );
    }
  });

  return q;
}

const queue: Queue.Queue<CaseEmbedJob> | typeof stubQueue = (() => {
  try {
    return createQueue();
  } catch (err) {
    logger.warn({ err }, 'failed to create case-embedder queue; using stub');
    return stubQueue;
  }
})();

// ─── Processor ─────────────────────────────────────────────────────────

async function processJob(job: Queue.Job<CaseEmbedJob>): Promise<unknown> {
  const { claim_id, force } = job.data;
  if (!claim_id) {
    logger.warn({ jobData: job.data }, 'caseEmbedder: malformed job (no claim_id)');
    return { skipped: true, reason: 'no_claim_id' };
  }

  // Dynamic import to avoid module-init cycles and to defer the embedder
  // singleton's env-var read to first job processing (so a worker boot
  // without VOYAGE_API_KEY still starts; the failure surfaces at job time).
  const { default: episodicMemory } = await import(
    '../Services/episodicMemory.service.js'
  );

  const result = await episodicMemory.embedClaim(claim_id, { force });
  logger.info(
    {
      claim_id,
      force: force === true,
      embedded: result.embedded,
      reason: result.reason,
      tokensUsed: result.tokensUsed,
      costInr: Number(result.costInr.toFixed(6)),
    },
    'caseEmbedder: job complete',
  );
  return result;
}

// ─── Public enqueue ────────────────────────────────────────────────────

/**
 * Enqueue an episodic embed for a claim. jobId = claim_id collapses
 * concurrent bursts (e.g. doc-classified + extracted + segmented all
 * firing within seconds) to a single embed at the tail.
 *
 * `force` skips dedup AND the unchanged-hash short-circuit downstream —
 * used by the admin "rebuild memory" action.
 */
export async function enqueueCaseEmbed(
  claim_id: string,
  opts?: { force?: boolean },
): Promise<void> {
  if (!claim_id) {
    logger.warn({ claim_id }, 'enqueueCaseEmbed: claim_id required');
    return;
  }
  try {
    const jobId = opts?.force ? `force:${claim_id}:${Date.now()}` : `embed:${claim_id}`;
    await queue.add(
      { claim_id, force: opts?.force === true },
      { jobId },
    );
  } catch (err) {
    logger.warn(
      { err, claim_id },
      'caseEmbedder: enqueue failed (non-fatal — backfill cron will catch up)',
    );
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────

export function startCaseEmbedderWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('caseEmbedder worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<CaseEmbedJob>).process(4, async (job) => {
      try {
        return await processJob(job);
      } catch (err) {
        logger.error(
          { err, jobId: job.id, jobData: job.data, attempt: job.attemptsMade },
          'caseEmbedder: job failed',
        );
        throw err;
      }
    });
    logger.info('caseEmbedder worker started (concurrency 4, 3 attempts)');
  }
}

// Auto-start preserves the same single-container backward compat the rest
// of the worker fleet uses. RUN_WORKERS=false suppresses processor registration.
startCaseEmbedderWorker();

export default queue;
