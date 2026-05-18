/**
 * AI Drafts Routes — Sprint 4, Wave 2C
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ INTEGRATION TODO                                                     ║
 * ║                                                                      ║
 * ║ These routes are NOT yet mounted in src/index.ts. The integration    ║
 * ║ sprint mounts them once:                                             ║
 * ║   - The FE cockpit renders the pending-drafts panel                  ║
 * ║   - The Gmail inbound pipeline calls enqueueEmailIntelligence()      ║
 * ║     from emailMatching.service after a successful claim match        ║
 * ║   - Hospital-scoped access control is verified — current handlers    ║
 * ║     only check that the caller is authenticated, not that they have  ║
 * ║     access to the claim the draft belongs to. Add a               ║
 * ║     hospital-membership guard before exposing publicly.              ║
 * ║                                                                      ║
 * ║ Mount with:                                                          ║
 * ║   import aiDraftsRoutes from './Routes/aiDrafts.routes.js';          ║
 * ║   app.use('/api', aiDraftsRoutes);                                   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as aiDraftsController from '../Controllers/aiDrafts.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// List drafts for a claim. Default filter is status='pending_review' — the
// cockpit's "needs your attention" panel. Pass ?status=applied etc. for
// historical views.
router.get(
  '/claims/:id/ai-drafts',
  AuthMiddleware.checkAuth,
  aiDraftsController.listDraftsForClaim,
);

// Apply a draft. Body may include `fieldOverrides` — a JSON-pointer-keyed
// map of corrections (e.g. { "amount_inr": 45000, "queries.0.deficiency_type": "missing_consent" }).
// Each override that differs from the AI's value is captured in
// email_intelligence_corrections.
router.post(
  '/ai-drafts/:id/apply',
  AuthMiddleware.checkAuth,
  aiDraftsController.applyDraft,
);

// Reject a draft. `reason` is required and stored on the draft row —
// drives the FE's "rejected drafts" audit trail and feeds the prompt-
// tuning feedback loop.
router.post(
  '/ai-drafts/:id/reject',
  AuthMiddleware.checkAuth,
  aiDraftsController.rejectDraft,
);

export default router;
