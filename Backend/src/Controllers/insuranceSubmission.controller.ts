import { Request, Response } from 'express';
import preauthSubmissionService from '../Services/insuranceSubmission.service.js';
import { logger } from '../Utils/logger.js';

/**
 * Insurance Submission Controller
 *
 *   POST   /api/v1/ipds/:ipdId/insurance/preflight   (CE-live check + blockers)
 *   POST   /api/v1/ipds/:ipdId/insurance/draft       (compose preview with filled PDF)
 *   POST   /api/v1/ipds/:ipdId/insurance/send        (commit + queue send)
 *   GET    /api/v1/ipds/:ipdId/insurance/submissions (timeline)
 */

/** POST /api/v1/ipds/:ipdId/insurance/preflight */
export const preflight = async (req: Request, res: Response) => {
  try {
    const { ipdId } = req.params;
    const hospitalId = (req.body?.hospital_id ?? req.query?.hospital_id) as string;
    if (!ipdId || !hospitalId) {
      return res
        .status(400)
        .json({ success: false, error: 'ipdId (path) and hospital_id (body/query) required' });
    }
    const result = await preauthSubmissionService.preflight(ipdId, hospitalId);
    res.status(200).json({ success: true, data: result, message: 'preflight complete' });
  } catch (error: any) {
    logger.error({ err: error }, 'preauth preflight failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to run preflight',
    });
  }
};

/** POST /api/v1/ipds/:ipdId/insurance/draft */
export const draft = async (req: Request, res: Response) => {
  try {
    const { ipdId } = req.params;
    const hospitalId = req.body?.hospital_id;
    const initiatedBy = req.user?.id ?? '';
    if (!ipdId || !hospitalId) {
      return res
        .status(400)
        .json({ success: false, error: 'ipdId (path) and hospital_id (body) required' });
    }
    const result = await preauthSubmissionService.draft({
      ipdId,
      hospitalId,
      initiatedBy,
    });
    res.status(200).json({ success: true, data: result, message: 'draft built' });
  } catch (error: any) {
    logger.error({ err: error }, 'preauth draft failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to build pre-auth draft',
    });
  }
};

/** POST /api/v1/ipds/:ipdId/insurance/send */
export const send = async (req: Request, res: Response) => {
  try {
    const { ipdId } = req.params;
    const hospitalId = req.body?.hospital_id;
    const submittedBy = req.user?.id ?? '';
    const overrides = req.body?.overrides;
    if (!ipdId || !hospitalId) {
      return res
        .status(400)
        .json({ success: false, error: 'ipdId (path) and hospital_id (body) required' });
    }
    const result = await preauthSubmissionService.send({
      ipdId,
      hospitalId,
      submittedBy,
      idempotencyKey: req.body?.idempotency_key,
      overrides,
    });
    res.status(201).json({
      success: true,
      data: result,
      message: result.idempotent_replay
        ? 'replayed existing submission (idempotent)'
        : 'pre-auth queued for send',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'preauth send failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to send pre-auth',
    });
  }
};

/**
 * PUT /api/v1/ipds/:ipdId/filing-route
 * Body: { hospital_id, route: 'cashless_everywhere' | 'network' }
 *
 * Sets the IPD's claim filing route — separate from which insurer (panel)
 * pays the claim. Required before any filing flow can run.
 */
export const setFilingRoute = async (req: Request, res: Response) => {
  try {
    const { ipdId } = req.params;
    const hospitalId = req.body?.hospital_id;
    const route = req.body?.route;
    if (!ipdId || !hospitalId || !route) {
      return res.status(400).json({
        success: false,
        error: 'ipdId (path), hospital_id, route required',
      });
    }
    if (!['cashless_everywhere', 'network'].includes(route)) {
      return res.status(400).json({
        success: false,
        error: "route must be 'cashless_everywhere' or 'network'",
      });
    }
    const { pool } = await import('../DB/db.js');
    const upd = await pool.query(
      `UPDATE hospital.ipds
          SET claim_filing_route = $1, updated_at = NOW()
        WHERE id = $2 AND hospital_id = $3
       RETURNING id, claim_filing_route`,
      [route, ipdId, hospitalId]
    );
    if ((upd.rowCount ?? 0) === 0) {
      return res.status(404).json({ success: false, error: 'IPD not found' });
    }
    res.status(200).json({
      success: true,
      data: upd.rows[0],
      message: 'filing route updated',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'setFilingRoute failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to set filing route',
    });
  }
};

/**
 * PUT /api/v1/ipds/:ipdId/stage
 * Body: { hospital_id, stage: <label from master_options(ipd_stage)> }
 *
 * Updates the patient's lifecycle stage. The value must match a Label in
 * master_options where category='ipd_stage' AND is_active=true — this is
 * enforced here so a stale FE option list can't write an invalid stage.
 */
export const setStage = async (req: Request, res: Response) => {
  try {
    const { ipdId } = req.params;
    const hospitalId = req.body?.hospital_id;
    const stage: string | null = req.body?.stage ?? null;
    if (!ipdId || !hospitalId) {
      return res.status(400).json({
        success: false,
        error: 'ipdId (path) and hospital_id required',
      });
    }
    const { pool } = await import('../DB/db.js');
    if (stage !== null && stage !== '') {
      const validate = await pool.query(
        `SELECT 1 FROM hospital.master_options
          WHERE category = 'ipd_stage'
            AND label = $1
            AND is_active = TRUE
          LIMIT 1`,
        [stage]
      );
      if ((validate.rowCount ?? 0) === 0) {
        return res.status(400).json({
          success: false,
          error: `'${stage}' is not a valid ipd_stage label`,
        });
      }
    }
    // Capture the prior stage so the audit log can record from→to.
    const prior = await pool.query<{ stage: string | null }>(
      `SELECT stage FROM hospital.ipds WHERE id = $1 AND hospital_id = $2`,
      [ipdId, hospitalId]
    );
    if ((prior.rowCount ?? 0) === 0) {
      return res.status(404).json({ success: false, error: 'IPD not found' });
    }
    const fromStage = prior.rows[0]?.stage ?? null;

    const upd = await pool.query(
      `UPDATE hospital.ipds
          SET stage = $1, updated_at = NOW()
        WHERE id = $2 AND hospital_id = $3
       RETURNING id, stage`,
      [stage || null, ipdId, hospitalId]
    );
    if ((upd.rowCount ?? 0) === 0) {
      return res.status(404).json({ success: false, error: 'IPD not found' });
    }

    // Audit log (A2): record the stage change. If no submission exists yet
    // for this IPD, the helper silently no-ops (audit-only).
    if (fromStage !== (stage || null)) {
      const { recordIpdStageChange } = await import('../Services/submissionEvents.service.js');
      await recordIpdStageChange({
        ipdId,
        hospitalId,
        fromStage,
        toStage: stage || null,
        actor: req.user?.id ?? null,
      });
    }

    res.status(200).json({
      success: true,
      data: upd.rows[0],
      message: 'stage updated',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'setStage failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to set stage',
    });
  }
};

/** GET /api/v1/ipds/:ipdId/insurance/submissions */
export const listSubmissions = async (req: Request, res: Response) => {
  try {
    const { ipdId } = req.params;
    const hospitalId = (req.query?.hospital_id ?? '') as string;
    if (!ipdId || !hospitalId) {
      return res
        .status(400)
        .json({ success: false, error: 'ipdId (path) and hospital_id (query) required' });
    }
    const rows = await preauthSubmissionService.getSubmissionsForIpd(ipdId, hospitalId);
    res.status(200).json({ success: true, data: rows, message: 'submissions fetched' });
  } catch (error: any) {
    logger.error({ err: error }, 'list submissions failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to fetch submissions',
    });
  }
};
