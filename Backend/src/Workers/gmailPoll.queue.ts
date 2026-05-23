import Queue from 'bull';
import gmailInboundService from '../Services/gmailInbound.service.js';
import { logger } from '../Utils/logger.js';

/**
 * Gmail Polling Worker
 *
 * Scheduled cron job that wakes up every GMAIL_POLL_INTERVAL_SECONDS
 * (default 120s = 2 min), lists hospitals with valid Gmail OAuth, and
 * calls gmailInboundService.pollHospital() for each. Per-hospital errors
 * are isolated — one hospital's auth failure doesn't stop the others.
 *
 * Replaces the Pub/Sub push path (gmailWatch.service + pubsubPush webhook).
 * Org-policy friction free: no Pub/Sub topic, no IAM grants to
 * gmail-api-push@system.gserviceaccount.com.
 *
 * Latency trade-off: ~1-2 min instead of <10s with Pub/Sub. For the
 * Cashless Everywhere workflow, where insurer turnaround is hours/days,
 * this is invisible.
 *
 * Manual triggers: the controller exposes a "force poll now" endpoint
 * that calls runOnce() directly — used by the ops "Force poll" button.
 */

interface GmailPollJobData {
  // No-op placeholder; the worker discovers its targets at run time.
  trigger: 'cron' | 'manual';
}

const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

const POLL_INTERVAL_SECONDS = parseInt(
  process.env.GMAIL_POLL_INTERVAL_SECONDS || '120',
  10
);
const QUEUE_NAME = 'gmail-poll';

function createQueue(): Queue.Queue<GmailPollJobData> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<GmailPollJobData>(QUEUE_NAME, {
    redis: {
      host: url.hostname,
      port: parseInt(url.port || '6379'),
      // Cron schedule writes happen at startup before Bull's connection is
      // fully writable; offline queueing lets those buffer briefly. The
      // overall worker still fails fast if Redis is truly unavailable —
      // retryStrategy below gives up after the first reconnect attempt.
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times >= 3) return null;
        return Math.min(times * 200, 1000);
      },
    } as any,
    defaultJobOptions: {
      // Cron jobs: short retry; we run again on the next tick anyway.
      attempts: 2,
      backoff: { type: 'fixed', delay: 5000 },
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  });

  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn('[GmailPoll] Redis not available — polling disabled until reconnect.');
    }
  });

  q.process(async (_job: Queue.Job<GmailPollJobData>) => {
    return runOnce();
  });

  return q;
}

/**
 * The unit of work: poll all connected hospitals once.
 */
export async function runOnce(): Promise<{
  hospitalCount: number;
  processed: number;
  skipped: number;
  failed: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  const hospitalIds = await gmailInboundService.listConnectedHospitalIds();
  for (const hospitalId of hospitalIds) {
    try {
      const result = await gmailInboundService.pollHospital(hospitalId);
      processed += result.processed;
      skipped += result.skipped;
      failed += result.failed;
    } catch (err) {
      failed += 1;
      logger.error({ err, hospitalId }, 'gmailPoll: hospital poll threw');
    }
  }

  const durationMs = Date.now() - startedAt;
  // Quiet by default — only log when there's something interesting.
  if (processed > 0 || failed > 0) {
    logger.info(
      { hospitalCount: hospitalIds.length, processed, skipped, failed, durationMs },
      'gmailPoll: cycle complete'
    );
  }
  return { hospitalCount: hospitalIds.length, processed, skipped, failed, durationMs };
}

const queue = createQueue();

/**
 * Start the cron schedule. Called once from index.ts at boot.
 * Uses repeat.every (ms) so a single repeat-job stays in Redis and
 * picks up on each backend restart instead of accumulating duplicates.
 */
export async function startGmailPollCron(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.GMAIL_POLL_ENABLED === 'false') {
    logger.info('gmailPoll cron disabled via GMAIL_POLL_ENABLED=false');
    return;
  }
  // Skip on the API container when RUN_WORKERS=false. Workers run in the
  // dedicated worker container instead, which has RUN_WORKERS unset (or =true).
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('gmailPoll cron NOT started (RUN_WORKERS=false)');
    return;
  }

  const q = queue as Queue.Queue<GmailPollJobData>;
  // We disabled enableOfflineQueue on the redis client so failed connections
  // bail fast — that means we MUST wait for the connection to be live before
  // scheduling the repeatable. isReady() resolves once Bull's clients connect;
  // if Redis is unavailable it rejects after the retryStrategy gives up.
  try {
    await Promise.race([
      q.isReady(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('redis not ready in 5s')), 5000)
      ),
    ]);
  } catch (err) {
    logger.warn({ err }, 'gmailPoll cron skipped — redis not reachable');
    return;
  }

  try {
    // Clear previously scheduled repeats so interval changes pick up cleanly
    const repeatables = await q.getRepeatableJobs?.().catch(() => []);
    for (const r of repeatables ?? []) {
      if (r.name === '__default__' || r.key.startsWith(QUEUE_NAME)) {
        await q.removeRepeatableByKey?.(r.key).catch(() => {});
      }
    }
    await q.add(
      { trigger: 'cron' },
      {
        repeat: { every: POLL_INTERVAL_SECONDS * 1000 },
        jobId: 'gmail-poll-recurring',
      } as any
    );
    logger.info(
      { intervalSeconds: POLL_INTERVAL_SECONDS },
      'gmailPoll cron scheduled'
    );
  } catch (err) {
    logger.warn({ err }, 'gmailPoll cron setup failed; manual /force-poll still available');
  }
}

export default queue;
