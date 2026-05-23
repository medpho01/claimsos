/**
 * Stage Requirements Controller (Sprint 3, Wave 3A)
 *
 * REST surface over hospital.stage_requirements + the RulesEngine.
 *
 *   GET    /api/stage-requirements                  list (filterable)
 *   POST   /api/stage-requirements                  create (admin)
 *   PUT    /api/stage-requirements/:id              update (admin)
 *   DELETE /api/stage-requirements/:id              soft delete (admin)
 *   GET    /api/stage-requirements/evaluate         evaluate against a claim
 *
 * Auth wiring lives in the routes file. This controller stays thin — query
 * shaping, DB I/O, and error mapping only.
 */

import type { Request, Response } from 'express';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import rulesEngine, { RulesEngine, RuleEvaluationInput } from '../Services/rulesEngine.service.js';
import claimDossierService from '../Services/claimDossier.service.js';

const ALLOWED_SEVERITIES = new Set(['blocking', 'warning', 'info']);

// ────────────────────────────────────────────────────────────────────────────
// GET /api/stage-requirements
// ────────────────────────────────────────────────────────────────────────────

export const list = async (req: Request, res: Response) => {
  try {
    const target_stage = (req.query.target_stage as string | undefined) ?? null;
    const panel_id = (req.query.panel_id as string | undefined) ?? null;
    const scope = (req.query.scope as string | undefined) ?? null; // 'global' | 'panel' | 'insurer' | 'procedure' | 'diagnosis'

    const where: string[] = ['active = true'];
    const params: unknown[] = [];

    if (target_stage) {
      params.push(target_stage);
      where.push(`target_stage = $${params.length}`);
    }
    if (panel_id) {
      params.push(panel_id);
      where.push(`scope_panel_id = $${params.length}`);
    }
    if (scope) {
      switch (scope) {
        case 'global':
          where.push('scope_global = true');
          break;
        case 'panel':
          where.push('scope_panel_id IS NOT NULL');
          break;
        case 'insurer':
          where.push('scope_insurer_id IS NOT NULL');
          break;
        case 'procedure':
          where.push('scope_procedure_code IS NOT NULL');
          break;
        case 'diagnosis':
          where.push('scope_diagnosis_class IS NOT NULL');
          break;
        default:
          return res
            .status(400)
            .json({ success: false, error: `unknown scope '${scope}'` });
      }
    }

    const result = await pool.query(
      `SELECT id, rule_key, target_stage,
              required_doc_category, required_fields,
              severity,
              scope_global, scope_panel_id, scope_insurer_id,
              scope_procedure_code, scope_diagnosis_class,
              active, version, effective_from, effective_to,
              created_by, created_at, updated_at
         FROM hospital.stage_requirements
        WHERE ${where.join(' AND ')}
        ORDER BY target_stage ASC, severity DESC, rule_key ASC`,
      params
    );

    return res.status(200).json({
      success: true,
      data: result.rows,
      count: result.rowCount ?? result.rows.length,
    });
  } catch (error: any) {
    logger.error({ err: error }, 'stage_requirements.list failed');
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to list stage requirements',
    });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// POST /api/stage-requirements
// ────────────────────────────────────────────────────────────────────────────

export const create = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const {
      rule_key,
      target_stage,
      required_doc_category = null,
      required_fields = null,
      severity,
      scope_global = false,
      scope_panel_id = null,
      scope_insurer_id = null,
      scope_procedure_code = null,
      scope_diagnosis_class = null,
      version = 1,
      effective_from = null,
      effective_to = null,
    } = body;

    if (!rule_key || !target_stage || !severity) {
      return res.status(400).json({
        success: false,
        error: 'rule_key, target_stage, severity are required',
      });
    }
    if (!ALLOWED_SEVERITIES.has(severity)) {
      return res
        .status(400)
        .json({ success: false, error: `invalid severity '${severity}'` });
    }
    if (required_doc_category == null && required_fields == null) {
      return res.status(400).json({
        success: false,
        error: 'at least one of required_doc_category / required_fields must be set',
      });
    }
    if (
      !scope_global &&
      !scope_panel_id &&
      !scope_insurer_id &&
      !scope_procedure_code &&
      !scope_diagnosis_class
    ) {
      return res.status(400).json({
        success: false,
        error: 'at least one scope must be declared',
      });
    }

    const created_by = (req as any).user?.id ?? null;

    const result = await pool.query(
      `INSERT INTO hospital.stage_requirements (
         rule_key, target_stage, required_doc_category, required_fields,
         severity,
         scope_global, scope_panel_id, scope_insurer_id,
         scope_procedure_code, scope_diagnosis_class,
         version, effective_from, effective_to, created_by
       ) VALUES (
         $1, $2, $3, $4::jsonb,
         $5,
         $6, $7, $8,
         $9, $10,
         $11, COALESCE($12, NOW()), $13, $14
       )
       RETURNING *`,
      [
        rule_key,
        target_stage,
        required_doc_category,
        required_fields == null ? null : JSON.stringify(required_fields),
        severity,
        !!scope_global,
        scope_panel_id,
        scope_insurer_id,
        scope_procedure_code,
        scope_diagnosis_class,
        version,
        effective_from,
        effective_to,
        created_by,
      ]
    );

    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    logger.error({ err: error }, 'stage_requirements.create failed');
    if (error?.code === '23505') {
      return res.status(409).json({
        success: false,
        error: 'A rule with this (rule_key, version) already exists',
      });
    }
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to create stage requirement',
    });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// PUT /api/stage-requirements/:id
// ────────────────────────────────────────────────────────────────────────────

export const update = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, error: 'id required' });
    }

    const body = req.body ?? {};
    const updatable = [
      'target_stage',
      'required_doc_category',
      'required_fields',
      'severity',
      'scope_global',
      'scope_panel_id',
      'scope_insurer_id',
      'scope_procedure_code',
      'scope_diagnosis_class',
      'active',
      'effective_from',
      'effective_to',
    ];

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of updatable) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        let value = (body as any)[key];
        if (key === 'severity' && value && !ALLOWED_SEVERITIES.has(value)) {
          return res
            .status(400)
            .json({ success: false, error: `invalid severity '${value}'` });
        }
        if (key === 'required_fields' && value != null) {
          value = JSON.stringify(value);
          params.push(value);
          sets.push(`${key} = $${params.length}::jsonb`);
          continue;
        }
        params.push(value);
        sets.push(`${key} = $${params.length}`);
      }
    }

    if (sets.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: 'no updatable fields provided' });
    }

    params.push(id);
    const result = await pool.query(
      `UPDATE hospital.stage_requirements
          SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length}
        RETURNING *`,
      params
    );

    if ((result.rowCount ?? 0) === 0) {
      return res
        .status(404)
        .json({ success: false, error: `stage_requirement ${id} not found` });
    }
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    logger.error({ err: error }, 'stage_requirements.update failed');
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to update stage requirement',
    });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/stage-requirements/:id  (soft delete)
// ────────────────────────────────────────────────────────────────────────────

export const remove = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, error: 'id required' });
    }
    const result = await pool.query(
      `UPDATE hospital.stage_requirements
          SET active = false, updated_at = NOW()
        WHERE id = $1
        RETURNING id, rule_key, active`,
      [id]
    );
    if ((result.rowCount ?? 0) === 0) {
      return res
        .status(404)
        .json({ success: false, error: `stage_requirement ${id} not found` });
    }
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    logger.error({ err: error }, 'stage_requirements.remove failed');
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to remove stage requirement',
    });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// GET /api/stage-requirements/evaluate
// ────────────────────────────────────────────────────────────────────────────
// Pulls the latest dossier projection for the claim, then asks the RulesEngine
// to evaluate against the target stage. Caller may also pass procedure_code
// and diagnosis_class as query params for scoped rules.

export const evaluate = async (req: Request, res: Response) => {
  try {
    const claim_id = (req.query.claim_id as string | undefined) ?? '';
    const target_stage = (req.query.target_stage as string | undefined) ?? '';
    if (!claim_id || !target_stage) {
      return res.status(400).json({
        success: false,
        error: 'claim_id and target_stage are required',
      });
    }

    const procedure_code = (req.query.procedure_code as string | undefined) || undefined;
    const diagnosis_class = (req.query.diagnosis_class as string | undefined) || undefined;

    const dossier = await claimDossierService.getDossier(claim_id);
    if (!dossier) {
      return res.status(404).json({
        success: false,
        error: `No dossier projection for claim ${claim_id}. Project events first.`,
      });
    }

    const docMap = (dossier.doc_sections_by_category ?? {}) as Record<string, string[]>;

    const input: RuleEvaluationInput = {
      claim_id,
      target_stage,
      dossier_snapshot: {
        current_panel_id: dossier.current_panel_id ?? null,
        current_insurer_id: dossier.current_insurer_id ?? null,
        doc_sections_by_category: docMap,
      },
      procedure_code,
      diagnosis_class,
    };

    const engine: RulesEngine = rulesEngine;
    const result = await engine.evaluate(input);
    return res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    logger.error({ err: error }, 'stage_requirements.evaluate failed');
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to evaluate stage requirements',
    });
  }
};
