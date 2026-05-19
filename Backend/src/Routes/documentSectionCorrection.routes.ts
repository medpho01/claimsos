/**
 * Document section category-correction route.
 * Mounted at /api/v1.
 */

import { Router } from 'express';
import { DocumentSectionCorrectionController } from '../Controllers/documentSectionCorrection.controller.js';
import authMiddleware from '../Middlewares/auth.middleware.js';

const AuthMiddleware = new authMiddleware();
const router = Router();

router.post(
  '/document-sections/:sectionId/category',
  AuthMiddleware.checkAuth,
  DocumentSectionCorrectionController.correctCategory,
);

export default router;
