/** Rule calibration — the learning loop (superadmin). */
import { Request, Response } from 'express';
import svc from '../Services/ruleCalibration.service.js';
import { logger } from '../Utils/logger.js';

function fail(res: Response, err: unknown, fallback: string) {
  logger.warn({ err }, fallback);
  return res.status(500).json({ error: err instanceof Error ? err.message : fallback });
}

class RuleCalibrationController {
  async calibration(req: Request, res: Response) {
    try {
      const days = Math.min(Number(req.query.days) || 90, 365);
      return res.status(200).json({ message: 'Calibration fetched', data: await svc.calibration(days) });
    } catch (err) { return fail(res, err, 'calibration failed'); }
  }

  async rootCauses(req: Request, res: Response) {
    try {
      const days = Math.min(Number(req.query.days) || 90, 365);
      return res.status(200).json({ message: 'Root causes fetched', data: await svc.rootCauseSummary(days) });
    } catch (err) { return fail(res, err, 'rootCauses failed'); }
  }

  async disagreements(req: Request, res: Response) {
    try {
      const data = await svc.recentDisagreements(req.query.rule_id as string | undefined);
      return res.status(200).json({ message: 'Disagreements fetched', data });
    } catch (err) { return fail(res, err, 'disagreements failed'); }
  }
}

export default new RuleCalibrationController();
