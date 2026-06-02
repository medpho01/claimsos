import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as ctrl from '../Controllers/stageAdjudication.controller.js';

const router = Router();
const Auth = new authMiddleware();

router.get('/claims/:claimId/stage-adjudication', Auth.checkAuth, ctrl.getAdjudication);
router.post('/claims/:claimId/stage-adjudication/evaluate', Auth.checkAuth, ctrl.evaluate);
router.post('/claims/:claimId/stage-adjudication/feedback', Auth.checkAuth, ctrl.postFeedback);
router.get('/claims/:claimId/stage-adjudication/feedback', Auth.checkAuth, ctrl.getFeedbackForClaim);
router.get('/stage-adjudication/feedback-summary', Auth.checkAuth, ctrl.getFeedbackSummary);

export default router;
