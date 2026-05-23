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

// Lightweight section listing for the Claim AI Summary Documents panel —
// returns section_id → document_id (ipd_doc.id) + file_name + mime_type
// so the FE can group sections under real documents and drive the
// preview modal off the actual ipd_doc.id (not the section_id, which
// is what the dossier ships).
router.get(
  '/claims/:claimId/intelligence/sections',
  AuthMiddleware.checkAuth,
  IntelligenceStatusController.getSections,
);

export default router;
