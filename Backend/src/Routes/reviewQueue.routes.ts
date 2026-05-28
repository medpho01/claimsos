/**
 * Review Queue routes (iter7 Stage 7). Mounted at /api/v1/review-queue.
 * Superadmin only — matches the existing intelligence-layer gate.
 */
import express from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import {
  listReviewQueue,
  getReviewQueueClaim,
  dispositionReviewQueueSection,
} from '../Controllers/reviewQueue.controller.js';

const router = express.Router();
const AuthMiddleware = new authMiddleware();

router.get(
  '/',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkSuperAdmin,
  listReviewQueue,
);
router.get(
  '/:claimId',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkSuperAdmin,
  getReviewQueueClaim,
);
router.post(
  '/:claimId/disposition',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkSuperAdmin,
  dispositionReviewQueueSection,
);

export default router;
