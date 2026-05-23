/**
 * Wave 12 — Bundle Classifier Worker
 *
 * Bull-backed queue that runs DocBundleClassifierService.classifyBundle()
 * on a whole document (replacing the docSegmenter → docClassifier chain).
 *
 * Retry policy:
 *   - 3 attempts, exponential backoff with a 30s base. Same logic as the
 *     legacy segmenter — LLM 5xx storms typically clear inside a minute.
 *     Idempotency in the service layer (classifier_version cache) makes
 *     retries cheap when the prior attempt got far enough to persist.
 *
 * Concurrency:
 *   - 2. LLM-bound work — same reasoning as the segmenter. The bundle
 *     classifier is a Sonnet call with a long prompt (up to ~80k chars
 *     of OCR text in the user prompt); 2 concurrent calls is enough to
 *     keep the worker busy without bursting Anthropic rate limits.
 *
 * RUN_WORKERS gating mirrors the other queue files — API container
 * imports to enqueue, worker container processes.
 */

import Queue from 'bull';
import { logger } from '../Utils/logger.js';
import { docBundleClassifierService } from '../Services/docBundleClassifier.service.js';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface BundleClassifierJob {
  documentId: string;
  claimId: string;
  hospitalId: string;
  s3_key: string;
  /**
   * When true, bypass the bundle classifier's version-based idempotency
   * short-circuit and run the LLM call even if rows already exist at
   * the current BUNDLE_CLASSIFIER_VERSION. Per-section corrections
   * (status='corrected' on existing rows from the v2 path) are NOT
   * preserved here — the bundle classifier produces fresh section
   * rows, so if a doc has existing corrected sections, the orchestrator
   * should NOT enqueue a bundle re-classify for that doc (it should
   * route through the per-section v2 path instead).
   */
  force?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Queue setup (stub-tolerant when Redis unreachable, mirrors other queues)
// ────────────────────────────────────────────────────────────────────────────

const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue(): Queue.Queue<BundleClassifierJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<BundleClassifierJob>('doc-bundle-classifier', {
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
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 200,
      removeOnFail: 1000,
    },
  });

  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn(
        '[DocBundleClassifier] Redis not available — bundle classification deferred until reconnect.',
      );
    }
  });

  // ─── P8: failed-job hook → record terminal failure into ledger + run ─
  // Bull fires 'failed' on every attempt; we only want the FINAL one
  // (attemptsMade === opts.attempts). On final failure:
  //   - mark the doc's ingest/classify phase as failed in doc_phase_ledger
  //   - increment claim_ai_runs.docs_failed
  // so the FE can surface "1 of 5 docs failed: <reason>".
  q.on('failed', async (job: any, err: Error) => {
    try {
      const attempts = job.opts?.attempts ?? 1;
      const attemptsMade = job.attemptsMade ?? 0;
      if (attemptsMade < attempts) return; // not final yet — Bull will retry
      const { documentId, claimId, s3_key } = job.data ?? {};
      if (!documentId || !claimId) return;

      // H7 (May 20, 2026): write a __failed__ marker row to
      // document_sections so the operator sees the silent drop. This
      // covers the failure paths that bypass `fallbackToSegmenter`
      // (OCR throws, persist throws, LLM 5xx storm exhaustion, etc.).
      // Idempotent — writeFailedMarker upserts on existing markers.
      const failReasonForMarker = (err?.message ?? String(err)).slice(0, 500);
      try {
        await docBundleClassifierService.writeFailedMarker({
          documentId,
          claimId,
          reason: `bull_job_exhausted: ${failReasonForMarker}`,
          s3Key: s3_key,
          attempt: attemptsMade,
          extra: {
            stage: 'bull_final_failure',
            bull_attempts: attempts,
          },
        });
      } catch (markerErr) {
        logger.warn(
          { err: markerErr, documentId, claimId },
          'docBundleClassifier: H7 — failed-marker write threw from queue hook (non-fatal)',
        );
      }

      const { default: claimAiRunService } = await import(
        '../Services/claimAiRun.service.js'
      );
      const { default: docPhaseLedgerService } = await import(
        '../Services/docPhaseLedger.service.js'
      );
      const run = await claimAiRunService.getLatestRun(claimId);
      if (!run) return;

      // Mark the phase that was running when we failed. We don't always
      // know which phase the failure landed in (could be ingest pre-OCR,
      // classify mid-LLM, etc.), so we tag whichever ledger row is still
      // 'running' for this doc. failPhase upserts so this is safe.
      const failReason = (err?.message ?? String(err)).slice(0, 500);
      // Walk all four bundle-classifier phases; only those in 'running'
      // for this doc actually get flipped (UPSERT pattern preserves
      // already-terminal rows).
      const { pool } = await import('../DB/db.js');
      const running = await pool.query(
        `SELECT phase FROM hospital.doc_phase_ledger
          WHERE doc_id = $1 AND run_id = $2 AND status = 'running'`,
        [documentId, run.id],
      );
      for (const row of running.rows as Array<{ phase: string }>) {
        await docPhaseLedgerService.failPhase(
          documentId,
          run.id,
          row.phase as any,
          `bull_job_exhausted: ${failReason}`,
        );
      }

      // Increment docs_failed on the run cursor. Heartbeat in
      // recomputeFromState will pick this up and flip status='partial'
      // once all docs are accounted for.
      await pool.query(
        `UPDATE hospital.claim_ai_runs
            SET docs_failed = docs_failed + 1
          WHERE id = $1`,
        [run.id],
      );
      logger.warn(
        { documentId, claimId, run_id: run.id, attemptsMade, reason: failReason },
        'docBundleClassifier: terminal job failure → incremented run.docs_failed + flipped phase ledger',
      );
    } catch (hookErr) {
      logger.warn(
        { err: hookErr },
        'docBundleClassifier: failed-hook itself errored (non-fatal)',
      );
    }
  });

  return q;
}

const queue = createQueue();

// ────────────────────────────────────────────────────────────────────────────
// Processor
// ────────────────────────────────────────────────────────────────────────────

async function processJob(job: Queue.Job<BundleClassifierJob>): Promise<{
  section_count: number;
  short_circuited: boolean;
  fell_back: boolean;
  cost_inr: number;
  tokens_used: number;
}> {
  const { documentId, claimId, hospitalId, s3_key, force } = job.data;
  if (!documentId || !claimId || !hospitalId || !s3_key) {
    logger.warn(
      { jobData: job.data },
      'docBundleClassifier worker: malformed job, skipping',
    );
    return {
      section_count: 0,
      short_circuited: false,
      fell_back: false,
      cost_inr: 0,
      tokens_used: 0,
    };
  }

  const result = await docBundleClassifierService.classifyBundle({
    documentId,
    claimId,
    hospitalId,
    s3Key: s3_key,
    force: force === true,
  });

  logger.info(
    {
      documentId,
      claimId,
      section_count: result.sectionCount,
      short_circuited: result.shortCircuited,
      fell_back: result.fellBack,
      cost_inr: result.costInr,
      tokens_used: result.tokensUsed,
    },
    'docBundleClassifier worker: bundle processed',
  );

  return {
    section_count: result.sectionCount,
    short_circuited: result.shortCircuited,
    fell_back: result.fellBack,
    cost_inr: result.costInr,
    tokens_used: result.tokensUsed,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export async function enqueueDocBundleClassification(
  documentId: string,
  claimId: string,
  hospitalId: string,
  s3Key: string,
  force = false,
  idempotencyKey?: string,
): Promise<void> {
  try {
    // De-dup at the Bull level via the job id. Non-force jobs collapse;
    // force jobs always get a unique ts-suffixed id so they aren't
    // dropped against an in-flight idempotent job.
    const jobId =
      idempotencyKey ??
      (force
        ? `bundle-classify:${documentId}:force:${Date.now()}`
        : `bundle-classify:${documentId}`);

    await queue.add(
      {
        documentId,
        claimId,
        hospitalId,
        s3_key: s3Key,
        force,
      },
      { jobId },
    );
  } catch (err) {
    logger.warn(
      { err, documentId, claimId },
      'docBundleClassifier: enqueue failed (reconciler will retry)',
    );
  }
}

export function startDocBundleClassifierWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('docBundleClassifier worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<BundleClassifierJob>).process(2, async (job) => {
      try {
        return await processJob(job);
      } catch (err) {
        logger.error(
          {
            err,
            jobId: job.id,
            jobData: job.data,
            attempt: job.attemptsMade,
          },
          'docBundleClassifier worker: job failed',
        );
        throw err;
      }
    });
    logger.info(
      'docBundleClassifier worker started (3 attempts × exponential backoff @ 30s, concurrency=2)',
    );
  }
  logger.info('docBundleClassifier worker loaded');
}

// Auto-start on import. Same pattern as docSegmenter / docClassifier /
// docExtractor — when the worker container imports this module, the
// processor registers; when the API container does (with RUN_WORKERS=
// false), the function returns early.
startDocBundleClassifierWorker();
