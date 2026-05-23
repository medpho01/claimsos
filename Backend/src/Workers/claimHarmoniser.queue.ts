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
import claimAiRunService from '../Services/claimAiRun.service.js';

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
      // Fix 12 (May 21, 2026): immediate cleanup on complete so the
      // jobId frees up. With removeOnComplete: 200 the jobId lingered
      // until 200 future jobs evicted it, blocking every subsequent
      // section-completion re-enqueue from running. Result: harmoniser
      // ran exactly once per claim, EVER. The whole iter4 test stalled
      // at docs_completed=1 because the harmoniser never re-fired
      // after the first early-return. true = immediate removal.
      removeOnComplete: true,
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

async function processJob(
  job: Queue.Job<ClaimHarmoniserJob>,
): Promise<{ skipped: boolean; reason?: string } | void> {
  const { claim_id, hospital_id, force } = job.data;
  if (!claim_id || !hospital_id) {
    logger.warn(
      { jobData: job.data },
      'claimHarmoniser: malformed job (missing claim_id/hospital_id), skipping',
    );
    return;
  }

  // ─── Run-cursor gate (May 2026, pipeline rearch Step 1) ───────────────
  // The dossier_state_hash idempotency keeps duplicate Sonnet calls free,
  // but a partially-extracted claim still produces a "results" UI that
  // changes as more docs land — looks like the run finished early and
  // then mutated. Gate harmonisation on the claim_ai_runs cursor: while
  // a run is mid-flight (queued/running) we only let the harmoniser fire
  // once every doc in that run has finished extraction. The dossier
  // projector and docExtractor will re-enqueue as sections complete, so
  // the LAST job through the queue (after docs_completed = total_docs)
  // is the one that actually runs the LLM.
  //
  // Legacy fallback: claims with no claim_ai_runs row (pre-rearch
  // claims, email-pipeline harmonisations, system-triggered
  // /regenerate when no run is open) bypass the gate and run as
  // before. We never want to silently drop harmonisation for those.
  try {
    const run = await claimAiRunService.getLatestRun(claim_id);
    if (run && (run.status === 'queued' || run.status === 'running')) {
      // Re-aggregate first — docs_completed on the row may be stale if
      // recompute hasn't been called since the most recent extraction.
      // recomputeFromState is purely derived from document_sections /
      // claim_harmonised_episodes, so calling it here is cheap and
      // gives us the authoritative state.
      const fresh = await claimAiRunService.recomputeFromState(claim_id);

      // If recompute just flipped status to a terminal state (succeeded,
      // partial, failed, superseded), fall through and harmonise. This
      // happens when (docs_completed + docs_failed) reached total_docs
      // INSIDE recomputeFromState — without this short-circuit we'd
      // skip harmonisation on partial-fail runs forever.
      const freshStatus = fresh?.status ?? run.status;
      if (
        freshStatus !== 'queued' &&
        freshStatus !== 'running'
      ) {
        // fall through to harmonise
      } else {
        // Still mid-flight. "All settled" includes failed docs — a doc
        // that failed quality gate / OCR / classify will never become
        // 'completed', so we must count it as settled to avoid the
        // gate deadlocking partial-fail runs (1 of 5 docs failing
        // would otherwise mean docs_completed=4 forever).
        const total = fresh?.total_docs ?? run.total_docs;
        const done = fresh?.docs_completed ?? run.docs_completed;
        const failed = fresh?.docs_failed ?? run.docs_failed;
        const settled = done + failed;
        const allSettled = total > 0 && settled >= total;
        if (!allSettled) {
          logger.info(
            {
              claim_id,
              run_id: run.id,
              docs: `${done} done + ${failed} failed / ${total}`,
              force: force === true,
            },
            'claimHarmoniser: skipping — docs still in flight, will re-fire as more sections complete',
          );
          return { skipped: true, reason: 'run_incomplete' };
        }
        // All docs settled but status is still queued/running because
        // phase resolution in recomputeFromState waits on harm_status,
        // which is exactly what we're about to fire. Fall through.
      }
    }
    // No run cursor, or run is terminal (succeeded/partial/failed/superseded),
    // or all docs settled — fall through to harmoniser.
  } catch (err) {
    // Failing to read the run cursor must not block harmonisation —
    // the worst-case outcome of a transient DB blip is one extra
    // (idempotent, dossier_state_hash-cached) LLM call, not a regression
    // in correctness.
    logger.warn(
      { err, claim_id },
      'claimHarmoniser: run-cursor gate read failed (proceeding without gating)',
    );
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

  // Fix 13 (May 21, 2026): recompute the run state AFTER the
  // harmonisation episode has been persisted. The pre-harm
  // recomputeFromState (line ~143) ran when harm_status was still
  // 'pending'/null, so phase resolved to 'harmonise'. Now that
  // harm_status is 'fresh'/'partial', phase should resolve to 'done'
  // and the run row should flip to terminal status. Without this
  // second recompute, the claim_ai_runs row sat at phase='harmonise'
  // forever and the FE never saw the run as complete — every iter4
  // patient ended up exactly here.
  try {
    await claimAiRunService.recomputeFromState(claim_id);
  } catch (err) {
    logger.warn(
      { err, claim_id },
      'claimHarmoniser: post-harm recomputeFromState failed (non-fatal; next /status hit will reconcile)',
    );
  }
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
        // Bull stores the resolved value in job.returnvalue — surfacing
        // the {skipped, reason} object from the gate path makes the skip
        // visible in Bull dashboards without needing to grep logs.
        return await processJob(job);
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
