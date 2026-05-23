/**
 * AiAuditTrail controller — surfaces the per-claim LLM call log to the
 * Claim AI Summary page (Wave 9). Reads from llm_cost_log filtered by
 * claim_id with optional task / since / until filters.
 */

import { Request, Response } from 'express';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

export class AiAuditTrailController {
  /**
   * GET /api/v1/claims/:claimId/ai-audit-trail
   * Query params: task?, since? (ISO datetime), until? (ISO datetime), limit?
   */
  static async getTrail(req: Request, res: Response): Promise<void> {
    const claimId = req.params.claimId;
    if (!claimId) {
      res.status(400).json({ error: 'claimId required' });
      return;
    }
    const task = typeof req.query.task === 'string' ? req.query.task : undefined;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const until = typeof req.query.until === 'string' ? req.query.until : undefined;
    const limit = Math.min(parseInt(String(req.query.limit ?? '500'), 10) || 500, 2000);

    const conds: string[] = ['claim_id = $1'];
    const params: unknown[] = [claimId];
    if (task) { params.push(task); conds.push(`task = $${params.length}`); }
    if (since) { params.push(since); conds.push(`created_at >= $${params.length}`); }
    if (until) { params.push(until); conds.push(`created_at <= $${params.length}`); }

    try {
      const r = await pool.query(
        `SELECT id, task, provider, model, prompt_version,
                tokens_input_uncached, tokens_input_cached, tokens_output,
                latency_ms, cost_inr, succeeded, error_message, created_at
           FROM hospital.llm_cost_log
          WHERE ${conds.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ${limit}`,
        params,
      );
      const rows = r.rows ?? [];
      // Rollup
      const totals = rows.reduce(
        (acc: any, row: any) => ({
          calls: acc.calls + 1,
          cost_inr: acc.cost_inr + Number(row.cost_inr ?? 0),
          tokens_input:
            acc.tokens_input + Number(row.tokens_input_uncached ?? 0) + Number(row.tokens_input_cached ?? 0),
          tokens_output: acc.tokens_output + Number(row.tokens_output ?? 0),
          failures: acc.failures + (row.succeeded ? 0 : 1),
        }),
        { calls: 0, cost_inr: 0, tokens_input: 0, tokens_output: 0, failures: 0 },
      );
      res.status(200).json({ rollup: totals, entries: rows });
    } catch (err: any) {
      logger.error({ err, claimId }, 'aiAuditTrail.getTrail failed');
      res.status(500).json({ error: 'failed to load audit trail', message: err?.message ?? String(err) });
    }
  }
}
