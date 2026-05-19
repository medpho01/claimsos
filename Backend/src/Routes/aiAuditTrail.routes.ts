/**
 * AI audit trail routes — Wave 9 FE consumer.
 * Mounted at /api/v1.
 */

import { Router } from 'express';
import { AiAuditTrailController } from '../Controllers/aiAuditTrail.controller.js';
import authMiddleware from '../Middlewares/auth.middleware.js';

const AuthMiddleware = new authMiddleware();
const router = Router();

router.get(
  '/claims/:claimId/ai-audit-trail',
  AuthMiddleware.checkAuth,
  AiAuditTrailController.getTrail,
);

export default router;
