/**
 * IntelligenceOrchestratorService
 * ─────────────────────────────────────────────────────────────────────────
 * Operator-triggered "run the AI on this patient" entrypoint.
 *
 * Intelligence Layer's event-driven workers only fire when *new* events
 * land (doc uploaded, email arrived, stage changed). Existing patients
 * with pre-existing documents are invisible to the AI until something
 * triggers them. This orchestrator gives a single endpoint that:
 *
 *   1. Walks all `ipd_doc` rows for the given IPD
 *   2. For each doc without `document_sections`, enqueues segmentation
 *      (which will then cascade into classify + extract via the queue
 *      hand-offs already wired in docSegmenter.queue.ts)
 *   3. Triggers a dossier rebuild from existing submission_events
 *   4. Kicks an adjudication run (rules + KB + episodic + optional
 *      reasoning per the heuristic)
 *
 * Returns immediately with the job IDs + counts so the UI can render a
 * "started" toast. The actual work is async via Bull queues.
 *
 * Cost model — two distinct re-run shapes:
 *   - NON-force re-run: ~₹0. Already-segmented docs are skipped and
 *     adjudication is dossier_state_hash cache-safe. Calling repeatedly
 *     is a no-op.
 *   - FORCE re-run ("Re-run AI Analysis"): the opposite, on purpose. It
 *     wipes ALL AI-derived state for the claim (sections, harmonised
 *     episode, phase ledger) and rebuilds from the source documents, so
 *     it pays the full segment + classify + extract LLM cost. Force =
 *     "redo everything from scratch". This is also what unsticks a run
 *     that wedged mid-count: rebuilding routes every doc through the
 *     bundle classifier, the only path that settles doc_phase_ledger.
 */

import { createHash } from 'crypto';
import { pool } from '../DB/db.js';
import { enqueueDocSegmentation } from '../Workers/docSegmenter.queue.js';
import { enqueueDocBundleClassification } from '../Workers/docBundleClassifier.queue.js';
import { enqueueClaimHarmonisation } from '../Workers/claimHarmoniser.queue.js';
import claimDossierService from './claimDossier.service.js';
import { AdjudicationEngine } from './adjudicationEngine.service.js';
import claimAiRunService from './claimAiRun.service.js';
import docPhaseLedgerService from './docPhaseLedger.service.js';
import { logger } from '../Utils/logger.js';
import { resolveAndPersistContext } from './context/loader.js';
import costAccountingService, {
  // MODULE-LEVEL functions, not methods on the default-exported instance.
  // costAccounting.service.ts exports the pure pricing helpers as free
  // functions and `new CostAccountingService()` as its default; calling
  // `costAccountingService.estimateRunCostInr(...)` is a TypeError at runtime
  // (TS2339 at build time) and used to 500 both /estimate and the 428 branch
  // of /analyze — i.e. it took out the entire consent gate.
  claimHardLimitInr,
  claimOcrHardLimitInr,
  estimateRunCostInr,
  type RunCostEstimate,
  type RunCostEstimateDocInput,
} from './costAccounting.service.js';
import s3Service from './s3.service.js';
import {
  censusPdfPages,
  IMAGE_CENSUS,
  PAGE_COUNT_UNKNOWN_PAGES,
} from './ocr.service.js';

export type { RunCostEstimate };

export interface AnalyzeClaimInput {
  claim_id: string;            // IPD id
  hospital_id: string;
  force?: boolean;             // re-segment even if version matches
  target_stage?: string;       // optional stage to adjudicate for
  triggered_by_user_id?: string;
  /**
   * Total rupees (OCR page reads + reasoning, combined) the user approved for
   * this run. The controller enforces consent; by the time we are called the
   * number has already been validated and, when consent is disabled, filled
   * in from the estimate's recommended budget.
   */
  approved_budget_inr?: number | null;
  /** Authenticated user id who approved; NULL when auto-approved. */
  budget_approved_by?: string | null;
  /**
   * The estimate the user was SHOWN when they approved, frozen onto the run
   * row. Audit: it must be possible to answer "what were they told?" without
   * recomputing against a document set that has since changed.
   */
  estimate?: RunCostEstimate | null;
}

export interface AnalyzeClaimResult {
  claim_id: string;
  /**
   * The claim_ai_runs row id that was opened for this analyzeClaim call.
   * The FE polls /claims/:id/status which now reads this run row to
   * decide whether the Documents tab should render the stable terminal
   * state or a "still processing" banner. Step 1 of the pipeline
   * rearchitecture (migration 060, May 2026).
   */
  run_id: string | null;
  docs_total: number;
  docs_already_segmented: number;
  docs_enqueued_for_segmentation: number;
  segmentation_job_ids: string[];
  dossier_rebuilt: boolean;
  adjudication_report_id: string | null;
  adjudication_target_stage: string | null;
  adjudication_readiness_score: number | null;
  warnings: string[];
  /** Echoed back so the FE can render "running against a ₹390 budget". */
  approved_budget_inr?: number | null;
  estimate?: RunCostEstimate | null;
}

export class IntelligenceOrchestratorService {
  /**
   * PRE-FLIGHT COST ESTIMATE (§B.1 / §B.2). CPU-only, ZERO LLM spend, creates
   * NO run row, safe to call repeatedly.
   *
   * The expensive-looking part is downloading each document from S3 to run a
   * page census on it. That is deliberate and unavoidable: the price of a run
   * is dominated by how many PIXEL pages it must send to vision, and there is
   * no way to know that without looking inside the PDF. A page with a real
   * embedded text layer costs nothing to read, and a quote that ignored the
   * distinction would be wrong by the size of the whole bill on a typed
   * bundle.
   *
   * `censusPdfPages` never throws: a parse failure comes back degraded, and a
   * degraded document is quoted at PAGE_COUNT_UNKNOWN_PAGES pixel pages so
   * the quote is conservative rather than absent. Being asked to approve a
   * number that turns out to be too high is recoverable; being asked to
   * approve nothing is not.
   */
  async estimateRun(input: {
    claim_id: string;
    hospital_id: string;
  }): Promise<RunCostEstimate> {
    const docs = await pool.query<{
      id: string;
      s3_key: string | null;
      file_name: string | null;
      mime_type: string | null;
    }>(
      `SELECT id, s3_key, file_name, mime_type
         FROM hospital.ipd_doc
        WHERE ipd_id = $1
          AND s3_key IS NOT NULL
          AND dedup_of IS NULL
        ORDER BY created_at NULLS LAST, id`,
      [input.claim_id],
    );

    const notes: string[] = [];
    const docInputs: RunCostEstimateDocInput[] = [];

    for (const d of docs.rows) {
      const label = d.file_name ?? d.id;
      const looksImage = /^image\//i.test(d.mime_type ?? '');
      try {
        const bytes = await s3Service.download(d.s3_key!);
        const census = looksImage || this.isImageBuffer(bytes)
          ? IMAGE_CENSUS
          : await censusPdfPages(bytes);
        if (census.degraded) {
          notes.push(
            `${label} could not be parsed; quoted at ${PAGE_COUNT_UNKNOWN_PAGES} pages`,
          );
        }
        docInputs.push({
          doc_id: d.id,
          file_name: d.file_name,
          total_pages: census.degraded
            ? PAGE_COUNT_UNKNOWN_PAGES
            : census.totalPages,
          pixel_pages: census.degraded
            ? PAGE_COUNT_UNKNOWN_PAGES
            : census.pixelPages.length,
          degraded: census.degraded,
        });
      } catch (err: any) {
        // An S3 miss is not a reason to refuse a quote — it is a reason to
        // quote conservatively and say so.
        logger.warn(
          { err, doc_id: d.id, claim_id: input.claim_id },
          'intelligenceOrchestrator.estimateRun: census failed; quoting conservatively',
        );
        notes.push(
          `${label} could not be read for the estimate; quoted at ${PAGE_COUNT_UNKNOWN_PAGES} pages`,
        );
        docInputs.push({
          doc_id: d.id,
          file_name: d.file_name,
          total_pages: PAGE_COUNT_UNKNOWN_PAGES,
          pixel_pages: PAGE_COUNT_UNKNOWN_PAGES,
          degraded: true,
        });
      }
    }

    // Headroom the existing STATIC caps still impose. The user's approval
    // buys headroom inside those caps, never through them — so showing both
    // numbers is the difference between "you may spend this" and "you may ask
    // to spend this".
    let priorSpend = 0;
    let ocrHeadroom = 0;
    let reasoningHeadroom = 0;
    try {
      const breakdown = await costAccountingService.getClaimSpendBreakdownInr(
        input.claim_id,
      );
      priorSpend = breakdown.totalInr;
      ocrHeadroom = Math.max(0, claimOcrHardLimitInr() - breakdown.ocrInr);
      reasoningHeadroom = Math.max(0, claimHardLimitInr() - breakdown.reasoningInr);
    } catch (err) {
      logger.warn(
        { err, claim_id: input.claim_id },
        'intelligenceOrchestrator.estimateRun: headroom read failed (showing zero headroom)',
      );
    }

    const estimate = estimateRunCostInr({
      claim_id: input.claim_id,
      docs: docInputs,
      prior_claim_spend_inr: priorSpend,
      claim_ocr_headroom_inr: ocrHeadroom,
      claim_reasoning_headroom_inr: reasoningHeadroom,
    });
    if (notes.length > 0) estimate.notes.push(...notes);
    return estimate;
  }

  /** Magic-byte sniff, same rule the segmenter uses. PNG / JPEG / GIF. */
  private isImageBuffer(buf: Buffer): boolean {
    if (!buf || buf.length < 4) return false;
    if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return true; // PNG
    }
    return buf.slice(0, 3).toString('ascii') === 'GIF';
  }

  /**
   * One-shot "analyze this claim" entrypoint. Idempotent across re-runs.
   */
  async analyzeClaim(input: AnalyzeClaimInput): Promise<AnalyzeClaimResult> {
    const warnings: string[] = [];
    const result: AnalyzeClaimResult = {
      claim_id: input.claim_id,
      run_id: null,
      docs_total: 0,
      docs_already_segmented: 0,
      docs_enqueued_for_segmentation: 0,
      segmentation_job_ids: [],
      dossier_rebuilt: false,
      adjudication_report_id: null,
      adjudication_target_stage: null,
      adjudication_readiness_score: null,
      warnings,
    };

    // ─── KILL SWITCH ────────────────────────────────────────────────────
    // AI_ANALYSIS_ENABLED=false in the env globally disables the
    // orchestrator. Set it when LLM cost is bleeding, when running a
    // backfill that we don't want disrupted by user-triggered runs, or
    // during incident response. The HTTP endpoint surfaces the refusal
    // as a 503 with `warnings: ['ai_analysis_disabled']` so the FE can
    // render a "AI analysis temporarily paused" banner.
    //
    // ALLOW-LIST escape hatch: set AI_ANALYSIS_ALLOWED_CLAIMS to a
    // comma-separated list of claim_ids that bypass the kill switch
    // (useful for verifying a fix on one patient without re-enabling
    // globally). Empty / missing = no allow-list, kill switch applies
    // to every claim.
    if (process.env.AI_ANALYSIS_ENABLED === 'false') {
      const allowList = (process.env.AI_ANALYSIS_ALLOWED_CLAIMS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!allowList.includes(input.claim_id)) {
        logger.warn(
          {
            claim_id: input.claim_id,
            allowed_count: allowList.length,
          },
          'intelligenceOrchestrator: analyzeClaim REFUSED — AI_ANALYSIS_ENABLED=false and claim not in allow-list',
        );
        warnings.push('ai_analysis_disabled');
        return result;
      }
      logger.info(
        { claim_id: input.claim_id },
        'intelligenceOrchestrator: analyzeClaim allowed via AI_ANALYSIS_ALLOWED_CLAIMS',
      );
    }

    // ─── Step 1: enumerate docs ─────────────────────────────────────────
    const docs = await pool.query<{
      id: string;
      s3_key: string | null;
      file_name: string | null;
    }>(
      `SELECT id, s3_key, file_name
         FROM hospital.ipd_doc
        WHERE ipd_id = $1
          AND s3_key IS NOT NULL`,
      [input.claim_id],
    );
    result.docs_total = docs.rowCount ?? 0;

    if (result.docs_total === 0) {
      warnings.push('no_documents_found');
    }

    // ─── Force re-run = start from scratch ──────────────────────────────
    // "Re-run AI Analysis" means redo everything. Before opening the new
    // run cursor we wipe all AI-derived state for the claim (sections,
    // harmonised episode, phase ledger) in one transaction. Two reasons:
    //   1. Counter resets to 0 — the run genuinely rebuilds from source,
    //      so the FE never shows a confusing mid-count carried over from a
    //      previous attempt.
    //   2. It unsticks the old wedge. With sections gone, Step 2 sees zero
    //      sections per doc and routes EVERY doc through the bundle
    //      classifier — the only path that settles doc_phase_ledger. That
    //      settlement is the precondition for the denominator rewrite
    //      (Fix 9.1) and the harmoniser gate; the legacy per-section force
    //      path never settled it, which is why re-runs jammed mid-count.
    // The reset is atomic — on failure the claim is untouched, so we bail
    // before opening a run rather than risk a half-wiped, inconsistent
    // claim. (Caveat: human field-corrections orphan on delete — see
    // resetClaimDerivedState.)
    if (input.force) {
      try {
        const reset = await this.resetClaimDerivedState(input.claim_id);
        logger.info(
          { claim_id: input.claim_id, ...reset },
          'intelligenceOrchestrator: force re-run — wiped derived state, rebuilding from scratch',
        );
      } catch (err: any) {
        logger.error(
          { err, claim_id: input.claim_id },
          'intelligenceOrchestrator: derived-state reset failed — aborting force re-run (claim left untouched)',
        );
        warnings.push(`force_reset_failed: ${err?.message ?? err}`);
        return result;
      }
    }

    // ─── Open a run cursor (Step 1 of pipeline rearch, migration 060) ───
    // One row per Run AI Analysis click. Supersedes any in-flight run for
    // this claim. The FE polls /claims/:id/status which now reads this
    // row to gate the Documents tab — terminal state only, no flickering
    // mid-run snapshots. Best-effort: a failed insert is logged but
    // doesn't block the orchestrator.
    let runId: string | null = null;
    try {
      const run = await claimAiRunService.openRun({
        claim_id: input.claim_id,
        triggered_by: input.triggered_by_user_id ?? null,
        total_docs: result.docs_total,
        approved_budget_inr: input.approved_budget_inr ?? null,
        budget_approved_by: input.budget_approved_by ?? null,
        estimate: input.estimate ?? null,
      });
      runId = run.id;
      result.run_id = runId;
      result.approved_budget_inr = run.approved_budget_inr;
      result.estimate = input.estimate ?? null;
    } catch (err: any) {
      logger.warn(
        { err, claim_id: input.claim_id },
        'intelligenceOrchestrator: openRun failed (continuing without run cursor)',
      );
      warnings.push(`run_open_failed: ${err?.message ?? err}`);
    }

    // ─── Declare pending phase ledger rows (Step P6, migration 061) ─────
    // For every doc we just enumerated, insert (doc_id, run_id, phase)
    // rows in 'pending' state for the phases that will actually execute.
    // This lets the FE render "N pending docs" before any worker picks
    // up the job, which is otherwise invisible (sections table is the
    // only signal today, and that's empty until classify finishes).
    //
    // Best-effort: a failure here only impacts FE telemetry, not the
    // pipeline itself.
    if (runId) {
      for (const doc of docs.rows) {
        for (const phase of ['ingest', 'classify', 'extract'] as const) {
          try {
            await docPhaseLedgerService.declarePending(doc.id, runId, phase);
          } catch (err) {
            // Per-doc per-phase declare failure is non-fatal — workers
            // will UPSERT the right state when they actually run.
            logger.debug(
              { err, doc_id: doc.id, run_id: runId, phase },
              'docPhaseLedger: declarePending failed (non-fatal)',
            );
          }
        }
      }
      // Claim-level phases (dedup, harmonise) get one synthetic row each.
      for (const phase of ['dedup', 'harmonise'] as const) {
        try {
          await docPhaseLedgerService.declarePending(
            (await import('./docPhaseLedger.service.js'))
              .DocPhaseLedgerService.CLAIM_LEVEL_DOC_ID,
            runId,
            phase,
          );
        } catch {
          /* non-fatal */
        }
      }
    }

    // ─── Step 2: for each doc, route to the bundle classifier ───────────
    //
    // Wave 12 routes NEW documents through docBundleClassifier (single
    // Sonnet call producing segments + categories together) instead of
    // the legacy docSegmenter → docClassifier chain. Decision tree:
    //
    //   - No sections yet for this doc → bundle classifier handles it.
    //   - Sections exist AND !force → already-segmented, skip.
    //   - force → the from-scratch reset above already deleted every
    //       section, so this doc has none and falls into the first case.
    //       (There is no longer a "re-classify existing sections" branch —
    //       force means rebuild, not refresh.)
    //
    // The bundle classifier has its own fallback inside the service: if
    // the document is too big for one LLM call (OCR text > 80k chars),
    // or the LLM emits an invalid response, it punts to the legacy
    // segmenter for that document.
    for (const doc of docs.rows) {
      // ─── §D.2 CHECKPOINT 1 — between documents, before the probe ──────
      // The first of the nine checkpoints, and the cheapest place to stop:
      // nothing has been fetched, nothing enqueued for this doc. A pause
      // landing here leaves the remaining docs with their 'pending' ledger
      // rows untouched, which is exactly what resume re-drives.
      if (runId) {
        const { halted } = await claimAiRunService.isRunHalted(runId);
        if (halted) {
          logger.info(
            {
              claim_id: input.claim_id,
              run_id: runId,
              enqueued_so_far: result.docs_enqueued_for_segmentation,
            },
            'intelligenceOrchestrator: run paused — stopping enqueue loop',
          );
          warnings.push('run_paused');
          break;
        }
      }

      const existing = await pool.query(
        `SELECT 1
           FROM hospital.document_sections
          WHERE document_id = $1
          LIMIT 1`,
        [doc.id],
      );
      if ((existing.rowCount ?? 0) > 0) {
        // Sections exist — either skip (no force) or let Step 2b handle
        // the per-section force re-run. Either way, no bundle enqueue.
        result.docs_already_segmented++;
        continue;
      }
      if (!doc.s3_key) {
        warnings.push(`doc_${doc.id}_missing_s3_key`);
        continue;
      }
      const idemKey = `bundle-classify:${doc.id}${input.force ? `:force:${Date.now()}` : ''}`;
      try {
        await enqueueDocBundleClassification(
          doc.id,
          input.claim_id,
          input.hospital_id,
          doc.s3_key,
          input.force === true,
          idemKey,
        );
        result.docs_enqueued_for_segmentation++;
        result.segmentation_job_ids.push(idemKey);
      } catch (err: any) {
        warnings.push(`doc_${doc.id}_bundle_enqueue_failed: ${err?.message ?? err}`);
        // Last-ditch: try the legacy segmenter so the doc isn't stuck.
        try {
          const fallbackIdem = createHash('sha256')
            .update(`${doc.id}:segmenter:fallback:${Date.now()}`)
            .digest('hex')
            .slice(0, 32);
          await enqueueDocSegmentation(
            doc.id,
            input.claim_id,
            input.hospital_id,
            doc.s3_key,
            fallbackIdem,
          );
          warnings.push(`doc_${doc.id}_used_legacy_segmenter_fallback`);
        } catch (segErr: any) {
          warnings.push(`doc_${doc.id}_all_enqueue_paths_failed: ${segErr?.message ?? segErr}`);
        }
      }
    }

    // ─── (Step 2b removed) ──────────────────────────────────────────────
    // There used to be a force-only "re-classify + re-extract the existing
    // sections in place" path here. It preserved section_ids/corrections
    // but never deleted sections — and crucially never settled the phase
    // ledger, which is what jammed the run cursor mid-count. Force now
    // means "from scratch": the reset above deletes every section, so by
    // this point there is nothing to re-enqueue and every doc has already
    // been routed through the bundle classifier in Step 2.

    // ─── Step 2c: claim-level content dedup ─────────────────────────────
    // Belt-and-braces. The bundle classifier already calls dedup after
    // each doc finishes (docBundleClassifier.service.ts), but one case
    // still reaches here without that having run:
    //   (a) all docs short-circuited via the idempotency cache → no
    //       persistBundle, no dedup trigger
    // Calling dedup synchronously here covers it. Cheap — pure SQL,
    // no LLM. Returns a summary we surface in the analyzeClaim result
    // so the UI can show "8 of 22 sections deduped this run".
    try {
      const { sectionDedupService } = await import('./sectionDedup.service.js');
      const dedupResult = await sectionDedupService.dedupClaim(input.claim_id);
      if (dedupResult.groups_found > 0) {
        logger.info(
          {
            claim_id: input.claim_id,
            groups_found: dedupResult.groups_found,
            sections_deduped: dedupResult.sections_deduped,
          },
          'intelligenceOrchestrator: section dedup applied (orchestrator-level safety net)',
        );
      }
    } catch (err: any) {
      logger.warn(
        { err, claim_id: input.claim_id },
        'intelligenceOrchestrator: section dedup failed (continuing; extractor will still respect any dedup_of pointers set by the bundle classifier path)',
      );
      warnings.push(`section_dedup_failed: ${err?.message ?? err}`);
    }

    // ─── Step 3: rebuild dossier from existing submission_events ────────
    try {
      await claimDossierService.rebuildFromEvents(input.claim_id);
      result.dossier_rebuilt = true;
    } catch (err: any) {
      // If the IPD has no events yet, rebuildFromEvents will throw — that's
      // fine, the projection just won't exist yet. Continue with adjudication
      // attempt; it'll create a fresh dossier shell if needed.
      logger.warn(
        { err, claim_id: input.claim_id },
        'intelligenceOrchestrator: dossier rebuild failed (continuing)',
      );
      warnings.push(`dossier_rebuild_failed: ${err?.message ?? err}`);
    }

    // ─── Step 3.5: resolve + persist claim_context (SHADOW) ─────────────
    // Deterministic {scheme,route,insurer,stage,case_type} for the claim,
    // UPSERT into hospital.claim_context (migration 067). Shadow-only — no
    // decision path reads it yet (M5 wires it in). Best-effort: never blocks.
    try {
      await resolveAndPersistContext(input.claim_id);
    } catch (err: any) {
      logger.warn(
        { err, claim_id: input.claim_id },
        'intelligenceOrchestrator: claim_context resolve/persist failed (shadow; continuing)',
      );
      warnings.push(`claim_context_failed: ${err?.message ?? err}`);
    }

    // ─── Step 4: trigger adjudication ───────────────────────────────────
    try {
      const engine = new AdjudicationEngine();
      const report = await engine.run({
        claim_id: input.claim_id,
        target_stage: input.target_stage,
        force: false, // cache hit is fine
      });
      result.adjudication_report_id = report.id;
      result.adjudication_target_stage = report.target_stage;
      result.adjudication_readiness_score = report.readiness_score;
    } catch (err: any) {
      // Common case for fresh IPDs with no dossier: throws "no dossier for
      // claim X". That's expected — segmentation will eventually project
      // events that build the dossier; user can re-trigger then.
      logger.warn(
        { err, claim_id: input.claim_id },
        'intelligenceOrchestrator: adjudication run failed (will become available once docs are processed)',
      );
      warnings.push(`adjudication_pending: ${err?.message ?? err}`);
    }

    // ─── Step 5: enqueue Wave-7 harmonisation ───────────────────────────
    // Fire-and-forget. The harmoniser is dossier_state_hash-cached so a
    // call against an unchanged dossier is a ~₹0 no-op; the worker
    // handles the LLM hit + budget checks asynchronously so this
    // endpoint stays snappy. If segmentation is still in flight, the
    // harmoniser will re-run when the dossier moves and the
    // dossier_state_hash flips.
    try {
      await enqueueClaimHarmonisation(input.claim_id, input.hospital_id, {
        force: input.force === true,
      });
    } catch (err: any) {
      logger.warn(
        { err, claim_id: input.claim_id },
        'intelligenceOrchestrator: harmonisation enqueue failed (non-blocking)',
      );
      warnings.push(`harmonisation_enqueue_failed: ${err?.message ?? err}`);
    }

    // ─── Recompute run cursor state ─────────────────────────────────────
    // We don't know yet if the workers will succeed — they're async. But
    // we can flip 'queued' → 'running' immediately if any sections already
    // exist (idempotent re-run case) or if a harmoniser row is in place.
    // The /status endpoint also calls recompute on every poll, so terminal
    // transitions ('succeeded'/'partial') happen as soon as the FE notices.
    if (runId) {
      try {
        await claimAiRunService.recomputeFromState(input.claim_id);
      } catch (err: any) {
        logger.warn(
          { err, claim_id: input.claim_id, run_id: runId },
          'intelligenceOrchestrator: recomputeFromState failed (non-blocking)',
        );
      }
    }

    logger.info(
      {
        claim_id: input.claim_id,
        run_id: runId,
        docs_total: result.docs_total,
        enqueued: result.docs_enqueued_for_segmentation,
        already: result.docs_already_segmented,
        adjudication_report_id: result.adjudication_report_id,
      },
      'intelligenceOrchestrator.analyzeClaim: completed',
    );

    return result;
  }

  /**
   * From-scratch wipe of a claim's AI-derived state. Called only on a
   * force re-run, before the new run cursor is opened.
   *
   * Deletes, in one transaction so a partial failure can't leave the
   * claim half-rebuilt:
   *   - doc_phase_ledger rows for every prior run of this claim — the
   *     stale pending/running rows from the wedged attempt. Cleared so
   *     the new run's ledger starts empty and the bundle classifier's
   *     fresh 'done'/'skipped' rows are the only settlement signal.
   *   - claim_harmonised_episodes — the stale AI Summary output. The
   *     harmoniser UPSERTs on claim_id so it would be overwritten anyway,
   *     but deleting it means the FE shows a clean "processing" state
   *     during the rebuild instead of the old episode.
   *   - document_sections — every segment/classification/extraction. This
   *     is the load-bearing delete: with these gone, Step 2 routes EVERY
   *     doc through the bundle classifier (the only ledger-settling path).
   *
   * Caveat — human field-corrections: extraction corrections (migration
   * 064) reference section_id with ON DELETE SET NULL. Deleting sections
   * ORPHANS those corrections (rows survive but detach; new sections get
   * new ids and won't re-adopt them). A from-scratch re-run therefore
   * yields pure-AI output — prior manual fixes are not re-applied. This is
   * the intended meaning of "redo everything"; preserving and re-applying
   * corrections across a rebuild would be a separate feature.
   */
  private async resetClaimDerivedState(claimId: string): Promise<{
    sections_deleted: number;
    episodes_deleted: number;
    ledger_rows_deleted: number;
  }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ledger = await client.query(
        `DELETE FROM hospital.doc_phase_ledger
          WHERE run_id IN (
            SELECT id FROM hospital.claim_ai_runs WHERE claim_id = $1
          )`,
        [claimId],
      );
      const episodes = await client.query(
        `DELETE FROM hospital.claim_harmonised_episodes WHERE claim_id = $1`,
        [claimId],
      );
      const sections = await client.query(
        `DELETE FROM hospital.document_sections WHERE claim_id = $1`,
        [claimId],
      );
      await client.query('COMMIT');
      return {
        sections_deleted: sections.rowCount ?? 0,
        episodes_deleted: episodes.rowCount ?? 0,
        ledger_rows_deleted: ledger.rowCount ?? 0,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export const intelligenceOrchestratorService = new IntelligenceOrchestratorService();
