/**
 * Harmonisation Routes — Wave 7
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ INTEGRATION TODO                                                     ║
 * ║                                                                      ║
 * ║ These routes are NOT yet mounted in src/index.ts. Stage 3 of the     ║
 * ║ Wave 7 integration plan mounts them once:                            ║
 * ║   - The FE cockpit consumes the harmonised episode panel on the     ║
 * ║     claim view + the correction modal.                              ║
 * ║   - Hospital-scoped access control is layered on (current handlers  ║
 * ║     only verify the caller is authenticated, not that they have     ║
 * ║     access to the claim's hospital).                                ║
 * ║   - The claim-harmoniser queue's processor is registered (it        ║
 * ║     auto-starts when its module is imported by the worker           ║
 * ║     container — wired in src/index.ts as part of THIS wave).        ║
 * ║                                                                      ║
 * ║ Mount with:                                                          ║
 * ║   import harmonisationRoutes from './Routes/harmonisation.routes.js';║
 * ║   app.use('/api/v1', harmonisationRoutes);                           ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { Router } from 'express';

import authMiddleware from '../Middlewares/auth.middleware.js';
import * as harmonisationController from '../Controllers/harmonisation.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// ============================================================================
// Harmonisation — canonical medical_episode.v2 per claim.
//
// Mirrors adjudication.routes.ts auth pattern (checkAuth for reads + writes).
// `regenerate` is gated by checkSuperAdmin because each call hits Sonnet
// (~₹1) and we don't want operators triggering refreshes whenever they
// please — corrections are the lighter-weight path for routine edits.
// ============================================================================

// Latest harmonised episode for a claim.
router.get(
  '/claims/:claimId/harmonised',
  AuthMiddleware.checkAuth,
  harmonisationController.getHarmonisedEpisode,
);

// Force a fresh harmonisation. Superadmin only — see note above on cost.
router.post(
  '/claims/:claimId/harmonised/regenerate',
  AuthMiddleware.checkSuperAdmin,
  harmonisationController.regenerateHarmonisedEpisode,
);

// Apply a human correction at a JSONPath inside the canonical episode.
// Patches the JSONB in place; does NOT invalidate the harmonisation
// cache or trigger an LLM call.
router.post(
  '/claims/:claimId/harmonised/corrections',
  AuthMiddleware.checkAuth,
  harmonisationController.applyHarmonisationCorrection,
);

export default router;
