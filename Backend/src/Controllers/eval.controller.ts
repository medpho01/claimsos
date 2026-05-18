import { Request, Response } from 'express';

import evalHarness, {
  type GetMetricsOpts,
} from '../Services/evalHarness.service.js';
import { logger } from '../Utils/logger.js';

/**
 * Eval Controller — Sprint 4, Wave 5A
 *
 *   GET    /api/eval/metrics       → getMetrics (dashboard rollups)
 *   GET    /api/eval/predictions   → list eval rows for a claim
 *   POST   /api/eval/backtest      → replay closed claims (superadmin)
 *
 * All routes are read-only against the eval store (the backtest endpoint
 * is a controlled mutation — see the route comment). Hospital-scoped
 * access control is layered in the routes file; these handlers assume
 * the caller is already authenticated.
 */

const VALID_PERIODS = new Set<GetMetricsOpts['period']>([
  'today',
  'week',
  'month',
  'all',
]);

/** GET /api/eval/metrics */
export const getMetrics = async (req: Request, res: Response) => {
  try {
    const periodRaw = (req.query.period as string | undefined) ?? 'month';
    const period = VALID_PERIODS.has(periodRaw as any)
      ? (periodRaw as GetMetricsOpts['period'])
      : 'month';

    const opts: GetMetricsOpts = { period };
    if (req.query.task) opts.task = String(req.query.task);
    if (req.query.rules_version) opts.rules_version = String(req.query.rules_version);
    if (req.query.engine_version) opts.engine_version = String(req.query.engine_version);
    if (req.query.hospital_id) opts.hospital_id = String(req.query.hospital_id);

    const data = await evalHarness.getMetrics(opts);
    res.status(200).json({
      success: true,
      data,
      message: `metrics loaded (n=${data.sample_size})`,
    });
  } catch (error: any) {
    logger.error({ err: error }, 'eval: getMetrics failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to load eval metrics',
    });
  }
};

/** GET /api/eval/predictions?claim_id=&target_stage= */
export const listPredictions = async (req: Request, res: Response) => {
  try {
    const claim_id = req.query.claim_id as string | undefined;
    if (!claim_id) {
      return res
        .status(400)
        .json({ success: false, error: 'claim_id (query) required' });
    }
    const target_stage = (req.query.target_stage as string | undefined) || undefined;
    const rows = await evalHarness.listPredictions({ claim_id, target_stage });
    res.status(200).json({
      success: true,
      data: rows,
      message: `predictions loaded (${rows.length})`,
    });
  } catch (error: any) {
    logger.error({ err: error }, 'eval: listPredictions failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to load predictions',
    });
  }
};

/** POST /api/eval/backtest */
export const runBacktest = async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      sinceDays?: number;
      maxClaims?: number;
      rules_version?: string;
    };
    const result = await evalHarness.backtest({
      sinceDays: typeof body.sinceDays === 'number' ? body.sinceDays : undefined,
      maxClaims: typeof body.maxClaims === 'number' ? body.maxClaims : undefined,
      rules_version: body.rules_version,
    });
    res.status(200).json({
      success: true,
      data: result,
      message: `backtest complete (replayed=${result.claims_replayed}, action_changes=${result.summary.action_change_count})`,
    });
  } catch (error: any) {
    logger.error({ err: error }, 'eval: backtest failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to run backtest',
    });
  }
};
