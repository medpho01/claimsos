import { Request, Response, NextFunction } from "express";
import asyncHandler from "../Utils/asyncHandler.util.js";
import apiResponse from "../Utils/apiResponse.util.js";
import apiError from "../Utils/errorHandler.util.js";
import AttributeDefinitionService from "../Services/attributeDefinition.service.js";

class AttributeDefinitionController {
  /**
   * GET /api/v1/admin/attribute-definitions
   * Fetch all attribute definitions with optional filters
   */
  getDefinitions = asyncHandler(async (req: Request, res: Response) => {
    const { category, data_type, is_active, search } = req.query;

    const filters = {
      category: category as string,
      data_type: data_type as string,
      is_active: is_active ? is_active === "true" : undefined,
      search: search as string,
    };

    const definitions = await AttributeDefinitionService.getDefinitions(filters);

    res.status(200).json(
      new apiResponse(200, definitions, `Retrieved ${definitions.length} attribute definitions`)
    );
  });

  /**
   * GET /api/v1/admin/attribute-definitions/:key
   * Fetch single attribute definition by key
   */
  getDefinition = asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;

    if (!key) {
      throw new apiError(400, "Attribute key is required");
    }

    const definition = await AttributeDefinitionService.getDefinitionByKey(key);

    res.status(200).json(
      new apiResponse(200, definition, "Attribute definition retrieved")
    );
  });

  /**
   * POST /api/v1/admin/attribute-definitions
   * Create new attribute definition
   */
  createDefinition = asyncHandler(async (req: Request, res: Response) => {
    const {
      key,
      category,
      label,
      description,
      data_type,
      unit,
      requires_document,
      has_expiry,
      expected_issuing_authority,
      can_verify_by_image,
      image_guidance,
      is_mandatory_basic,
      is_mandatory_empanelment,
      sort_order,
      is_active,
    } = req.body;

    // Validate required fields
    if (!key || !category || !label || !data_type) {
      throw new apiError(
        400,
        "Required fields: key, category, label, data_type"
      );
    }

    const definition = await AttributeDefinitionService.createDefinition({
      key,
      category,
      label,
      description,
      data_type,
      unit,
      requires_document,
      has_expiry,
      expected_issuing_authority,
      can_verify_by_image,
      image_guidance,
      is_mandatory_basic,
      is_mandatory_empanelment,
      sort_order,
      is_active: is_active !== false,
    });

    res.status(201).json(
      new apiResponse(201, definition, "Attribute definition created successfully")
    );
  });

  /**
   * PUT /api/v1/admin/attribute-definitions/:key
   * Update attribute definition
   */
  updateDefinition = asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;

    if (!key) {
      throw new apiError(400, "Attribute key is required");
    }

    // Cannot update key itself
    if ("key" in req.body) {
      throw new apiError(400, "Cannot update attribute key. Create a new definition instead.");
    }

    const definition = await AttributeDefinitionService.updateDefinition(key, req.body);

    res.status(200).json(
      new apiResponse(200, definition, "Attribute definition updated successfully")
    );
  });

  /**
   * DELETE /api/v1/admin/attribute-definitions/:key
   * Delete attribute definition
   */
  deleteDefinition = asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;

    if (!key) {
      throw new apiError(400, "Attribute key is required");
    }

    const definition = await AttributeDefinitionService.deleteDefinition(key);

    res.status(200).json(
      new apiResponse(200, definition, "Attribute definition deleted successfully")
    );
  });

  /**
   * PATCH /api/v1/admin/attribute-definitions/:key/activate
   * Activate (enable) attribute definition
   */
  activateDefinition = asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;

    if (!key) {
      throw new apiError(400, "Attribute key is required");
    }

    const definition = await AttributeDefinitionService.activateDefinition(key);

    res.status(200).json(
      new apiResponse(200, definition, "Attribute definition activated successfully")
    );
  });

  /**
   * PATCH /api/v1/admin/attribute-definitions/:key/deactivate
   * Deactivate (disable) attribute definition
   */
  deactivateDefinition = asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;

    if (!key) {
      throw new apiError(400, "Attribute key is required");
    }

    const definition = await AttributeDefinitionService.deactivateDefinition(key);

    res.status(200).json(
      new apiResponse(200, definition, "Attribute definition deactivated successfully")
    );
  });

  /**
   * POST /api/v1/admin/attribute-definitions/validate-key
   * Validate key uniqueness
   */
  validateKey = asyncHandler(async (req: Request, res: Response) => {
    const { key, excludeKey } = req.body;

    if (!key) {
      throw new apiError(400, "Key is required");
    }

    const validation = await AttributeDefinitionService.validateKeyUniqueness(
      key,
      excludeKey
    );

    res.status(200).json(
      new apiResponse(200, validation, "Key validation completed")
    );
  });

  /**
   * GET /api/v1/admin/attribute-definitions/metadata/categories
   * Get all unique categories
   */
  getCategories = asyncHandler(async (req: Request, res: Response) => {
    const categories = await AttributeDefinitionService.getCategories();

    res.status(200).json(
      new apiResponse(200, categories, `Retrieved ${categories.length} categories`)
    );
  });

  /**
   * GET /api/v1/admin/attribute-definitions/metadata/data-types
   * Get all unique data types
   */
  getDataTypes = asyncHandler(async (req: Request, res: Response) => {
    const dataTypes = await AttributeDefinitionService.getDataTypes();

    res.status(200).json(
      new apiResponse(200, dataTypes, `Retrieved ${dataTypes.length} data types`)
    );
  });
}

export default new AttributeDefinitionController();
