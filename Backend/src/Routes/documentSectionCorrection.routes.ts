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

// Per-field correction on a section's extracted_fields. Used by the
// SectionRow's editable JSON viewer in the AI Summary Documents panel.
// Mirrors the category-correction loop: writes to
// document_section_corrections (action='edit_fields') + ai_corrections
// (surface='extracted_field'), so the KB miner can later mine
// (category, field_key, value_pattern → corrected_value) patterns.
router.post(
  '/document-sections/:sectionId/fields/:fieldKey',
  AuthMiddleware.checkAuth,
  DocumentSectionCorrectionController.correctField,
);

export default router;
