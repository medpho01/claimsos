/**
 * Eval Routes — Sprint 4, Wave 5A
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ INTEGRATION TODO                                                     ║
 * ║                                                                      ║
 * ║ These routes are NOT yet mounted in src/index.ts. The integration    ║
 * ║ sprint mounts them once:                                             ║
 * ║   - The FE EvalDashboard (webapp/src/pages/superadmin/EvalDashboard) ║
 * ║     consumes /api/eval/metrics + /api/eval/predictions.              ║
 * ║   - Hospital-scoped access control: getMetrics already accepts a    ║
 * ║     `hospital_id` query param, but the route layer should enforce   ║
 * ║     "non-superadmin callers can ONLY see their own hospital" — the ║
 * ║     placeholder uses checkAuth; tighten before mounting.            ║
 * ║   - POST /api/eval/backtest must be SUPERADMIN-ONLY. The route      ║
 * ║     below uses `checkSuperAdmin`; verify the middleware is wired    ║
 * ║     before exposing the endpoint publicly.                          ║
 * ║                                                                      ║
 * ║ Mount with:                                                          ║
 * ║   import evalRoutes from './Routes/eval.routes.js';                  ║
 * ║   app.use('/api/eval', evalRoutes);                                  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { Router } from 'express';

import authMiddleware from '../Middlewares/auth.middleware.js';
import * as evalController from '../Controllers/eval.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// ============================================================================
// Eval — observability/scorecard for the intelligence layer.
//
// Auth pattern:
//   - getMetrics + listPredictions: any authenticated user. Hospital-scope
//     enforcement happens via the hospital_id query filter (auth middleware
//     should reject when the user's hospital_id doesn't match).
//   - runBacktest: superadmin-only. Backtest re-runs the AdjudicationEngine
//     against closed claims and may incur LLM cost (the engine's
//     ReasoningAgent path is gated, but a misconfigured replay can still
//     burn tokens). Lock this down.
// ============================================================================

// Dashboard rollup: prediction accuracy %, breakdown by task, calibration,
// weekly trend, cost-per-claim percentiles.
router.get('/metrics', AuthMiddleware.checkAuth, evalController.getMetrics);

// Per-claim eval row list. Required: ?claim_id=. Optional: &target_stage=.
router.get(
  '/predictions',
  AuthMiddleware.checkAuth,
  evalController.listPredictions,
);

// Regression backtest. Superadmin-only. Body: { sinceDays?, maxClaims?, rules_version? }.
router.post(
  '/backtest',
  AuthMiddleware.checkSuperAdmin,
  evalController.runBacktest,
);

export default router;
