/**
 * Claim Actions Routes — Sprint 3, Wave 3C
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ INTEGRATION TODO                                                     ║
 * ║                                                                      ║
 * ║ These routes are NOT yet mounted in src/index.ts. The integration    ║
 * ║ sprint mounts them once:                                             ║
 * ║   - Hospital-membership access control is wired — current handlers   ║
 * ║     only check that the caller is authenticated, not that they own   ║
 * ║     the claim the action belongs to. Add a hospital-membership       ║
 * ║     guard (similar to claimDossier.routes) before exposing publicly. ║
 * ║   - The FE Action Queue page renders the list — same wave but only   ║
 * ║     useful with live data.                                           ║
 * ║   - The action-engine + action-dispatcher Bull workers are running   ║
 * ║     in the dedicated worker container (RUN_WORKERS != false).        ║
 * ║                                                                      ║
 * ║ Mount with:                                                          ║
 * ║   import claimActionsRoutes from './Routes/claimActions.routes.js';  ║
 * ║   app.use('/api', claimActionsRoutes);                               ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as claimActionsController from '../Controllers/claimActions.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// List actions. Required: one of user_id / claim_id (the controller 400s
// if neither is supplied). Default status filter is 'pending' — Kratika's
// inbox case. Pass status=all for the historical view.
router.get(
  '/claim-actions',
  AuthMiddleware.checkAuth,
  claimActionsController.listActions,
);

// Ack an action. Body may include `response` (free-form JSON captured on
// the row — for approval_request actions this is { decision: 'approved' }).
router.post(
  '/claim-actions/:id/ack',
  AuthMiddleware.checkAuth,
  claimActionsController.ackAction,
);

// Decline an action. `reason` is required and stored on the row; drives
// the audit trail and feeds the prompt-tuning feedback loop.
router.post(
  '/claim-actions/:id/decline',
  AuthMiddleware.checkAuth,
  claimActionsController.declineAction,
);

export default router;
