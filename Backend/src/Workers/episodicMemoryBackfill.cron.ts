/**
 * Episodic Memory Backfill Cron — Sprint 4, Wave 4B
 *
 * Nightly sweep that finds claims with missing or stale episodic
 * embeddings and enqueues them on the case-embedder queue.
 *
 * Why a cron (vs trigger-driven only): triggers cover the steady-state
 * path (dossier moves → embed), but:
 *   - Backfill: a fresh deployment has zero embeddings; we don't want
 *     the model agent to read empty retrieval results until every claim
 *     has been touched by an event.
 *   - Self-heal: jobs that failed mid-call leave rows in status='failed';
 *     the cron re-queues them.
 *   - Version bumps: when EPISODIC_VERSION ticks, all existing rows are
 *     implicitly stale. The cron picks them up without a manual migration.
 *
 * Schedule: nightly. Uses Bull's repeatable jobs (every: 24h) keyed off
 * a stable jobId so a deploy doesn't accidentally fan out duplicate cron
 * registrations.
 *
 * Batch size: 50 per tick. Each enqueue is cheap (Redis SADD), but we
 * cap so a backlog of 100k stale rows doesn't spike Voyage call volume
 * in a single minute. Multiple ticks chew through the backlog over
 * subsequent nights — acceptable for a v0 self-heal mechanism.
 *
 * RUN_WORKERS gating: the cron's processor only runs when the worker
 * container has the flag enabled. The repeatable-job registration is
 * also gated so a misconfigured API container doesn't accidentally
 * schedule the cron.
 */

import Queue from 'bull';

import { logger } from '../Utils/logger.js';
import { enqueueCaseEmbed } from './caseEmbedder.queue.js';

export const CRON_QUEUE_NAME = 'episodic-backfill-cron';
export const CRON_JOB_ID = 'episodic-backfill-cron-repeat';

interface CronJobData {
  trigger: 'cron' | 'manual';
}

const BATCH_SIZE = 50;

// 24h in ms — the cron tick interval.
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000;

const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
  getRepeatableJobs: async () => [],
  removeRepeatableByKey: async () => {},
} as any;

function createQueue(): Queue.Queue<CronJobData> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);
  const q = new Queue<CronJobData>(CRON_QUEUE_NAME, {
    redis: {
      host: url.hostname,
      port: parseInt(url.port || '6379'),
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times >= 3) return null;
        return Math.min(times * 200, 1000);
      },
    } as any,
    defaultJobOptions: {
      // Cron — short retry, we'll run again on the next tick.
      attempts: 2,
      backoff: { type: 'fixed', delay: 10_000 },
      removeOnComplete: 30,
      removeOnFail: 100,
    },
  });
  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn(
        '[episodicMemoryBackfill] Redis not available — backfill paused.',
      );
    }
  });
  return q;
}

const queue: Queue.Queue<CronJobData> | typeof stubQueue = (() => {
  try {
    return createQueue();
  } catch (err) {
    logger.warn({ err }, 'failed to create episodic-backfill-cron queue; using stub');
    return stubQueue;
  }
})();

// ─── The unit of work ──────────────────────────────────────────────────

/**
 * Find claims that need (re)embedding and enqueue them.
 *
 * Two cohorts, unioned with a cap so the worst case is bounded:
 *   1. Claims with NO embedding row at all (case_embeddings.claim_id IS NULL).
 *   2. Claims whose embedding is status IN ('stale', 'failed').
 *
 * Ordering: rows that closed recently first — a freshly-closed claim
 * being missing its terminal embedding is more painful than an
 * old-and-active claim still being stale.
 */
export async function runOnce(): Promise<{
  enqueuedCount: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  let enqueuedCount = 0;

  try {
    // Dynamic import to avoid forcing the DB pool to open during module
    // load — keeps `import` cheap in test contexts.
    const { pool } = await import('../DB/db.js');

    const res = await pool.query<{ id: string }>(
      `SELECT i.id
         FROM hospital.ipds i
         LEFT JOIN hospital.case_embeddings ce ON ce.claim_id = i.id
        WHERE ce.claim_id IS NULL
           OR ce.status IN ('stale', 'failed')
        ORDER BY i.updated_at DESC NULLS LAST
        LIMIT $1`,
      [BATCH_SIZE],
    );

    for (const row of res.rows) {
      try {
        await enqueueCaseEmbed(row.id);
        enqueuedCount += 1;
      } catch (err) {
        logger.warn(
          { err, claim_id: row.id },
          'episodicMemoryBackfill: enqueue failed for one claim',
        );
      }
    }
  } catch (err) {
    logger.error(
      { err },
      'episodicMemoryBackfill: SQL probe failed; nothing enqueued this tick',
    );
  }

  const durationMs = Date.now() - startedAt;
  logger.info(
    { enqueuedCount, durationMs },
    'episodicMemoryBackfill: tick complete',
  );
  return { enqueuedCount, durationMs };
}

// ─── Boot / schedule ───────────────────────────────────────────────────

export function startEpisodicBackfillCron(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('episodicMemoryBackfill cron NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process !== 'function') return;

  // Register processor.
  (queue as Queue.Queue<CronJobData>).process(async (_job) => {
    return runOnce();
  });

  // Schedule the repeatable. isReady-style guard (best-effort) so a
  // Redis-less boot doesn't crash; the cron just won't fire.
  void scheduleRepeat(queue as Queue.Queue<CronJobData>);

  logger.info('episodicMemoryBackfill cron started (every 24h, batch 50)');
}

async function scheduleRepeat(q: Queue.Queue<CronJobData>): Promise<void> {
  try {
    // Clear any pre-existing repeatables under our key so an interval
    // change picks up cleanly on the next deploy. Same pattern as
    // gmailPoll.queue.ts.
    const existing = (await q.getRepeatableJobs?.().catch(() => [])) ?? [];
    for (const r of existing) {
      if ((r as any).id === CRON_JOB_ID) {
        await q.removeRepeatableByKey?.((r as any).key).catch(() => {});
      }
    }
    await q.add(
      { trigger: 'cron' },
      {
        jobId: CRON_JOB_ID,
        repeat: { every: REPEAT_EVERY_MS },
      },
    );
  } catch (err) {
    logger.warn(
      { err },
      'episodicMemoryBackfill: schedule setup failed; manual runOnce() still available',
    );
  }
}

// Auto-start matches the rest of the worker fleet. RUN_WORKERS=false on
// the API container suppresses both the processor and the schedule call.
startEpisodicBackfillCron();

export default queue;
