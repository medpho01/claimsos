/**
 * Sprint 5 / Wave 2B — Document Extractor Worker
 *
 * Bull-backed queue that runs DocExtractorService.extractSection() on
 * sections that have a category set. Enqueued by the classifier worker
 * (or a reconciler) one job per section.
 *
 * Same patterns as docClassifier.queue.ts — see comments there for
 * stub-queue, retry, RUN_WORKERS gating rationale.
 */

import Queue from 'bull';
import { logger } from '../Utils/logger.js';
import { DocExtractorService } from '../Services/docExtractor.service.js';

interface DocExtractorJob {
  section_id: string;
  claim_id: string;
  hospital_id: string;
  /**
   * When true, bypass the extractor's version-based idempotency check
   * and rerun the LLM call even if extracted_fields is already
   * populated at the current EXTRACTOR_VERSION. The `_corrected_fields`
   * guard inside persistExtraction still preserves individual
   * field-level human overrides across the re-run.
   */
  force?: boolean;
}

const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue(): Queue.Queue<DocExtractorJob> | typeof stubQueue {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  const q = new Queue<DocExtractorJob>('doc-extractor', {
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
        '[DocExtractor] Redis not available — extractions deferred until reconnect.',
      );
    }
  });

  // ─── Fix 3 (May 21, 2026): tolerate partial extract failures ───
  // Cross-hospital smoke test (cross_hospital_report.md) showed that one
  // failed extract job (e.g. Shokin's 5MB image hitting Anthropic's
  // hard limit) stalls the entire claim_ai_runs cursor at `queued`.
  // The harmoniser gate (P7) waits on (docs_completed + docs_failed)
  // >= total_docs — but nothing was incrementing docs_failed when an
  // extract job terminally failed.
  //
  // Mirror the bundle-classifier failed-hook pattern (P8): on terminal
  // failure of an extract job, increment claim_ai_runs.docs_failed.
  // Note: extract is PER-SECTION, but docs_failed counts at the doc
  // level. We only count a doc as "failed" if ALL sections of that doc
  // have terminal extract failures — otherwise partial success is
  // perfectly acceptable. The simpler "any-section-fail = doc-fail"
  // would over-flag healthy docs.
  q.on('failed', async (job: any, err: Error) => {
    try {
      const attempts = job.opts?.attempts ?? 1;
      const attemptsMade = job.attemptsMade ?? 0;
      if (attemptsMade < attempts) return; // Bull will retry
      const { section_id, claim_id } = job.data ?? {};
      if (!section_id || !claim_id) return;

      const { default: claimAiRunService } = await import(
        '../Services/claimAiRun.service.js'
      );
      const run = await claimAiRunService.getLatestRun(claim_id);
      if (!run) return;

      // Look up the doc this section belongs to.
      const { pool } = await import('../DB/db.js');
      const sec = await pool.query(
        `SELECT document_id FROM hospital.document_sections WHERE id = $1`,
        [section_id],
      );
      const documentId = sec.rows[0]?.document_id;
      if (!documentId) return;

      // Check whether ALL sections of this doc terminally failed (extracted_fields IS NULL).
      // We approximate "terminal extract failure" as: extracted_fields IS NULL AND
      // updated_at > triggered_at (i.e., the extractor TOUCHED it but produced nothing).
      const status = await pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE extracted_fields IS NOT NULL OR extractor_model = 'no_schema') AS done
         FROM hospital.document_sections
         WHERE document_id = $1 AND dedup_of IS NULL`,
        [documentId],
      );
      const total = Number(status.rows[0].total);
      const done = Number(status.rows[0].done);
      const allFailed = total > 0 && done === 0;

      if (allFailed) {
        // Bump docs_failed once per failing doc (idempotent: we'd over-bump
        // if multiple sections fail and we don't dedupe by doc_id).
        // Use a marker column or per-section guard. Simpler: do an UPSERT
        // into a `claim_ai_run_doc_fails` audit table — but we don't have
        // one. Compromise: only bump if no other failing section for this
        // doc has already been recorded (we use a sentinel row in
        // doc_phase_ledger).
        const { default: docPhaseLedgerService } = await import(
          '../Services/docPhaseLedger.service.js'
        );
        // Check whether doc already marked failed in this run's ledger
        const ledgerCheck = await pool.query(
          `SELECT status FROM hospital.doc_phase_ledger
            WHERE doc_id = $1 AND run_id = $2 AND phase = 'extract'`,
          [documentId, run.id],
        );
        const alreadyFailed = ledgerCheck.rows[0]?.status === 'failed';
        if (!alreadyFailed) {
          await docPhaseLedgerService.failPhase(
            documentId,
            run.id,
            'extract',
            `all_sections_extract_failed: ${(err?.message ?? String(err)).slice(0, 300)}`,
          );
          await pool.query(
            `UPDATE hospital.claim_ai_runs SET docs_failed = docs_failed + 1 WHERE id = $1`,
            [run.id],
          );
          logger.warn(
            { section_id, document_id: documentId, claim_id, run_id: run.id },
            'docExtractor: all sections of doc failed → incremented run.docs_failed (Fix 3)',
          );
        }
      } else {
        // Partial doc failure — just mark this section in the ledger,
        // don't bump docs_failed (other sections of this doc are healthy).
        logger.info(
          { section_id, document_id: documentId, claim_id, partial: `${done}/${total}` },
          'docExtractor: section extract failed but other sections of doc OK — not bumping docs_failed',
        );
      }
    } catch (hookErr) {
      logger.warn(
        { err: hookErr },
        'docExtractor: failed-hook errored (non-fatal)',
      );
    }
  });

  return q;
}

const queue = createQueue();

let serviceInstance: DocExtractorService | null = null;
function getService(): DocExtractorService {
  if (!serviceInstance) serviceInstance = new DocExtractorService();
  return serviceInstance;
}

async function processJob(job: Queue.Job<DocExtractorJob>): Promise<{
  field_count: number;
  cost_inr: number;
  tier_escalated: boolean;
  dedup_skipped?: boolean;
}> {
  const { section_id, claim_id, hospital_id, force } = job.data;
  if (!section_id || !claim_id || !hospital_id) {
    logger.warn(
      { jobData: job.data },
      'docExtractor worker: malformed job, skipping',
    );
    return { field_count: 0, cost_inr: 0, tier_escalated: false };
  }

  // ─── Section dedup gate (Wave 12 content dedup) ─────────────────────
  // If this section is a duplicate of a canonical (dedup_of NOT NULL),
  // skip the LLM call entirely. The canonical's extraction will be
  // projected onto this section by SectionDedupService.projectCanonicalExtraction
  // after the canonical's extract job completes (below).
  //
  // Race: this job may have been enqueued BEFORE dedup ran for the
  // claim. By the time we pick it up, dedup_of may have been stamped.
  // We check at job-pickup time (here) instead of enqueue time so the
  // gate always catches the latest state.
  const { pool } = await import('../DB/db.js');
  const dedupCheck = await pool.query<{ dedup_of: string | null }>(
    `SELECT dedup_of FROM hospital.document_sections WHERE id = $1 LIMIT 1`,
    [section_id],
  );
  const dedupOf = dedupCheck.rows[0]?.dedup_of ?? null;
  if (dedupOf) {
    logger.info(
      { section_id, claim_id, canonical_id: dedupOf },
      'docExtractor worker: section is a content duplicate — skipping LLM call (canonical will project)',
    );
    return {
      field_count: 0,
      cost_inr: 0,
      tier_escalated: false,
      dedup_skipped: true,
    };
  }

  const result = await getService().extractSection({
    sectionId: section_id,
    claimId: claim_id,
    hospitalId: hospital_id,
    force: force === true,
  });
  logger.info(
    {
      section_id,
      claim_id,
      field_count: Object.keys(result.fields).length,
      cost_inr: result.costInr,
      tier_escalated: result.tierEscalated,
    },
    'docExtractor worker: section extracted',
  );

  // ─── Canonical-projection (Wave 12 content dedup) ───────────────────
  // If this section IS a canonical (i.e., other sections point at it
  // via dedup_of), project its freshly-extracted fields onto those
  // duplicates so the FE sees data on every section row without paying
  // for N parallel extractions. Best-effort — failure here doesn't
  // re-throw because the canonical's extraction already succeeded.
  try {
    const { sectionDedupService } = await import('../Services/sectionDedup.service.js');
    const projected = await sectionDedupService.projectCanonicalExtraction(section_id);
    if (projected > 0) {
      logger.info(
        { canonical_id: section_id, duplicates_updated: projected },
        'docExtractor worker: projected canonical extraction onto duplicates',
      );
    }
  } catch (err) {
    logger.warn(
      { err, section_id },
      'docExtractor worker: canonical projection failed (non-fatal; duplicates will be projected on next dedup run)',
    );
  }

  // ─── Re-enqueue harmoniser (May 2026, pipeline rearch Step 1) ───────
  // Each section_extracted nudges the harmoniser to re-check whether the
  // run is now complete. The harmoniser queue dedupes on jobId
  // `harmonise:<claim_id>`, so a burst of N section completions collapses
  // into a single in-flight job. The harmoniser's own gate
  // (claimHarmoniser.queue.ts processJob) then decides whether the run
  // has all docs done or whether to skip this fire-and-wait cycle.
  // Without this re-enqueue the orchestrator's at-start enqueue is the
  // only trigger, and that one is always gated out — leaving claims
  // permanently un-harmonised after Step 1 of the rearch landed.
  try {
    const { enqueueClaimHarmonisation } = await import(
      './claimHarmoniser.queue.js'
    );
    await enqueueClaimHarmonisation(claim_id, hospital_id);
  } catch (err) {
    logger.warn(
      { err, section_id, claim_id },
      'docExtractor worker: harmoniser re-enqueue failed (orchestrator end-of-run safety net will still cover this claim)',
    );
  }

  return {
    field_count: Object.keys(result.fields).length,
    cost_inr: result.costInr,
    tier_escalated: result.tierEscalated,
  };
}

export async function enqueueDocExtraction(
  sectionId: string,
  claimId: string,
  hospitalId: string,
  force = false,
): Promise<void> {
  try {
    await queue.add(
      {
        section_id: sectionId,
        claim_id: claimId,
        hospital_id: hospitalId,
        force,
      },
      {
        // Forced re-runs get a unique jobId so Bull doesn't deduplicate
        // them against the idempotent classify:<sid> jobId.
        jobId: force
          ? `extract:${sectionId}:force:${Date.now()}`
          : `extract:${sectionId}`,
      },
    );
  } catch (err) {
    logger.warn(
      { err, sectionId, claimId },
      'docExtractor: enqueue failed (will be picked up by reconciler)',
    );
  }
}

export function startDocExtractorWorker(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('docExtractor worker NOT started (RUN_WORKERS=false)');
    return;
  }
  if (typeof (queue as any).process === 'function') {
    (queue as Queue.Queue<DocExtractorJob>).process(4, async (job) => {
      try {
        return await processJob(job);
      } catch (err) {
        logger.error(
          { err, jobId: job.id, jobData: job.data, attempt: job.attemptsMade },
          'docExtractor worker: job failed',
        );
        throw err;
      }
    });
    logger.info(
      'docExtractor worker started (3 attempts × exponential backoff, concurrency=4)',
    );
  }
}

startDocExtractorWorker();

export default queue;
