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
import costAccountingService, {
  type RunCostEstimate,
  type RunSpend,
} from './costAccounting.service.js';
import { formatPageRanges } from './ocrUnreadable.js';
import type { UnreadableReason } from './ocr.service.js';

export type { RunCostEstimate, RunSpend };

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

/**
 * Process-local memo window for the pause observation (§D.1). One indexed PK
 * read per second per worker is free; it is cheaper than the mistake of
 * caching it longer, because the cache duration IS the pause latency.
 */
const RUN_CONTROL_MEMO_MS = Math.max(
  0,
  parseInt(process.env.RUN_CONTROL_MEMO_MS ?? '1000', 10) || 1000,
);

/** Redis pub/sub channel for the ADVISORY pause/resume wake-up (§D.1). */
export const RUN_CONTROL_CHANNEL = 'claimai:run:control';

/** Env read PER CALL (never snapshotted at import), with a frozen default. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'superseded';

export type RunPauseReason = 'user_requested' | 'cost_consent_required';

export type RunEndReason =
  | 'completed'
  | 'budget_declined'
  | 'user_cancelled'
  | 'unreadable_pages'
  | 'orchestrator_error'
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
  // ── existing (060) ──
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
  // ── new (076) ──
  pause_reason: RunPauseReason | null;
  paused_at: string | null;
  paused_by: string | null;
  approved_budget_inr: number | null;
  budget_approved_by: string | null;
  budget_approved_at: string | null;
  spend_at_pause_inr: number | null;
  projected_remaining_inr: number | null;
  resume_count: number;
  estimate: RunCostEstimate | null;
  end_reason: RunEndReason | null;
  unreadable_acknowledged_at: string | null;
  unreadable_acknowledged_by: string | null;
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'partial',
  'failed',
  'superseded',
] as const;
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'paused',
] as const;
export const RESUMABLE_RUN_STATUSES: readonly RunStatus[] = ['paused'] as const;

export function isTerminalRunStatus(s: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(s);
}

// ────────────────────────────────────────────────────────────────────────────
// The budget-gate pause statement, as DATA.
//
// Extracted so it can be asserted on directly: the pair (text, values) has an
// invariant that is trivially checkable and was, in fact, violated —
// EVERY value must be referenced by the text. Postgres infers a parameter's
// type from its use, so an unreferenced $n is not a harmless extra argument,
// it is `42P18 could not determine data type of parameter $n` and the whole
// statement fails. See claimAiRunService.pauseForConsent.
// ────────────────────────────────────────────────────────────────────────────

export interface PauseForConsentInput {
  run_id: string;
  claim_id: string;
  spend_inr: number;
  projected_remaining_inr: number;
}

/** The exact (text, values) pair `pauseForConsent` sends to Postgres. */
export function buildPauseForConsentQuery(input: PauseForConsentInput): {
  text: string;
  values: unknown[];
} {
  return {
    // claim_id is deliberately NOT a parameter here. It is not part of the
    // predicate — the run id is the key, and adding `AND claim_id = $n` would
    // turn a caller passing a stale claim_id into a SILENT failure to pause,
    // which is the failure mode this whole method exists to prevent. The
    // mismatch is detected and logged after the fact instead.
    text: `UPDATE hospital.claim_ai_runs
              SET status                  = 'paused',
                  pause_reason            = 'cost_consent_required',
                  paused_at               = NOW(),
                  spend_at_pause_inr      = $2,
                  projected_remaining_inr = $3
            WHERE id = $1
              AND status IN ('queued','running')
          RETURNING *`,
    values: [
      input.run_id,
      Number.isFinite(input.spend_inr) ? input.spend_inr : 0,
      Number.isFinite(input.projected_remaining_inr)
        ? input.projected_remaining_inr
        : 0,
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// RELEASING UNREADABLE MARKERS ON RESUME (§C.4 / §D.4) — HIGH 4
//
// A row in claim_ai_unreadable_pages is the record that a page could not be
// read, why, in which phase, and SINCE WHEN. Resume used to open with
//
//     DELETE FROM hospital.claim_ai_unreadable_pages
//      WHERE run_id = $1 AND reason IN ('cost_budget','latency_budget')
//
// which is wrong twice over:
//
//   1. It deleted markers for documents resume was NOT re-driving. Nothing
//      was ever going to re-read those pages, so their blocked-ness simply
//      vanished — out of the end-of-run summary, out of decision_required,
//      out of the projected-remaining the NEXT pause would quote. The user
//      was told less about what they had not bought than before they paid.
//   2. Even for documents it WAS re-driving, it destroyed the history. A
//      page blocked at classify, released, re-read, and blocked again comes
//      back through persistUnreadablePages as a brand-new row with a brand-new
//      detected_at — so "this page has been unreadable since the first
//      attempt, three resumes ago" is unanswerable, and the DELETE was the
//      thing that made it unanswerable.
//
// THE RULE NOW — release, and archive before you do:
//
//   * Resume only touches markers for documents it is ACTUALLY RE-DRIVING,
//     i.e. ones carrying a ledger row it just re-armed to 'pending'. A marker
//     on any other document is LEFT EXACTLY WHERE IT IS. More budget does not
//     fix a page nothing is going to re-read, and pretending otherwise is how
//     blocked work goes missing.
//   * Before those markers are released, the full rows — doc_id, page_number,
//     reason, detail, phase, section_id and the ORIGINAL detected_at — are
//     archived verbatim into hospital.audit_logs (action
//     `claim_ai_run.resume.unreadable_released`, entity_id = run_id), inside
//     the same transaction. The history is therefore never destroyed, only
//     moved somewhere a DELETE cannot reach.
//   * Only then are they released, so the re-read the extra budget just paid
//     for is not pre-judged by the verdict of the read that was cut short.
//     This keeps the proven behaviour: every downstream consumer
//     (docExtractor's prior-unreadable short-circuit above all) sees the page
//     as un-judged and actually re-reads it.
//   * Settlement is then the re-read's job, exactly as for a first read:
//     still blocked -> persistUnreadablePages writes a fresh marker and the
//     page is visibly blocked again; read fine -> no marker, and the archive
//     row is the answer to "what did the extra ₹120 buy?".
//
// 'page_budget', 'vision_failed' and 'render_failed' are never released:
// money does not fix a page that failed to render.
// ────────────────────────────────────────────────────────────────────────────

/** audit_logs.action for the archive resume writes before releasing. */
export const UNREADABLE_RELEASED_AUDIT_ACTION =
  'claim_ai_run.resume.unreadable_released';

/** audit_logs.entity_type for that archive. */
export const RUN_AUDIT_ENTITY_TYPE = 'claim_ai_run';

/** One archived marker, exactly as it stood before resume released it. */
export interface ArchivedUnreadableMarker {
  doc_id: string;
  page_number: number;
  reason: UnreadableReason;
  detail: string | null;
  phase: string | null;
  section_id: string | null;
  /** The FIRST time this page was found unreadable. The DELETE lost this. */
  detected_at: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Unreadable-page summary types (§C.4) — the ONE consolidated end-of-run
// decision. Not one per page, not one per document: one per run.
// ────────────────────────────────────────────────────────────────────────────

export type UnreadableAction =
  | 'approve_more_budget'
  | 'rerun_with_more_time'
  | 'split_document'
  | 'retry_document'
  | 'reupload_document';

/**
 * Each reason maps to exactly ONE operator action. That mapping is the whole
 * reason the reasons are separate members rather than one "could not read it"
 * — "approve more budget" and "re-upload the document" are not the same ask.
 */
export const UNREADABLE_ACTION_BY_REASON: Record<
  UnreadableReason,
  UnreadableAction
> = {
  cost_budget: 'approve_more_budget',
  latency_budget: 'rerun_with_more_time',
  page_budget: 'split_document',
  vision_failed: 'retry_document',
  render_failed: 'reupload_document',
};

/** Most-impactful first. Drives the order of CTAs in the FE banner. */
const ACTION_PRIORITY: UnreadableAction[] = [
  'approve_more_budget',
  'reupload_document',
  'retry_document',
  'split_document',
  'rerun_with_more_time',
];

export interface UnreadableDocGroup {
  doc_id: string;
  file_name: string | null;
  total_pages: number;
  unreadable_page_numbers: number[];
  /** Compact display form, e.g. "4-7, 11". */
  page_ranges: string;
  reasons: UnreadableReason[];
  primary_action: UnreadableAction;
  /** Sections wholly unreadable, so the UI can say what was LOST. */
  affected_section_categories: string[];
}

export interface RunUnreadableSummary {
  run_id: string;
  claim_id: string;
  run_status: RunStatus;
  end_reason: RunEndReason | null;
  /** Pages still unread as of now. */
  unreadable_pages_total: number;
  /**
   * Pages that WERE blocked and that a resume released to a re-read, summed
   * over every resume of this run and read back from the archive resume
   * writes before releasing. `released - unreadable` is what the extra budget
   * actually bought; it is only answerable because resume archives rather
   * than deletes (HIGH 4).
   */
  released_pages_total: number;
  readable_pages_total: number;
  documents_affected: number;
  documents_fully_unreadable: number;
  by_reason: Record<UnreadableReason, number>;
  documents: UnreadableDocGroup[];
  suggested_actions: UnreadableAction[];
  est_cost_to_finish_inr: number | null;
  decision_required: boolean;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

/** What resume re-armed, for the API response and the log line. */
export interface ResumedWorkSummary {
  docs_reenqueued: number;
  sections_reenqueued: number;
  phases_rearmed: number;
  phases_skipped_already_done: number;
  /**
   * Budget/latency markers handed to the re-read this resume paid for, on
   * documents this resume is actually re-driving. Archived into
   * hospital.audit_logs first — see RELEASING UNREADABLE MARKERS ON RESUME
   * below — so the record of what was blocked, and since when, outlives the
   * release.
   */
  unreadable_markers_released: number;
  /**
   * Markers still standing afterwards: pages on documents with no re-armed
   * phase, plus every reason money does not fix. Surfaced rather than
   * silently dropped — they are the part of the blocked work the extra
   * budget does NOT buy, and the old blanket DELETE erased them.
   */
  unreadable_markers_preserved: number;
  /** @deprecated Pre-HIGH-4 name for `unreadable_markers_released`. */
  unreadable_markers_cleared: number;
}

/**
 * Deliberately ONE shape rather than a discriminated union: the caller is an
 * HTTP handler that must map three outcomes onto three status codes, and a
 * single object with an optional `error` keeps that mapping obvious at the
 * call site without narrowing gymnastics.
 */
export interface ResumeRunResult {
  ok: boolean;
  /** Set only when ok === false. */
  error?: 'run_not_paused' | 'budget_not_increased';
  /** The run as it now stands — the resumed row on success, the current row otherwise. */
  run: ClaimAiRunRow | null;
  /** Set only when ok === true. */
  resumed?: ResumedWorkSummary;
}

export interface OpenRunInput {
  claim_id: string;
  triggered_by?: string | null;
  total_docs: number;
  /**
   * Total rupees (OCR page reads + reasoning, combined) the user approved for
   * this run. NULL only when consent is disabled (CI / auto-approve).
   */
  approved_budget_inr?: number | null;
  /** Authenticated user id; NULL when auto-approved. */
  budget_approved_by?: string | null;
  /** Frozen snapshot of what the user was SHOWN when they approved. */
  estimate?: RunCostEstimate | null;
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
      //
      // 076: 'paused' joins the active set. A new Run-Analysis click must
      // also supersede a run somebody left paused three days ago — otherwise
      // the claim carries two live cursors and /status has to guess.
      await client.query(
        `UPDATE hospital.claim_ai_runs
            SET status = 'superseded',
                end_reason = 'superseded',
                finished_at = COALESCE(finished_at, NOW())
          WHERE claim_id = $1
            AND status IN ('queued','running','paused')`,
        [input.claim_id],
      );

      const ins = await client.query<ClaimAiRunRow>(
        `INSERT INTO hospital.claim_ai_runs
           (claim_id, triggered_by, status, phase, total_docs,
            approved_budget_inr, budget_approved_by, budget_approved_at,
            estimate)
         VALUES ($1, $2, 'queued', NULL, $3,
                 $4, $5,
                 CASE WHEN $4::numeric IS NULL THEN NULL ELSE NOW() END,
                 $6::jsonb)
         RETURNING *`,
        [
          input.claim_id,
          input.triggered_by ?? null,
          input.total_docs,
          input.approved_budget_inr ?? null,
          input.budget_approved_by ?? null,
          input.estimate ? JSON.stringify(input.estimate) : null,
        ],
      );

      await client.query('COMMIT');
      const row = ins.rows[0]!;
      logger.info(
        {
          claim_id: input.claim_id,
          run_id: row.id,
          total_docs: input.total_docs,
          approved_budget_inr: input.approved_budget_inr ?? null,
          budget_approved_by: input.budget_approved_by ?? null,
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

    // ─── THE PAUSE GUARD (§A.3) — the single most important line here ────
    //
    // A paused run is returned UNCHANGED and NOTHING ELSE happens. Not a
    // stall sweep, not the orphan re-enqueuer, not the harmoniser auto-heal.
    //
    // Everything below this line is a self-healing mechanism whose whole
    // purpose is to push a stuck run forward. During a deliberate pause that
    // is precisely the wrong behaviour: the FE polls /status, /status calls
    // recompute, and within one poll cycle the stall detector would flip the
    // parked ledger rows to 'failed', the Fix-11 orphan detector would
    // re-enqueue every unextracted section, and the Fix-17 auto-heal would
    // fire the harmoniser. The user would watch a run they just paused carry
    // on spending money.
    //
    // Terminal runs are immutable for the ordinary reason: their answer is
    // already final.
    if (run.status === 'paused' || isTerminalRunStatus(run.status)) {
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
                -- 076: 'unreadable' joins 'no_schema' as an explicit
                -- settled-skip marker. A section whose every page was
                -- unreadable costs zero LLM and can never produce fields;
                -- if it did not count as settled, the doc would never
                -- complete and the run could never reach a terminal state.
                -- Naming it here (rather than relying on the incidental
                -- extracted_fields='{}' the skip path writes) makes the
                -- intent explicit instead of load-bearing-by-accident.
                COUNT(*) FILTER (
                  WHERE ds.dedup_of IS NULL
                    AND (ds.extracted_fields IS NOT NULL
                         OR ds.extractor_model IN ('no_schema','unreadable'))
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

    // TERMINAL STATUS RULE (§C.4): a run that finishes with any unreadable
    // page terminates 'partial', never 'succeeded'. "Succeeded" must mean
    // every page was read — otherwise the operator reads a green tick as a
    // promise the run cannot keep, and a missing implant charge on page 7
    // looks exactly like a complete extraction.
    let unreadableCount = 0;
    if (allDone) {
      try {
        const u = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n
             FROM hospital.claim_ai_unreadable_pages
            WHERE run_id = $1`,
          [run.id],
        );
        unreadableCount = Number(u.rows[0]?.n ?? 0);
      } catch (err) {
        // Table missing (pre-076 DB) or unreadable: fail SAFE toward the
        // pre-076 behaviour rather than wedging every run's termination.
        logger.debug(
          { err, run_id: run.id },
          'claimAiRun: unreadable-page count failed (treating as zero)',
        );
      }
    }

    let endReason: RunEndReason | null = null;
    if (allDone) {
      if (docsFailedNow > 0 || unreadableCount > 0) {
        nextStatus = 'partial';
        endReason = docsFailedNow > 0 ? 'completed' : 'unreadable_pages';
      } else {
        nextStatus = 'succeeded';
        endReason = 'completed';
      }
    } else if (
      (fresh?.status ?? run.status) === 'queued' &&
      (sections_total > 0 || harm_status)
    ) {
      nextStatus = 'running';
    }

    const willFinish =
      nextStatus === 'succeeded' || nextStatus === 'partial' || nextStatus === 'failed';

    // Fix 18 (counter duality): clamp docs_failed at the terminal write
    // so the visible math (docs_complete + docs_failed) never overshoots
    // total_docs. The docs_failed accumulator can inflate when the bull
    // failure hook fires multiple times for the same doc (e.g., stale
    // jobs from a superseded run finishing their retry exhaustion). We
    // deliberately leave the in-flight accumulator alone (the harmoniser
    // gate semantics depend on it being monotonic), but the terminal row
    // should tell the truth: "22 of 23 done, 1 failed" not "22 done +
    // 15 failed of 23."
    const docsFailedClamped = Math.min(
      docsFailedNow,
      Math.max(0, effectiveTotalDocs - docs_complete),
    );

    // The WHERE clause is guarded on the ACTIVE statuses so a pause or a
    // supersession landing between the read at the top of this method and
    // this write cannot be clobbered by our stale view. An illegal
    // transition becomes a no-op UPDATE, not an error (§A.3).
    await pool.query(
      `UPDATE hospital.claim_ai_runs
          SET status = $2,
              phase = $3,
              docs_completed = $4,
              docs_failed = CASE WHEN $5::boolean THEN $8 ELSE docs_failed END,
              total_docs = CASE WHEN $6::boolean THEN $7 ELSE total_docs END,
              end_reason = CASE WHEN $5::boolean THEN COALESCE($9, end_reason) ELSE end_reason END,
              finished_at = CASE WHEN $5::boolean THEN NOW() ELSE finished_at END
        WHERE id = $1
          AND status IN ('queued','running')`,
      [
        run.id,
        nextStatus,
        phase,
        docs_complete,
        willFinish,
        shouldRewriteTotalDocs,
        effectiveTotalDocs,
        docsFailedClamped,
        endReason,
      ],
    );

    // Fix 17 (auto-heal wedged harmoniser):
    // The harmoniser is re-triggered by extractor-done hooks ("will re-
    // fire as more sections complete"). If the last extractor completion
    // fires before the gate (docs_complete + docs_failed >= total) is
    // satisfied, the chain ends and the harmoniser sits idle forever
    // even though it would now succeed. This was today's "stuck at
    // 22/23 harmonise for an hour" wedge: I had to manually enqueue.
    //
    // When recompute is called from a /status poll and sees that exact
    // wedge, kick the harmoniser. Non-force enqueue coalesces by jobId,
    // so concurrent pollers don't pile up jobs, and the
    // dossier_state_hash cache inside the harmoniser makes already-
    // harmonised re-runs ~₹0. After a successful harmonisation,
    // harm_status flips to 'fresh' and this guard goes silent on the
    // next poll.
    if (
      phase === 'harmonise' &&
      (harm_status === null || harm_status === 'pending') &&
      docsSettled >= effectiveTotalDocs &&
      effectiveTotalDocs > 0 &&
      nextStatus === 'running'
    ) {
      try {
        const h = await pool.query<{ hospital_id: string | null }>(
          `SELECT hospital_id FROM hospital.ipds WHERE id = $1`,
          [claim_id],
        );
        const hospital_id = h.rows[0]?.hospital_id;
        if (hospital_id) {
          // Dynamic import dodges a circular dep — the queue module
          // imports this service to read run state in its gate check.
          const { enqueueClaimHarmonisation } = await import(
            '../Workers/claimHarmoniser.queue.js'
          );
          // terminal:true → distinct `harmonise:<id>:final` jobId. We have
          // already established docsSettled >= effectiveTotalDocs above, so
          // this is the genuine ready-to-harmonise transition. Using the
          // terminal id guarantees this fire cannot be coalesced away by an
          // in-flight `harmonise:<id>` gate job that read pre-commit state —
          // the exact race behind the June 2026 9-hour stall.
          await enqueueClaimHarmonisation(claim_id, hospital_id, { terminal: true });
          logger.info(
            {
              claim_id,
              run_id: run.id,
              docs_complete,
              docs_failed: docsFailedNow,
              total: effectiveTotalDocs,
            },
            'claimAiRun: auto-heal — re-enqueued wedged harmoniser via recompute',
          );
        }
      } catch (err) {
        logger.warn(
          { err, claim_id, run_id: run.id },
          'claimAiRun: auto-heal harmoniser enqueue failed (non-fatal)',
        );
      }
    }

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
              end_reason = COALESCE(end_reason, 'orchestrator_error'),
              finished_at = NOW()
        WHERE id = $1
          AND status IN ('queued','running','paused')`,
      [run_id, error.slice(0, 1000)],
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // §D.1 — THE CONTROL PLANE
  //
  // The API container and the worker container are separate processes
  // sharing Postgres and Redis. A process-local flag is therefore not a
  // mechanism, and neither is an in-memory event emitter.
  //
  //   POSTGRES IS THE SOLE AUTHORITY. The pause IS the row:
  //   claim_ai_runs.status = 'paused'. Nothing else is the pause.
  //
  //   REDIS IS ADVISORY ONLY. A Redis outage changes NOTHING about
  //   correctness — it only makes the pause take up to RUN_CONTROL_MEMO_MS
  //   longer to be observed. A Redis miss is never read as "not paused".
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Per-process memo of the halted verdict, keyed by runId.
   * Value is the answer plus the wall-clock ms at which it expires.
   */
  private haltMemo = new Map<
    string,
    { at: number; halted: boolean; status: RunStatus | null; pauseReason: RunPauseReason | null }
  >();

  /**
   * Is this run halted (paused) right now?
   *
   * PG-authoritative, memoised per process for RUN_CONTROL_MEMO_MS.
   *
   * Returns `{ halted: false }` for an unknown runId — a run that no longer
   * exists cannot be paused, and blocking on a missing row would wedge the
   * worker forever on a claim whose run was deleted. Likewise a DB error
   * returns not-halted: failing closed here would stop the pipeline on a
   * transient blip, and the worst case of failing open is that one more unit
   * of work runs before the next check catches the pause.
   */
  async isRunHalted(runId: string | null | undefined): Promise<{
    halted: boolean;
    status: RunStatus | null;
    pauseReason: RunPauseReason | null;
  }> {
    if (!runId) return { halted: false, status: null, pauseReason: null };

    const now = Date.now();
    const memo = this.haltMemo.get(runId);
    if (memo && memo.at > now) {
      return {
        halted: memo.halted,
        status: memo.status,
        pauseReason: memo.pauseReason,
      };
    }

    let halted = false;
    let status: RunStatus | null = null;
    let pauseReason: RunPauseReason | null = null;
    try {
      const r = await pool.query<{
        status: RunStatus;
        pause_reason: RunPauseReason | null;
      }>(
        `SELECT status, pause_reason FROM hospital.claim_ai_runs WHERE id = $1`,
        [runId],
      );
      const row = r.rows[0];
      if (row) {
        status = row.status;
        pauseReason = row.pause_reason;
        halted = row.status === 'paused';
      }
    } catch (err) {
      logger.debug(
        { err, run_id: runId },
        'claimAiRun.isRunHalted: read failed (treating as not halted)',
      );
    }

    this.haltMemo.set(runId, {
      at: now + RUN_CONTROL_MEMO_MS,
      halted,
      status,
      pauseReason,
    });
    // Bound the map — a long-lived worker touches many runs.
    if (this.haltMemo.size > 500) {
      for (const [k, v] of this.haltMemo) {
        if (v.at <= now) this.haltMemo.delete(k);
      }
    }
    return { halted, status, pauseReason };
  }

  /** Drop the memo for a run, so the very next check re-reads PG. */
  invalidateHaltMemo(runId: string | null | undefined): void {
    if (runId) this.haltMemo.delete(runId);
  }

  /**
   * Convenience for the OCR `shouldStop` hook (OcrExtractOpts.shouldStop).
   *
   * Returns `undefined` when runId is null, so an unattended caller —
   * emailIntelligence, which opens no run — never gets a pause hook and can
   * never raise OcrPausedError.
   */
  makeShouldStop(runId: string | null): (() => Promise<boolean>) | undefined {
    if (!runId) return undefined;
    return async () => {
      const { halted } = await this.isRunHalted(runId);
      return halted;
    };
  }

  /**
   * Advisory Redis wake-up so a worker sleeping between units of work notices
   * promptly rather than at the next memo expiry. Deliberately fire-and-
   * forget and deliberately unimportant: correctness lives in Postgres.
   */
  private async publishControl(
    action: 'pause' | 'resume' | 'cancel',
    runId: string,
    claimId: string,
  ): Promise<void> {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      const mod: any = await import('ioredis');
      const Redis = mod?.default ?? mod?.Redis ?? mod;
      const client = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      client.on('error', () => {});
      await client.connect();
      await client.publish(
        RUN_CONTROL_CHANNEL,
        JSON.stringify({ run_id: runId, claim_id: claimId, action }),
      );
      client.disconnect();
    } catch (err) {
      logger.debug(
        { err, run_id: runId, action },
        'claimAiRun: control publish failed (advisory only — the pause is the PG row)',
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Run lookups
  // ══════════════════════════════════════════════════════════════════════

  async getRunById(runId: string): Promise<ClaimAiRunRow | null> {
    const r = await pool.query<ClaimAiRunRow>(
      `SELECT * FROM hospital.claim_ai_runs WHERE id = $1`,
      [runId],
    );
    return r.rows[0] ?? null;
  }

  /** Resolve a run by explicit id, else the claim's latest. */
  async resolveRun(
    claimId: string,
    runId?: string | null,
  ): Promise<ClaimAiRunRow | null> {
    if (runId) {
      const row = await this.getRunById(runId);
      if (row && row.claim_id === claimId) return row;
      return null;
    }
    return this.getLatestRun(claimId);
  }

  /** Spend against this run, combined OCR + reasoning (§B.5). */
  async getRunSpend(run: ClaimAiRunRow): Promise<RunSpend> {
    return costAccountingService.getRunSpendInr(
      run.id,
      run.claim_id,
      run.triggered_at,
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // §B.6 / §E.3 — PAUSE
  // ══════════════════════════════════════════════════════════════════════

  /**
   * User-requested pause. queued|running -> paused.
   *
   * rowCount = 0 means the run was already terminal or already paused. The
   * caller turns that into a 409; this method reports it by returning null.
   */
  async pauseRun(input: {
    run_id: string;
    paused_by?: string | null;
  }): Promise<ClaimAiRunRow | null> {
    const r = await pool.query<ClaimAiRunRow>(
      `UPDATE hospital.claim_ai_runs
          SET status       = 'paused',
              pause_reason = 'user_requested',
              paused_at    = NOW(),
              paused_by    = $2
        WHERE id = $1
          AND status IN ('queued','running')
      RETURNING *`,
      [input.run_id, input.paused_by ?? null],
    );
    const row = r.rows[0] ?? null;
    if (!row) return null;

    this.invalidateHaltMemo(row.id);
    // Record spend-so-far for display. Best-effort: the pause is already
    // committed and must not be undone by a cost-log hiccup.
    try {
      const spend = await this.getRunSpend(row);
      await pool.query(
        `UPDATE hospital.claim_ai_runs SET spend_at_pause_inr = $2 WHERE id = $1`,
        [row.id, spend.totalInr],
      );
      row.spend_at_pause_inr = spend.totalInr;
    } catch {
      /* display-only */
    }
    void this.publishControl('pause', row.id, row.claim_id);
    logger.info(
      { run_id: row.id, claim_id: row.claim_id, paused_by: input.paused_by ?? null },
      'claimAiRun: paused (user_requested)',
    );
    return row;
  }

  /**
   * Budget-gate pause. Called by a WORKER, not by the API, when actual spend
   * would cross the approved budget.
   *
   * The SQL and its values live in `buildPauseForConsentQuery` (below the
   * class) so a test can assert the (text, values) pair is well-formed
   * without a database, and execute it against a real one when there is one.
   * That seam exists because of a real bug: the UPDATE used to be written
   * against `$1, $3, $4` while FOUR values were passed. `$2` was never
   * referenced, so Postgres could not infer its type and every single call
   * failed with `42P18 could not determine data type of parameter $2`. All
   * three call sites wrap this in try/catch and log — so the throw was
   * swallowed, the run stayed `status=running, pause_reason=NULL`,
   * `isRunHalted` kept answering `halted:false`, and the run carried on
   * spending past the budget the user approved. Silently.
   *
   * rowCount = 0 is a NO-OP, not an error. Two workers hitting the budget in
   * the same moment is the normal case, not a race to report — the first one
   * pauses the run and the second one simply finds it already paused.
   *
   * `spend_at_pause_inr` is denormalised deliberately: the UI must show the
   * same number the pause decision was made on, even if late cost-log rows
   * from in-flight calls land afterwards.
   */
  async pauseForConsent(input: {
    run_id: string;
    claim_id: string;
    spend_inr: number;
    projected_remaining_inr: number;
  }): Promise<ClaimAiRunRow | null> {
    const q = buildPauseForConsentQuery(input);
    const r = await pool.query<ClaimAiRunRow>(q.text, q.values);
    const row = r.rows[0] ?? null;
    if (!row) {
      // The guarded UPDATE matched nothing. That is USUALLY benign — two
      // workers hitting the budget together, or a run that has already gone
      // terminal — but it is also exactly what a broken pause looks like, and
      // this method's whole job is to stop money being spent. So we go and
      // LOOK, and say which of the two it was at a level someone will see.
      let actual: { status: RunStatus; pause_reason: RunPauseReason | null } | null =
        null;
      try {
        const cur = await pool.query<{
          status: RunStatus;
          pause_reason: RunPauseReason | null;
        }>(
          `SELECT status, pause_reason FROM hospital.claim_ai_runs WHERE id = $1`,
          [input.run_id],
        );
        actual = cur.rows[0] ?? null;
      } catch {
        /* the diagnostic must never be the thing that throws */
      }
      if (actual && (actual.status === 'queued' || actual.status === 'running')) {
        // Still live after a pause attempt: the run WILL keep spending.
        logger.error(
          {
            run_id: input.run_id,
            claim_id: input.claim_id,
            status: actual.status,
            spend_inr: input.spend_inr,
          },
          'claimAiRun.pauseForConsent: pause DID NOT TAKE EFFECT — run is still live and will keep spending',
        );
      } else {
        logger.debug(
          { run_id: input.run_id, status: actual?.status ?? null },
          'claimAiRun.pauseForConsent: no-op (already paused or terminal)',
        );
      }
      return null;
    }
    if (input.claim_id && row.claim_id !== input.claim_id) {
      // Not fatal — the pause is what matters and it has happened — but a
      // caller that pauses a run belonging to a different claim has a bug
      // upstream, and this is the only place it is observable.
      logger.warn(
        {
          run_id: row.id,
          run_claim_id: row.claim_id,
          caller_claim_id: input.claim_id,
        },
        'claimAiRun.pauseForConsent: claim_id mismatch between caller and run row',
      );
    }
    this.invalidateHaltMemo(row.id);
    void this.publishControl('pause', row.id, row.claim_id);
    logger.warn(
      {
        run_id: row.id,
        claim_id: row.claim_id,
        approved_budget_inr: row.approved_budget_inr,
        spend_inr: input.spend_inr,
        projected_remaining_inr: input.projected_remaining_inr,
      },
      'claimAiRun: PAUSED for cost consent — approved budget would be exceeded',
    );
    return row;
  }

  /**
   * What is still owed on this run, in rupees (§B.6).
   *
   *   unread pixel pages still owed  × OCR_VISION_EST_PAGE_COST_INR
   * + sections classified but not extracted × EST_SECTION_EXTRACT_LIGHT_INR
   *
   * Deliberately an estimate over LIVE state rather than a slice of the
   * original quote: by the time we pause, the document set is known exactly
   * and the original estimate may have been for a different one.
   */
  async computeProjectedRemainingInr(run: ClaimAiRunRow): Promise<number> {
    let pagesOwed = 0;
    let sectionsOwed = 0;
    try {
      const p = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM hospital.claim_ai_unreadable_pages
          WHERE run_id = $1 AND reason = 'cost_budget'`,
        [run.id],
      );
      pagesOwed = Number(p.rows[0]?.n ?? 0);
    } catch {
      /* table may be absent pre-076 */
    }
    try {
      const s = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM hospital.document_sections
          WHERE claim_id = $1
            AND dedup_of IS NULL
            AND category IS NOT NULL
            AND extractor_model IS NULL`,
        [run.claim_id],
      );
      sectionsOwed = Number(s.rows[0]?.n ?? 0);
    } catch {
      /* best effort */
    }
    // Read per call, never snapshotted at import — same contract as
    // claimHardLimitInr(). Defaults are the frozen §0 values; they are read
    // here rather than through costAccounting so this projection cannot be
    // wedged by an unrelated change to the estimator's accessor surface.
    const pageCost = envNumber('OCR_VISION_EST_PAGE_COST_INR', 5.5);
    const lightCost = envNumber('EST_SECTION_EXTRACT_LIGHT_INR', 1.5);
    const total = pagesOwed * pageCost + sectionsOwed * lightCost;
    return Math.round(total * 100) / 100;
  }

  /**
   * What the pause card offers as the primary CTA: enough headroom to finish
   * the remaining work with the same 25% safety factor the pre-flight quote
   * used, rounded up to a clean ₹10 step.
   */
  suggestedAdditionalBudgetInr(projectedRemainingInr: number): number {
    const raw = Math.max(0, projectedRemainingInr) * 1.25;
    return Math.max(10, Math.ceil(raw / 10) * 10);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §D.4 / §E.4 — RESUME
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Resume a paused run, re-arming ONLY the work the ledger says is owed.
   *
   * THE SKIP RULE, per (doc_id, run_id, phase) ledger row:
   *   'done'    SKIP     work completed; never redo it
   *   'skipped' SKIP     dedup/quality dropped it; that is a decision
   *   'failed'  SKIP     terminal for that doc; counted in docs_failed
   *   'blocked' RE-RUN   cut short by a budget/pause bound — precisely what
   *                      the extra budget buys
   *   'running' RE-RUN   stale; the worker exited without finishing
   *   'pending' RE-RUN   never started
   *
   * Resume MUST NOT call resetClaimDerivedState(). Resume is not a force
   * re-run: wiping sections here would destroy exactly the completed work
   * the ledger just told us to skip.
   */
  async resumeRun(input: {
    run_id: string;
    approved_budget_inr?: number | null;
    budget_approved_by?: string | null;
  }): Promise<ResumeRunResult> {
    const client = await pool.connect();
    let run: ClaimAiRunRow;
    let phasesRearmed = 0;
    let phasesSkipped = 0;
    let markersCleared = 0;
    let markersPreserved = 0;
    try {
      await client.query('BEGIN');

      // 1. Guard: lock the row and re-read under the lock, so two resume
      //    clicks cannot both re-arm the same ledger rows.
      const locked = await client.query<ClaimAiRunRow>(
        `SELECT * FROM hospital.claim_ai_runs WHERE id = $1 FOR UPDATE`,
        [input.run_id],
      );
      const current = locked.rows[0] ?? null;
      if (!current || current.status !== 'paused') {
        await client.query('ROLLBACK');
        return { ok: false, error: 'run_not_paused', run: current };
      }

      // 2. A cost-consent pause can only be lifted by MORE money. Anything
      //    else would resume straight back into the same wall, burning the
      //    re-read and pausing again — consent as theatre.
      const requested =
        input.approved_budget_inr == null ? null : Number(input.approved_budget_inr);
      if (current.pause_reason === 'cost_consent_required') {
        const existing =
          current.approved_budget_inr == null
            ? null
            : Number(current.approved_budget_inr);
        if (
          requested == null ||
          !Number.isFinite(requested) ||
          (existing != null && requested <= existing)
        ) {
          await client.query('ROLLBACK');
          return { ok: false, error: 'budget_not_increased', run: current };
        }
      }
      // Never LOWER an approved budget: a running budget that shrinks is an
      // illegal transition (§A.3).
      const nextBudget =
        requested != null &&
        Number.isFinite(requested) &&
        (current.approved_budget_inr == null ||
          requested > Number(current.approved_budget_inr))
          ? requested
          : null;

      // 3. Reclaim and re-arm. 'running' rows are stale workers; 'blocked'
      //    rows are the parked work the extra budget is for.
      const rearm = await client.query(
        `UPDATE hospital.doc_phase_ledger
            SET status = 'pending', started_at = NULL, error = NULL
          WHERE run_id = $1 AND status IN ('running','blocked')`,
        [input.run_id],
      );
      phasesRearmed = rearm.rowCount ?? 0;

      const settled = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM hospital.doc_phase_ledger
          WHERE run_id = $1 AND status IN ('done','skipped','failed')`,
        [input.run_id],
      );
      phasesSkipped = Number(settled.rows[0]?.n ?? 0);

      const upd = await client.query<ClaimAiRunRow>(
        `UPDATE hospital.claim_ai_runs
            SET status                  = 'running',
                pause_reason            = NULL,
                paused_at               = NULL,
                paused_by               = NULL,
                spend_at_pause_inr      = NULL,
                projected_remaining_inr = NULL,
                resume_count            = resume_count + 1,
                approved_budget_inr     = COALESCE($2, approved_budget_inr),
                budget_approved_by      = COALESCE($3, budget_approved_by),
                budget_approved_at      = CASE WHEN $2::numeric IS NULL
                                               THEN budget_approved_at
                                               ELSE NOW() END
          WHERE id = $1 AND status = 'paused'
        RETURNING *`,
        [input.run_id, nextBudget, input.budget_approved_by ?? null],
      );
      if (!upd.rows[0]) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'run_not_paused', run: current };
      }
      run = upd.rows[0];

      // 4. ARCHIVE, then RELEASE, the markers that MORE MONEY / MORE TIME
      //    genuinely fixes — see "RELEASING UNREADABLE MARKERS ON RESUME"
      //    at the top of this file for the rule and why the old blanket
      //    DELETE was wrong. Scope, deliberately narrow on both axes:
      //      * reason IN ('cost_budget','latency_budget') only.
      //      * ONLY documents this resume is actually re-driving — ones with
      //        a ledger row the re-arm above just set to 'pending'.
      //
      //    All of it is inside this transaction, so the rows cannot be
      //    released without their archive landing first.
      const doomed = await client.query<ArchivedUnreadableMarker>(
        `SELECT u.doc_id,
                u.page_number,
                u.reason,
                u.detail,
                u.phase,
                u.section_id::text AS section_id,
                u.detected_at
           FROM hospital.claim_ai_unreadable_pages u
          WHERE u.run_id = $1
            AND u.reason IN ('cost_budget','latency_budget')
            AND EXISTS (
                  SELECT 1
                    FROM hospital.doc_phase_ledger l
                   WHERE l.run_id = u.run_id
                     AND l.doc_id = u.doc_id
                     AND l.status = 'pending')
          ORDER BY u.doc_id, u.page_number
          FOR UPDATE`,
        [input.run_id],
      );
      const releasing = doomed.rows;
      markersCleared = releasing.length;

      if (markersCleared > 0) {
        // The archive. user_id stays NULL on purpose: audit_logs.user_id is
        // FK'd to hospital.users, and an approver id that does not resolve
        // there would abort the whole resume over a log line. The id is kept
        // in `details` instead, where it can never fail the transaction.
        await client.query(
          `INSERT INTO hospital.audit_logs
             (user_id, action, entity_type, entity_id, details)
           VALUES (NULL, $1, $2, $3, $4::jsonb)`,
          [
            UNREADABLE_RELEASED_AUDIT_ACTION,
            RUN_AUDIT_ENTITY_TYPE,
            input.run_id,
            JSON.stringify({
              run_id: input.run_id,
              claim_id: run.claim_id,
              resume_count: run.resume_count,
              approved_budget_inr:
                run.approved_budget_inr == null
                  ? null
                  : Number(run.approved_budget_inr),
              budget_approved_by: input.budget_approved_by ?? null,
              released_count: markersCleared,
              released: releasing.map((m) => ({
                ...m,
                detected_at:
                  m.detected_at == null
                    ? null
                    : new Date(m.detected_at as any).toISOString(),
              })),
            }),
          ],
        );

        await client.query(
          `DELETE FROM hospital.claim_ai_unreadable_pages u
            WHERE u.run_id = $1
              AND (u.doc_id, u.page_number) IN (
                    SELECT * FROM UNNEST($2::uuid[], $3::int[]))`,
          [
            input.run_id,
            releasing.map((m) => m.doc_id),
            releasing.map((m) => m.page_number),
          ],
        );
      }

      // Everything still blocked that this resume is NOT going to re-read:
      // documents with no re-armed phase, and reasons money cannot fix. These
      // markers are LEFT ALONE — the old DELETE took them too, which is how
      // blocked work went missing from the summary. Counted here so the
      // response and the log say it out loud.
      const kept = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM hospital.claim_ai_unreadable_pages
          WHERE run_id = $1`,
        [input.run_id],
      );
      markersPreserved = Number(kept.rows[0]?.n ?? 0);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    this.invalidateHaltMemo(run.id);
    void this.publishControl('resume', run.id, run.claim_id);

    // 5. Re-drive, in pipeline order, ONLY the re-armed work.
    const redrive = await this.redriveResumedWork(run);

    logger.info(
      {
        run_id: run.id,
        claim_id: run.claim_id,
        approved_budget_inr: run.approved_budget_inr,
        resume_count: run.resume_count,
        phases_rearmed: phasesRearmed,
        phases_skipped_already_done: phasesSkipped,
        unreadable_markers_released: markersCleared,
        unreadable_markers_preserved: markersPreserved,
        ...redrive,
      },
      'claimAiRun: resumed',
    );

    return {
      ok: true,
      run,
      resumed: {
        docs_reenqueued: redrive.docs_reenqueued,
        sections_reenqueued: redrive.sections_reenqueued,
        phases_rearmed: phasesRearmed,
        phases_skipped_already_done: phasesSkipped,
        unreadable_markers_released: markersCleared,
        unreadable_markers_preserved: markersPreserved,
        unreadable_markers_cleared: markersCleared,
      },
    };
  }

  /**
   * §D.4 step 5 — re-enqueue only what the ledger re-armed.
   *
   * Every enqueue here is NON-FORCE with the orchestrator's own idempotent
   * jobId, so Bull collapses it against anything still queued from before the
   * pause. A force jobId would create a second job for work that is already
   * on the queue and double-spend the re-read.
   */
  private async redriveResumedWork(run: ClaimAiRunRow): Promise<{
    docs_reenqueued: number;
    sections_reenqueued: number;
  }> {
    let docs_reenqueued = 0;
    let sections_reenqueued = 0;

    const hospitalRes = await pool.query<{ hospital_id: string | null }>(
      `SELECT hospital_id FROM hospital.ipds WHERE id = $1`,
      [run.claim_id],
    );
    const hospitalId = hospitalRes.rows[0]?.hospital_id ?? null;
    if (!hospitalId) {
      logger.warn(
        { run_id: run.id, claim_id: run.claim_id },
        'claimAiRun.resume: no hospital for claim — cannot re-drive',
      );
      return { docs_reenqueued, sections_reenqueued };
    }

    // (a) Documents with a re-armed ingest/classify phase.
    try {
      const docs = await pool.query<{ id: string; s3_key: string }>(
        `SELECT DISTINCT d.id, d.s3_key
           FROM hospital.ipd_doc d
           JOIN hospital.doc_phase_ledger l ON l.doc_id = d.id
          WHERE d.ipd_id = $1
            AND d.s3_key IS NOT NULL
            AND l.run_id = $2
            AND l.phase IN ('ingest','classify')
            AND l.status = 'pending'`,
        [run.claim_id, run.id],
      );
      if ((docs.rowCount ?? 0) > 0) {
        const { enqueueDocBundleClassification } = await import(
          '../Workers/docBundleClassifier.queue.js'
        );
        for (const d of docs.rows) {
          await enqueueDocBundleClassification(
            d.id,
            run.claim_id,
            hospitalId,
            d.s3_key,
            false,
            `bundle-classify:${d.id}`,
          );
          docs_reenqueued++;
        }
      }
    } catch (err) {
      logger.warn(
        { err, run_id: run.id },
        'claimAiRun.resume: doc re-drive failed (reconciler will retry)',
      );
    }

    // (b) Sections classified but never extracted.
    try {
      const sections = await pool.query<{ id: string }>(
        `SELECT id
           FROM hospital.document_sections
          WHERE claim_id = $1
            AND category IS NOT NULL
            AND extractor_model IS NULL
            AND dedup_of IS NULL`,
        [run.claim_id],
      );
      if ((sections.rowCount ?? 0) > 0) {
        const { enqueueDocExtraction } = await import(
          '../Workers/docExtractor.queue.js'
        );
        for (const s of sections.rows) {
          await enqueueDocExtraction(s.id, run.claim_id, hospitalId, false);
          sections_reenqueued++;
        }
      }
    } catch (err) {
      logger.warn(
        { err, run_id: run.id },
        'claimAiRun.resume: section re-drive failed (orphan detector will retry)',
      );
    }

    // (c) Nothing left to do at doc level? Fire the terminal harmonisation.
    if (docs_reenqueued === 0 && sections_reenqueued === 0) {
      try {
        const { enqueueClaimHarmonisation } = await import(
          '../Workers/claimHarmoniser.queue.js'
        );
        await enqueueClaimHarmonisation(run.claim_id, hospitalId, {
          terminal: true,
        });
      } catch (err) {
        logger.warn(
          { err, run_id: run.id },
          'claimAiRun.resume: harmoniser enqueue failed (auto-heal will retry)',
        );
      }
    }

    return { docs_reenqueued, sections_reenqueued };
  }

  // ══════════════════════════════════════════════════════════════════════
  // §B.7 / §E.5 — CANCEL ("Finish with what we have")
  // ══════════════════════════════════════════════════════════════════════

  /**
   * End a paused run cleanly, KEEPING partial results. This is the DECLINE
   * half of the mid-run consent question. Nothing is deleted: the sections
   * already extracted stay extracted, and the unreadable-page summary is what
   * the user is shown next.
   *
   * Terminates as 'partial', never 'failed' — the run did what it was paid
   * for and then stopped on request. Calling it a failure would be a lie that
   * shows up in every rollup.
   */
  async cancelRun(input: {
    run_id: string;
    reason: 'budget_declined' | 'user_cancelled';
  }): Promise<ClaimAiRunRow | null> {
    const r = await pool.query<ClaimAiRunRow>(
      `UPDATE hospital.claim_ai_runs
          SET status      = 'partial',
              end_reason  = $2,
              finished_at = NOW()
        WHERE id = $1
          AND status = 'paused'
      RETURNING *`,
      [input.run_id, input.reason],
    );
    const row = r.rows[0] ?? null;
    if (!row) return null;
    this.invalidateHaltMemo(row.id);
    void this.publishControl('cancel', row.id, row.claim_id);
    logger.info(
      { run_id: row.id, claim_id: row.claim_id, end_reason: input.reason },
      'claimAiRun: run ended on user decision — partial results kept',
    );
    return row;
  }

  // ══════════════════════════════════════════════════════════════════════
  // §C.4 — THE CONSOLIDATED END-OF-RUN DECISION
  // ══════════════════════════════════════════════════════════════════════

  /**
   * One summary per run, grouped by document. The grouping matters: an
   * operator can act on "final_bill.pdf pages 5-12 were not read, approve
   * more budget" and cannot act on twelve separate page notifications.
   */
  async getUnreadableSummary(
    runId: string,
  ): Promise<RunUnreadableSummary | null> {
    const run = await this.getRunById(runId);
    if (!run) return null;

    const rows = await pool.query<{
      doc_id: string;
      page_number: number;
      reason: UnreadableReason;
      file_name: string | null;
    }>(
      `SELECT u.doc_id, u.page_number, u.reason, d.file_name
         FROM hospital.claim_ai_unreadable_pages u
         LEFT JOIN hospital.ipd_doc d ON d.id = u.doc_id
        WHERE u.run_id = $1
        ORDER BY u.doc_id, u.page_number`,
      [runId],
    );

    const byReason: Record<UnreadableReason, number> = {
      vision_failed: 0,
      cost_budget: 0,
      latency_budget: 0,
      page_budget: 0,
      render_failed: 0,
    };
    const grouped = new Map<
      string,
      { file_name: string | null; pages: number[]; reasons: Set<UnreadableReason> }
    >();
    for (const row of rows.rows) {
      if (byReason[row.reason] !== undefined) byReason[row.reason] += 1;
      let g = grouped.get(row.doc_id);
      if (!g) {
        g = { file_name: row.file_name, pages: [], reasons: new Set() };
        grouped.set(row.doc_id, g);
      }
      g.pages.push(row.page_number);
      g.reasons.add(row.reason);
    }

    const unreadableTotal = rows.rowCount ?? 0;

    // What earlier resumes released to a re-read, read back out of the
    // archive. This is the number that answers "what did the extra budget
    // buy?" — released minus what is blocked again is what got read — and it
    // is only answerable because resume archives instead of deleting.
    let releasedTotal = 0;
    try {
      const rel = await pool.query<{ n: string }>(
        `SELECT COALESCE(SUM((details->>'released_count')::int), 0)::text AS n
           FROM hospital.audit_logs
          WHERE entity_type = $1
            AND entity_id   = $2
            AND action      = $3`,
        [RUN_AUDIT_ENTITY_TYPE, runId, UNREADABLE_RELEASED_AUDIT_ACTION],
      );
      releasedTotal = Number(rel.rows[0]?.n ?? 0);
    } catch (err) {
      logger.debug(
        { err, runId },
        'claimAiRun: released-marker archive read failed (reporting zero)',
      );
    }

    // Per-document page counts, so "8 of 12 pages" is honest and so we can
    // say which documents are wholly unreadable.
    const pageCounts = new Map<string, number>();
    const sectionCats = new Map<string, Set<string>>();
    if (grouped.size > 0) {
      const docIds = [...grouped.keys()];
      try {
        const secs = await pool.query<{
          document_id: string;
          category: string | null;
          page_start: number | null;
          page_end: number | null;
          extractor_model: string | null;
        }>(
          `SELECT document_id, category, page_start, page_end, extractor_model
             FROM hospital.document_sections
            WHERE document_id = ANY($1::uuid[])`,
          [docIds],
        );
        for (const s of secs.rows) {
          const prev = pageCounts.get(s.document_id) ?? 0;
          pageCounts.set(
            s.document_id,
            Math.max(prev, Number(s.page_end ?? 0)),
          );
          // A section counts as LOST when the extractor settled it as
          // unreadable — that is the one place we know the whole page range
          // had no text, rather than inferring it from page overlap.
          if (s.category && s.extractor_model === 'unreadable') {
            let set = sectionCats.get(s.document_id);
            if (!set) {
              set = new Set();
              sectionCats.set(s.document_id, set);
            }
            set.add(s.category);
          }
        }
      } catch (err) {
        logger.debug({ err, runId }, 'claimAiRun: section lookup for summary failed');
      }
    }

    const documents: UnreadableDocGroup[] = [];
    let fullyUnreadable = 0;
    for (const [doc_id, g] of grouped) {
      const pages = [...new Set(g.pages)].sort((a, b) => a - b);
      const totalPages = Math.max(
        pageCounts.get(doc_id) ?? 0,
        pages[pages.length - 1] ?? 0,
      );
      if (totalPages > 0 && pages.length >= totalPages) fullyUnreadable++;
      const reasons = [...g.reasons];
      // The document's primary action is the most-impactful one across its
      // reasons — a doc with one cost_budget page and one render_failed page
      // needs budget first, because that is the cheaper fix to try.
      const primary =
        ACTION_PRIORITY.find((a) =>
          reasons.some((r) => UNREADABLE_ACTION_BY_REASON[r] === a),
        ) ?? 'retry_document';
      documents.push({
        doc_id,
        file_name: g.file_name,
        total_pages: totalPages,
        unreadable_page_numbers: pages,
        page_ranges: formatPageRanges(pages),
        reasons,
        primary_action: primary,
        affected_section_categories: [...(sectionCats.get(doc_id) ?? [])],
      });
    }

    const suggested = ACTION_PRIORITY.filter((a) =>
      documents.some((d) =>
        d.reasons.some((r) => UNREADABLE_ACTION_BY_REASON[r] === a),
      ),
    );

    let estToFinish: number | null = null;
    if (suggested.includes('approve_more_budget')) {
      estToFinish = await this.computeProjectedRemainingInr(run);
    }

    // Readable pages = every page the run actually transcribed. Derived from
    // the sections' page spans, which is the only page census we retain after
    // the read; absent that, it is 0 rather than a guess.
    let readableTotal = 0;
    try {
      const rp = await pool.query<{ n: string }>(
        `SELECT COALESCE(SUM(GREATEST(0, page_end - page_start + 1)),0)::text AS n
           FROM hospital.document_sections
          WHERE claim_id = $1 AND dedup_of IS NULL`,
        [run.claim_id],
      );
      readableTotal = Math.max(0, Number(rp.rows[0]?.n ?? 0) - unreadableTotal);
    } catch {
      /* display only */
    }

    return {
      run_id: run.id,
      claim_id: run.claim_id,
      run_status: run.status,
      end_reason: run.end_reason,
      unreadable_pages_total: unreadableTotal,
      released_pages_total: releasedTotal,
      readable_pages_total: readableTotal,
      documents_affected: documents.length,
      documents_fully_unreadable: fullyUnreadable,
      by_reason: byReason,
      documents,
      suggested_actions: suggested,
      est_cost_to_finish_inr: estToFinish,
      decision_required:
        unreadableTotal > 0 && run.unreadable_acknowledged_at == null,
      acknowledged_at: run.unreadable_acknowledged_at,
      acknowledged_by: run.unreadable_acknowledged_by,
    };
  }

  /**
   * "I have seen this; stop showing me the banner." Changes NO pipeline
   * state — acknowledging is not the same as fixing, and the unreadable rows
   * stay exactly where they are so a later report still tells the truth.
   */
  async acknowledgeUnreadable(
    runId: string,
    userId: string | null,
  ): Promise<{ acknowledged_at: string; acknowledged_by: string | null } | null> {
    const r = await pool.query<{
      unreadable_acknowledged_at: string;
      unreadable_acknowledged_by: string | null;
    }>(
      `UPDATE hospital.claim_ai_runs
          SET unreadable_acknowledged_at = NOW(),
              unreadable_acknowledged_by = $2
        WHERE id = $1
      RETURNING unreadable_acknowledged_at, unreadable_acknowledged_by`,
      [runId, userId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      acknowledged_at:
        typeof row.unreadable_acknowledged_at === 'string'
          ? row.unreadable_acknowledged_at
          : new Date(row.unreadable_acknowledged_at as any).toISOString(),
      acknowledged_by: row.unreadable_acknowledged_by,
    };
  }
}

export const claimAiRunService = new ClaimAiRunService();
export default claimAiRunService;

/**
 * §D.2 checkpoints 2-6 — the FIRST statement of each Bull processor.
 *
 * Called before any S3 fetch, any OCR and any LLM call. When the run is
 * paused it resets this (doc, run, phase) ledger row to 'pending' and returns
 * true, and the processor returns WITHOUT error.
 *
 * The job is CONSUMED, not retried, and that choice is deliberate. Throwing
 * would burn one of Bull's three attempts against a run that is deliberately
 * parked, and after three the doc dead-letters — the pause would have
 * destroyed work rather than deferred it. Resetting the ledger row to
 * 'pending' is what makes resume re-enqueue it (§D.4 step 5).
 *
 * Returns false — carry on — when there is no run cursor at all, which is the
 * legacy/unattended path and has nothing to pause.
 */
export async function pauseCheckpoint(args: {
  claimId: string;
  docId: string;
  phase: 'ingest' | 'classify' | 'dedup' | 'extract' | 'harmonise';
  runId?: string | null;
  label: string;
}): Promise<boolean> {
  try {
    let runId = args.runId ?? null;
    if (!runId) {
      const run = await claimAiRunService.getLatestRun(args.claimId);
      if (!run) return false;
      runId = run.id;
    }
    const { halted } = await claimAiRunService.isRunHalted(runId);
    if (!halted) return false;

    const { default: docPhaseLedgerService } = await import(
      './docPhaseLedger.service.js'
    );
    // Re-arm rather than block: this phase never started, so there is no
    // partial work to distinguish. 'pending' is the plain truth.
    await docPhaseLedgerService
      .declarePendingForce(args.docId, runId, args.phase)
      .catch(() => {});
    logger.info(
      { claim_id: args.claimId, run_id: runId, doc_id: args.docId, phase: args.phase },
      `${args.label}: run is paused — job consumed without work; resume will re-enqueue it`,
    );
    return true;
  } catch (err) {
    // A checkpoint that cannot read the run must not stop the pipeline.
    // Worst case one more unit of work runs before the next check.
    logger.debug({ err, ...args }, 'pauseCheckpoint: check failed (continuing)');
    return false;
  }
}
