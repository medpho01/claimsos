/** Per-panel adjudication config + non-payables catalog (superadmin). */
import { Request, Response } from 'express';
import svc from '../Services/adjudicationConfig.service.js';
import { logger } from '../Utils/logger.js';

function fail(res: Response, err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : String(err);
  const client = /unknown |must be greater/.test(message);
  logger.warn({ err }, fallback);
  return res.status(client ? 400 : 500).json({ error: message || fallback });
}

class AdjudicationConfigController {
  async listPanels(_req: Request, res: Response) {
    try {
      return res.status(200).json({ message: 'Panel configs fetched', data: await svc.listPanelConfigs() });
    } catch (err) { return fail(res, err, 'adjConfig: listPanels failed'); }
  }

  async upsertPanel(req: Request, res: Response) {
    try {
      const data = await svc.upsertPanelConfig(req.params.panelId, req.body ?? {}, (req as any).user?.id);
      logger.info({ panel_id: req.params.panelId, by: (req as any).user?.id }, 'adjConfig: panel config saved');
      return res.status(200).json({ message: 'Panel config saved', data });
    } catch (err) { return fail(res, err, 'adjConfig: upsertPanel failed'); }
  }

  async listNonPayables(req: Request, res: Response) {
    try {
      const data = await svc.listNonPayables(req.query.search as string | undefined);
      return res.status(200).json({ message: 'Non-payables fetched', ...data });
    } catch (err) { return fail(res, err, 'adjConfig: listNonPayables failed'); }
  }

  async upsertNonPayable(req: Request, res: Response) {
    try {
      const { item_name: name, list_number: list } = req.body ?? {};
      if (!name || !list) return res.status(400).json({ error: 'item_name and list_number are required' });
      return res.status(200).json({ message: 'Item saved', data: await svc.upsertNonPayable(req.body) });
    } catch (err) { return fail(res, err, 'adjConfig: upsertNonPayable failed'); }
  }

  /** Bill descriptions matching nothing — the alias-learning loop. */
  async unmatched(req: Request, res: Response) {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      return res.status(200).json({ message: 'Unmatched lines fetched', data: await svc.unmatchedBillLines(limit) });
    } catch (err) { return fail(res, err, 'adjConfig: unmatched failed'); }
  }
}

export default new AdjudicationConfigController();
