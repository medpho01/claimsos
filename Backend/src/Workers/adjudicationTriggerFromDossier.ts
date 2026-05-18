/**
 * Adjudication Trigger From Dossier — Sprint 3, Wave 3B
 *
 * Wires Wave 1's claim-dossier projector to Wave 3B's adjudication engine
 * *without* modifying the projector itself (the projector is owned by Lane B
 * of Wave 1).
 *
 * Approach: we attach a listener to the projector queue's `completed` event.
 * Every time the projector finishes folding an event into a dossier, we
 * enqueue a debounced adjudication run for that claim. Bursts of events on
 * the same claim coalesce inside the adjudication queue thanks to the
 * deterministic jobId there (= "dossier_changed:<claim_id>") plus the 5s
 * delayed-job dedup.
 *
 * Why a separate file rather than modifying the projector:
 *   - The projector worker is conceptually pure ("apply event → write
 *     row"). Reaching across to schedule downstream work bleeds concerns.
 *   - Subscribing to queue.on('completed') lets us trigger from a fan-out
 *     point that fires regardless of who enqueued the projection — doc
 *     pipeline, email ingest, manual replay, all of them.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ INTEGRATION TODO                                                     ║
 * ║                                                                      ║
 * ║ This file is NOT yet auto-started anywhere. To wire it up, the       ║
 * ║ integration sprint should call `startAdjudicationTriggerFromDossier`  ║
 * ║ once at process start-up (next to the other worker bootstraps in     ║
 * ║ src/index.ts or src/Workers/startup.ts).                             ║
 * ║                                                                      ║
 * ║ It is RUN_WORKERS-gated and a no-op in NODE_ENV=test.                ║
 * ║                                                                      ║
 * ║ If the projector lane evolves to emit its own typed `dossier_changed` ║
 * ║ event (vs the current Bull `completed` hook) — switch this listener  ║
 * ║ over to the typed bus. The contract is unchanged: one event per      ║
 * ║ successful projection → one enqueueAdjudication call.                ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { logger } from '../Utils/logger.js';
import projectorQueue from './claimDossierProjector.queue.js';
import { enqueueAdjudication } from './adjudicationEngine.queue.js';

let started = false;

export function startAdjudicationTriggerFromDossier(): void {
  if (started) return;
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info(
      'adjudicationTriggerFromDossier NOT started (RUN_WORKERS=false)',
    );
    return;
  }

  // The stub queue exported when Redis is unavailable returns its own .on
  // function — we still attach so the listener is in place when Redis
  // reconnects (Bull rebinds events on reconnect).
  const q: any = projectorQueue;
  if (typeof q.on !== 'function') {
    logger.warn(
      'adjudicationTriggerFromDossier: projector queue has no .on (stub?), skipping wire-up',
    );
    return;
  }

  q.on('completed', (job: any) => {
    try {
      const claim_id =
        job?.data?.claim_id ??
        // Fallback shape — in case the projector job payload evolves.
        job?.returnvalue?.claim_id;
      if (!claim_id) {
        logger.debug(
          { jobId: job?.id, data: job?.data },
          'adjudicationTriggerFromDossier: completed event without claim_id, skipping',
        );
        return;
      }
      // Fire-and-forget — enqueueAdjudication swallows errors internally.
      void enqueueAdjudication(claim_id, undefined, 'dossier_changed');
    } catch (err) {
      logger.warn(
        { err, jobId: job?.id },
        'adjudicationTriggerFromDossier: listener threw',
      );
    }
  });

  started = true;
  logger.info(
    'adjudicationTriggerFromDossier started — listening on claim-dossier-projector queue completions',
  );
}
