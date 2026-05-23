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
 * Cost-conscious: documents already segmented at the current segmenter
 * version are skipped. Adjudication is cache-hit-safe (dossier_state_hash
 * idempotency). Re-running this endpoint repeatedly costs ~₹0.
 */

import { createHash } from 'crypto';
import { pool } from '../DB/db.js';
import { enqueueDocSegmentation } from '../Workers/docSegmenter.queue.js';
import { enqueueDocBundleClassification } from '../Workers/docBundleClassifier.queue.js';
import { enqueueDocClassification } from '../Workers/docClassifier.queue.js';
import { enqueueDocExtraction } from '../Workers/docExtractor.queue.js';
import { enqueueClaimHarmonisation } from '../Workers/claimHarmoniser.queue.js';
import claimDossierService from './claimDossier.service.js';
import { AdjudicationEngine } from './adjudicationEngine.service.js';
import claimAiRunService from './claimAiRun.service.js';
import docPhaseLedgerService from './docPhaseLedger.service.js';
import { logger } from '../Utils/logger.js';

export interface AnalyzeClaimInput {
  claim_id: string;            // IPD id
  hospital_id: string;
  force?: boolean;             // re-segment even if version matches
  target_stage?: string;       // optional stage to adjudicate for
  triggered_by_user_id?: string;
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
}

export class IntelligenceOrchestratorService {
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
      });
      runId = run.id;
      result.run_id = runId;
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

    // ─── Step 2: for each doc, route to bundle classifier OR fall through
    //            to Step 2b (per-section path) when sections already exist ──
    //
    // Wave 12 routes NEW documents through docBundleClassifier (single
    // Sonnet call producing segments + categories together) instead of
    // the legacy docSegmenter → docClassifier chain. Decision tree:
    //
    //   - No sections yet for this doc → bundle classifier handles it.
    //   - Sections exist AND !force → already-segmented, skip.
    //   - Sections exist AND force → DON'T re-bundle (we'd lose section
    //       ids and orphan any per-field corrections). Fall through to
    //       Step 2b which re-classifies + re-extracts the existing
    //       sections via the per-section path, preserving corrections.
    //
    // The bundle classifier has its own fallback inside the service: if
    // the document is too big for one LLM call (OCR text > 80k chars),
    // or the LLM emits an invalid response, it punts to the legacy
    // segmenter for that document.
    for (const doc of docs.rows) {
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

    // ─── Step 2b: force re-classify + re-extract existing sections ──────
    //
    // The segmenter only runs on docs that don't yet have sections (or
    // when force=true, but even then existing sections aren't deleted —
    // we'd lose section_ids and orphan corrections). The classifier and
    // extractor have their own version-based idempotency, so a re-run
    // with no version bump quietly skips them.
    //
    // For force re-runs we explicitly enqueue both jobs for EVERY
    // existing section on the claim, with the force flag set. The
    // service-side guards stay in place:
    //   - Classifier: status='corrected' sections are still untouched.
    //   - Extractor: _corrected_fields entries are preserved on persist.
    // So the user's corrections survive; everything else gets re-
    // classified (with current bundle context + KB hints) and re-
    // extracted (with current category schemas + vision routing).
    if (input.force) {
      try {
        // CRITICAL CHANGE (May 20, 2026):
        //   - Skip duplicate sections (dedup_of IS NOT NULL) — re-running
        //     classifier/extractor on a duplicate burns LLM cost AND can
        //     produce non-deterministic categories that drift from the
        //     canonical, breaking the "one logical doc, one category"
        //     invariant. Duplicates already inherit canonical's data via
        //     projection.
        //   - Skip user-corrected sections (status='corrected') — those
        //     carry deliberate human intent that the classifier should
        //     never re-overwrite. The classifier already has a guard,
        //     but skipping at enqueue time avoids the wasted job entirely.
        //   - The legacy per-section docClassifier + docExtractor cascade
        //     here exists primarily to refresh sections when schemas
        //     change. With Wave 12 bundle classifier as the primary path
        //     for NEW work, this Step 2b should be a safety net, not
        //     the main course.
        const sections = await pool.query<{ id: string; dedup_of: string | null; status: string }>(
          `SELECT id, dedup_of, status
             FROM hospital.document_sections
            WHERE claim_id = $1
              AND dedup_of IS NULL
              AND status != 'corrected'`,
          [input.claim_id],
        );
        for (const sec of sections.rows) {
          try {
            await enqueueDocClassification(
              sec.id,
              input.claim_id,
              input.hospital_id,
              true,
            );
          } catch (err: any) {
            warnings.push(
              `section_${sec.id}_classify_enqueue_failed: ${err?.message ?? err}`,
            );
          }
          // We also force-enqueue the extractor directly. The
          // classifier will normally cascade into the extractor on
          // success, but doing it explicitly here covers the case
          // where the classifier short-circuits on a corrected
          // section (status='corrected'): we still want extraction
          // to re-run with the latest schemas / vision routing.
          try {
            await enqueueDocExtraction(
              sec.id,
              input.claim_id,
              input.hospital_id,
              true,
            );
          } catch (err: any) {
            warnings.push(
              `section_${sec.id}_extract_enqueue_failed: ${err?.message ?? err}`,
            );
          }
        }
        logger.info(
          {
            claim_id: input.claim_id,
            sections_force_enqueued: sections.rowCount,
            note: 'canonicals only (duplicates + corrected sections skipped)',
          },
          'intelligenceOrchestrator: force-enqueued classifier+extractor for canonical sections',
        );
      } catch (err: any) {
        logger.warn(
          { err, claim_id: input.claim_id },
          'intelligenceOrchestrator: force re-enqueue loop failed (continuing)',
        );
        warnings.push(`force_reenqueue_failed: ${err?.message ?? err}`);
      }
    }

    // ─── Step 2c: claim-level content dedup ─────────────────────────────
    // Belt-and-braces. The bundle classifier already calls dedup after
    // each doc finishes (docBundleClassifier.service.ts), but two
    // cases reach here without that having run:
    //   (a) all docs short-circuited via the idempotency cache → no
    //       persistBundle, no dedup trigger
    //   (b) force=true re-classify path goes through Step 2b (per-
    //       section classifier/extractor) which doesn't run dedup
    // Calling dedup synchronously here covers both. Cheap — pure SQL,
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
}

export const intelligenceOrchestratorService = new IntelligenceOrchestratorService();
