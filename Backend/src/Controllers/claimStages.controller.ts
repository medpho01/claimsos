/**
 * Claim stages — superadmin CRUD for the claim lifecycle taxonomy.
 *
 * Every mutating route is gated on checkSuperAdmin at the router. The read
 * routes are NOT: the upload dropdown needs them, and that is a hospital user.
 */

import { Request, Response } from 'express';
import claimStagesService from '../Services/claimStages.service.js';
import { logger } from '../Utils/logger.js';

function fail(res: Response, err: unknown, fallback: string, status = 500) {
  const message = err instanceof Error ? err.message : String(err);
  // Validation errors from the service carry operator-actionable text; a
  // generic 500 body would throw that away and leave the UI with nothing to
  // show beyond "something went wrong".
  logger.warn({ err }, fallback);
  return res.status(status).json({ error: message || fallback });
}

class ClaimStagesController {
  /** GET /claim-stages?include_retired=true */
  async list(req: Request, res: Response) {
    try {
      const includeRetired = req.query.include_retired === 'true';
      const data = await claimStagesService.list(includeRetired);
      return res.status(200).json({ message: 'Claim stages fetched', data });
    } catch (err) {
      return fail(res, err, 'claimStages: list failed');
    }
  }

  /**
   * GET /claim-stages/upload-options?current_stage=PREAUTH
   *
   * What the upload dropdown shows. Deliberately a separate endpoint from
   * `list`: the curation rules (past free, next with a confirm, nothing
   * further) are policy, and policy belongs on the server where it is tested
   * once rather than re-implemented in every client that uploads a document.
   */
  async uploadOptions(req: Request, res: Response) {
    try {
      const current = (req.query.current_stage as string) || null;
      const data = await claimStagesService.uploadOptions(current);
      return res.status(200).json({ message: 'Upload options fetched', data });
    } catch (err) {
      return fail(res, err, 'claimStages: uploadOptions failed');
    }
  }

  /** GET /claim-stages/:code/usage — blast radius before retiring. */
  async usage(req: Request, res: Response) {
    try {
      const stage = await claimStagesService.get(req.params.code);
      if (!stage) return res.status(404).json({ error: 'Stage not found' });
      const data = await claimStagesService.usage(req.params.code);
      return res.status(200).json({ message: 'Stage usage fetched', data });
    } catch (err) {
      return fail(res, err, 'claimStages: usage failed');
    }
  }

  /** POST /claim-stages */
  async create(req: Request, res: Response) {
    try {
      const { code, label, definition, sort_order } = req.body ?? {};
      if (!code || !label || !definition || typeof sort_order !== 'number') {
        return res
          .status(400)
          .json({ error: 'code, label, definition and sort_order are required' });
      }
      const data = await claimStagesService.create(req.body);
      logger.info({ code, by: (req as any).user?.id }, 'claimStages: stage created');
      return res.status(201).json({ message: 'Claim stage created', data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/duplicate key/i.test(msg)) {
        return res.status(409).json({ error: 'A stage with that code or sort order already exists' });
      }
      return fail(res, err, 'claimStages: create failed', /must be|invalid/.test(msg) ? 400 : 500);
    }
  }

  /**
   * PATCH /claim-stages/:code
   *
   * `code` is intentionally not patchable. It is referenced by convention from
   * four columns and a TEXT[] with no real FK, so a rename would silently
   * detach rule packs from claims with nothing reporting the break.
   */
  async update(req: Request, res: Response) {
    try {
      if ('code' in (req.body ?? {})) {
        return res.status(400).json({
          error:
            'code is immutable — rule sets, document requirements and live claims reference it. Retire this stage and create a new one instead.',
        });
      }
      const data = await claimStagesService.update(req.params.code, req.body ?? {});
      if (!data) return res.status(404).json({ error: 'Stage not found' });
      logger.info({ code: req.params.code, by: (req as any).user?.id }, 'claimStages: stage updated');
      return res.status(200).json({ message: 'Claim stage updated', data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      return fail(res, err, 'claimStages: update failed', /invalid|must include/.test(msg) ? 400 : 500);
    }
  }

  /** PUT /claim-stages/order  { codes: [...] } — full list required. */
  async reorder(req: Request, res: Response) {
    try {
      const codes = req.body?.codes;
      if (!Array.isArray(codes) || codes.length === 0) {
        return res.status(400).json({ error: 'codes must be a non-empty array' });
      }
      const data = await claimStagesService.reorder(codes);
      logger.info({ by: (req as any).user?.id }, 'claimStages: lifecycle reordered');
      return res.status(200).json({ message: 'Claim stages reordered', data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      return fail(res, err, 'claimStages: reorder failed', /missing|unknown/.test(msg) ? 400 : 500);
    }
  }

  /**
   * POST /claim-stages/:code/retire   { is_active: boolean }
   *
   * Retire, never delete. Returns usage so the UI can state the blast radius
   * rather than asking for blind confirmation.
   */
  async setActive(req: Request, res: Response) {
    try {
      const isActive = req.body?.is_active;
      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'is_active (boolean) is required' });
      }
      const { stage, usage } = await claimStagesService.setActive(req.params.code, isActive);
      if (!stage) return res.status(404).json({ error: 'Stage not found' });
      logger.info(
        { code: req.params.code, is_active: isActive, usage, by: (req as any).user?.id },
        'claimStages: stage active flag changed',
      );
      return res.status(200).json({ message: 'Claim stage updated', data: stage, usage });
    } catch (err) {
      return fail(res, err, 'claimStages: setActive failed');
    }
  }
}

export default new ClaimStagesController();
