import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import c from '../Controllers/ruleSetAuthoring.controller.js';

const router = Router();
const Auth = new authMiddleware();

/**
 * Rule set authoring. ALL superadmin — these edits change how every claim is
 * judged, and a live pack cannot be edited in place at all (the service
 * refuses; this is the outer gate).
 *
 * Mounted under /rule-sets to sit clear of the existing read-only
 * /insurer-rule-sets endpoints in rulesV2.routes.ts, which stay as they are.
 */

router.get('/rule-sets', Auth.checkSuperAdmin, c.list);
// Before /:ruleSetId so "kinds" is not read as an id.
router.get('/rule-sets/kinds', Auth.checkSuperAdmin, c.kinds);
router.get('/rule-sets/:ruleSetId', Auth.checkSuperAdmin, c.get);
router.get('/rule-sets/:ruleSetId/versions', Auth.checkSuperAdmin, c.versions);
router.get('/rule-sets/:ruleSetId/shadow-runs', Auth.checkSuperAdmin, c.shadowHistory);

router.post('/rule-sets/:ruleSetId/clone', Auth.checkSuperAdmin, c.clone);
router.patch('/rule-sets/:ruleSetId', Auth.checkSuperAdmin, c.updateSet);
router.put('/rule-sets/:ruleSetId/rules', Auth.checkSuperAdmin, c.upsertRule);
router.delete('/rule-sets/:ruleSetId/rules/:ruleId', Auth.checkSuperAdmin, c.deleteRule);
router.post('/rule-sets/:ruleSetId/shadow-run', Auth.checkSuperAdmin, c.shadowRun);
router.post('/rule-sets/:ruleSetId/promote', Auth.checkSuperAdmin, c.promote);

export default router;
