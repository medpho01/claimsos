import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import c from '../Controllers/adjudicationConfig.controller.js';

const router = Router();
const Auth = new authMiddleware();

/**
 * Per-panel deadlines, terminology aliases and the non-payables catalog.
 * All superadmin: these drive timeliness rules and deduction warnings on every
 * claim, and a wrong deadline accuses a hospital of being late when it was not.
 */
router.get('/adjudication-config/panels', Auth.checkSuperAdmin, c.listPanels);
router.put('/adjudication-config/panels/:panelId', Auth.checkSuperAdmin, c.upsertPanel);

router.get('/adjudication-config/non-payables', Auth.checkSuperAdmin, c.listNonPayables);
// Before /:id-style routes would matter; kept explicit for clarity.
router.get('/adjudication-config/non-payables/unmatched', Auth.checkSuperAdmin, c.unmatched);
router.put('/adjudication-config/non-payables', Auth.checkSuperAdmin, c.upsertNonPayable);

export default router;
