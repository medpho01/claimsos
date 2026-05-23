import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as gmailAuthController from '../Controllers/gmailAuth.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// ============================================================================
// Gmail OAuth — Cashless Everywhere outbound + inbound channel
// ============================================================================

// Initiate OAuth (hospital admin)
router.post(
  '/hospitals/:hospitalId/gmail-oauth/initiate',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  gmailAuthController.initiateGmailOauth
);

// Google OAuth redirect target. NOT under :hospitalId — identity comes
// from the signed `state` param.
//
// IMPORTANT: this route MUST NOT have checkAuth — Google's redirect
// arrives without our session cookie. Identity is verified by the OAuth
// code exchange itself.
router.get(
  '/oauth/gmail/callback',
  gmailAuthController.gmailOauthCallback
);

// Status check (UI shows "Connected as foo@hospital.com" / "Not connected")
router.get(
  '/hospitals/:hospitalId/gmail-oauth/status',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  gmailAuthController.getGmailStatus
);

// Verify credentials (pings Gmail; refreshes token if needed)
router.post(
  '/hospitals/:hospitalId/gmail-oauth/verify',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  gmailAuthController.verifyGmail
);

// Revoke + clear stored credentials
router.post(
  '/hospitals/:hospitalId/gmail-oauth/revoke',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  gmailAuthController.revokeGmail
);

export default router;
