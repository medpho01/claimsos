/**
 * Intelligence pipeline status route. Mounted at /api/v1.
 * Cheap polling endpoint — safe at 3-5s intervals.
 */

import { Router } from 'express';
import { IntelligenceStatusController } from '../Controllers/intelligenceStatus.controller.js';
import authMiddleware from '../Middlewares/auth.middleware.js';

const AuthMiddleware = new authMiddleware();
const router = Router();

router.get(
  '/claims/:claimId/intelligence/status',
  AuthMiddleware.checkAuth,
  IntelligenceStatusController.getStatus,
);

export default router;
