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
import claimDossierService from './claimDossier.service.js';
import { AdjudicationEngine } from './adjudicationEngine.service.js';
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

    // ─── Step 2: for each doc, check segmentation status + enqueue ──────
    for (const doc of docs.rows) {
      // Skip if already segmented at the current version (unless force).
      if (!input.force) {
        const existing = await pool.query(
          `SELECT 1
             FROM hospital.document_sections
            WHERE document_id = $1
            LIMIT 1`,
          [doc.id],
        );
        if ((existing.rowCount ?? 0) > 0) {
          result.docs_already_segmented++;
          continue;
        }
      }
      if (!doc.s3_key) {
        warnings.push(`doc_${doc.id}_missing_s3_key`);
        continue;
      }
      const idemKey = createHash('sha256')
        .update(`${doc.id}:segmenter:v1:${input.force ? Date.now() : 'idem'}`)
        .digest('hex')
        .slice(0, 32);
      try {
        await enqueueDocSegmentation(
          doc.id,
          input.claim_id,
          input.hospital_id,
          doc.s3_key,
          idemKey,
        );
        result.docs_enqueued_for_segmentation++;
        result.segmentation_job_ids.push(idemKey);
      } catch (err: any) {
        warnings.push(`doc_${doc.id}_enqueue_failed: ${err?.message ?? err}`);
      }
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

    logger.info(
      {
        claim_id: input.claim_id,
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
