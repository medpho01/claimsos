import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as ctrl from '../Controllers/claimFinancials.controller.js';

const router = Router();
const Auth = new authMiddleware();

router.get('/claims/:claimId/financials', Auth.checkAuth, ctrl.getFinancials);
router.put('/claims/:claimId/financials/claimed', Auth.checkAuth, ctrl.setClaimed);
router.put('/claims/:claimId/financials/approved', Auth.checkAuth, ctrl.setApproved);

export default router;
