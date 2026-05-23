/**
 * KB Patterns Routes — Sprint 3, Wave 4A
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ INTEGRATION TODO                                                     ║
 * ║                                                                      ║
 * ║ These routes are NOT mounted in src/index.ts. Mount once:            ║
 * ║   - The Wave 5 admin review UI (KbPatternReview) is ready to render  ║
 * ║     the list. Without a consumer the endpoints sit cold.             ║
 * ║   - A superadmin role-check middleware is wired to                   ║
 * ║     /api/admin/kb-miner/run (the controller currently double-checks  ║
 * ║     via req.user.role but a dedicated middleware is cleaner).        ║
 * ║   - The kb-pattern-miner-cron + kb-pattern-feedback Bull workers     ║
 * ║     are running in the dedicated worker container; the miner cron    ║
 * ║     is scheduled via scheduleKbPatternMiner() at boot.               ║
 * ║                                                                      ║
 * ║ Mount with:                                                          ║
 * ║   import kbPatternsRoutes from './Routes/kbPatterns.routes.js';      ║
 * ║   app.use('/api', kbPatternsRoutes);                                 ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { Router } from 'express';

import authMiddleware from '../Middlewares/auth.middleware.js';
import * as kbPatternsController from '../Controllers/kbPatterns.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// Admin list. Default status filter is 'candidate' (the review queue).
router.get(
  '/kb-patterns',
  AuthMiddleware.checkAuth,
  kbPatternsController.listPatterns,
);

// Detail view — includes recent matches for the audit trail.
router.get(
  '/kb-patterns/:id',
  AuthMiddleware.checkAuth,
  kbPatternsController.getPattern,
);

// Promote / demote — body { reason } required; controller persists reason
// on the row and stamps reviewed_by + reviewed_at.
router.post(
  '/kb-patterns/:id/promote',
  AuthMiddleware.checkAuth,
  kbPatternsController.promotePattern,
);

router.post(
  '/kb-patterns/:id/demote',
  AuthMiddleware.checkAuth,
  kbPatternsController.demotePattern,
);

// Manual miner trigger — superadmin-only. The controller double-checks the
// role; a dedicated middleware should also be applied at mount time once
// available.
router.post(
  '/admin/kb-miner/run',
  AuthMiddleware.checkAuth,
  kbPatternsController.runMinerManually,
);

export default router;
