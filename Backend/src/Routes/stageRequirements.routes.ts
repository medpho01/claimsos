// TODO(integration): wire this in Backend/src/index.ts after Wave 3A review.
//   Mount at /api alongside the other routers — e.g.
//       app.use('/api', stageRequirementsRoutes);
//   Do NOT register here; that integration step is intentionally deferred so
//   the rules engine lane can land independently of the API surface.

import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as ctrl from '../Controllers/stageRequirements.controller.js';

const router = Router();
const Auth = new authMiddleware();

// ============================================================================
// Stage Requirements — the Rules Engine catalogue + evaluation surface
//
// Read endpoints are open to any authenticated user (they drive the FE
// readiness widgets). Write endpoints (create / update / soft delete) are
// gated to admin / superadmin — these rules change the workflow gating for
// every claim, so we want admin sign-off.
// ============================================================================

// List active rules, optionally filtered.
router.get(
  '/stage-requirements',
  Auth.checkAuth,
  ctrl.list
);

// Evaluate a claim's readiness for a target stage.
router.get(
  '/stage-requirements/evaluate',
  Auth.checkAuth,
  ctrl.evaluate
);

// Create a new rule. Admin or superadmin.
router.post(
  '/stage-requirements',
  Auth.checkAuth,
  Auth.checkSuperAdminOrAdmin,
  ctrl.create
);

// Update an existing rule. Admin or superadmin.
router.put(
  '/stage-requirements/:id',
  Auth.checkAuth,
  Auth.checkSuperAdminOrAdmin,
  ctrl.update
);

// Soft-delete (active=false). Admin or superadmin.
router.delete(
  '/stage-requirements/:id',
  Auth.checkAuth,
  Auth.checkSuperAdminOrAdmin,
  ctrl.remove
);

export default router;
