import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import {
  getAllDefinitions,
  getDefinitionsByCategory,
  getDefinition,
  createDefinition,
  updateDefinition,
  deleteDefinition,
  activateDefinition,
  deactivateDefinition,
  validateKey,
} from "../Controllers/panelAttributeDefinition.controller.js";

const router = Router();
const AuthMiddleware = new authMiddleware();

/**
 * Panel Attribute Definitions Management Routes
 * All routes require superadmin authentication (except metadata GET endpoints)
 */

// Metadata endpoints - allow authenticated users to read
router.get(
  "/admin/panel-attributes/definitions/by-category",
  AuthMiddleware.checkAuth,
  getDefinitionsByCategory
);

router.get(
  "/admin/panel-attributes/definitions",
  AuthMiddleware.checkAuth,
  getAllDefinitions
);

// Validation endpoints - require superadmin
router.post(
  "/admin/panel-attributes/definitions/validate-key",
  AuthMiddleware.checkSuperAdmin,
  validateKey
);

// CRUD endpoints - require superadmin
router.get(
  "/admin/panel-attributes/definitions/:id",
  AuthMiddleware.checkSuperAdmin,
  getDefinition
);

router.post(
  "/admin/panel-attributes/definitions",
  AuthMiddleware.checkSuperAdmin,
  createDefinition
);

router.put(
  "/admin/panel-attributes/definitions/:id",
  AuthMiddleware.checkSuperAdmin,
  updateDefinition
);

router.delete(
  "/admin/panel-attributes/definitions/:id",
  AuthMiddleware.checkSuperAdmin,
  deleteDefinition
);

router.patch(
  "/admin/panel-attributes/definitions/:id/activate",
  AuthMiddleware.checkSuperAdmin,
  activateDefinition
);

router.patch(
  "/admin/panel-attributes/definitions/:id/deactivate",
  AuthMiddleware.checkSuperAdmin,
  deactivateDefinition
);

export default router;
