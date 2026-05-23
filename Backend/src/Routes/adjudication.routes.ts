/**
 * Adjudication Routes — Sprint 3, Wave 3B
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ INTEGRATION TODO                                                     ║
 * ║                                                                      ║
 * ║ These routes are NOT yet mounted in src/index.ts. The integration    ║
 * ║ sprint mounts them once:                                             ║
 * ║   - The FE cockpit consumes the adjudication card on the claim view  ║
 * ║   - Hospital-scoped access control is layered on (current handlers   ║
 * ║     only check that the caller is authenticated, not that the        ║
 * ║     authenticated user has access to the claim's hospital).          ║
 * ║   - The adjudication queue's processor is registered (it auto-starts ║
 * ║     when this module is imported by the worker container).          ║
 * ║                                                                      ║
 * ║ Mount with:                                                          ║
 * ║   import adjudicationRoutes from './Routes/adjudication.routes.js';  ║
 * ║   app.use('/api', adjudicationRoutes);                               ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as adjudicationController from '../Controllers/adjudication.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// ============================================================================
// Adjudication — engine-produced opinion on a claim's readiness to file.
//
// Mirrors claimDossier.routes.ts auth pattern (checkAuth for reads + writes).
// Manual replay (force=true on POST) is permitted to any authenticated user
// in v0 — the integration sprint should tighten this to ops-role only if
// abuse becomes a concern (re-running burns rules-engine CPU; future LLM
// pass burns tokens).
// ============================================================================

// Latest report for a claim. Optional ?target_stage=<stage> filter.
router.get(
  '/claims/:id/adjudication',
  AuthMiddleware.checkAuth,
  adjudicationController.getLatestAdjudication,
);

// Full history (newest first). Optional ?target_stage= and ?limit= filters.
router.get(
  '/claims/:id/adjudication/history',
  AuthMiddleware.checkAuth,
  adjudicationController.getAdjudicationHistory,
);

// Run adjudication synchronously. Body: { target_stage?, force? }.
// `force=true` bypasses the dossier_state_hash cache and re-evaluates.
router.post(
  '/claims/:id/adjudication/run',
  AuthMiddleware.checkAuth,
  adjudicationController.runAdjudication,
);

export default router;
