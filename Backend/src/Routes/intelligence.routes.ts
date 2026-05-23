/**
 * Intelligence routes — operator-triggered "analyze this claim" entrypoint.
 * Mounted at /api/v1.
 */

import { Router } from 'express';
import { IntelligenceController } from '../Controllers/intelligence.controller.js';
import authMiddleware from '../Middlewares/auth.middleware.js';

const AuthMiddleware = new authMiddleware();
const router = Router();

router.post(
  '/claims/:claimId/intelligence/analyze',
  AuthMiddleware.checkAuth,
  IntelligenceController.analyzeClaim,
);

export default router;
