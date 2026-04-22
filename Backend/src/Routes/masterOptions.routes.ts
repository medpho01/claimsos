import express from "express";
import masterOptionsController from "../Controllers/masterOptions.controller.js";

const router = express.Router();

/**
 * GET /api/master-options
 * Fetch all master options with pagination
 * Query params: page (default 1), limit (default 100)
 */
router.get("/", masterOptionsController.getAllOptions.bind(masterOptionsController));

/**
 * GET /api/master-options/by-category/:category
 * Fetch all options for a specific category
 * Examples: /by-category/hospital_type, /by-category/speciality
 */
router.get(
  "/by-category/:category",
  masterOptionsController.getOptionsByCategory.bind(masterOptionsController)
);

/**
 * GET /api/master-options/categories/list
 * Get all available categories with their option counts
 */
router.get(
  "/categories/list",
  masterOptionsController.getCategories.bind(masterOptionsController)
);

/**
 * GET /api/master-options/:id
 * Fetch a single master option by ID
 */
router.get("/:id", masterOptionsController.getOptionById.bind(masterOptionsController));

/**
 * POST /api/master-options
 * Create a new master option
 * Requires: category, code, label
 * Optional: description, sort_order
 * Admin only
 */
router.post("/", masterOptionsController.createOption.bind(masterOptionsController));

/**
 * PUT /api/master-options/:id
 * Update an existing master option
 * Updatable fields: label, description, sort_order, is_active
 * Admin only
 */
router.put("/:id", masterOptionsController.updateOption.bind(masterOptionsController));

/**
 * DELETE /api/master-options/:id
 * Soft delete a master option (marks as_inactive)
 * Admin only
 */
router.delete("/:id", masterOptionsController.deleteOption.bind(masterOptionsController));

export default router;
