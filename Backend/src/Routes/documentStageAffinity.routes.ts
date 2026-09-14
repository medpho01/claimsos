import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import controller from '../Controllers/documentStageAffinity.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

/**
 * Document → stage mapping.
 *
 * Reads are open: the upload flow and the stage tagger need the mapping and
 * both run as a hospital user. Writes are superadmin-only — `stage_floor` is
 * the one field permitted to reject a human's upload choice, so a careless
 * edit silently blocks correct tagging.
 */

router.get('/document-stage-affinity', controller.list);

// Before /:docCategory so "groups" is not read as a category slug.
router.get('/document-stage-affinity/groups', controller.groups);

router.post(
  '/document-stage-affinity/bulk-evergreen',
  AuthMiddleware.checkSuperAdmin,
  controller.bulkEvergreen,
);

router.put(
  '/document-stage-affinity/:docCategory',
  AuthMiddleware.checkSuperAdmin,
  controller.upsert,
);

export default router;
