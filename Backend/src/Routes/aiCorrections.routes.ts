/**
 * Wave 10 — AI Corrections routes. Mounted at /api/v1.
 *
 *   GET /api/v1/ai-corrections?surface=&since_days=&limit=  (admin list)
 *   GET /api/v1/ai-corrections/stats?since_days=             (admin stats)
 *   GET /api/v1/claims/:claimId/ai-corrections?limit=        (per claim)
 */

import { Router } from 'express';

import authMiddleware from '../Middlewares/auth.middleware.js';
import {
  listUnmined,
  getStats,
  listForClaim,
} from '../Controllers/aiCorrections.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

router.get('/ai-corrections/stats', AuthMiddleware.checkAuth, getStats);
router.get('/ai-corrections', AuthMiddleware.checkAuth, listUnmined);
router.get(
  '/claims/:claimId/ai-corrections',
  AuthMiddleware.checkAuth,
  listForClaim,
);

export default router;
