/**
 * ClaimAiRunService — claim-level run cursor for the intelligence pipeline.
 *
 * Backed by hospital.claim_ai_runs (migration 060). One row per
 * "Run AI Analysis" click. Workers don't write to this table directly;
 * instead, the orchestrator opens a run at the start of analyzeClaim,
 * and a recompute step (or this service's heartbeat) updates progress
 * counters by aggregating over document_sections + claim_harmonised_episodes.
 *
 * Why a single aggregator rather than per-worker writes?
 *   - We have 6+ Bull workers (bundle classifier, dedup, segmenter,
 *     classifier, extractor, harmoniser). Wiring run progress into each
 *     of them is a lot of code surface to keep consistent, and a missed
 *     update path is invisible (run gets stuck in 'running' forever).
 *   - The DB already holds all the truth — document_sections rows + their
 *     status, claim_harmonised_episodes.status, etc. An aggregator that
 *     reads these gives us the right answer regardless of which workers
 *     wrote what.
 *   - When Step 3 (doc_phase_ledger) lands, workers WILL write phase
 *     rows. The aggregator becomes "read ledger, compute run state".
 *
 * Today (Step 1 of the rearch) the aggregator is intentionally simple:
 *   - phase = which stage the bottleneck is in (classify/extract/harmonise)
 *   - docs_completed = COUNT(distinct document_id with all sections extracted)
 *   - status flips to 'succeeded' when harmoniser.status='completed' AND
 *     all docs have all sections extracted; 'partial' if docs_failed > 0
 *     (currently always 0 — wired up properly in Step 6 when the quality
 *     gate can mark docs failed).
 *
 * Cost: 1 SELECT-aggregate per call. The recompute is invoked from:
 *   - The /status endpoint (replaces ad-hoc activity-window detection)
 *   - The Bull queue completion hooks (Step 7 — for now, polling is fine)
 */

import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

/**
 * Stall threshold: a phase ledger row in 'running' state for longer
 * than this is considered stuck. Calibrated for the slowest phase
 * (classify, which has its own retry-with-backoff cycle of ~90s before
 * Bull gives up entirely). A worker that's actively making progress
 * shouldn't sit on the same row this long.
 *
 * Heartbeat is driven by /status polls — no cron needed. Stalls
 * surface within one poll cycle (~3-5s) after the threshold expires.
 */
const STALL_THRESHOLD_SECONDS = 300;

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'superseded';

export type RunPhase =
  | 'quality'
  | 'orient'
  | 'dedup'
  | 'classify'
  | 'extract'
  | 'harmonise'
  | 'done';

export interface ClaimAiRunRow {
  id: string;
  claim_id: string;
  triggered_by: string | null;
  triggered_at: string;
  status: RunStatus;
  phase: RunPhase | null;
  total_docs: number;
  docs_completed: number;
  docs_failed: number;
  cost_inr: number | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpenRunInput {
  claim_id: string;
  triggered_by?: string | null;
  total_docs: number;
}

export class ClaimAiRunService {
  /**
   * Open a new run row and supersede any in-flight runs for this claim.
   *
   * Idempotency is at the caller (orchestrator) level — we don't try
   * to dedupe rapid double-clicks here, because we want each click to
   * be auditable in the table. The new run will simply supersede the
   * old, and the old's `finished_at` gets stamped with the supersession
   * time.
   */
  async openRun(input: OpenRunInput): Promise<ClaimAiRunRow> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Mark any currently-active runs for this claim as superseded.
      // We don't error if there are none — this is the normal first-run
      // case.
      await client.query(
        `UPDATE hospital.claim_ai_runs
            SET status = 'superseded',
                finished_at = COALESCE(finished_at, NOW())
          WHERE claim_id = $1
            AND status IN ('queued','running')`,
        [input.claim_id],
      );

      const ins = await client.query<ClaimAiRunRow>(
        `INSERT INTO hospital.claim_ai_runs
           (claim_id, triggered_by, status, phase, total_docs)
         VALUES ($1, $2, 'queued', NULL, $3)
         RETURNING *`,
        [input.claim_id, input.triggered_by ?? null, input.total_docs],
      );

      await client.query('COMMIT');
      const row = ins.rows[0]!;
      logger.info(
        {
          claim_id: input.claim_id,
          run_id: row.id,
          total_docs: input.total_docs,
        },
        'claimAiRun: opened',
      );
      return row;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Read the most recent run for a claim. Used by the /status endpoint
   * and by recomputeFromState() below.
   */
  async getLatestRun(claim_id: string): Promise<ClaimAiRunRow | null> {
    const r = await pool.query<ClaimAiRunRow>(
      `SELECT *
         FROM hospital.claim_ai_runs
        WHERE claim_id = $1
        ORDER BY triggered_at DESC
        LIMIT 1`,
      [claim_id],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Aggregate document/section/harmoniser state and update the latest
   * run row accordingly. Called from the /status endpoint and at the end
   * of analyzeClaim. Safe to call repeatedly — purely derived from the
   * underlying tables.
   *
   * Logic:
   *   - phase: highest pending stage in order quality→orient→dedup→
   *            classify→extract→harmonise. "Pending" means "this stage
   *            has work that isn't done yet". For Step 1 we only know
   *            classify/extract/harmonise; quality/orient/dedup land
   *            in later steps.
   *   - docs_completed: count of distinct ipd_doc rows where every
   *            non-duplicate section is extracted (extracted_fields not
   *            null OR extractor_model = 'no_schema').
   *   - status: 'succeeded' when harmoniser status = 'completed' AND
   *             docs_completed = total_docs AND docs_failed = 0;
   *             'partial' when above but docs_failed > 0;
   *             'running' when sections exist but progress incomplete;
   *             unchanged otherwise.
   *
   * Fix 9 (May 21, 2026): total_docs shrinks to match docs-with-sections
   * once classify lands, so dedup'd ipd_doc rows don't stall the gate.
   * Without this the harmoniser only ever fires on manually-forced runs.
   *
   * Background: total_docs is initialised at openRun() time from the raw
   * ipd_doc count. After bundle classification + file-level dedup +
   * content dedup, some ipd_doc rows produce ZERO document_sections rows
   * (filtered out as duplicates / quality-gated / no extractable content).
   * docs_completed is bounded above by COUNT(distinct document_id in
   * document_sections), so for any claim with dedup'd docs the gate
   *   (docs_completed + docs_failed) >= total_docs
   * is structurally unreachable. We rewrite total_docs once classify is
   * settled so the new semantics is "docs that actually need extraction".
   *
   * Guard: only shrink total_docs when (a) sections_total > 0 AND
   * sections_classified == sections_total (classify is done across the
   * board) AND (b) every original ipd_doc either has at least one
   * document_sections row OR a corresponding doc_phase_ledger row in
   * a terminal state (done/failed/skipped) — i.e. we know the doc has
   * been processed by the pipeline and definitively produced no
   * extractable content. This prevents racing against in-flight classify.
   */
  async recomputeFromState(claim_id: string): Promise<ClaimAiRunRow | null> {
    const run = await this.getLatestRun(claim_id);
    if (!run) return null;
    // Terminal runs are immutable.
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'superseded' || run.status === 'partial') {
      return run;
    }

    // ─── Heartbeat / stall detection (P8) ─────────────────────────────
    // Find any doc_phase_ledger rows in 'running' state for longer than
    // STALL_THRESHOLD_SECONDS. If any exist, those phases are stuck —
    // most likely the worker crashed mid-phase, or a Bull job got
    // stuck without firing 'failed'. Flip the stuck rows to 'failed'
    // and increment docs_failed on the run row.
    //
    // Race: between this check and the UPDATE, a worker could legitimately
    // finish the row (status -> done). The UPDATE is keyed on
    // (status='running') so it's a no-op in that case. Safe.
    try {
      const stalled = await pool.query<{
        doc_id: string;
        phase: string;
        started_at: Date;
      }>(
        `SELECT doc_id, phase, started_at
           FROM hospital.doc_phase_ledger
          WHERE run_id = $1
            AND status = 'running'
            AND started_at < NOW() - ($2 || ' seconds')::interval`,
        [run.id, String(STALL_THRESHOLD_SECONDS)],
      );
      if ((stalled.rowCount ?? 0) > 0) {
        // Flip stalled rows to failed. The phase name goes into the
        // error so the FE can show "stalled at classify".
        for (const row of stalled.rows) {
          await pool.query(
            `UPDATE hospital.doc_phase_ledger
                SET status = 'failed',
                    finished_at = NOW(),
                    error = $3
              WHERE run_id = $1
                AND doc_id = $2
                AND phase = $4
                AND status = 'running'`,
            [run.id, row.doc_id, `stalled_at_${row.phase} (>${STALL_THRESHOLD_SECONDS}s no progress)`, row.phase],
          );
        }
        // Count distinct stalled docs (a single doc could be stuck in
        // multiple phases — count it once).
        const stalledDocs = new Set(stalled.rows.map((r) => r.doc_id)).size;
        await pool.query(
          `UPDATE hospital.claim_ai_runs
              SET docs_failed = docs_failed + $2
            WHERE id = $1`,
          [run.id, stalledDocs],
        );
        logger.warn(
          {
            claim_id,
            run_id: run.id,
            stalled_phase_rows: stalled.rowCount,
            stalled_docs: stalledDocs,
          },
          'claimAiRun: heartbeat detected stalled phases — flipped to failed',
        );
      }
    } catch (err) {
      logger.warn(
        { err, claim_id, run_id: run.id },
        'claimAiRun: heartbeat check failed (non-fatal)',
      );
    }

    // ─── Fix 11 (May 21, 2026): orphaned-section detector ─────────────
    // The P8 heartbeat above only catches sections whose extractor wrote
    // a doc_phase_ledger row in 'running' state. But a Bull job can also
    // die BEFORE writing that row (Redis hiccup, worker crash between
    // job pickup and DB write, enqueue itself failing silently). The
    // section then sits with `category IS NOT NULL` (classified) but
    // `extractor_model IS NULL` (never extracted), no ledger row, no
    // Bull job — invisible to all our existing reconciliation paths.
    //
    // We caught this manually on Divyansh: one admission_notes section
    // sat orphaned for 3.5h. Without this detector, manual re-enqueue
    // is the only way out.
    //
    // Strategy: find orphaned sections (classified but no extractor_model,
    // aged > ORPHAN_THRESHOLD_SECONDS) and re-enqueue with force=true.
    // Bull's 3-attempt retry will either succeed or trigger Fix 3's
    // failed-hook which marks the doc as failed. Either way, the next
    // recompute sees a settled state.
    //
    // Loop prevention: skip sections whose document already has a
    // terminal 'failed' entry in doc_phase_ledger for phase='extract' —
    // that doc is done (failed) and we shouldn't keep poking it.
    const ORPHAN_THRESHOLD_SECONDS = 5 * 60; // 5 minutes
    try {
      const orphans = await pool.query<{
        section_id: string;
        document_id: string;
        hospital_id: string;
      }>(
        `SELECT ds.id AS section_id, ds.document_id, ipd.hospital_id
           FROM hospital.document_sections ds
           JOIN hospital.ipds ipd ON ipd.id = ds.claim_id
          WHERE ds.claim_id = $1
            AND ds.dedup_of IS NULL
            AND ds.category IS NOT NULL
            AND ds.extractor_model IS NULL
            AND ds.extracted_fields IS NULL
            AND ds.updated_at < NOW() - ($2 || ' seconds')::interval
            AND NOT EXISTS (
              SELECT 1 FROM hospital.doc_phase_ledger dpl
               WHERE dpl.run_id = $3
                 AND dpl.doc_id = ds.document_id
                 AND dpl.phase = 'extract'
                 AND dpl.status = 'failed'
            )`,
        [claim_id, String(ORPHAN_THRESHOLD_SECONDS), run.id],
      );
      if ((orphans.rowCount ?? 0) > 0) {
        const { enqueueDocExtraction } = await import(
          '../Workers/docExtractor.queue.js'
        );
        for (const row of orphans.rows) {
          await enqueueDocExtraction(
            row.section_id,
            claim_id,
            row.hospital_id,
            true, // force=true → unique jobId, bypasses any Bull dedup
          );
        }
        logger.warn(
          {
            claim_id,
            run_id: run.id,
            orphan_count: orphans.rowCount,
            sample_section_ids: orphans.rows.slice(0, 3).map((r) => r.section_id),
          },
          'claimAiRun: orphaned-section detector re-enqueued extracts (Fix 11)',
        );
      }
    } catch (err) {
      logger.warn(
        { err, claim_id, run_id: run.id },
        'claimAiRun: orphan detector failed (non-fatal)',
      );
    }

    // Aggregate across the claim. We compute progress at the per-document
    // level: a document is "complete" when all its canonical (non-dup)
    // sections have extracted_fields OR extractor_model='no_schema'.
    const agg = await pool.query<{
      total_docs: string;
      docs_complete: string;
      sections_total: string;
      sections_classified: string;
      sections_extracted: string;
      harm_status: string | null;
      ipd_docs_total: string;
      ipd_docs_classify_settled: string;
    }>(
      `WITH ds AS (
         SELECT ds.document_id,
                COUNT(*) FILTER (WHERE ds.dedup_of IS NULL) AS canonical_sections,
                COUNT(*) FILTER (
                  WHERE ds.dedup_of IS NULL
                    AND (ds.extracted_fields IS NOT NULL OR ds.extractor_model = 'no_schema')
                ) AS extracted_sections,
                -- Fix 9.2 (May 21, 2026): use CANONICAL counts only for
                -- all_sections AND classified_sections. Phase resolution
                -- compares classified < total and extracted < classified.
                -- Mixing canonical with non-canonical (dedup'd) sections
                -- on either side makes the phase walker stall: a claim
                -- with dedup'd sections that were classified before
                -- dedup would forever look like classify (or extract)
                -- pending, even when no work remained. Canonical-only
                -- on both sides makes the comparisons monotonic.
                COUNT(*) FILTER (WHERE ds.dedup_of IS NULL) AS all_sections,
                COUNT(*) FILTER (WHERE ds.dedup_of IS NULL AND ds.category IS NOT NULL) AS classified_sections
           FROM hospital.document_sections ds
          WHERE ds.claim_id = $1
          GROUP BY ds.document_id
       ),
       docs AS (
         -- Fix 9.1 (May 21, 2026): exclude docs with canonical_sections=0
         -- from the denominator. These are docs whose sections all got
         -- dedup'd-out by content/visual dedup — they have nothing to
         -- extract. If we left them in total_docs, the gap between
         -- total (counted) and docs_complete (where >0 canonical) would
         -- be permanent: NIDA had 22 docs in document_sections but 2
         -- with 0 canonical → docs_completed maxed at 20/22 forever.
         SELECT COUNT(*) FILTER (WHERE ds.canonical_sections > 0)::text AS total_docs,
                COUNT(*) FILTER (
                  WHERE ds.canonical_sections > 0
                    AND ds.canonical_sections = ds.extracted_sections
                )::text AS docs_complete
           FROM ds
       ),
       -- Per-ipd_doc classify settlement: did the bundle classifier
       -- definitively process every original doc? An ipd_doc is "classify
       -- settled" iff its doc_phase_ledger row for phase='classify' is
       -- in a terminal state (done / skipped / failed). 'skipped' is the
       -- signal that file-level dedup or quality gate dropped the doc
       -- before sections were ever emitted. We need ALL ipd_doc rows for
       -- the claim to be classify-settled before we trust the
       -- document_sections count as a final-state denominator.
       ipd_doc_classify AS (
         SELECT id.id AS doc_id,
                EXISTS (
                  SELECT 1
                    FROM hospital.doc_phase_ledger dpl
                    JOIN hospital.claim_ai_runs car
                      ON car.id = dpl.run_id
                   WHERE car.claim_id = $1
                     AND dpl.doc_id = id.id
                     AND dpl.phase = 'classify'
                     AND dpl.status IN ('done','skipped','failed')
                ) AS classify_settled
           FROM hospital.ipd_doc id
          WHERE id.ipd_id = $1
       ),
       ipd AS (
         SELECT COUNT(*)::text AS ipd_docs_total,
                COUNT(*) FILTER (WHERE classify_settled)::text AS ipd_docs_classify_settled
           FROM ipd_doc_classify
       )
       SELECT docs.total_docs,
              docs.docs_complete,
              COALESCE(SUM(ds.all_sections),0)::text         AS sections_total,
              COALESCE(SUM(ds.classified_sections),0)::text  AS sections_classified,
              COALESCE(SUM(ds.extracted_sections),0)::text   AS sections_extracted,
              (SELECT status FROM hospital.claim_harmonised_episodes
                WHERE claim_id = $1 LIMIT 1)                  AS harm_status,
              ipd.ipd_docs_total,
              ipd.ipd_docs_classify_settled
         FROM docs
         LEFT JOIN ds ON true
         CROSS JOIN ipd
         GROUP BY docs.total_docs, docs.docs_complete,
                  ipd.ipd_docs_total, ipd.ipd_docs_classify_settled`,
      [claim_id],
    );

    const a = agg.rows[0];
    const docs_complete = Number(a?.docs_complete ?? 0);
    const docs_with_sections = Number(a?.total_docs ?? 0);
    const sections_total = Number(a?.sections_total ?? 0);
    const sections_classified = Number(a?.sections_classified ?? 0);
    const sections_extracted = Number(a?.sections_extracted ?? 0);
    const harm_status = a?.harm_status ?? null;
    const ipd_docs_total = Number(a?.ipd_docs_total ?? 0);
    const ipd_docs_classify_settled = Number(a?.ipd_docs_classify_settled ?? 0);

    // Fix 9 (May 21, 2026): decide whether to rewrite total_docs.
    // Once classify is settled for every ipd_doc AND every emitted
    // section is classified, the count of distinct document_ids in
    // hospital.document_sections is the true denominator — any
    // ipd_doc that didn't make it into document_sections was dropped
    // by file-level dedup / quality gate and will never produce
    // sections. Without this rewrite, docs_completed is permanently
    // capped below total_docs and the harmoniser gate is unreachable.
    const classifyFullySettled =
      sections_total > 0 &&
      sections_classified === sections_total &&
      ipd_docs_total > 0 &&
      ipd_docs_classify_settled === ipd_docs_total;
    const shouldRewriteTotalDocs =
      classifyFullySettled && docs_with_sections < run.total_docs;

    // Phase resolution: pick the first incomplete stage in pipeline order.
    //
    // Fix 9.3 (May 21, 2026): use DOC-level settlement for the
    // classify→extract transitions. Sections inside a doc whose
    // extraction terminally failed (Fix 3 hook marked the doc as
    // failed in docs_failed) will NEVER get extracted_fields. If we
    // gate phase on section counts, those sections leave the gate
    // permanently un-reachable. We use docs_complete + run.docs_failed
    // against the effective total instead — that's the same accounting
    // the harmoniser gate uses, so the two stay in sync.
    const docsFailedSnapshot = run.docs_failed;
    const effectiveTotalForPhase =
      classifyFullySettled && docs_with_sections < run.total_docs
        ? docs_with_sections
        : run.total_docs;
    let phase: RunPhase = 'classify';
    if (sections_total === 0 && ipd_docs_total > 0 && ipd_docs_classify_settled < ipd_docs_total) {
      // No sections yet and classify still running for some ipd_docs.
      phase = 'classify';
    } else if (sections_classified < sections_total) {
      phase = 'classify';
    } else if (
      effectiveTotalForPhase > 0 &&
      docs_complete + docsFailedSnapshot < effectiveTotalForPhase
    ) {
      phase = 'extract';
    } else if (harm_status === 'pending' || harm_status === null) {
      phase = 'harmonise';
    } else {
      phase = 'done';
    }

    // Status resolution:
    //   - 'queued' → 'running' on first activity
    //   - 'running' → 'succeeded' when ALL docs accounted for (completed
    //     or failed) AND harmoniser settled AND no failures
    //   - 'running' → 'partial' when ALL docs accounted for AND failures > 0
    //
    // P8 change: re-fetch the run row to pick up docs_failed increments
    // that the heartbeat block above may have made. Without this we'd be
    // operating on stale in-memory state and could miss the partial flip.
    const fresh = await this.getLatestRun(claim_id);
    const docsFailedNow = fresh?.docs_failed ?? run.docs_failed;

    // Effective denominator for the all-settled check. Once classify is
    // fully settled, we trust docs_with_sections as the new total_docs
    // (see Fix 9 comment above). Before that, we keep the initial
    // ipd_doc count from openRun() so we don't race classify.
    const effectiveTotalDocs = shouldRewriteTotalDocs
      ? docs_with_sections
      : run.total_docs;

    let nextStatus: RunStatus = fresh?.status ?? run.status;
    // "All docs accounted for" — both completed AND failed count toward
    // termination, since a failed doc will never become completed.
    const docsSettled = docs_complete + docsFailedNow;
    const allDone =
      phase === 'done' &&
      docsSettled >= effectiveTotalDocs &&
      effectiveTotalDocs > 0;

    if (allDone) {
      nextStatus = docsFailedNow > 0 ? 'partial' : 'succeeded';
    } else if (
      (fresh?.status ?? run.status) === 'queued' &&
      (sections_total > 0 || harm_status)
    ) {
      nextStatus = 'running';
    }

    const willFinish =
      nextStatus === 'succeeded' || nextStatus === 'partial' || nextStatus === 'failed';

    await pool.query(
      `UPDATE hospital.claim_ai_runs
          SET status = $2,
              phase = $3,
              docs_completed = $4,
              total_docs = CASE WHEN $6::boolean THEN $7 ELSE total_docs END,
              finished_at = CASE WHEN $5::boolean THEN NOW() ELSE finished_at END
        WHERE id = $1`,
      [run.id, nextStatus, phase, docs_complete, willFinish, shouldRewriteTotalDocs, effectiveTotalDocs],
    );

    return this.getLatestRun(claim_id);
  }

  /**
   * Mark a run as orchestrator-level failed. Called when analyzeClaim
   * throws before any worker can pick up the work.
   */
  async failRun(run_id: string, error: string): Promise<void> {
    await pool.query(
      `UPDATE hospital.claim_ai_runs
          SET status = 'failed',
              error = $2,
              finished_at = NOW()
        WHERE id = $1
          AND status IN ('queued','running')`,
      [run_id, error.slice(0, 1000)],
    );
  }
}

export const claimAiRunService = new ClaimAiRunService();
export default claimAiRunService;
