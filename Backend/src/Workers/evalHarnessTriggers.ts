/**
 * Eval Harness Triggers — Sprint 4, Wave 5A
 *
 * Wires Wave 3B's adjudication queue and Wave 1's claim-dossier projector
 * queue to Wave 5A's eval harness *without* modifying either upstream
 * file. Same pattern as Workers/adjudicationTriggerFromDossier.ts.
 *
 *   adjudicationEngine.queue → evalHarness.snapshotPrediction
 *     Fires every time a fresh adjudication_report is written. The
 *     adjudication queue's job payload carries the report_id on
 *     completion (when present) — we read it and freeze a snapshot.
 *
 *   projector queue → evalHarness.resolveActuals
 *     Fires every time the dossier projector applies an event. We can't
 *     tell from the queue payload alone whether the event was a
 *     stage_transitioned / claim_closed, so we call resolveActuals
 *     unconditionally — the harness internally short-circuits when no
 *     unresolved rows match the claim's current stage. The cost is
 *     one extra SELECT per projection, which is cheap.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ INTEGRATION TODO                                                     ║
 * ║                                                                      ║
 * ║ This file is NOT yet auto-started anywhere. To wire it up, the       ║
 * ║ integration sprint should call `startEvalHarnessTriggers` once at    ║
 * ║ process start-up (next to the other worker bootstraps in            ║
 * ║ src/index.ts or src/Workers/startup.ts).                             ║
 * ║                                                                      ║
 * ║ RUN_WORKERS-gated and a no-op in NODE_ENV=test.                      ║
 * ║                                                                      ║
 * ║ When the projector lane evolves to emit typed events (vs the Bull    ║
 * ║ completed hook), switch this listener over to the typed bus. The     ║
 * ║ contract is unchanged: one event per dossier transition → one       ║
 * ║ resolveActuals call.                                                 ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { logger } from '../Utils/logger.js';
import projectorQueue from './claimDossierProjector.queue.js';
import adjudicationQueue from './adjudicationEngine.queue.js';
import evalHarness from '../Services/evalHarness.service.js';

let started = false;

export function startEvalHarnessTriggers(): void {
  if (started) return;
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('evalHarnessTriggers NOT started (RUN_WORKERS=false)');
    return;
  }

  // ── adjudication run → snapshotPrediction ──────────────────────────
  const aq: any = adjudicationQueue;
  if (typeof aq?.on === 'function') {
    aq.on('completed', (job: any, result: any) => {
      try {
        // The adjudication queue's processor returns the AdjudicationReport
        // it produced; we grab its id off `result` if present, otherwise
        // off the job payload (some legacy paths stash report_id on
        // job.data).
        const reportId =
          result?.id ??
          result?.report_id ??
          job?.returnvalue?.id ??
          job?.data?.report_id ??
          null;
        if (!reportId) {
          logger.debug(
            { jobId: job?.id, data: job?.data },
            'evalHarnessTriggers: adjudication completed without report_id, skipping snapshot',
          );
          return;
        }
        void evalHarness.snapshotPrediction(reportId).catch((err) => {
          logger.warn(
            { err, reportId },
            'evalHarnessTriggers: snapshotPrediction failed',
          );
        });
      } catch (err) {
        logger.warn(
          { err, jobId: job?.id },
          'evalHarnessTriggers: adjudication listener threw',
        );
      }
    });
  } else {
    logger.warn(
      'evalHarnessTriggers: adjudication queue has no .on (stub?), skipping snapshot wire-up',
    );
  }

  // ── dossier projection → resolveActuals ────────────────────────────
  const pq: any = projectorQueue;
  if (typeof pq?.on === 'function') {
    pq.on('completed', (job: any) => {
      try {
        const claim_id =
          job?.data?.claim_id ?? job?.returnvalue?.claim_id ?? null;
        if (!claim_id) {
          logger.debug(
            { jobId: job?.id },
            'evalHarnessTriggers: projector completed without claim_id, skipping resolve',
          );
          return;
        }
        void evalHarness.resolveActuals(claim_id).catch((err) => {
          logger.warn(
            { err, claim_id },
            'evalHarnessTriggers: resolveActuals failed',
          );
        });
      } catch (err) {
        logger.warn(
          { err, jobId: job?.id },
          'evalHarnessTriggers: projector listener threw',
        );
      }
    });
  } else {
    logger.warn(
      'evalHarnessTriggers: projector queue has no .on (stub?), skipping resolve wire-up',
    );
  }

  started = true;
  logger.info(
    'evalHarnessTriggers started — listening on adjudication & projector queue completions',
  );
}
