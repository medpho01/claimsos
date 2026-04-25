import type { Request, Response, NextFunction } from 'express';
import asyncHandler from '../Utils/asyncHandler.util.js';
import apiError from '../Utils/errorHandler.util.js';
import apiResponse from '../Utils/apiResponse.util.js';
import DoctorAttributeDefinitionService from '../Services/doctorAttributeDefinition.service.js';

class DoctorAttributeDefinitionController {
  /**
   * GET /admin/doctor-attributes/definitions
   * Get all doctor attribute definitions (with optional category filter)
   */
  getDefinitions = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { category, isActive } = req.query;

    const definitions = await DoctorAttributeDefinitionService.getAllDefinitions(
      category as string | undefined,
      isActive !== 'false'
    );

    res.status(200).json(
      new apiResponse(200, definitions, `Retrieved ${definitions.length} doctor attribute definitions`)
    );
  });

  /**
   * GET /admin/doctor-attributes/definitions/grouped-by-category
   * Get all doctor attribute definitions grouped by category
   */
  getDefinitionsByCategory = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { isActive } = req.query;

    const grouped = await DoctorAttributeDefinitionService.getDefinitionsByCategory(
      isActive !== 'false'
    );

    res.status(200).json(
      new apiResponse(200, grouped, 'Doctor attribute definitions grouped by category')
    );
  });

  /**
   * GET /admin/doctor-attributes/definitions/:id
   * Get single doctor attribute definition by ID
   */
  getDefinition = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;

    if (!id) throw new apiError(400, 'Definition ID is required');

    const definition = await DoctorAttributeDefinitionService.getDefinition(id);

    res.status(200).json(
      new apiResponse(200, definition, 'Doctor attribute definition retrieved')
    );
  });

  /**
   * GET /admin/doctor-attributes/definitions/by-key/:key
   * Get single doctor attribute definition by key
   */
  getDefinitionByKey = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { key } = req.params;

    if (!key) throw new apiError(400, 'Definition key is required');

    const definition = await DoctorAttributeDefinitionService.getDefinitionByKey(key);

    res.status(200).json(
      new apiResponse(200, definition, 'Doctor attribute definition retrieved')
    );
  });

  /**
   * POST /admin/doctor-attributes/definitions
   * Create new doctor attribute definition
   */
  createDefinition = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const {
      key,
      label,
      category,
      description,
      dataType,
      isRequired,
      hasExpiry,
      requiresDocument,
      canVerifyByDocument,
      sortOrder,
      categorySortOrder,
      requiresValidatorVerification,
      autoVerifiable,
      verificationUrlPattern
    } = req.body;

    const userId = req.user?.id;

    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    if (!key || !label || !category || !dataType) {
      throw new apiError(400, 'Required fields: key, label, category, dataType');
    }

    const definition = await DoctorAttributeDefinitionService.createDefinition(
      {
        key,
        label,
        category,
        description,
        dataType,
        isRequired,
        hasExpiry,
        requiresDocument,
        canVerifyByDocument,
        sortOrder,
        categorySortOrder,
        requiresValidatorVerification,
        autoVerifiable,
        verificationUrlPattern
      },
      userId
    );

    res.status(201).json(
      new apiResponse(201, definition, 'Doctor attribute definition created successfully')
    );
  });

  /**
   * PUT /admin/doctor-attributes/definitions/:id
   * Update doctor attribute definition
   */
  updateDefinition = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!id) throw new apiError(400, 'Definition ID is required');
    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    const definition = await DoctorAttributeDefinitionService.updateDefinition(
      id,
      req.body,
      userId
    );

    res.status(200).json(
      new apiResponse(200, definition, 'Doctor attribute definition updated successfully')
    );
  });

  /**
   * DELETE /admin/doctor-attributes/definitions/:id
   * Deactivate (soft delete) doctor attribute definition
   */
  deactivateDefinition = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!id) throw new apiError(400, 'Definition ID is required');
    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    const definition = await DoctorAttributeDefinitionService.deactivateDefinition(id, userId);

    res.status(200).json(
      new apiResponse(200, definition, 'Doctor attribute definition deactivated successfully')
    );
  });

  /**
   * GET /admin/doctor-attributes/definitions/stats
   * Get doctor attribute definition statistics
   */
  getDefinitionStats = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const stats = await DoctorAttributeDefinitionService.getDefinitionStats();

    res.status(200).json(
      new apiResponse(200, stats, 'Doctor attribute definition statistics retrieved')
    );
  });
}

export default new DoctorAttributeDefinitionController();
