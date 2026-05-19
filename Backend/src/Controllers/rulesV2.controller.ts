/**
 * Rules v2 Controller (Wave 8)
 *
 *   GET    /api/v1/claims/:claimId/rules-v2                    latest evals (or run)
 *   POST   /api/v1/claims/:claimId/rules-v2/evaluate           force a fresh evaluate
 *   POST   /api/v1/claims/:claimId/rules-v2/:ruleId/override   accept / waive a rule
 *   GET    /api/v1/insurer-rule-sets                           list (admin)
 *   GET    /api/v1/insurer-rule-sets/:id                       detail (admin)
 *
 * The latest-evals GET returns the persisted ledger and only invokes the
 * engine when no rows exist for the claim (or when `?run=true`). Overrides
 * are recorded separately in hospital.rule_overrides — read paths LEFT JOIN
 * to fold the latest override over the latest evaluation.
 */

import type { Request, Response } from 'express';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import { getRulesEngineV2 } from '../Services/rulesEngineV2.service.js';
import { recordCorrectionBestEffort } from '../Services/aiCorrections.service.js';

const VALID_OVERRIDE_ACTIONS = new Set(['mark_passed', 'mark_skipped', 'accept_deduction']);

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/claims/:claimId/rules-v2
// ────────────────────────────────────────────────────────────────────────────

export const getLatest = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    if (!claimId) return res.status(400).json({ success: false, error: 'claimId required' });
    const run = req.query.run === 'true' || req.query.run === '1';

    if (!run) {
      const existing = await pool.query(
        `SELECT e.rule_id, e.rule_set_id, e.status, e.severity, e.impact,
                e.evidence, e.message, e.deduction_estimate, e.evaluated_at,
                r.rule_name, r.category, r.remediation_guidance,
                r.required_documents, r.query_template,
                s.rule_set_id   AS rule_set_code,
                s.rule_set_name AS rule_set_name,
                o.action        AS override_action,
                o.reason        AS override_reason,
                o.overridden_by AS overridden_by,
                o.overridden_at AS overridden_at
           FROM hospital.claim_rule_evaluations e
           JOIN hospital.insurer_rule_sets s ON s.id = e.rule_set_id
           LEFT JOIN hospital.insurance_rules r ON r.rule_set_id = e.rule_set_id AND r.rule_id = e.rule_id
           LEFT JOIN LATERAL (
             SELECT action, reason, overridden_by, overridden_at
               FROM hospital.rule_overrides o2
              WHERE o2.claim_id = e.claim_id
                AND o2.rule_set_id = e.rule_set_id
                AND o2.rule_id = e.rule_id
              ORDER BY o2.overridden_at DESC
              LIMIT 1
           ) o ON true
          WHERE e.claim_id = $1
          ORDER BY e.evaluated_at DESC, e.rule_id ASC`,
        [claimId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        return res.json({ success: true, data: { evaluations: existing.rows, source: 'persisted' } });
      }
    }

    const engine = await getRulesEngineV2();
    const result = await engine.evaluate(claimId);
    return res.json({ success: true, data: { ...result, source: 'fresh' } });
  } catch (err) {
    logger?.error?.('[rulesV2.getLatest] ' + (err instanceof Error ? err.message : String(err)));
    return res.status(500).json({ success: false, error: 'failed to get rules v2 evaluation' });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/claims/:claimId/rules-v2/evaluate
// ────────────────────────────────────────────────────────────────────────────

export const evaluate = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    if (!claimId) return res.status(400).json({ success: false, error: 'claimId required' });
    const engine = await getRulesEngineV2();
    const result = await engine.evaluate(claimId);
    return res.json({ success: true, data: result });
  } catch (err) {
    logger?.error?.('[rulesV2.evaluate] ' + (err instanceof Error ? err.message : String(err)));
    return res.status(500).json({ success: false, error: 'failed to evaluate rules v2' });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/claims/:claimId/rules-v2/:ruleId/override
// ────────────────────────────────────────────────────────────────────────────

export const override = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    const ruleId = req.params.ruleId;
    if (!claimId || !ruleId) return res.status(400).json({ success: false, error: 'claimId and ruleId required' });
    const body = (req.body ?? {}) as { action?: string; reason?: string; rule_set_id?: string };
    if (!body.action || !VALID_OVERRIDE_ACTIONS.has(body.action)) {
      return res.status(400).json({ success: false, error: `action must be one of ${Array.from(VALID_OVERRIDE_ACTIONS).join(', ')}` });
    }
    if (!body.reason || body.reason.trim().length < 4) {
      return res.status(400).json({ success: false, error: 'reason is required (>=4 chars)' });
    }
    const userId = (req as any)?.user?.id ?? (req as any)?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'auth required' });

    // Resolve rule_set_id either from body, or from the latest evaluation row.
    let ruleSetUuid = body.rule_set_id;
    if (!ruleSetUuid) {
      const r = await pool.query(
        `SELECT rule_set_id FROM hospital.claim_rule_evaluations
          WHERE claim_id = $1 AND rule_id = $2
          ORDER BY evaluated_at DESC LIMIT 1`,
        [claimId, ruleId]
      );
      ruleSetUuid = r.rows?.[0]?.rule_set_id;
      if (!ruleSetUuid) {
        return res.status(404).json({ success: false, error: 'no evaluation found for this rule; supply rule_set_id explicitly' });
      }
    }

    await pool.query(
      `INSERT INTO hospital.rule_overrides (claim_id, rule_set_id, rule_id, action, reason, overridden_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [claimId, ruleSetUuid, ruleId, body.action, body.reason, userId]
    );

    // Wave 10 — mirror into the unified ai_corrections stream so the kb
    // miner can mine rule_overreach signatures. Best-effort, never blocks
    // the override write.
    await recordCorrectionBestEffort({
      surface: 'rule_override',
      claim_id: claimId,
      target_id: ruleId,
      target_kind: ruleId,
      ai_value: { rule_set_id: ruleSetUuid, expected_status: 'FAIL' },
      human_value: { action: body.action },
      reason: body.reason,
      corrected_by: userId,
    });

    return res.json({ success: true, data: { claim_id: claimId, rule_id: ruleId, action: body.action } });
  } catch (err) {
    logger?.error?.('[rulesV2.override] ' + (err instanceof Error ? err.message : String(err)));
    return res.status(500).json({ success: false, error: 'failed to record override' });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/insurer-rule-sets
// ────────────────────────────────────────────────────────────────────────────

export const listRuleSets = async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string | undefined) ?? 'live';
    const insurer = req.query.insurer_code as string | undefined;
    const params: unknown[] = [status];
    let sql = `SELECT id, rule_set_id, rule_set_name, version, insurer_code,
                      applicable_treatments, applicable_specialties, status,
                      effective_from, effective_till, created_at
                 FROM hospital.insurer_rule_sets
                WHERE status = $1`;
    if (insurer) {
      params.push(insurer);
      sql += ` AND insurer_code = $${params.length}`;
    }
    sql += ` ORDER BY rule_set_id ASC`;
    const r = await pool.query(sql, params);
    return res.json({ success: true, data: r.rows });
  } catch (err) {
    logger?.error?.('[rulesV2.listRuleSets] ' + (err instanceof Error ? err.message : String(err)));
    return res.status(500).json({ success: false, error: 'failed to list rule sets' });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/insurer-rule-sets/:id
// ────────────────────────────────────────────────────────────────────────────

export const getRuleSet = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    const [setRes, rulesRes, docsRes, finRes, losRes] = await Promise.all([
      pool.query(`SELECT * FROM hospital.insurer_rule_sets WHERE id = $1 OR rule_set_id = $1 LIMIT 1`, [id]),
      pool.query(
        `SELECT * FROM hospital.insurance_rules
          WHERE rule_set_id = (SELECT id FROM hospital.insurer_rule_sets WHERE id::text = $1 OR rule_set_id = $1 LIMIT 1)
          ORDER BY order_index ASC, rule_id ASC`,
        [id]
      ),
      pool.query(
        `SELECT * FROM hospital.insurer_document_requirements
          WHERE rule_set_id = (SELECT id FROM hospital.insurer_rule_sets WHERE id::text = $1 OR rule_set_id = $1 LIMIT 1)`,
        [id]
      ),
      pool.query(
        `SELECT * FROM hospital.insurer_financial_limits
          WHERE rule_set_id = (SELECT id FROM hospital.insurer_rule_sets WHERE id::text = $1 OR rule_set_id = $1 LIMIT 1)`,
        [id]
      ),
      pool.query(
        `SELECT * FROM hospital.insurer_los_benchmarks
          WHERE rule_set_id = (SELECT id FROM hospital.insurer_rule_sets WHERE id::text = $1 OR rule_set_id = $1 LIMIT 1)`,
        [id]
      ),
    ]);
    const set = setRes.rows?.[0];
    if (!set) return res.status(404).json({ success: false, error: 'rule set not found' });
    return res.json({
      success: true,
      data: {
        rule_set: set,
        rules: rulesRes.rows,
        document_requirements: docsRes.rows,
        financial_limits: finRes.rows,
        los_benchmarks: losRes.rows,
      },
    });
  } catch (err) {
    logger?.error?.('[rulesV2.getRuleSet] ' + (err instanceof Error ? err.message : String(err)));
    return res.status(500).json({ success: false, error: 'failed to load rule set' });
  }
};
