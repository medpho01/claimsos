/**
 * One way to write a phase-ledger row.
 *
 * WHY THIS EXISTS
 * docPhaseLedger declares five phases — ingest, classify, dedup, extract,
 * harmonise — and its own header says the extractor, harmoniser and dedup
 * services write theirs. They did not. Only docBundleClassifier ever called
 * the ledger, for two of the five, through a `ledgerSafe` closure defined
 * inline in the middle of a 2000-line method.
 *
 * Three phases therefore never got a row, so a run could never reach `done`.
 * Downstream that produced fake "stuck" banners, made the reconciler re-drive
 * work that had already finished, and broke the resume contract — `done` is
 * skipped on resume and `blocked` is redone, and a phase with no row at all is
 * neither.
 *
 * Copying that inline closure three more times would have meant four places to
 * get the run-cursor lookup, the no-op-when-absent rule and the swallow-errors
 * rule right. This is that logic once.
 *
 * EVERY WRITE IS BEST-EFFORT AND SILENT ON FAILURE.
 * The ledger is an audit trail of work, not the work. A claim whose documents
 * were classified but whose ledger row failed to write is recoverable; one
 * whose classification was rolled back because an audit write failed is not.
 * `forClaim` returning a no-op recorder when there is no active run is the
 * same rule: a system-triggered or legacy call still does its work, it just
 * leaves no trail.
 */

import { logger } from '../../Utils/logger.js';
import type { LedgerPhase } from '../docPhaseLedger.service.js';

export interface PhaseRecorder {
  /** True when an active run was found and writes will actually land. */
  readonly active: boolean;
  start(docId: string, phase: LedgerPhase, evidence?: unknown): Promise<void>;
  finish(docId: string, phase: LedgerPhase, evidence?: unknown): Promise<void>;
  skip(docId: string, phase: LedgerPhase, reason: string, evidence?: unknown): Promise<void>;
  fail(docId: string, phase: LedgerPhase, reason: string, evidence?: unknown): Promise<void>;
}

const NOOP: PhaseRecorder = {
  active: false,
  async start() {},
  async finish() {},
  async skip() {},
  async fail() {},
};

/**
 * Harmonisation is claim-level, not per-document, but doc_phase_ledger's
 * primary key is (doc_id, run_id, phase). The all-zeros UUID is the synthetic
 * doc_id that convention already assigned it — documented in the service
 * header, now actually used.
 */
export const CLAIM_LEVEL_DOC_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Build a recorder bound to the claim's CURRENT run.
 *
 * Returns the no-op recorder when there is no run, or the run is already
 * terminal — writing phase rows against a finished run would resurrect it in
 * every progress view that counts unfinished phases.
 */
export interface RecorderDeps {
  getLatestRun(claimId: string): Promise<{ id: string; status: string } | null>;
  ledger: Record<string, (...args: any[]) => Promise<unknown>>;
}

/**
 * Loaded lazily by default — these modules pull in the pg pool, and importing
 * them eagerly would drag a database connection into every worker that merely
 * references this file. Injectable so the tests can exercise the no-op and
 * swallow-errors paths, which are the two that decide whether a bug here
 * damages a run.
 */
async function defaultDeps(): Promise<RecorderDeps> {
  const { default: claimAiRunService } = await import('../claimAiRun.service.js');
  const { default: ledger } = await import('../docPhaseLedger.service.js');
  return {
    getLatestRun: (claimId) => claimAiRunService.getLatestRun(claimId) as any,
    ledger: ledger as any,
  };
}

export async function forClaim(
  claimId: string,
  deps?: RecorderDeps,
): Promise<PhaseRecorder> {
  let runId: string | null = null;
  let ledger: RecorderDeps['ledger'] | null = null;

  try {
    const d = deps ?? (await defaultDeps());
    const run = await d.getLatestRun(claimId);
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return NOOP;
    runId = run.id;
    ledger = d.ledger;
  } catch (err) {
    logger.debug({ err, claimId }, 'phaseRecorder: run lookup failed — ledger writes skipped');
    return NOOP;
  }

  if (!runId || !ledger) return NOOP;

  const write = async (fn: string, args: unknown[], phase: LedgerPhase, docId: string) => {
    try {
      await ledger![fn](...args);
    } catch (err) {
      logger.debug({ err, docId, phase, fn }, 'phaseRecorder: ledger write failed (non-fatal)');
    }
  };

  return {
    active: true,
    start: (docId, phase, evidence) =>
      write('startPhase', [docId, runId, phase, evidence ?? null], phase, docId),
    finish: (docId, phase, evidence) =>
      write('finishPhase', [docId, runId, phase, evidence ?? null], phase, docId),
    skip: (docId, phase, reason, evidence) =>
      write('skipPhase', [docId, runId, phase, reason, evidence ?? null], phase, docId),
    fail: (docId, phase, reason, evidence) =>
      write('failPhase', [docId, runId, phase, reason, evidence ?? null], phase, docId),
  };
}

export default { forClaim, CLAIM_LEVEL_DOC_ID };
