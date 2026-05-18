/**
 * Sprint 3, Wave 4A — KB Pattern Feedback Queue
 *
 * Triggered when a claim closes (closure_outcome moves to a terminal value).
 * For every open kb_pattern_matches row on that claim:
 *
 *   1. Derive the actual outcome from the closed dossier.
 *   2. Compare that outcome to the matched pattern's `prediction`.
 *   3. Persist actual_outcome, prediction_correct, resolved_at on the
 *      match row.
 *
 * This is the data layer the Wave 5 eval harness consumes. Keeping it as a
 * dedicated queue (rather than inline on the claim_closed event handler)
 * means:
 *
 *   * Feedback can be re-run after a prediction-comparison bug fix without
 *     re-emitting claim_closed.
 *   * The compute is not on the critical path of closing a claim.
 *
 * Not yet wired into the projector. The integration sprint plugs an
 * enqueueFeedbackForClaim(claim_id) call into the projector's
 * claim_closed handler.
 *
 * RUN_WORKERS gated like the rest of the worker fleet.
 */

import Queue from 'bull';

import { logger } from '../Utils/logger.js';

export const QUEUE_NAME = 'kb-pattern-feedback';

export interface KbPatternFeedbackJob {
  claim_id: string;
  /** 'claim_closed' from the projector, 'manual' from admin re-runs. */
  trigger: 'claim_closed' | 'manual';
}

const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue(): Queue.Queue<KbPatternFeedbackJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);
  try {
    const q = new Queue<KbPatternFeedbackJob>(QUEUE_NAME, {
      redis: {
        host: url.hostname,
        port: parseInt(url.port || '6379'),
        retryStrategy: (times: number) => (times >= 3 ? null : Math.min(times * 300, 1500)),
        enableOfflineQueue: false,
      } as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    });
    q.on('error', (err: Error) => {
      if ((err as any).code === 'ECONNREFUSED') {
        console.warn('[kb-pattern-feedback] Redis not available; feedback paused.');
      }
    });
    return q;
  } catch (err) {
    logger.warn({ err }, 'kb-pattern-feedback: queue init failed; using stub');
    return stubQueue;
  }
}

const queue = createQueue();

// ─── Processor ────────────────────────────────────────────────────────────

async function processJob(job: Queue.Job<KbPatternFeedbackJob>): Promise<unknown> {
  const { claim_id } = job.data;
  if (!claim_id) {
    logger.warn({ jobData: job.data }, 'kbPatternFeedback: malformed job');
    return { skipped: true };
  }

  const { pool } = await import('../DB/db.js');

  // 1. Load the dossier (we need closure_outcome, amounts, events_summary).
  const dossierRes = await pool.query<{
    claim_id: string;
    closure_outcome: string | null;
    amounts: any;
    events_summary: any;
    doc_sections_by_category: any;
  }>(
    `SELECT claim_id, closure_outcome, amounts, events_summary, doc_sections_by_category
       FROM hospital.claim_dossiers
      WHERE claim_id = $1`,
    [claim_id],
  );
  if (dossierRes.rowCount === 0) {
    logger.warn({ claim_id }, 'kbPatternFeedback: dossier not found');
    return { skipped: true };
  }
  const dossier = dossierRes.rows[0]!;

  // 2. Load all unresolved matches for this claim, joined to their pattern's
  //    prediction.
  const matchesRes = await pool.query<{
    match_id: string;
    pattern_id: string;
    prediction: any;
  }>(
    `SELECT m.id AS match_id, m.pattern_id, p.prediction
       FROM hospital.kb_pattern_matches m
       JOIN hospital.kb_patterns p ON p.id = m.pattern_id
      WHERE m.claim_id = $1
        AND m.resolved_at IS NULL`,
    [claim_id],
  );

  let resolved = 0;
  for (const row of matchesRes.rows ?? []) {
    const actual = deriveActualOutcome(row.prediction?.kind, dossier);
    const correct = comparePrediction(row.prediction, actual);
    await pool.query(
      `UPDATE hospital.kb_pattern_matches
          SET actual_outcome = $2::jsonb,
              prediction_correct = $3,
              resolved_at = NOW()
        WHERE id = $1`,
      [row.match_id, JSON.stringify(actual), correct],
    );
    resolved += 1;
  }

  logger.info(
    { claim_id, resolved },
    'kbPatternFeedback: feedback row(s) updated',
  );
  return { resolved };
}

// ─── Outcome derivation ───────────────────────────────────────────────────
// One branch per prediction kind. Unknown kinds yield {} + null verdict so
// downstream filters can ignore them.

function deriveActualOutcome(
  predictionKind: string | undefined,
  dossier: {
    closure_outcome: string | null;
    amounts: any;
    events_summary: any;
  },
): Record<string, any> {
  switch (predictionKind) {
    case 'query_likely': {
      const events = Array.isArray(dossier.events_summary)
        ? dossier.events_summary
        : [];
      const hadQuery = events.some((e: any) => e?.kind === 'query_raised');
      return { query_raised: hadQuery };
    }
    case 'amount_cut_pct':
    case 'approval_ratio': {
      const claimed = Number(dossier.amounts?.claimed ?? 0);
      const approved = Number(
        dossier.amounts?.final_approved ??
          dossier.amounts?.pre_auth_approved ??
          0,
      );
      const ratio = claimed > 0 ? approved / claimed : null;
      const cutPct = claimed > 0 ? (claimed - approved) / claimed : null;
      return { approval_ratio: ratio, cut_pct: cutPct, claimed, approved };
    }
    case 'deduction_likely': {
      return { closure_outcome: dossier.closure_outcome };
    }
    case 'approval_likely': {
      return { closure_outcome: dossier.closure_outcome };
    }
    case 'stage_dwell_forecast': {
      // We don't compute exact dwell here — the eval harness will pull
      // dwell from the events_summary directly when it needs it. Stash the
      // raw events count so it can be cross-checked.
      const events = Array.isArray(dossier.events_summary)
        ? dossier.events_summary.filter((e: any) => e?.kind === 'stage_transitioned')
        : [];
      return { stage_transitions: events.length };
    }
    default:
      return {};
  }
}

function comparePrediction(prediction: any, actual: Record<string, any>): boolean | null {
  if (!prediction || typeof prediction !== 'object') return null;
  switch (prediction.kind) {
    case 'query_likely': {
      const predTrue = (prediction.point_estimate ?? prediction.params?.rate ?? 0) > 0.5;
      const actualTrue = actual.query_raised === true;
      return predTrue === actualTrue;
    }
    case 'amount_cut_pct': {
      const predCut = Number(prediction.point_estimate ?? 0);
      const actualCut = Number(actual.cut_pct ?? 0);
      // Within +/- 0.15 absolute is "correct enough" for v0.
      return Math.abs(predCut - actualCut) <= 0.15;
    }
    case 'approval_ratio': {
      const predRatio = Number(prediction.point_estimate ?? 0);
      const actualRatio = Number(actual.approval_ratio ?? 0);
      return Math.abs(predRatio - actualRatio) <= 0.15;
    }
    case 'deduction_likely':
    case 'approval_likely':
      return null; // qualitative — eval harness assesses
    default:
      return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/** Enqueue a feedback recompute for a closed claim. */
export async function enqueueFeedbackForClaim(
  claim_id: string,
  trigger: KbPatternFeedbackJob['trigger'] = 'claim_closed',
): Promise<void> {
  if (!claim_id) return;
  try {
    await (queue as any).add(
      { claim_id, trigger },
      { jobId: `${trigger}:${claim_id}` },
    );
  } catch (err) {
    logger.warn(
      { err, claim_id, trigger },
      'kbPatternFeedback: enqueue failed',
    );
  }
}

export function startKbPatternFeedbackWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('kbPatternFeedback worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<KbPatternFeedbackJob>).process(3, processJob);
    logger.info('kbPatternFeedback worker started (concurrency 3)');
  }
}

// NOT auto-started — integration sprint mounts via startKbPatternFeedbackWorker.

export default queue;
