import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as emailInboxController from '../Controllers/emailInbox.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// Inbound emails attached to an IPD (notifications tab)
router.get(
  '/ipds/:ipdId/emails-inbound',
  AuthMiddleware.checkAuth,
  emailInboxController.getIpdInbound
);

// Ops queue: emails that couldn't be auto-matched
router.get(
  '/hospitals/:hospitalId/emails-inbound/unmatched',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  emailInboxController.getUnmatchedQueue
);

// Manually link an unmatched email to an IPD
router.post(
  '/emails-inbound/:inboundId/manual-link',
  AuthMiddleware.checkAuth,
  emailInboxController.manuallyLinkInbound
);

// Outbox monitor: stuck/failed outbound emails
router.get(
  '/hospitals/:hospitalId/emails-outbound/issues',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  emailInboxController.getOutboxIssues
);

// Retry a failed outbound email
router.post(
  '/emails-outbound/:emailOutboundId/retry',
  AuthMiddleware.checkAuth,
  emailInboxController.retryOutbound
);

export default router;
