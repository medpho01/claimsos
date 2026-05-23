import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as gmailInboundController from '../Controllers/gmailInbound.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// ============================================================================
// Gmail Inbound — polling mode (cron-driven)
// ============================================================================

// Force a poll of one hospital's Gmail inbox NOW (admin / ops convenience).
// Cron runs every GMAIL_POLL_INTERVAL_SECONDS regardless; this is for
// "I just sent a test email, don't make me wait" UX.
router.post(
  '/hospitals/:hospitalId/gmail-poll/now',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  gmailInboundController.forcePollHospital
);

// Superadmin: run one full poll cycle across all connected hospitals.
router.post(
  '/admin/gmail-poll/run-cycle',
  AuthMiddleware.checkAuth,
  gmailInboundController.runFullPollCycle
);

export default router;
