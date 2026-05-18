/**
 * IntelligenceController — operator-triggered "analyze this claim" endpoint.
 * Mounted in `index.ts` under /api/v1.
 */

import { Request, Response } from 'express';
import { intelligenceOrchestratorService } from '../Services/intelligenceOrchestrator.service.js';
import { logger } from '../Utils/logger.js';

export class IntelligenceController {
  /**
   * POST /api/v1/claims/:claimId/intelligence/analyze
   * Body (optional): { force?: boolean; target_stage?: string }
   *
   * Walks the IPD's documents, enqueues segmentation for any unsegmented
   * docs, rebuilds the dossier, and triggers adjudication. Returns
   * immediately; the actual segmentation cascade runs async via Bull.
   *
   * Idempotent: re-running on a fully-processed claim returns quickly
   * with docs_already_segmented matching docs_total and a cache-hit
   * adjudication report.
   */
  static async analyzeClaim(req: Request, res: Response): Promise<void> {
    const claimId = req.params.claimId;
    const force = req.body?.force === true;
    const targetStage =
      typeof req.body?.target_stage === 'string' ? req.body.target_stage : undefined;
    // hospital_id resolution: prefer body, else infer from the IPD row.
    let hospitalId: string | undefined =
      typeof req.body?.hospital_id === 'string' ? req.body.hospital_id : undefined;

    if (!claimId) {
      res.status(400).json({ error: 'claimId required in path' });
      return;
    }

    try {
      if (!hospitalId) {
        // Inline lookup; cheap, avoids forcing the FE to pass it.
        const { pool } = await import('../DB/db.js');
        const r = await pool.query<{ hospital_id: string | null }>(
          `SELECT hospital_id FROM hospital.ipds WHERE id = $1`,
          [claimId],
        );
        hospitalId = r.rows[0]?.hospital_id ?? undefined;
      }
      if (!hospitalId) {
        res.status(404).json({ error: 'claim or hospital not found' });
        return;
      }

      const result = await intelligenceOrchestratorService.analyzeClaim({
        claim_id: claimId,
        hospital_id: hospitalId,
        force,
        target_stage: targetStage,
        triggered_by_user_id: (req as any).user?.id,
      });

      res.status(202).json({
        ok: true,
        ...result,
        message:
          result.docs_enqueued_for_segmentation > 0
            ? `Started — ${result.docs_enqueued_for_segmentation} docs being analyzed. Check back in a minute.`
            : result.adjudication_report_id
              ? 'Analysis complete.'
              : result.docs_total === 0
                ? 'No documents to analyze yet.'
                : 'All documents already processed.',
      });
    } catch (err: any) {
      logger.error(
        { err, claimId },
        'intelligenceController.analyzeClaim failed',
      );
      res.status(500).json({
        error: 'intelligence analysis failed',
        message: err?.message ?? String(err),
      });
    }
  }
}
