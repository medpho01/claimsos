import { Request, Response } from 'express';

import episodicMemory, {
  type EpisodicRetrievalFilters,
} from '../Services/episodicMemory.service.js';
import claimDossierService from '../Services/claimDossier.service.js';
import { enqueueCaseEmbed } from '../Workers/caseEmbedder.queue.js';
import { logger } from '../Utils/logger.js';

/**
 * Episodic Memory Controller — Sprint 4, Wave 4B
 *
 *   GET    /api/claims/:id/episodic-similar  → top-k similar prior cases
 *   POST   /api/claims/:id/episodic-embed    → trigger embed (admin)
 *
 * Both routes are scoped to a single claim id; the service handles the
 * heavy lifting (vector retrieval, summary build, embedder call).
 *
 * Auth gating happens in the routes file — these handlers assume the
 * caller is already authenticated (and that hospital-scope checks are
 * layered on at integration time, same as the adjudication routes).
 */

/** GET /api/claims/:id/episodic-similar?k=5&hospital_id=...&panel_id=... */
export const getSimilarCases = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.id;
    if (!claimId) {
      return res
        .status(400)
        .json({ success: false, error: 'claim id (path) required' });
    }

    // We need the dossier as the retrieval input (the service falls
    // back to embedding a query summary when no precomputed row exists).
    const dossier = await claimDossierService.getDossier(claimId);
    if (!dossier) {
      return res.status(404).json({
        success: false,
        error: `No dossier for claim ${claimId}`,
      });
    }

    const kRaw = req.query.k as string | undefined;
    const k = kRaw ? parseInt(kRaw, 10) || undefined : undefined;

    const filters: EpisodicRetrievalFilters = {};
    const q = req.query as Record<string, string | undefined>;
    if (q.hospital_id) filters.hospital_id = q.hospital_id;
    if (q.panel_id) filters.panel_id = q.panel_id;
    if (q.insurer_id) filters.insurer_id = q.insurer_id;
    if (q.procedure_class) filters.procedure_class = q.procedure_class;
    if (q.diagnosis_class) filters.diagnosis_class = q.diagnosis_class;
    if (q.outcome_category) filters.outcome_category = q.outcome_category;
    if (q.min_evidence) {
      const n = parseInt(q.min_evidence, 10);
      if (Number.isFinite(n)) filters.min_evidence = n;
    }

    const results = await episodicMemory.retrieve({
      claim_id: claimId,
      dossier,
      k,
      filters,
    });

    res.status(200).json({
      success: true,
      data: results,
      message: `retrieved ${results.length} similar case(s)`,
    });
  } catch (error: any) {
    logger.error({ err: error }, 'episodicMemory: getSimilarCases failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to retrieve similar cases',
    });
  }
};

/** POST /api/claims/:id/episodic-embed  body: { force?: boolean } */
export const triggerEmbed = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.id;
    if (!claimId) {
      return res
        .status(400)
        .json({ success: false, error: 'claim id (path) required' });
    }
    const body = (req.body ?? {}) as { force?: boolean };

    // Async path — enqueue and return 202. Embedding takes <1s in the
    // common case but going through Bull keeps the API responsive when
    // Voyage is slow and avoids holding an HTTP connection open.
    await enqueueCaseEmbed(claimId, { force: body.force === true });

    res.status(202).json({
      success: true,
      data: { claim_id: claimId, force: body.force === true },
      message: 'episodic embed enqueued',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'episodicMemory: triggerEmbed failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to enqueue episodic embed',
    });
  }
};
