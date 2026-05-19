/**
 * Wave 10 — AI Corrections Controller.
 *
 * Read-only endpoints surfacing rows from hospital.ai_corrections.
 *
 *   GET /api/v1/ai-corrections?surface=&since_days=&limit=
 *       Admin list of unmined corrections — backs the KB pattern review
 *       "From Corrections" tab + summary count card.
 *
 *   GET /api/v1/ai-corrections/stats?since_days=
 *       Roll-up counts by surface for the dashboard.
 *
 *   GET /api/v1/claims/:claimId/ai-corrections?limit=
 *       Per-claim drawer — recent corrections (mined and unmined alike).
 *
 * No write endpoints — record() lives inside the source-of-truth services
 * (documentSectionCorrection, emailIntelligence, harmonisation, rulesV2).
 */

import type { Request, Response } from 'express';

import aiCorrectionsService, {
  type AiCorrectionSurface,
} from '../Services/aiCorrections.service.js';
import { logger } from '../Utils/logger.js';

const VALID_SURFACES = new Set<AiCorrectionSurface>([
  'document_category',
  'extraction_field',
  'harmonised_field',
  'rule_override',
  'ai_draft_field',
  'audit_call_wrong',
]);

function parseSinceDays(q: unknown, fallback: number): number {
  if (typeof q === 'string' && q.length > 0) {
    const n = Number.parseInt(q, 10);
    if (Number.isFinite(n) && n > 0 && n <= 3650) return n;
  }
  return fallback;
}

function parseLimit(q: unknown, fallback: number, max: number): number {
  if (typeof q === 'string' && q.length > 0) {
    const n = Number.parseInt(q, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, max);
  }
  return fallback;
}

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v1/ai-corrections
// ──────────────────────────────────────────────────────────────────────────

export const listUnmined = async (req: Request, res: Response) => {
  try {
    const surfaceQ = req.query.surface;
    let surface: AiCorrectionSurface | undefined;
    if (typeof surfaceQ === 'string' && surfaceQ.length > 0) {
      if (!VALID_SURFACES.has(surfaceQ as AiCorrectionSurface)) {
        return res
          .status(400)
          .json({ success: false, error: 'invalid surface' });
      }
      surface = surfaceQ as AiCorrectionSurface;
    }
    const since_days = parseSinceDays(req.query.since_days, 180);
    const limit = parseLimit(req.query.limit, 200, 2000);
    const rows = await aiCorrectionsService.listUnmined({
      surface,
      since_days,
      limit,
    });
    return res.json({ success: true, data: rows });
  } catch (err) {
    logger?.error?.(
      '[aiCorrections.listUnmined] ' +
        (err instanceof Error ? err.message : String(err)),
    );
    return res
      .status(500)
      .json({ success: false, error: 'failed to list ai_corrections' });
  }
};

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v1/ai-corrections/stats
// ──────────────────────────────────────────────────────────────────────────

export const getStats = async (req: Request, res: Response) => {
  try {
    const since_days = parseSinceDays(req.query.since_days, 180);
    const counts = await aiCorrectionsService.countsBySurface({ since_days });
    return res.json({
      success: true,
      data: {
        since_days,
        by_surface: counts,
        totals: {
          total: counts.reduce((s, c) => s + c.total, 0),
          unmined: counts.reduce((s, c) => s + c.unmined, 0),
        },
      },
    });
  } catch (err) {
    logger?.error?.(
      '[aiCorrections.getStats] ' +
        (err instanceof Error ? err.message : String(err)),
    );
    return res
      .status(500)
      .json({ success: false, error: 'failed to load ai_corrections stats' });
  }
};

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v1/claims/:claimId/ai-corrections
// ──────────────────────────────────────────────────────────────────────────

export const listForClaim = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    if (!claimId) {
      return res.status(400).json({ success: false, error: 'claimId required' });
    }
    const limit = parseLimit(req.query.limit, 50, 200);
    const rows = await aiCorrectionsService.getRecent(claimId, limit);
    return res.json({ success: true, data: rows });
  } catch (err) {
    logger?.error?.(
      '[aiCorrections.listForClaim] ' +
        (err instanceof Error ? err.message : String(err)),
    );
    return res
      .status(500)
      .json({ success: false, error: 'failed to load claim corrections' });
  }
};
