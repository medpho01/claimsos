/**
 * Global per-process LLM concurrency semaphore.
 *
 * Why this exists:
 *   Bull queue-level concurrency caps the number of JOBS in flight per
 *   queue (e.g. docExtractor.process(N, …)), but jobs across multiple
 *   queues (classify + segment + extract + harmonise) all hit the same
 *   Anthropic account. Under load the sum of per-queue concurrencies
 *   can blow past the account RPM/TPM ceiling → 429 retry storms → tail
 *   latency explodes → looks like the pipeline is "stuck". This
 *   semaphore caps the TOTAL number of in-flight LLM calls per worker
 *   process, independent of which queue the call originated in, so
 *   bumping queue concurrencies (Tier 1.1) cannot accidentally swamp
 *   Anthropic.
 *
 * Why per-model pools (haiku vs sonnet):
 *   Sonnet costs ~5× more per token and is ~3-5× larger per call (huge
 *   harmoniser prompts). At Anthropic's tier-1 limits, Sonnet's TPM is
 *   the binding constraint long before Haiku's. A single pool would
 *   starve cheap Haiku traffic (classify, dedup, page-read) behind a
 *   backlog of slow Sonnet harmoniser calls. Independent pools give
 *   Haiku and Sonnet their own slots so cheap-and-fast work isn't
 *   blocked by expensive-and-slow work, and each pool can be tuned to
 *   the model's published rate limits.
 *
 * Scope (deliberate):
 *   PER-PROCESS (not cross-worker). When scaling worker containers
 *   horizontally (`docker-compose up --scale worker=N`), the effective
 *   global limit is `N × per-pool cap`. Tune the per-pool envs down as
 *   you scale workers up so total stays comfortably below the account
 *   ceiling. A Redis-backed token bucket would give true cross-worker
 *   global limiting — deferred to Tier 2, ship that when there's a
 *   real signal we're hitting account-wide caps.
 *
 * Tunables (env-var, all integer):
 *   LLM_MAX_CONCURRENT_HAIKU   — default 24
 *   LLM_MAX_CONCURRENT_SONNET  — default  8
 *   Numbers chosen to comfortably accommodate the Tier 1 queue bumps
 *   (classifier 8 + segmenter 8 + classifier 12 + extractor 16 +
 *    harmoniser 4 = 48 jobs, but most are Haiku and not all are in
 *    flight at the same instant).
 *
 * Errors: never throws. Callers always get a slot eventually; FIFO
 * within each pool. The release function is idempotent (safe to call
 * twice, or call from a finally block on any code path).
 */

import { logger } from './logger.js';

type Pool = 'haiku' | 'sonnet';

const MAX_HAIKU = Math.max(
  1,
  parseInt(process.env.LLM_MAX_CONCURRENT_HAIKU ?? '24', 10),
);
const MAX_SONNET = Math.max(
  1,
  parseInt(process.env.LLM_MAX_CONCURRENT_SONNET ?? '8', 10),
);

const max: Record<Pool, number> = { haiku: MAX_HAIKU, sonnet: MAX_SONNET };
const inFlight: Record<Pool, number> = { haiku: 0, sonnet: 0 };
const waiters: Record<Pool, Array<() => void>> = { haiku: [], sonnet: [] };

/**
 * Classify a model id into a pool. Anything matching "sonnet" or "opus"
 * lands in the sonnet pool (large/expensive); everything else in haiku.
 * Conservative on unknowns: a new model that doesn't match either pattern
 * uses haiku slots (cheap pool); if it's actually a big-and-slow model
 * we'd just see contention and bump the cap.
 */
function poolOf(model: string): Pool {
  return /sonnet|opus/i.test(model) ? 'sonnet' : 'haiku';
}

/**
 * Acquire a slot for an LLM call against the given model. Returns a
 * release function — call it once the network call returns (success or
 * error; the canonical pattern is a try/finally around messages.create).
 *
 * Waits FIFO within the chosen pool when at capacity. Never times out —
 * the underlying SDK call has its own timeout and that's the right
 * place to bound a hung call (semaphore timeouts would just turn a
 * recoverable wait into an irrecoverable error).
 */
export async function acquireLlmSlot(model: string): Promise<() => void> {
  const pool = poolOf(model);
  while (inFlight[pool] >= max[pool]) {
    // Log first time we have to wait at all in this pool — gives
    // an early signal that bumps are needed before tail latency blows up.
    if (waiters[pool].length === 0) {
      logger.debug(
        { pool, inFlight: inFlight[pool], cap: max[pool] },
        'llmConcurrency: pool at capacity, queueing call',
      );
    }
    await new Promise<void>((resolve) => waiters[pool].push(resolve));
  }
  inFlight[pool] += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight[pool] = Math.max(0, inFlight[pool] - 1);
    const next = waiters[pool].shift();
    if (next) next();
  };
}

/**
 * Observability snapshot. Wire into /health or a periodic metric so we
 * can see saturation, queue depth, and tune the env caps from real data.
 */
export function llmConcurrencySnapshot(): {
  haiku: { in_flight: number; cap: number; waiting: number };
  sonnet: { in_flight: number; cap: number; waiting: number };
} {
  return {
    haiku: {
      in_flight: inFlight.haiku,
      cap: max.haiku,
      waiting: waiters.haiku.length,
    },
    sonnet: {
      in_flight: inFlight.sonnet,
      cap: max.sonnet,
      waiting: waiters.sonnet.length,
    },
  };
}
