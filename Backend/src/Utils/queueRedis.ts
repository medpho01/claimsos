/**
 * Single source of truth for the Bull/ioredis producer-connection retry policy.
 *
 * BUG THIS FIXES (prod incident 2026-06-01):
 *   Every queue file used to inline this retryStrategy:
 *
 *       retryStrategy: (times) => { if (times >= 1) return null; return 500; }
 *
 *   Returning `null` tells ioredis to STOP reconnecting — permanently. So the
 *   first time the connection dropped (a Redis restart, a network blip), the
 *   client ended itself and never came back. From then on every `queue.add()`
 *   threw "Connection is closed" until the *process* was restarted.
 *
 *   On 2026-06-01 a Redis restart wedged the API container's producer client
 *   exactly this way. The worker survived only because it happened to be
 *   restarted at the same moment (fresh connect to a live Redis). Claim
 *   analyses then silently stuck in 'queued': the enqueue threw, the helper
 *   swallowed it ("reconciler will retry"), and no job ever ran.
 *
 * THE FIX:
 *   Reconnect forever with a capped linear backoff. This mirrors ioredis's own
 *   sane default (min(times*50, 2000)) but a little gentler. A transient Redis
 *   outage now self-heals: the client keeps trying and resumes enqueuing the
 *   moment Redis is back — no manual process restart required.
 *
 *   NOTE: this only governs *reconnection*. We deliberately keep
 *   `enableOfflineQueue: false` on the queues (see redisOfflineFilter.ts) so we
 *   never memory-buffer jobs while Redis is down — an enqueue attempted during
 *   the actual outage window still fails fast. That gap is covered durably by
 *   the claim-run reconciler (claimRunReconciler.cron.ts), which re-drives any
 *   run left stranded in 'queued'.
 */
export function queueRetryStrategy(times: number): number {
  return Math.min(times * 200, 5000);
}
