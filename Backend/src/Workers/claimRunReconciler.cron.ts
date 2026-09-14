/**
 * Claim AI Run Reconciler — durable-fix companion to queueRedis.ts
 *
 * Background (two distinct "stranded run" incidents):
 *
 *   (1) Producer-side enqueue loss — orchestrator inserts a claim_ai_runs
 *       row (status='queued') and fire-and-forget enqueues a bundle-classify
 *       job per document. The OLD Bull/ioredis retryStrategy gave up
 *       reconnecting after a SINGLE failed attempt, so any Redis blip left
 *       subsequent queue.add() calls throwing "Connection is closed" until
 *       process restart. queueRedis.ts fixes the reconnect (reconnect-
 *       forever, 5s cap) so the window closes; PASS 1 below heals the rows
 *       stranded *during* a window — and any future enqueue that slips
 *       through a transient gap.
 *
 *   (2) Stuck mid-extract — observed: a run shows 47/47 sections classified
 *       but extracts plateau at e.g. 41/47, "extract (19/23)" docs, for
 *       30–40 minutes. The healing logic *already exists* inside
 *       claimAiRunService.recomputeFromState — specifically the stall
 *       detector (P8: flips doc_phase_ledger 'running' rows older than
 *       STALL_THRESHOLD_SECONDS to 'failed' + bumps docs_failed) and the
 *       orphan-section detector (Fix 11: re-enqueues classified-but-not-
 *       extracted sections aged > ORPHAN_THRESHOLD_SECONDS, with force=true
 *       so Bull cannot dedup against a lost job). The problem is that
 *       NOTHING SERVER-SIDE PERIODICALLY CALLS recomputeFromState. Its
 *       triggers are all event-driven:
 *         - docBundleClassifier.queue 'completed' hook — fires when the
 *           classifier finishes; useless once classify is already done.
 *         - claimHarmoniser.queue pre/post — won't fire because the
 *           harmoniser is gated on extract completing.
 *         - intelligenceOrchestrator at end of analyzeClaim — fires once
 *           at start of the run, not periodically.
 *         - intelligenceStatus.controller on every /status request — the
 *           only active path while a claim is mid-extract, but it stops
 *           the moment the user navigates away from the claim page.
 *       Without a periodic server-side trigger, healing is fragile (user
 *       behaviour controls it) and laggy (heals only when someone looks).
 *       PASS 2 below calls recomputeFromState on every non-terminal run
 *       once per poll, making reconciliation independent of the FE — the
 *       existing in-service stall + orphan detectors do the actual work.
 *
 * What each pass does:
 *   - PASS 1 (reconcileQueuedRuns): finds runs in 'queued' for >90s whose
 *     docs have an s3_key but no document_sections rows; re-enqueues
 *     bundle-classify per doc using the orchestrator's idempotent jobId
 *     so Bull collapses against any in-flight job. Self-terminating: a
 *     successful classify writes section rows, the WHERE clause flips
 *     false, the doc stops being re-picked.
 *   - PASS 2 (reconcileInProgressRuns): finds runs in 'queued'/'running'
 *     and calls claimAiRunService.recomputeFromState(claim_id) on each.
 *     recompute is documented as "Safe to call repeatedly — purely
 *     derived from the underlying tables" and is cheap (one aggregate
 *     SELECT + at most 1 UPDATE for the run row, plus bounded inner
 *     enqueues from the orphan detector for sections > 5min stale).
 *     Healing latency for a mid-extract stall drops from "until the user
 *     refreshes" to "next 60s poll + 5min orphan threshold".
 *
 * GATING — the two passes now ship with DIFFERENT defaults (June 2026,
 * CRIT-1 stall fix). They were previously both dormant behind a single
 * flag, which meant a claim whose terminal harmonise-fire was lost had
 * ZERO server-side self-recovery — the iter4 9-hour stall.
 *
 *   PASS 2 (in-progress recompute) — the SAFE, BOUNDED self-heal
 *   heartbeat. It is the only FE-independent trigger for the in-service
 *   stall detector, orphan-section detector, and Fix-17 harmoniser
 *   auto-heal. Each recompute is one aggregate SELECT + ≤1 UPDATE and
 *   spends NO LLM unless there is genuinely lost work to recover (orphan
 *   re-extract; auto-heal harmonise is dossier-cached ~₹0). This now runs
 *   ALWAYS-ON on the worker, capped at IN_PROGRESS_PER_CYCLE/cycle. Kill
 *   switch: CLAIM_RUN_HEARTBEAT_ENABLED=false.
 *
 *   PASS 1 (queued-stage bundle-classify re-drive) — the HEAVIER "drain a
 *   stranded backlog" pass. It re-enqueues Sonnet-VISION classification
 *   for docs that were never classified, so a worker that has been off for
 *   hours could fan into real spend. This STAYS DORMANT behind
 *   CLAIM_RUN_RECONCILER_ENABLED === 'true' — enabling the heavy backfill
 *   remains a deliberate, reversible ops action (set the env var + restart
 *   the worker). Unchanged from the original design.
 *
 *   Both passes are still suppressed entirely on the API container
 *   (RUN_WORKERS === 'false').
 *
 * Scope:
 *   PASS 1 heals "docs never classified". PASS 2 heals "classify done but
 *   extract stalled / terminal harmonise-fire lost" by triggering the
 *   existing recompute that the FE poll would normally drive. Each pass
 *   guards its own errors so a failure in one (transient DB blip,
 *   lazy-import miss) doesn't kill the other, and the interval keeps
 *   firing regardless.
 */

import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import { enqueueDocBundleClassification } from './docBundleClassifier.queue.js';

// ────────────────────────────────────────────────────────────────────────────
// Tunables (kept as consts — the only env surface is the enable flag, to
// keep the "is it on?" answer unambiguous in an incident).
// ────────────────────────────────────────────────────────────────────────────

/** A run 'queued' longer than this with un-classified docs is stranded. */
const STRANDED_GRACE_SECONDS = 90;
/** Poll cadence. */
const POLL_INTERVAL_MS = 60 * 1000;
/** Max stranded claims handled per cycle (drains a backlog gradually). */
const CLAIMS_PER_CYCLE = 10;
/** Hard ceiling on re-enqueues per cycle, across all claims — a safety
 *  brake so a large backlog can't fan into hundreds of LLM calls in one
 *  tick. Remaining work is picked up on the next cycle. */
const DOCS_PER_CYCLE = 100;
/** Max in-progress claims recomputed per cycle. Each recompute is cheap
 *  (one aggregate SELECT + ≤1 UPDATE; the in-service orphan detector
 *  fires bounded inner enqueues only for sections >5min stale). The cap
 *  exists so a worker that has been off for hours can't fan into a
 *  thousand recomputes in one tick; remaining claims pick up next cycle. */
const IN_PROGRESS_PER_CYCLE = 50;

interface StrandedRun {
  claim_id: string;
  run_id: string;
  hospital_id: string;
  triggered_at: string;
  approved_budget_inr: string | null;
}

/**
 * NON-USER TRIGGER AUDIT (founder's point 5, 2026-09-14).
 *
 * PASS 1 is the ONLY thing in this codebase besides the Run Analysis button
 * that can start LLM work on a claim. It does not open a run — it re-drives
 * documents belonging to a run a user already started and paid for — but it
 * can still spend money on that user's behalf without them asking, so it now
 * carries two guards it did not have before:
 *
 *   1. PAUSED RUNS ARE NEVER RE-DRIVEN. A pause means "stop starting new
 *      work"; a reconciler that re-enqueues through a pause is not a healer,
 *      it is a second operator with opposite instructions. The status filter
 *      excludes 'paused' structurally, and `isRunHalted` is re-checked per
 *      claim in case the pause lands between the scan and the enqueue.
 *   2. AN EXHAUSTED BUDGET IS NEVER RE-DRIVEN. If the run has already spent
 *      what the user approved, re-enqueueing it would spend past a number a
 *      human said no to — through the back door, on a timer, with nobody
 *      watching. That is the precise failure the consent flow exists to
 *      prevent.
 *
 * PASS 2 spends nothing itself; it calls recomputeFromState, which is a
 * documented no-op on a paused run (§A.3).
 */
async function runBudgetExhausted(run: StrandedRun): Promise<boolean> {
  if (run.approved_budget_inr == null) return false;
  const approved = Number(run.approved_budget_inr);
  if (!Number.isFinite(approved) || approved <= 0) return false;
  try {
    const { default: costAccountingService } = await import(
      '../Services/costAccounting.service.js'
    );
    const spend = await costAccountingService.getRunSpendInr(
      run.run_id,
      run.claim_id,
      run.triggered_at,
    );
    return spend.totalInr >= approved;
  } catch (err) {
    // Fail CLOSED on the spend read: if we cannot tell whether the budget is
    // exhausted, we do not spend. A stranded run stays stranded until the
    // next cycle or until a human re-runs it; that is recoverable. Spending
    // past an approval is not.
    logger.warn(
      { err, run_id: run.run_id },
      'claimRunReconciler: run-spend read failed — skipping re-drive (fail closed)',
    );
    return true;
  }
}

interface MissingDoc {
  id: string;
  s3_key: string;
}

/**
 * PASS 1 — Queued-stage healing.
 *
 * Find runs in 'queued' for >STRANDED_GRACE_SECONDS whose documents were
 * never classified (s3_key set, no document_sections rows). Re-enqueue
 * bundle-classify per doc using the orchestrator's non-force idempotent
 * jobId so Bull collapses against any job already in flight.
 */
async function reconcileQueuedRuns(): Promise<void> {
  const strandedRes = await pool.query<StrandedRun>(
    // 'queued' only — 'paused' is structurally excluded here, and a run that
    // reached 'running' is PASS 2's business.
    `SELECT DISTINCT ON (r.claim_id)
            r.claim_id,
            r.id                  AS run_id,
            i.hospital_id,
            r.triggered_at,
            r.approved_budget_inr
       FROM hospital.claim_ai_runs r
       JOIN hospital.ipds i ON i.id = r.claim_id
      WHERE r.status = 'queued'
        AND r.triggered_at < NOW() - INTERVAL '${STRANDED_GRACE_SECONDS} seconds'
      ORDER BY r.claim_id, r.triggered_at DESC
      LIMIT $1`,
    [CLAIMS_PER_CYCLE],
  );

  if (strandedRes.rowCount === 0) return;

  let claimsTouched = 0;
  let docsReenqueued = 0;

  for (const run of strandedRes.rows) {
    if (docsReenqueued >= DOCS_PER_CYCLE) {
      logger.warn(
        { docsReenqueued, cap: DOCS_PER_CYCLE },
        'claimRunReconciler: hit per-cycle re-enqueue cap, deferring rest to next tick',
      );
      break;
    }

    // ─── Guard 1: the run must not be paused RIGHT NOW ────────────────
    // The status filter above already excludes 'paused', but a pause can
    // land between that scan and this enqueue. isRunHalted is PG-
    // authoritative and memoised, so this is effectively free.
    const { default: claimAiRunService } = await import(
      '../Services/claimAiRun.service.js'
    );
    const { halted } = await claimAiRunService.isRunHalted(run.run_id);
    if (halted) {
      logger.info(
        { claim_id: run.claim_id, run_id: run.run_id },
        'claimRunReconciler: run is paused — NOT re-driving (a pause is not a stall)',
      );
      continue;
    }

    // ─── Guard 2: the approved budget must not be exhausted ───────────
    if (await runBudgetExhausted(run)) {
      logger.info(
        {
          claim_id: run.claim_id,
          run_id: run.run_id,
          approved_budget_inr: run.approved_budget_inr,
        },
        'claimRunReconciler: run has spent its approved budget — NOT re-driving; the user must approve more',
      );
      continue;
    }

    const missingRes = await pool.query<MissingDoc>(
      `SELECT d.id, d.s3_key
         FROM hospital.ipd_doc d
        WHERE d.ipd_id = $1
          AND d.s3_key IS NOT NULL
          AND NOT EXISTS (
                SELECT 1
                  FROM hospital.document_sections s
                 WHERE s.document_id = d.id
              )`,
      [run.claim_id],
    );

    if (missingRes.rowCount === 0) {
      // Run is 'queued' but every doc already has sections — not an
      // enqueue-loss case. PASS 2 below will trigger recompute and the
      // in-service stall + orphan detectors handle whatever's stuck.
      continue;
    }

    claimsTouched += 1;

    for (const doc of missingRes.rows) {
      if (docsReenqueued >= DOCS_PER_CYCLE) break;
      // Non-force idempotent jobId — identical to the orchestrator's, so
      // Bull collapses this against any job already in flight for the doc.
      await enqueueDocBundleClassification(
        doc.id,
        run.claim_id,
        run.hospital_id,
        doc.s3_key,
        false,
        `bundle-classify:${doc.id}`,
      );
      docsReenqueued += 1;
    }

    logger.info(
      {
        claim_id: run.claim_id,
        run_id: run.run_id,
        docs_reenqueued: missingRes.rowCount,
      },
      'claimRunReconciler: re-drove stranded run (queued-stage)',
    );
  }

  if (docsReenqueued > 0) {
    logger.info(
      { claimsTouched, docsReenqueued, claimsScanned: strandedRes.rowCount },
      'claimRunReconciler: queued-stage pass complete',
    );
  }
}

/**
 * PASS 2 — In-progress recompute trigger.
 *
 * Find non-terminal runs (status IN ('queued', 'running')) and call
 * claimAiRunService.recomputeFromState(claim_id) on each. That single call
 * fires, inside the service:
 *   - Stall heartbeat (P8): flips doc_phase_ledger 'running' rows older
 *     than 5min to 'failed' + bumps docs_failed on the run.
 *   - Orphan-section detector (Fix 11): re-enqueues sections that are
 *     classified-but-not-extracted aged > 5min, with force=true so Bull
 *     cannot dedup against a lost job.
 *   - Status recompute: flips run status to succeeded/partial/running
 *     based on the current section + harmoniser state.
 *
 * Without this periodic trigger, the ONLY path that calls recomputeFromState
 * while a claim is mid-extract is the FE /status poll — which stops the
 * moment the user navigates away. Symptom (the incident this pass
 * closes): claims sitting at e.g. extract (19/23) for tens of minutes
 * because no one is actively viewing the page to drive the poll.
 *
 * Each recompute is cheap (one aggregate SELECT + ≤1 UPDATE) and the
 * service documents it as "Safe to call repeatedly — purely derived from
 * the underlying tables." A failure for one claim is logged and swallowed
 * so the rest of the cycle continues.
 */
async function reconcileInProgressRuns(): Promise<void> {
  // 'paused' is deliberately NOT in this list. recomputeFromState is a
  // documented no-op on a paused run (§A.3), so including it would be
  // harmless but pointless — and leaving it out makes the intent legible in
  // the query rather than only in the service.
  const res = await pool.query<{ claim_id: string }>(
    `SELECT DISTINCT ON (claim_id) claim_id
       FROM hospital.claim_ai_runs
      WHERE status IN ('queued', 'running')
      ORDER BY claim_id, triggered_at DESC
      LIMIT $1`,
    [IN_PROGRESS_PER_CYCLE],
  );

  if ((res.rowCount ?? 0) === 0) return;

  // Lazy import — avoids any circular-import risk between the cron module
  // (loaded at boot) and the service layer (which transitively imports
  // many queue modules). Also keeps the API container's load path clean,
  // since this pass is never invoked there (PASS 1 same rationale).
  const { default: claimAiRunService } = await import(
    '../Services/claimAiRun.service.js'
  );

  let recomputed = 0;
  let failures = 0;
  for (const r of res.rows) {
    try {
      await claimAiRunService.recomputeFromState(r.claim_id);
      recomputed += 1;
    } catch (err) {
      failures += 1;
      logger.warn(
        { err, claim_id: r.claim_id },
        'claimRunReconciler: recomputeFromState failed for run (non-fatal)',
      );
    }
  }

  if (recomputed > 0 || failures > 0) {
    logger.info(
      { scanned: res.rowCount, recomputed, failures },
      'claimRunReconciler: in-progress recompute pass complete',
    );
  }
}

/**
 * One reconcile cycle. Each sub-pass guards its own errors so a failure
 * in one (e.g. transient DB blip during PASS 1, lazy-import miss in
 * PASS 2) does not prevent the other from running. The interval keeps
 * firing regardless — a single bad cycle must not kill the loop.
 */
async function pollAndReconcile(opts: { queuedStage: boolean }): Promise<void> {
  // PASS 1 only runs when the heavy queued-stage backfill is explicitly
  // enabled. PASS 2 (the safe heartbeat) always runs when this cycle fires.
  if (opts.queuedStage) {
    try {
      await reconcileQueuedRuns();
    } catch (err) {
      logger.error(
        { err },
        'claimRunReconciler: queued-stage pass failed (will retry next tick)',
      );
    }
  }
  try {
    await reconcileInProgressRuns();
  } catch (err) {
    logger.error(
      { err },
      'claimRunReconciler: in-progress pass failed (will retry next tick)',
    );
  }
}

/**
 * Start the reconciler poll loop. Self-gates — safe to call unconditionally
 * from index.ts.
 *
 *   - API container (RUN_WORKERS=false): never runs either pass.
 *   - Worker container: PASS 2 (safe self-heal heartbeat) runs ALWAYS-ON by
 *     default; disable with CLAIM_RUN_HEARTBEAT_ENABLED=false. PASS 1 (heavy
 *     queued-stage Sonnet-vision re-drive) stays DORMANT unless
 *     CLAIM_RUN_RECONCILER_ENABLED=true.
 *   - If both are off, the module loads, logs "fully DORMANT", and never polls.
 */
export function startClaimRunReconciler(): void {
  if (process.env.NODE_ENV === 'test') return;

  if (process.env.RUN_WORKERS === 'false') {
    logger.info('claimRunReconciler NOT started (RUN_WORKERS=false — API container)');
    return;
  }

  // PASS 2 — always-on, bounded self-heal heartbeat. This is the CRIT-1
  // fix: without an FE-independent periodic recompute, a claim whose
  // terminal harmonise-fire was lost (coalesced + removeOnComplete) never
  // self-recovers. Default ON; killable for incident control.
  const heartbeatEnabled = process.env.CLAIM_RUN_HEARTBEAT_ENABLED !== 'false';

  // PASS 1 — heavy queued-stage backfill (re-drives Sonnet-vision classify
  // for never-classified docs). Stays dormant behind an explicit flag so
  // turning on the spend-driving backlog drain is a deliberate ops action.
  const queuedStageEnabled = process.env.CLAIM_RUN_RECONCILER_ENABLED === 'true';

  if (!heartbeatEnabled && !queuedStageEnabled) {
    logger.info(
      'claimRunReconciler fully DORMANT (CLAIM_RUN_HEARTBEAT_ENABLED=false AND CLAIM_RUN_RECONCILER_ENABLED!=true)',
    );
    return;
  }

  setInterval(() => {
    void pollAndReconcile({ queuedStage: queuedStageEnabled });
  }, POLL_INTERVAL_MS).unref();

  logger.info(
    {
      heartbeat_pass2: heartbeatEnabled
        ? 'ON (always-on self-heal)'
        : 'off (CLAIM_RUN_HEARTBEAT_ENABLED=false)',
      queued_stage_pass1: queuedStageEnabled
        ? 'ON'
        : 'DORMANT (set CLAIM_RUN_RECONCILER_ENABLED=true)',
      grace_seconds: STRANDED_GRACE_SECONDS,
      poll_interval_ms: POLL_INTERVAL_MS,
      claims_per_cycle: CLAIMS_PER_CYCLE,
      docs_per_cycle: DOCS_PER_CYCLE,
      in_progress_per_cycle: IN_PROGRESS_PER_CYCLE,
    },
    'claimRunReconciler started',
  );
}
