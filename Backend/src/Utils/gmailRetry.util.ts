import { logger } from './logger.js';

/**
 * Retry-with-backoff wrapper for Gmail API calls.
 *
 * S1 (Batch 3): the polling cron fires for every hospital every 120s and
 * the outbox worker sends a flurry on burst traffic. At scale we'd start
 * hitting Gmail's per-user quota (250 quota units/sec per user; 1 billion/day).
 * Without backoff, a transient 429/503 immediately fails the job and Bull
 * retries the WHOLE job after its default delay — wasteful and brittle.
 *
 * This wrapper catches retryable errors (429, 5xx, ECONNRESET, ETIMEDOUT)
 * and retries with exponential backoff up to maxAttempts times. Other errors
 * (4xx that aren't 429, e.g. invalid_grant) propagate immediately — those
 * need ops attention, not retries.
 *
 * Usage:
 *   const result = await withGmailRetry(
 *     () => gmail.users.messages.send({ userId: 'me', requestBody: { raw } }),
 *     { context: { hospitalId, ipdId } }
 *   );
 */

interface RetryOptions {
  /** Max attempts including the first try. Default 4 (≈ 1s + 2s + 4s = 7s extra). */
  maxAttempts?: number;
  /** Base delay in ms; doubled each attempt. Default 1000. */
  baseDelayMs?: number;
  /** Cap on individual delay. Default 30s. */
  maxDelayMs?: number;
  /** Logging context — typically { hospitalId, ipdId, op }. */
  context?: Record<string, unknown>;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'context'>> = {
  maxAttempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

/**
 * Decide whether an error is retryable.
 *  - Gmail/Google errors carry .code (HTTP status) and sometimes .errors[].reason
 *  - Network-level errors carry .code = ECONNRESET / ETIMEDOUT / EAI_AGAIN
 *  - 429 = rate limit; 500/502/503/504 = transient backend issues; retry.
 *  - 401/403 (auth) = NOT retryable — refresh token or scope problem.
 *  - 400/404 etc. = NOT retryable — bug or stale state.
 */
function isRetryable(err: any): boolean {
  if (!err) return false;
  // Network errors
  const netCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']);
  if (typeof err.code === 'string' && netCodes.has(err.code)) return true;

  // googleapis surfaces HTTP status on .code (number) AND on .response.status
  const status: number | undefined =
    (typeof err.code === 'number' ? err.code : undefined) ??
    err?.response?.status ??
    err?.status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }

  // Some googleapis errors surface a `reason` field
  const reason = err?.errors?.[0]?.reason ?? err?.response?.data?.error?.errors?.[0]?.reason;
  if (reason && /rateLimitExceeded|userRateLimitExceeded|backendError|quotaExceeded/i.test(reason)) {
    return true;
  }
  return false;
}

/** Sleep helper that respects an optional `Retry-After` header. */
function delayForAttempt(attempt: number, opts: Required<Omit<RetryOptions, 'context'>>, err: any): number {
  // Honour Retry-After if Gmail sent one (seconds).
  const retryAfter = Number(err?.response?.headers?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, opts.maxDelayMs);
  }
  // Exponential backoff: 1s, 2s, 4s, 8s, capped.
  const expo = opts.baseDelayMs * 2 ** (attempt - 1);
  // Add jitter (±25%) so concurrent callers don't synchronise their retries.
  const jitter = expo * (Math.random() * 0.5 - 0.25);
  return Math.min(opts.maxDelayMs, expo + jitter);
}

export async function withGmailRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let attempt = 0;
  let lastErr: any;
  while (attempt < opts.maxAttempts) {
    attempt++;
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (!isRetryable(err) || attempt >= opts.maxAttempts) {
        throw err;
      }
      const wait = delayForAttempt(attempt, opts, err);
      logger.warn(
        {
          ...(options.context ?? {}),
          attempt,
          waitMs: Math.round(wait),
          status: err?.code ?? err?.response?.status,
          reason: err?.errors?.[0]?.reason,
        },
        'gmail: retryable error, backing off',
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
