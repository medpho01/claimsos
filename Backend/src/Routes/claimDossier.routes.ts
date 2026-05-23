// TODO(integration): wire this in Backend/src/index.ts after Wave 1 review.
//   Mount at /api/v1 alongside the other routers — e.g.
//       app.use('/api/v1', claimDossierRoutes);
//   Do NOT register here; that integration step is intentionally deferred so
//   the projector lane can land independently of the API surface.

import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as claimDossierController from '../Controllers/claimDossier.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// ============================================================================
// Claim Dossier — read-side projection of an insurance claim
//
// Mirrors insuranceSubmission.routes.ts auth pattern (checkAuth for reads).
// The rebuild endpoint is gated to superadmin because a rebuild rewrites the
// entire projection from the event log and a buggy event vocabulary could
// (worst case) overwrite a manually-fixed dossier with stale data.
// ============================================================================

// Read the latest projection.
router.get(
  '/claims/:id/dossier',
  AuthMiddleware.checkAuth,
  claimDossierController.getDossier
);

// Full replay from hospital.submission_events. Superadmin-only.
router.post(
  '/claims/:id/dossier/rebuild',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkSuperAdmin,
  claimDossierController.rebuildDossier
);

export default router;
