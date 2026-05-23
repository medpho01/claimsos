/**
 * Sprint 3, Wave 4A — KB Patterns Admin Controller
 *
 * Endpoints (not yet mounted — see kbPatterns.routes.ts):
 *
 *   GET    /api/kb-patterns?status=&pattern_type=        → paginated list
 *   GET    /api/kb-patterns/:id                          → details + recent matches
 *   POST   /api/kb-patterns/:id/promote   body: {reason}
 *   POST   /api/kb-patterns/:id/demote    body: {reason}
 *   POST   /api/admin/kb-miner/run        body: {sinceDays?, maxClaims?}
 *
 * The miner-run endpoint enqueues a one-off job rather than running inline —
 * the strategies do several full closed-claim scans and we don't want a
 * superadmin click to block the request thread.
 */

import { Request, Response } from 'express';

import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import { KbPatternMiner } from '../Services/kbPatternMiner.service.js';
import { enqueueManualMineRun } from '../Workers/kbPatternMiner.cron.js';

const ALLOWED_STATUSES = new Set(['candidate', 'live', 'demoted', 'archived', 'all']);

const miner = new KbPatternMiner();

// ─── GET /api/kb-patterns ─────────────────────────────────────────────────

export const listPatterns = async (req: Request, res: Response) => {
  try {
    const status = ((req.query.status as string | undefined) ?? 'candidate').trim();
    const patternType = (req.query.pattern_type as string | undefined)?.trim();
    const limit = Math.min(parseInt((req.query.limit as string) ?? '100', 10) || 100, 500);
    const offset = Math.max(parseInt((req.query.offset as string) ?? '0', 10) || 0, 0);

    if (!ALLOWED_STATUSES.has(status)) {
      return res.status(400).json({
        success: false,
        error: `invalid status: ${status}`,
      });
    }

    const where: string[] = [];
    const params: any[] = [];
    if (status !== 'all') {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (patternType) {
      params.push(patternType);
      where.push(`pattern_type = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT id, pattern_type, title, description, scope, condition, prediction,
              confidence, evidence_count, status, mined_at, last_seen_at,
              miner_version, reviewed_by, reviewed_at,
              promotion_reason, demotion_reason
         FROM hospital.kb_patterns
         ${whereSql}
         ORDER BY status ASC, confidence DESC, evidence_count DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return res.json({
      success: true,
      data: result.rows,
      meta: { limit, offset, count: result.rowCount },
    });
  } catch (err) {
    logger.error({ err }, 'kbPatterns.listPatterns failed');
    return res.status(500).json({
      success: false,
      error: (err as Error)?.message ?? 'unknown error',
    });
  }
};

// ─── GET /api/kb-patterns/:id ─────────────────────────────────────────────

export const getPattern = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const patternRes = await pool.query(
      `SELECT id, pattern_type, title, description, scope, condition, prediction,
              confidence, evidence_count, evidence_claim_ids, status,
              mined_at, last_seen_at, miner_version, prompt_version,
              reviewed_by, reviewed_at, promotion_reason, demotion_reason
         FROM hospital.kb_patterns
        WHERE id = $1`,
      [id],
    );
    if (patternRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'pattern not found' });
    }

    // Recent matches — last 20, joined to claim id so the FE can render
    // the audit trail.
    const matchesRes = await pool.query(
      `SELECT id, claim_id, adjudication_report_id, matched_at,
              actual_outcome, prediction_correct, resolved_at
         FROM hospital.kb_pattern_matches
        WHERE pattern_id = $1
        ORDER BY matched_at DESC
        LIMIT 20`,
      [id],
    );

    return res.json({
      success: true,
      data: {
        pattern: patternRes.rows[0],
        recent_matches: matchesRes.rows,
      },
    });
  } catch (err) {
    logger.error({ err }, 'kbPatterns.getPattern failed');
    return res.status(500).json({
      success: false,
      error: (err as Error)?.message ?? 'unknown error',
    });
  }
};

// ─── POST /api/kb-patterns/:id/promote ────────────────────────────────────

export const promotePattern = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const reviewerId = (req as any).user?.id ?? (req as any).user?.userId;
    if (!reviewerId) {
      return res.status(401).json({ success: false, error: 'unauthenticated' });
    }
    const reason = (req.body?.reason as string | undefined)?.trim();
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }
    await miner.promoteCandidate(id, reviewerId, reason);
    return res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'kbPatterns.promotePattern failed');
    return res.status(500).json({
      success: false,
      error: (err as Error)?.message ?? 'unknown error',
    });
  }
};

// ─── POST /api/kb-patterns/:id/demote ─────────────────────────────────────

export const demotePattern = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const reviewerId = (req as any).user?.id ?? (req as any).user?.userId;
    if (!reviewerId) {
      return res.status(401).json({ success: false, error: 'unauthenticated' });
    }
    const reason = (req.body?.reason as string | undefined)?.trim();
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }
    await miner.demotePattern(id, reviewerId, reason);
    return res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'kbPatterns.demotePattern failed');
    return res.status(500).json({
      success: false,
      error: (err as Error)?.message ?? 'unknown error',
    });
  }
};

// ─── POST /api/admin/kb-miner/run ─────────────────────────────────────────

export const runMinerManually = async (req: Request, res: Response) => {
  try {
    const role = (req as any).user?.role;
    // Superadmin gate — the controller is defensive even though routes mount
    // a superadmin middleware. Belt-and-suspenders.
    if (role !== 'superadmin' && !(Array.isArray(role) && role.includes('superadmin'))) {
      return res.status(403).json({ success: false, error: 'superadmin only' });
    }
    const sinceDays =
      typeof req.body?.sinceDays === 'number' ? req.body.sinceDays : undefined;
    const maxClaims =
      typeof req.body?.maxClaims === 'number' ? req.body.maxClaims : undefined;
    await enqueueManualMineRun({ sinceDays, maxClaims });
    return res.json({ success: true, enqueued: true });
  } catch (err) {
    logger.error({ err }, 'kbPatterns.runMinerManually failed');
    return res.status(500).json({
      success: false,
      error: (err as Error)?.message ?? 'unknown error',
    });
  }
};
