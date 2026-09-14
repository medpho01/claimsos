/**
 * Document → stage mapping (superadmin).
 *
 * Writes are gated at the router. Reads are open: the upload flow and the
 * stage tagger both need the mapping, and those run as a hospital user.
 */

import { Request, Response } from 'express';
import svc from '../Services/documentStageAffinity.service.js';
import { logger } from '../Utils/logger.js';

function fail(res: Response, err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : String(err);
  // Validation messages here name the offending slug or stage code, which is
  // the whole value of them — a generic 500 body throws that away.
  const status = /unknown |cannot be both|stage floor/.test(message) ? 400 : 500;
  logger.warn({ err }, fallback);
  return res.status(status).json({ error: message || fallback });
}

class DocumentStageAffinityController {
  /** GET /document-stage-affinity?group=kyc_identity_insurance */
  async list(req: Request, res: Response) {
    try {
      const group = (req.query.group as string) || undefined;
      const data = await svc.listMappings(group);
      return res.status(200).json({ message: 'Document mappings fetched', data });
    } catch (err) {
      return fail(res, err, 'documentStageAffinity: list failed');
    }
  }

  /** GET /document-stage-affinity/groups */
  async groups(_req: Request, res: Response) {
    try {
      const data = await svc.listGroups();
      return res.status(200).json({ message: 'Document groups fetched', data });
    } catch (err) {
      return fail(res, err, 'documentStageAffinity: groups failed');
    }
  }

  /** PUT /document-stage-affinity/:docCategory */
  async upsert(req: Request, res: Response) {
    try {
      const data = await svc.upsert(
        req.params.docCategory,
        req.body ?? {},
        (req as any).user?.id,
      );
      logger.info(
        { doc_category: req.params.docCategory, by: (req as any).user?.id },
        'documentStageAffinity: mapping updated',
      );
      return res.status(200).json({ message: 'Mapping saved', data });
    } catch (err) {
      return fail(res, err, 'documentStageAffinity: upsert failed');
    }
  }

  /** POST /document-stage-affinity/bulk-evergreen  { group, is_evergreen } */
  async bulkEvergreen(req: Request, res: Response) {
    try {
      const { group, is_evergreen: isEvergreen } = req.body ?? {};
      if (!group || typeof isEvergreen !== 'boolean') {
        return res.status(400).json({ error: 'group and is_evergreen (boolean) are required' });
      }
      const updated = await svc.bulkSetEvergreen(group, isEvergreen, (req as any).user?.id);
      logger.info(
        { group, is_evergreen: isEvergreen, updated, by: (req as any).user?.id },
        'documentStageAffinity: bulk evergreen applied',
      );
      return res.status(200).json({ message: `${updated} categories updated`, updated });
    } catch (err) {
      return fail(res, err, 'documentStageAffinity: bulkEvergreen failed');
    }
  }
}

export default new DocumentStageAffinityController();
