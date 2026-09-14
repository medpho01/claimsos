/**
 * Intelligence routes — the run-control plane. Mounted at /api/v1.
 *
 * `analyze` is the ONLY route that starts a run, and the Run Analysis button
 * is the only thing that calls it. Everything else here controls or reports
 * on a run that already exists.
 */

import { Router } from 'express';
import { IntelligenceController } from '../Controllers/intelligence.controller.js';
import authMiddleware from '../Middlewares/auth.middleware.js';

const AuthMiddleware = new authMiddleware();
const router = Router();

// ─── Cost consent ──────────────────────────────────────────────────────────
router.post(
  '/claims/:claimId/intelligence/estimate',
  AuthMiddleware.checkAuth,
  IntelligenceController.estimate,
);
router.post(
  '/claims/:claimId/intelligence/analyze',
  AuthMiddleware.checkAuth,
  IntelligenceController.analyzeClaim,
);

// ─── Run control ───────────────────────────────────────────────────────────
router.post(
  '/claims/:claimId/intelligence/pause',
  AuthMiddleware.checkAuth,
  IntelligenceController.pauseRun,
);
router.post(
  '/claims/:claimId/intelligence/resume',
  AuthMiddleware.checkAuth,
  IntelligenceController.resumeRun,
);
router.post(
  '/claims/:claimId/intelligence/cancel',
  AuthMiddleware.checkAuth,
  IntelligenceController.cancelRun,
);

// ─── The consolidated end-of-run decision ──────────────────────────────────
router.get(
  '/claims/:claimId/intelligence/runs/:runId/unreadable',
  AuthMiddleware.checkAuth,
  IntelligenceController.getUnreadableSummary,
);
router.post(
  '/claims/:claimId/intelligence/runs/:runId/unreadable/acknowledge',
  AuthMiddleware.checkAuth,
  IntelligenceController.acknowledgeUnreadable,
);

export default router;
