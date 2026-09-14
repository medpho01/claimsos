import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import c from '../Controllers/ruleCalibration.controller.js';

const router = Router();
const Auth = new authMiddleware();

/**
 * Rule calibration. Superadmin: it reports how often each rule is overruled by
 * reviewers, which is the evidence for retiring or re-tuning it.
 */
router.get('/rule-calibration', Auth.checkSuperAdmin, c.calibration);
router.get('/rule-calibration/root-causes', Auth.checkSuperAdmin, c.rootCauses);
router.get('/rule-calibration/disagreements', Auth.checkSuperAdmin, c.disagreements);

export default router;
