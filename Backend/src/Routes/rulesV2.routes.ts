// TODO(integration): wire this in Backend/src/index.ts after Wave 8 review.
//   Mount alongside other routers — e.g.
//       app.use('/api/v1', rulesV2Routes);
//   Do NOT register here; integration is intentionally deferred so the
//   Rules Engine v2 lane can land independently of the API surface and
//   Wave 9 FE can wire it on its own cadence.

import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as ctrl from '../Controllers/rulesV2.controller.js';

const router = Router();
const Auth = new authMiddleware();

// ============================================================================
// Per-claim evaluation surface
// ============================================================================

router.get(
  '/claims/:claimId/rules-v2',
  Auth.checkAuth,
  ctrl.getLatest
);

router.post(
  '/claims/:claimId/rules-v2/evaluate',
  Auth.checkAuth,
  ctrl.evaluate
);

router.post(
  '/claims/:claimId/rules-v2/:ruleId/override',
  Auth.checkAuth,
  ctrl.override
);

// ============================================================================
// Admin / catalog surface
// ============================================================================

router.get(
  '/insurer-rule-sets',
  Auth.checkAuth,
  ctrl.listRuleSets
);

router.get(
  '/insurer-rule-sets/:id',
  Auth.checkAuth,
  ctrl.getRuleSet
);

export default router;
