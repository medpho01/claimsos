import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import AttributeDefinitionController from "../Controllers/attributeDefinition.controller.js";

const router = Router();
const AuthMiddleware = new authMiddleware();

/**
 * Attribute Definitions Management Routes
 * All routes require superadmin authentication
 */

// Metadata endpoints (GET only, can be less restricted)
router.get(
  "/admin/attribute-definitions/metadata/categories",
  AuthMiddleware.checkAuth,
  AttributeDefinitionController.getCategories
);

router.get(
  "/admin/attribute-definitions/metadata/data-types",
  AuthMiddleware.checkAuth,
  AttributeDefinitionController.getDataTypes
);

// Validation endpoints
router.post(
  "/admin/attribute-definitions/validate-key",
  AuthMiddleware.checkSuperAdmin,
  AttributeDefinitionController.validateKey
);

// CRUD endpoints - require superadmin
router.get(
  "/admin/attribute-definitions",
  AuthMiddleware.checkSuperAdmin,
  AttributeDefinitionController.getDefinitions
);

router.get(
  "/admin/attribute-definitions/:key",
  AuthMiddleware.checkSuperAdmin,
  AttributeDefinitionController.getDefinition
);

router.post(
  "/admin/attribute-definitions",
  AuthMiddleware.checkSuperAdmin,
  AttributeDefinitionController.createDefinition
);

router.put(
  "/admin/attribute-definitions/:key",
  AuthMiddleware.checkSuperAdmin,
  AttributeDefinitionController.updateDefinition
);

router.delete(
  "/admin/attribute-definitions/:key",
  AuthMiddleware.checkSuperAdmin,
  AttributeDefinitionController.deleteDefinition
);

router.patch(
  "/admin/attribute-definitions/:key/activate",
  AuthMiddleware.checkSuperAdmin,
  AttributeDefinitionController.activateDefinition
);

router.patch(
  "/admin/attribute-definitions/:key/deactivate",
  AuthMiddleware.checkSuperAdmin,
  AttributeDefinitionController.deactivateDefinition
);

export default router;
