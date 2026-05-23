import Queue from 'bull';
import { logger } from '../Utils/logger.js';

/**
 * Inbound Notification Worker
 *
 * Wraps `notificationDispatch.dispatchInboundRevert(inboundId)` in a Bull
 * queue with retry. Solves A8: previously this dispatcher was called inline
 * with a try/catch in `emailMatching.service.match()` — if UltraMsg (the
 * underlying WhatsApp gateway) was briefly down, the notification was
 * logged and silently lost.
 *
 * Retry policy: 4 attempts with exponential backoff (10s, 20s, 40s). At
 * 80 cumulative seconds we give up — by then either UltraMsg is unhealthy
 * for real (ops issue) or this specific job is bad data.
 *
 * Gated behind RUN_WORKERS so the API container can enqueue but only the
 * worker container processes (mirrors emailOutbox.queue).
 */

interface InboundNotificationJob {
  inboundId: string;
}

const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
} as any;

function createQueue(): Queue.Queue<InboundNotificationJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<InboundNotificationJob>('inbound-notification', {
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
      attempts: 4, // total tries including the first
      backoff: { type: 'exponential', delay: 10_000 }, // 10s, 20s, 40s
      removeOnComplete: 200,
      removeOnFail: 500,
    },
  });

  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn('[InboundNotificationQueue] Redis not available — notifications deferred.');
    }
  });

  return q;
}

const queue = createQueue();

export function startInboundNotificationWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('inboundNotification worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<InboundNotificationJob>).process(async (job) => {
      const { inboundId } = job.data;
      // Dynamic import to avoid circular module init across the worker boot.
      const { default: dispatcher } = await import('../Services/notificationDispatch.service.js');
      const result = await dispatcher.dispatchInboundRevert(inboundId);
      if (!result.whatsapp_sent && result.whatsapp_error) {
        // Surface as a job error so Bull retries per policy.
        throw new Error(`WhatsApp send failed: ${result.whatsapp_error}`);
      }
      return result;
    });
  }
  logger.info('inboundNotification worker started (4 attempts × exponential backoff)');
}

// Auto-start preserves single-container backward compatibility.
startInboundNotificationWorker();

export default queue;
