/**
 * Sprint 3, Wave 4A — KB Pattern Miner Cron
 *
 * Repeatable Bull job that runs the miner nightly. Job behaviour:
 *
 *   * Schedule: nightly at 02:00 local time (cron expression below).
 *   * Single repeatable job in Redis (no duplication across restarts —
 *     same dedup pattern as gmailPoll.queue.ts).
 *   * RUN_WORKERS gated: the API container imports for the scheduler
 *     helper but never processes; the dedicated worker container picks up
 *     the cron firings.
 *   * Errors are logged but not surfaced to a user-facing alert channel
 *     yet — the miner is best-effort and a missed night is not a P1.
 *     Wave 5 wires a notification dispatch (TODO marker below).
 *
 * NOT wired into src/index.ts on purpose — the spec explicitly forbids it.
 * Integration sprint mounts via `scheduleKbPatternMiner(queue)` at boot.
 */

import Queue from 'bull';

import { logger } from '../Utils/logger.js';
import {
  KbPatternMiner,
  MINER_VERSION,
  type MineOptions,
} from '../Services/kbPatternMiner.service.js';

export const QUEUE_NAME = 'kb-pattern-miner-cron';
const REPEATABLE_JOB_ID = 'kb-pattern-miner-recurring';
// 02:00 every day. Cron is in node-cron / Bull's interpretation: minute,
// hour, day-of-month, month, day-of-week. "0 2 * * *" = 02:00 daily.
const CRON_EXPRESSION = '0 2 * * *';

export interface KbPatternMinerJob {
  trigger: 'cron' | 'manual';
  sinceDays?: number;
  maxClaims?: number;
}

// Stub mirrors the pattern used elsewhere — keeps non-Redis environments
// (CLI tools, tests) importable.
const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
  getRepeatableJobs: async () => [] as any[],
  removeRepeatableByKey: async () => undefined,
} as any;

function createQueue(): Queue.Queue<KbPatternMinerJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);
  try {
    const q = new Queue<KbPatternMinerJob>(QUEUE_NAME, {
      redis: {
        host: url.hostname,
        port: parseInt(url.port || '6379'),
        retryStrategy: (times: number) => (times >= 3 ? null : Math.min(times * 500, 2000)),
        enableOfflineQueue: false,
      } as any,
      defaultJobOptions: {
        // The miner is idempotent (ON CONFLICT bump) so retry is safe, but
        // a single retry is enough — if it fails twice, log and skip the
        // night.
        attempts: 2,
        backoff: { type: 'fixed', delay: 60_000 },
        removeOnComplete: 30,
        removeOnFail: 60,
      },
    });
    q.on('error', (err: Error) => {
      if ((err as any).code === 'ECONNREFUSED') {
        console.warn('[kb-pattern-miner-cron] Redis not available; cron paused.');
      }
    });
    return q;
  } catch (err) {
    logger.warn({ err }, 'kb-pattern-miner-cron: queue init failed; using stub');
    return stubQueue;
  }
}

const queue = createQueue();

// ─── Processor ────────────────────────────────────────────────────────────

async function processJob(job: Queue.Job<KbPatternMinerJob>): Promise<unknown> {
  const start = Date.now();
  const opts: MineOptions = {};
  if (typeof job.data?.sinceDays === 'number') opts.sinceDays = job.data.sinceDays;
  if (typeof job.data?.maxClaims === 'number') opts.maxClaims = job.data.maxClaims;

  const miner = new KbPatternMiner();
  try {
    const result = await miner.mineCandidatesFromClosedClaims(opts);
    logger.info(
      {
        trigger: job.data?.trigger ?? 'cron',
        candidatesAdded: result.candidatesAdded,
        existingReinforced: result.existingReinforced,
        durationMs: Date.now() - start,
        minerVersion: MINER_VERSION,
      },
      'kbPatternMiner.cron: mining run complete',
    );
    return result;
  } catch (err) {
    // TODO(wave-5): surface to ops via notificationDispatch once an
    // appropriate channel exists for system-health alerts. For now, log
    // loudly — the cron is best-effort.
    logger.error(
      { err, jobData: job.data, durationMs: Date.now() - start },
      'kbPatternMiner.cron: mining run failed',
    );
    throw err;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Register the repeatable cron job. Idempotent — removes any prior
 * repeatable with the same id before re-adding so the cron expression
 * picks up changes cleanly on redeploy.
 *
 * Mirrors gmailPoll's startGmailPollCron pattern.
 */
export async function scheduleKbPatternMiner(
  q: Queue.Queue<KbPatternMinerJob> | typeof stubQueue = queue,
): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('kbPatternMiner cron NOT scheduled (RUN_WORKERS=false)');
    return;
  }

  try {
    await Promise.race([
      (q as any).isReady?.(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('redis not ready in 5s')), 5000),
      ),
    ]);
  } catch (err) {
    logger.warn({ err }, 'kbPatternMiner cron skipped — redis not reachable');
    return;
  }

  // Bull's getRepeatableJobs() races the underlying ioredis subscribe
  // stream during a cold start of the worker — q.isReady() resolves once
  // the main connection is up, but the subscriber/blocking connection
  // Bull uses internally may still be mid-handshake, and the very first
  // ZREVRANGE call then fails with "Stream isn't writeable and
  // enableOfflineQueue options is false". A one-shot retry after a short
  // settle gives Bull's internal connections time to become writable —
  // observed reliable on every boot we've debugged.
  const attempt = async (): Promise<void> => {
    const repeatables = (await (q as any).getRepeatableJobs?.()) ?? [];
    for (const r of repeatables) {
      if (r.id === REPEATABLE_JOB_ID || r.key?.includes(REPEATABLE_JOB_ID)) {
        await (q as any).removeRepeatableByKey?.(r.key).catch(() => {});
      }
    }
    await (q as any).add(
      { trigger: 'cron' },
      {
        jobId: REPEATABLE_JOB_ID,
        repeat: { cron: CRON_EXPRESSION },
      },
    );
  };

  try {
    await attempt();
    logger.info({ cron: CRON_EXPRESSION }, 'kbPatternMiner cron scheduled');
  } catch (err) {
    logger.warn(
      { err: (err as any)?.message ?? String(err) },
      'kbPatternMiner cron initial schedule failed — retrying in 2s',
    );
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await attempt();
      logger.info(
        { cron: CRON_EXPRESSION },
        'kbPatternMiner cron scheduled on retry',
      );
    } catch (err2) {
      logger.error(
        { err: (err2 as any)?.message ?? String(err2) },
        'kbPatternMiner cron setup failed after retry — patterns will NOT be auto-mined until next worker restart',
      );
    }
  }
}

/**
 * Start the processor. Called from boot in the worker container; the API
 * container's RUN_WORKERS=false suppresses processor registration.
 */
export function startKbPatternMinerWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('kbPatternMiner worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<KbPatternMinerJob>).process(1, async (job) => {
      try {
        return await processJob(job);
      } catch (err) {
        logger.error(
          { err, jobId: job.id, attempt: job.attemptsMade },
          'kbPatternMiner.cron: job processing failed',
        );
        throw err;
      }
    });
    logger.info('kbPatternMiner worker started (concurrency 1)');
  }
}

/**
 * Manually enqueue a one-off mining run. Used by the admin endpoint
 * (POST /api/admin/kb-miner/run). The cron-recurring jobId is NOT reused
 * here so a manual run doesn't shift the nightly schedule.
 */
export async function enqueueManualMineRun(
  opts: MineOptions = {},
): Promise<void> {
  try {
    await (queue as any).add({
      trigger: 'manual',
      sinceDays: opts.sinceDays,
      maxClaims: opts.maxClaims,
    });
  } catch (err) {
    logger.warn({ err, opts }, 'kbPatternMiner cron: manual enqueue failed');
    throw err;
  }
}

// NOT auto-started — caller invokes `scheduleKbPatternMiner` +
// `startKbPatternMinerWorker` at app boot. Spec explicitly forbids
// touching src/index.ts in this lane.

export default queue;
