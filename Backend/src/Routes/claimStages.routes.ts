import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import claimStagesController from '../Controllers/claimStages.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

/**
 * Claim stages — the configurable claim lifecycle.
 *
 * READS are open to any authenticated user: the upload dropdown needs them and
 * that is a hospital user, not a superadmin.
 *
 * WRITES are superadmin-only. A stage code is referenced by convention from
 * ipds.stage, claim_context.stage, document_sections.stage and the
 * insurer_rule_sets.applicable_stages TEXT[] — none with a real FK — so a bad
 * edit detaches rule packs from claims silently.
 */

// ─── Reads ──────────────────────────────────────────────────────────────
router.get('/claim-stages', claimStagesController.list);

// Ordered BEFORE /claim-stages/:code so "upload-options" is not swallowed as a
// stage code.
router.get('/claim-stages/upload-options', claimStagesController.uploadOptions);

router.get(
  '/claim-stages/:code/usage',
  AuthMiddleware.checkSuperAdmin,
  claimStagesController.usage,
);

// ─── Writes (superadmin) ────────────────────────────────────────────────
router.post('/claim-stages', AuthMiddleware.checkSuperAdmin, claimStagesController.create);

// Ordered BEFORE /claim-stages/:code so "order" is not read as a code.
router.put('/claim-stages/order', AuthMiddleware.checkSuperAdmin, claimStagesController.reorder);

router.patch('/claim-stages/:code', AuthMiddleware.checkSuperAdmin, claimStagesController.update);

router.post(
  '/claim-stages/:code/retire',
  AuthMiddleware.checkSuperAdmin,
  claimStagesController.setActive,
);

export default router;
