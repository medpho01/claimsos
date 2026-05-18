/**
 * Episodic Memory Routes — Sprint 4, Wave 4B
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ INTEGRATION TODO                                                     ║
 * ║                                                                      ║
 * ║ These routes are NOT yet mounted in src/index.ts. The integration    ║
 * ║ sprint (Wave 4C) mounts them once:                                   ║
 * ║   - The FE cockpit consumes the "similar prior cases" card on the    ║
 * ║     claim view.                                                      ║
 * ║   - Hospital-scoped access control is layered on (current handlers   ║
 * ║     only check that the caller is authenticated, not that the auth'd ║
 * ║     user has access to the claim's hospital).                        ║
 * ║   - The /episodic-embed POST should be restricted to superadmin —   ║
 * ║     forcing a re-embed bypasses the dedup cache and burns Voyage    ║
 * ║     tokens. The placeholder uses checkAuth; tighten before mounting. ║
 * ║                                                                      ║
 * ║ Mount with:                                                          ║
 * ║   import episodicMemoryRoutes from './Routes/episodicMemory.routes.js';
 * ║   app.use('/api', episodicMemoryRoutes);                             ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { Router } from 'express';

import authMiddleware from '../Middlewares/auth.middleware.js';
import * as episodicMemoryController from '../Controllers/episodicMemory.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// Top-k similar prior cases for a claim. Optional query params:
//   k                    — 1..20 (default 5)
//   hospital_id          — restrict to same hospital
//   panel_id             — restrict to same panel
//   insurer_id           — restrict to same insurer
//   procedure_class      — restrict to same coarse procedure class
//   diagnosis_class      — restrict to same coarse diagnosis class
//   outcome_category     — settled | rejected | withdrawn
//   min_evidence         — >0 restricts to claims with terminal outcome
router.get(
  '/claims/:id/episodic-similar',
  AuthMiddleware.checkAuth,
  episodicMemoryController.getSimilarCases,
);

// Operator-triggered episodic embed. Body: { force?: boolean }.
// SUPERADMIN-ONLY in production (integration sprint tightens this) —
// repeated force=true calls can burn Voyage tokens for no benefit.
router.post(
  '/claims/:id/episodic-embed',
  AuthMiddleware.checkAuth,
  episodicMemoryController.triggerEmbed,
);

export default router;
