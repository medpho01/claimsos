import Queue from 'bull';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import claimDossierService from '../Services/claimDossier.service.js';
import type { SubmissionEventRow } from '../Services/claimDossierProjector.service.js';

/**
 * Claim Dossier Projector Worker
 *
 * Consumes { claim_id, event_id } jobs and folds the matching submission_events
 * row into hospital.claim_dossiers via `ClaimDossierService.upsertProjection`.
 *
 * Enqueue points (to be wired by Lane A as canonical events land):
 *   - submissionEvents.service.recordSubmissionEvent → after INSERT, enqueue
 *     for any submission whose event_type is in the projector's vocabulary.
 *   - Any future event writer (doc segmenter, adjudicator, RPA dispatcher)
 *     calls `enqueueDossierProjection(claim_id, event_id)` after committing.
 *
 * Retry policy: 3 attempts with exponential backoff (matches the spec — short
 * because the work is idempotent and downstream readers tolerate seconds of
 * lag).
 *
 * Concurrency: 5 workers per process. The processor reads ALL events newer
 * than the dossier's last_event_at on each job (idempotent catch-up), so even
 * if jobs are processed out of order Bull-side, the eventual result is the
 * same. A per-claim_id Redis lock could be added later if we observe duplicate
 * effort under load.
 *
 * Dead-letter handling: log + leave the job in Bull's failed set (removeOnFail
 * = 1000 preserves a generous history). A proper DLQ table is a follow-up.
 *
 * RUN_WORKERS gating: same convention as emailOutbox.queue.ts — the API
 * container imports this module to enqueue jobs, the worker container also
 * registers the processor. RUN_WORKERS=false suppresses the processor.
 */

interface ProjectorJob {
  claim_id: string;
  event_id: string;
}

// Stub queue keeps the API container alive when Redis isn't reachable —
// .add() becomes a no-op (we'll be re-enqueued from the catch-up loop, once
// that lands).
const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue(): Queue.Queue<ProjectorJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<ProjectorJob>('claim-dossier-projector', {
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
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 200,
      removeOnFail: 1000,
    },
  });

  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn(
        '[ClaimDossierProjector] Redis not available — projections deferred until reconnect.'
      );
    }
  });

  return q;
}

const queue = createQueue();

// ────────────────────────────────────────────────────────────────────────────
// Job processor
// ────────────────────────────────────────────────────────────────────────────

async function processJob(job: Queue.Job<ProjectorJob>): Promise<void> {
  const { claim_id, event_id } = job.data;
  if (!claim_id || !event_id) {
    logger.warn({ jobData: job.data }, 'claimDossierProjector: malformed job, skipping');
    return;
  }

  // Load the event. If it's gone (deleted, never committed) bail without
  // throwing — there's no work to do and retrying won't help.
  const evtRes = await pool.query<{
    id: string;
    event_type: string;
    payload: any;
    actor: string | null;
    created_at: Date;
    insurance_submission_id: string;
  }>(
    `SELECT id, event_type, payload, actor, created_at, insurance_submission_id
       FROM hospital.submission_events
      WHERE id = $1`,
    [event_id]
  );
  if ((evtRes.rowCount ?? 0) === 0) {
    logger.warn(
      { claim_id, event_id },
      'claimDossierProjector: event not found, skipping (likely deleted)'
    );
    return;
  }
  const evt = evtRes.rows[0]!;

  // Defence-in-depth: the job's claim_id should match the event's submission_id.
  // If it doesn't, prefer the event's own pointer — the enqueuer may have had
  // stale data.
  const effectiveClaimId = evt.insurance_submission_id || claim_id;

  const eventRow: SubmissionEventRow = {
    id: evt.id,
    kind: evt.event_type,
    payload: evt.payload ?? {},
    actor: evt.actor,
    created_at: evt.created_at,
  };

  const dossier = await claimDossierService.upsertProjection(
    effectiveClaimId,
    eventRow
  );
  logger.info(
    {
      claim_id: effectiveClaimId,
      event_id,
      event_kind: evt.event_type,
      new_version: dossier.version,
    },
    'claimDossierProjector: applied'
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Enqueue a projection job for (claim_id, event_id). Callers should invoke
 * AFTER they've committed the submission_events row, so the worker can read
 * the event back from the DB. On Redis being unavailable this is a no-op —
 * the (future) catch-up scheduler will fill the gap.
 */
export async function enqueueDossierProjection(
  claim_id: string,
  event_id: string
): Promise<void> {
  try {
    await queue.add({ claim_id, event_id });
  } catch (err) {
    logger.warn(
      { err, claim_id, event_id },
      'claimDossierProjector: enqueue failed (will be picked up by catch-up)'
    );
  }
}

export function startClaimDossierProjectorWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('claimDossierProjector worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<ProjectorJob>).process(5, async (job) => {
      try {
        await processJob(job);
      } catch (err) {
        logger.error(
          { err, jobId: job.id, jobData: job.data, attempt: job.attemptsMade },
          'claimDossierProjector: job failed'
        );
        throw err; // let Bull retry per policy
      }
    });
    logger.info(
      'claimDossierProjector worker started (3 attempts × exponential backoff, concurrency=5)'
    );
  }
}

// Auto-start preserves the single-container backward compatibility used by
// the rest of the worker fleet. RUN_WORKERS=false on the API container
// suppresses processor registration.
startClaimDossierProjectorWorker();

export default queue;
