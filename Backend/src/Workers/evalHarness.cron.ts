/**
 * Eval Harness Cron — Sprint 4, Wave 5A
 *
 * Two nightly jobs sharing one repeatable queue:
 *
 *   * Nightly resolve-actuals sweep (03:00 every day):
 *     For every claim that closed in the past day, call
 *     EvalHarness.resolveActuals(claim_id). This catches any cases the
 *     event-driven trigger (Workers/evalHarnessTriggers.ts) missed —
 *     stage-transitioned events landing in a transient window where the
 *     trigger wasn't subscribed, etc. Belt-and-braces.
 *
 *   * Weekly regression sweep (03:00 every Sunday):
 *     Runs EvalHarness.backtest() against the last 14 days of closed
 *     claims and emits the summary into the application log. Hooks into
 *     the "should we ship new rules?" decision — when an ops engineer
 *     bumps RULES_VERSION on Monday, Sunday's regression sweep is what
 *     surfaces the change shape before they commit to it.
 *
 * Not auto-started — RUN_WORKERS=false suppresses both registration and
 * processor wiring. The integration sprint mounts via the exported
 * `scheduleEvalHarnessCron()` + `startEvalHarnessCronWorker()` at boot.
 *
 * NOT wired into src/index.ts on purpose — the spec explicitly forbids it.
 */

import Queue from 'bull';

import { logger } from '../Utils/logger.js';
import evalHarness from '../Services/evalHarness.service.js';

export const QUEUE_NAME = 'eval-harness-cron';
const NIGHTLY_JOB_ID = 'eval-harness-nightly';
const WEEKLY_JOB_ID = 'eval-harness-weekly-regression';

// 03:00 daily.
const NIGHTLY_CRON = '0 3 * * *';
// 03:00 every Sunday.
const WEEKLY_CRON = '0 3 * * 0';

interface CronJobData {
  trigger: 'nightly' | 'weekly';
  // For manual replays — overrides the default sinceDays/maxClaims.
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

function createQueue(): Queue.Queue<CronJobData> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);
  try {
    const q = new Queue<CronJobData>(QUEUE_NAME, {
      redis: {
        host: url.hostname,
        port: parseInt(url.port || '6379'),
        retryStrategy: (times: number) =>
          times >= 3 ? null : Math.min(times * 500, 2000),
        enableOfflineQueue: false,
      } as any,
      defaultJobOptions: {
        // Cron — short retry, next tick will catch any miss.
        attempts: 2,
        backoff: { type: 'fixed', delay: 60_000 },
        removeOnComplete: 30,
        removeOnFail: 60,
      },
    });
    q.on('error', (err: Error) => {
      if ((err as any).code === 'ECONNREFUSED') {
        console.warn('[eval-harness-cron] Redis not available; cron paused.');
      }
    });
    return q;
  } catch (err) {
    logger.warn({ err }, 'eval-harness-cron: queue init failed; using stub');
    return stubQueue;
  }
}

const queue = createQueue();

// ─── Processors ───────────────────────────────────────────────────────────

/**
 * Nightly resolve-actuals: walk claims closed in the past 24h and
 * resolve their outstanding eval rows.
 *
 * Why query closed claims rather than unresolved eval rows directly:
 *   - Unresolved eval rows include in-flight claims whose target_stage
 *     hasn't been reached yet. Iterating over them would mostly be a
 *     no-op (isPastTargetStage returns false).
 *   - Closed claims are guaranteed to have at least their final
 *     target_stage in the past, so the resolve call always makes
 *     progress.
 *
 * Best-effort: per-claim errors are logged, the sweep continues.
 */
async function runNightlyResolve(): Promise<{
  claimsScanned: number;
  rowsResolved: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  let claimsScanned = 0;
  let rowsResolved = 0;

  try {
    const { pool } = await import('../DB/db.js');
    const res = await pool.query<{ claim_id: string }>(
      `SELECT DISTINCT d.claim_id
         FROM hospital.claim_dossiers d
         JOIN hospital.adjudication_eval e ON e.claim_id = d.claim_id
        WHERE d.closed_at IS NOT NULL
          AND d.closed_at >= NOW() - INTERVAL '2 days'
          AND e.resolved_at IS NULL`,
    );
    for (const row of res.rows) {
      claimsScanned += 1;
      try {
        const r = await evalHarness.resolveActuals(row.claim_id);
        rowsResolved += r.rowsResolved;
      } catch (err) {
        logger.warn(
          { err, claim_id: row.claim_id },
          'eval-harness-cron: per-claim resolve failed',
        );
      }
    }
  } catch (err) {
    logger.error(
      { err },
      'eval-harness-cron: nightly resolve SQL probe failed',
    );
  }

  const durationMs = Date.now() - startedAt;
  logger.info(
    { claimsScanned, rowsResolved, durationMs },
    'eval-harness-cron: nightly resolve sweep complete',
  );
  return { claimsScanned, rowsResolved, durationMs };
}

/**
 * Weekly regression sweep — runs backtest against the last 14 days
 * (configurable via job payload).
 */
async function runWeeklyRegression(data: CronJobData): Promise<unknown> {
  const sinceDays = data.sinceDays ?? 14;
  const maxClaims = data.maxClaims ?? 100;
  const result = await evalHarness.backtest({ sinceDays, maxClaims });
  logger.info(
    {
      sinceDays,
      maxClaims,
      claims_replayed: result.claims_replayed,
      mean_readiness_delta: result.summary.mean_readiness_delta,
      action_change_count: result.summary.action_change_count,
    },
    'eval-harness-cron: weekly regression sweep complete',
  );
  // Return summary only — the deltas array is potentially large; the
  // structured log line carries the headlines for ops.
  return {
    claims_replayed: result.claims_replayed,
    summary: result.summary,
  };
}

async function processJob(job: Queue.Job<CronJobData>): Promise<unknown> {
  if (job.data.trigger === 'weekly') {
    return await runWeeklyRegression(job.data);
  }
  return await runNightlyResolve();
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Register both repeatable cron jobs. Idempotent — clears any
 * pre-existing repeatables with our keys so a cron-expression change
 * picks up cleanly on redeploy.
 */
export async function scheduleEvalHarnessCron(
  q: Queue.Queue<CronJobData> | typeof stubQueue = queue,
): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('eval-harness-cron NOT scheduled (RUN_WORKERS=false)');
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
    logger.warn({ err }, 'eval-harness-cron skipped — redis not reachable');
    return;
  }

  try {
    const repeatables = (await (q as any).getRepeatableJobs?.()) ?? [];
    for (const r of repeatables) {
      if (
        r.id === NIGHTLY_JOB_ID ||
        r.id === WEEKLY_JOB_ID ||
        r.key?.includes(NIGHTLY_JOB_ID) ||
        r.key?.includes(WEEKLY_JOB_ID)
      ) {
        await (q as any).removeRepeatableByKey?.(r.key).catch(() => {});
      }
    }
    await (q as any).add(
      { trigger: 'nightly' },
      { jobId: NIGHTLY_JOB_ID, repeat: { cron: NIGHTLY_CRON } },
    );
    await (q as any).add(
      { trigger: 'weekly' },
      { jobId: WEEKLY_JOB_ID, repeat: { cron: WEEKLY_CRON } },
    );
    logger.info(
      { nightly: NIGHTLY_CRON, weekly: WEEKLY_CRON },
      'eval-harness-cron scheduled',
    );
  } catch (err) {
    logger.warn({ err }, 'eval-harness-cron setup failed');
  }
}

/**
 * Start the processor. Called from boot in the worker container.
 */
export function startEvalHarnessCronWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('eval-harness-cron worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<CronJobData>).process(1, async (job) => {
      try {
        return await processJob(job);
      } catch (err) {
        logger.error(
          { err, jobId: job.id, attempt: job.attemptsMade, data: job.data },
          'eval-harness-cron: job processing failed',
        );
        throw err;
      }
    });
    logger.info('eval-harness-cron worker started (concurrency 1)');
  }
}

/**
 * Manually enqueue a regression backtest. Used by the
 * POST /api/eval/backtest controller (which is superadmin-gated).
 */
export async function enqueueManualBacktest(opts: {
  sinceDays?: number;
  maxClaims?: number;
} = {}): Promise<void> {
  try {
    await (queue as any).add({
      trigger: 'weekly',
      sinceDays: opts.sinceDays,
      maxClaims: opts.maxClaims,
    });
  } catch (err) {
    logger.warn({ err, opts }, 'eval-harness-cron: manual enqueue failed');
    throw err;
  }
}

// NOT auto-started — integration sprint invokes scheduleEvalHarnessCron +
// startEvalHarnessCronWorker at boot. Spec explicitly forbids touching
// src/index.ts in this lane.

export default queue;
