/**
 * Extraction Corrections routes. Mounted at /api/v1.
 *
 *   POST /api/v1/claims/:claimId/corrections                  (auth)
 *   GET  /api/v1/claims/:claimId/corrections                  (auth)
 *   GET  /api/v1/admin/extraction-corrections/systemic        (admin-only)
 */

import { Router } from 'express';

import authMiddleware from '../Middlewares/auth.middleware.js';
import {
  recordCorrection,
  listForClaim,
  listSystemicErrors,
} from '../Controllers/extractionCorrections.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

router.post(
  '/claims/:claimId/corrections',
  AuthMiddleware.checkAuth,
  recordCorrection,
);

router.get(
  '/claims/:claimId/corrections',
  AuthMiddleware.checkAuth,
  listForClaim,
);

router.get(
  '/admin/extraction-corrections/systemic',
  AuthMiddleware.checkSuperAdminOrAdmin,
  listSystemicErrors,
);

export default router;
