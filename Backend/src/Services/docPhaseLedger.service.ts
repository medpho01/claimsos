/**
 * DocPhaseLedgerService — per-doc per-phase audit trail.
 *
 * Companion to ClaimAiRunService (the claim-level cursor). Migration 061
 * created hospital.doc_phase_ledger with a composite PK (doc_id, run_id,
 * phase). This service is the only thing that should write to that
 * table; callers are the workers themselves at phase boundaries.
 *
 * Design choices:
 *   - UPSERT-on-write so re-runs of the SAME (doc, run, phase) tuple
 *     are idempotent. A bundle classifier that retries the same job
 *     won't error on duplicate inserts; the row gets the latest state.
 *   - evidence is the per-phase JSONB. Schema is documented in the
 *     migration block-comment; this service doesn't validate it because
 *     phases will evolve their shape over time.
 *   - status transitions are NOT enforced (pending → running → done
 *     is a convention, not a constraint). A worker that crashes
 *     mid-phase will leave a row at status='running' until the
 *     heartbeat watcher (P8) flips it to failed.
 *
 * Used by:
 *   - intelligenceOrchestrator (creates pending rows for each doc when
 *     a run is opened — known docs that will be processed)
 *   - docBundleClassifier worker (writes 'ingest' + 'classify' rows)
 *   - docExtractor worker (writes 'extract' row, scoped to canonical
 *     sections of a doc)
 *   - claimHarmoniser worker (writes 'harmonise' row, claim-level —
 *     uses a synthetic doc_id of all-zeros UUID since harmonise isn't
 *     per-doc)
 *   - sectionDedupService (writes 'dedup' rows — one per doc that had
 *     sections, scoped to the run that triggered it)
 */

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

export type LedgerPhase = 'ingest' | 'classify' | 'dedup' | 'extract' | 'harmonise';
export type LedgerStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface LedgerRow {
  doc_id: string;
  run_id: string;
  phase: LedgerPhase;
  status: LedgerStatus;
  started_at: string | null;
  finished_at: string | null;
  evidence: Record<string, any> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface PoolLike {
  query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

export class DocPhaseLedgerService {
  constructor(private readonly pool: PoolLike = defaultPool as any) {}

  /**
   * Synthetic doc_id for claim-level phases (dedup, harmonise) where
   * "this work is per-doc" doesn't apply. The all-zeros UUID is a
   * convention; the schema treats it as just another UUID. Callers
   * write to (CLAIM_LEVEL_DOC_ID, run_id, phase).
   */
  static readonly CLAIM_LEVEL_DOC_ID = '00000000-0000-0000-0000-000000000000';

  /**
   * Stamp a phase as starting. UPSERT so callers don't have to know
   * whether the row exists (e.g. orchestrator may have inserted a
   * pending placeholder ahead of time, or this might be the first write).
   */
  async startPhase(
    docId: string,
    runId: string,
    phase: LedgerPhase,
    evidence: Record<string, any> | null = null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO hospital.doc_phase_ledger
         (doc_id, run_id, phase, status, started_at, evidence)
       VALUES ($1, $2, $3, 'running', NOW(), $4)
       ON CONFLICT (doc_id, run_id, phase) DO UPDATE
         SET status = 'running',
             started_at = COALESCE(hospital.doc_phase_ledger.started_at, NOW()),
             evidence = COALESCE(EXCLUDED.evidence, hospital.doc_phase_ledger.evidence)`,
      [docId, runId, phase, evidence ? JSON.stringify(evidence) : null],
    );
  }

  /**
   * Stamp a phase as done. Evidence here is the FINAL outcome — replaces
   * (rather than merges) any evidence written at start. Most workers
   * write evidence here, not at startPhase.
   */
  async finishPhase(
    docId: string,
    runId: string,
    phase: LedgerPhase,
    evidence: Record<string, any> | null = null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO hospital.doc_phase_ledger
         (doc_id, run_id, phase, status, started_at, finished_at, evidence)
       VALUES ($1, $2, $3, 'done', NOW(), NOW(), $4)
       ON CONFLICT (doc_id, run_id, phase) DO UPDATE
         SET status = 'done',
             finished_at = NOW(),
             evidence = EXCLUDED.evidence,
             error = NULL`,
      [docId, runId, phase, evidence ? JSON.stringify(evidence) : null],
    );
  }

  /**
   * Stamp a phase as skipped (e.g. quality gate failed, file-level dedup
   * matched, no sections of the right kind for this phase). Evidence
   * should explain WHY.
   */
  async skipPhase(
    docId: string,
    runId: string,
    phase: LedgerPhase,
    reason: string,
    evidence: Record<string, any> | null = null,
  ): Promise<void> {
    const ev = { ...(evidence ?? {}), skip_reason: reason };
    await this.pool.query(
      `INSERT INTO hospital.doc_phase_ledger
         (doc_id, run_id, phase, status, started_at, finished_at, evidence)
       VALUES ($1, $2, $3, 'skipped', COALESCE($4::timestamptz, NOW()), NOW(), $5)
       ON CONFLICT (doc_id, run_id, phase) DO UPDATE
         SET status = 'skipped',
             finished_at = NOW(),
             evidence = EXCLUDED.evidence`,
      [docId, runId, phase, null, JSON.stringify(ev)],
    );
  }

  /**
   * Stamp a phase as failed. Worker should call this from its catch
   * block so the FE can render the failure reason inline.
   */
  async failPhase(
    docId: string,
    runId: string,
    phase: LedgerPhase,
    error: string,
    evidence: Record<string, any> | null = null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO hospital.doc_phase_ledger
         (doc_id, run_id, phase, status, started_at, finished_at, evidence, error)
       VALUES ($1, $2, $3, 'failed', NOW(), NOW(), $4, $5)
       ON CONFLICT (doc_id, run_id, phase) DO UPDATE
         SET status = 'failed',
             finished_at = NOW(),
             evidence = COALESCE(EXCLUDED.evidence, hospital.doc_phase_ledger.evidence),
             error = EXCLUDED.error`,
      [
        docId,
        runId,
        phase,
        evidence ? JSON.stringify(evidence) : null,
        error.slice(0, 1000),
      ],
    );
  }

  /**
   * Insert a pending placeholder row. Used by the orchestrator at
   * analyzeClaim time to declare "we're going to process N docs through
   * these phases" so the FE knows what's coming before any worker has
   * started.
   *
   * Safe to call for phases that might end up skipped — the worker will
   * UPSERT the right terminal state when it actually runs.
   */
  async declarePending(
    docId: string,
    runId: string,
    phase: LedgerPhase,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO hospital.doc_phase_ledger
         (doc_id, run_id, phase, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (doc_id, run_id, phase) DO NOTHING`,
      [docId, runId, phase],
    );
  }

  /**
   * Read all ledger rows for a run. Used by the /status endpoint to
   * surface per-doc per-phase state to the FE.
   */
  async getRowsForRun(runId: string): Promise<LedgerRow[]> {
    const r = await this.pool.query(
      `SELECT *
         FROM hospital.doc_phase_ledger
        WHERE run_id = $1
        ORDER BY doc_id, phase`,
      [runId],
    );
    return r.rows as LedgerRow[];
  }

  /**
   * Stall detection — find phase rows in 'running' state for more than
   * `maxAgeSeconds`. P8 (heartbeat) will use this to flip stuck rows
   * to 'failed' with error='stalled_at_<phase>'.
   *
   * Default 300s = 5 min. Calibrated for the slowest phase (classify,
   * which has a 2-attempt retry with 30s backoff before workers give
   * up). A run actively in-flight at classify shouldn't sit longer
   * than that without progress.
   */
  async findStalledPhases(maxAgeSeconds = 300): Promise<LedgerRow[]> {
    const r = await this.pool.query(
      `SELECT *
         FROM hospital.doc_phase_ledger
        WHERE status = 'running'
          AND started_at < NOW() - ($1 || ' seconds')::interval
        ORDER BY started_at ASC`,
      [String(maxAgeSeconds)],
    );
    return r.rows as LedgerRow[];
  }
}

export const docPhaseLedgerService = new DocPhaseLedgerService();
export default docPhaseLedgerService;
