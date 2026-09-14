/**
 * Rule set authoring + shadow runs (superadmin).
 *
 * Every error here is operator-actionable by design — "this draft has not been
 * shadow-run since it was last edited" tells someone what to do, where a 500
 * tells them nothing. So validation messages are passed through verbatim.
 */

import { Request, Response } from 'express';
import authoring, { RULE_KINDS } from '../Services/ruleSetAuthoring.service.js';
import shadow from '../Services/ruleSetShadow.service.js';
import { logger } from '../Utils/logger.js';

function fail(res: Response, err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : String(err);
  const client =
    /unknown |required|already live|cannot be edited|has not been shadow-run|must be between/.test(message);
  logger.warn({ err }, fallback);
  return res.status(client ? 400 : 500).json({ error: message || fallback });
}

class RuleSetAuthoringController {
  async list(req: Request, res: Response) {
    try {
      const data = await authoring.list({
        status: req.query.status as any,
        insurer: req.query.insurer as string,
      });
      return res.status(200).json({ message: 'Rule sets fetched', data });
    } catch (err) { return fail(res, err, 'ruleSets: list failed'); }
  }

  /** The evaluator-kind registry, so the editor builds its forms from the
   *  server's truth rather than a hard-coded copy that can drift. */
  async kinds(_req: Request, res: Response) {
    return res.status(200).json({
      message: 'Rule kinds fetched',
      data: RULE_KINDS.map((kind) => ({
        kind,
        semantic: kind === 'LLM_COHERENCE' || kind === 'EVIDENCE_CHECK',
      })),
    });
  }

  async get(req: Request, res: Response) {
    try {
      const data = await authoring.get(req.params.ruleSetId);
      if (!data) return res.status(404).json({ error: 'Rule set not found' });
      return res.status(200).json({ message: 'Rule set fetched', data });
    } catch (err) { return fail(res, err, 'ruleSets: get failed'); }
  }

  async clone(req: Request, res: Response) {
    try {
      const { new_rule_set_id: id, new_name: name } = req.body ?? {};
      if (!id || !name) {
        return res.status(400).json({ error: 'new_rule_set_id and new_name are required' });
      }
      const data = await authoring.clone(req.params.ruleSetId, id, name, (req as any).user?.id);
      logger.info({ from: req.params.ruleSetId, to: id, by: (req as any).user?.id }, 'ruleSets: cloned');
      return res.status(201).json({ message: 'Draft created', data });
    } catch (err) { return fail(res, err, 'ruleSets: clone failed'); }
  }

  async updateSet(req: Request, res: Response) {
    try {
      const data = await authoring.updateSet(req.params.ruleSetId, req.body ?? {}, (req as any).user?.id);
      return res.status(200).json({ message: 'Rule set updated', data });
    } catch (err) { return fail(res, err, 'ruleSets: update failed'); }
  }

  async upsertRule(req: Request, res: Response) {
    try {
      const data = await authoring.upsertRule(req.params.ruleSetId, req.body ?? {}, (req as any).user?.id);
      return res.status(200).json({ message: 'Rule saved', data });
    } catch (err) { return fail(res, err, 'ruleSets: upsertRule failed'); }
  }

  async deleteRule(req: Request, res: Response) {
    try {
      await authoring.deleteRule(req.params.ruleSetId, req.params.ruleId, (req as any).user?.id);
      return res.status(200).json({ message: 'Rule deleted' });
    } catch (err) { return fail(res, err, 'ruleSets: deleteRule failed'); }
  }

  async promote(req: Request, res: Response) {
    try {
      const note = req.body?.change_note;
      const data = await authoring.promote(req.params.ruleSetId, note, (req as any).user?.id);
      logger.info(
        { rule_set_id: req.params.ruleSetId, note, by: (req as any).user?.id },
        'ruleSets: promoted to live',
      );
      return res.status(200).json({ message: 'Rule set promoted to live', data });
    } catch (err) { return fail(res, err, 'ruleSets: promote failed'); }
  }

  async versions(req: Request, res: Response) {
    try {
      const data = await authoring.versions(req.params.ruleSetId);
      return res.status(200).json({ message: 'Versions fetched', data });
    } catch (err) { return fail(res, err, 'ruleSets: versions failed'); }
  }

  /** POST /rule-sets/:ruleSetId/shadow-run */
  async shadowRun(req: Request, res: Response) {
    try {
      const data = await shadow.run(req.params.ruleSetId, req.body ?? {}, (req as any).user?.id);
      logger.info(
        { rule_set_id: req.params.ruleSetId, claims: data.claims_evaluated, by: (req as any).user?.id },
        'ruleSets: shadow run complete',
      );
      return res.status(200).json({ message: 'Shadow run complete', data });
    } catch (err) { return fail(res, err, 'ruleSets: shadowRun failed'); }
  }

  async shadowHistory(req: Request, res: Response) {
    try {
      const data = await shadow.history(req.params.ruleSetId);
      return res.status(200).json({ message: 'Shadow runs fetched', data });
    } catch (err) { return fail(res, err, 'ruleSets: shadowHistory failed'); }
  }
}

export default new RuleSetAuthoringController();
