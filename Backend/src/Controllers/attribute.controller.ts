import type { Request, Response, NextFunction } from 'express';
import asyncHandler from '../Utils/asyncHandler.util.js';
import apiError from '../Utils/errorHandler.util.js';
import apiResponse from '../Utils/apiResponse.util.js';
import AttributeService from '../Services/attribute.service.js';

class AttributeController {
  /**
   * GET /attributes/definitions
   * Get all attribute definitions (optionally filtered by category)
   */
  getDefinitions = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { category } = req.query;

    const definitions = await AttributeService.getAllDefinitions(category as string | undefined);

    res.status(200).json(
      new apiResponse(200, definitions, 'Attribute definitions retrieved')
    );
  });

  /**
   * GET /attributes/definitions/:key
   * Get single attribute definition
   */
  getDefinition = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { key } = req.params;

    if (!key) throw new apiError(400, 'Attribute key is required');

    const definition = await AttributeService.getAttributeDefinition(key);

    res.status(200).json(
      new apiResponse(200, definition, 'Attribute definition retrieved')
    );
  });

  /**
   * GET /hospitals/:hospitalId/attributes
   * Get all hospital attributes (optionally filtered)
   */
  getAttributes = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const { category, status } = req.query;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const attributes = await AttributeService.getHospitalAttributes(
      hospitalId,
      category as string | undefined,
      status as string | undefined
    );

    res.status(200).json(
      new apiResponse(200, attributes, `Retrieved ${attributes.length} attributes`)
    );
  });

  /**
   * GET /hospitals/:hospitalId/attributes/:attributeKey
   * Get single hospital attribute
   */
  getAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, attributeKey } = req.params;

    if (!hospitalId || !attributeKey) throw new apiError(400, 'Hospital ID and attribute key are required');

    const attribute = await AttributeService.getAttribute(hospitalId, attributeKey);

    if (!attribute) {
      throw new apiError(404, 'Attribute not set for this hospital');
    }

    res.status(200).json(
      new apiResponse(200, attribute, 'Attribute retrieved')
    );
  });

  /**
   * POST /hospitals/:hospitalId/attributes/:attributeKey
   * Set hospital attribute value
   */
  setAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, attributeKey } = req.params;
    const {
      value,  // Legacy: generic value field
      valueBoolean,
      valueInteger,
      valueText,
      valueDate,
      documentId,
      certificateNumber,
      issueDate,
      expiresAt,
      issuingAuthority
    } = req.body;

    if (!hospitalId || !attributeKey) throw new apiError(400, 'Hospital ID and attribute key are required');

    // Accept either specific typed fields OR generic value field for backwards compatibility
    const input: {
      hospitalId: string;
      attributeKey: string;
      valueBoolean?: boolean | null;
      valueInteger?: number | null;
      valueText?: string | null;
      valueDate?: string | null;
      documentId?: any;
      certificateNumber?: any;
      issueDate?: any;
      expiresAt?: any;
      issuingAuthority?: any;
    } = {
      hospitalId: hospitalId!,
      attributeKey: attributeKey!,
      valueBoolean: valueBoolean ?? (typeof value === 'boolean' ? value : null),
      valueInteger: valueInteger ?? (typeof value === 'number' ? value : null),
      valueText: valueText ?? (typeof value === 'string' ? value : null),
      valueDate: valueDate ?? null,
      documentId,
      certificateNumber,
      issueDate,
      expiresAt,
      issuingAuthority
    };

    const attribute = await AttributeService.setAttribute(input);

    res.status(200).json(
      new apiResponse(200, attribute, 'Attribute set successfully')
    );
  });

  /**
   * GET /hospitals/:hospitalId/attributes/unverified
   * Get attributes needing verification
   */
  getUnverifiedAttributes = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const attributes = await AttributeService.getUnverifiedAttributes(hospitalId);

    res.status(200).json(
      new apiResponse(200, attributes, `${attributes.length} attributes need verification`)
    );
  });

  /**
   * GET /hospitals/:hospitalId/attributes/expiring
   * Get expiring attributes (90-day warning)
   */
  getExpiringAttributes = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const { days } = req.query;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const attributes = await AttributeService.getExpiringAttributes(
      hospitalId,
      parseInt(days as string) || 90
    );

    res.status(200).json(
      new apiResponse(200, attributes, `${attributes.length} attributes expiring soon`)
    );
  });

  /**
   * GET /hospitals/:hospitalId/attributes/expired
   * Get expired attributes
   */
  getExpiredAttributes = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const attributes = await AttributeService.getExpiredAttributes(hospitalId);

    res.status(200).json(
      new apiResponse(200, attributes, `${attributes.length} expired attributes`)
    );
  });

  /**
   * PUT /hospitals/:hospitalId/attributes/:attributeKey/verify
   * Mark attribute as verified
   */
  verifyAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, attributeKey } = req.params;
    const { method, notes } = req.body;
    const verifiedBy = req.user?.id;

    if (!hospitalId || !attributeKey) throw new apiError(400, 'Hospital ID and attribute key are required');
    if (!verifiedBy) {
      throw new apiError(401, 'Unauthorized');
    }

    if (!['document', 'image', 'manual', 'automated'].includes(method)) {
      throw new apiError(400, 'Invalid verification method');
    }

    const attribute = await AttributeService.verifyAttribute(
      hospitalId,
      attributeKey,
      method,
      verifiedBy,
      notes
    );

    res.status(200).json(
      new apiResponse(200, attribute, 'Attribute verified successfully')
    );
  });

  /**
   * PUT /hospitals/:hospitalId/attributes/:attributeKey/reject
   * Reject attribute
   */
  rejectAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, attributeKey } = req.params;
    const { reason } = req.body;
    const rejectedBy = req.user?.id;

    if (!hospitalId || !attributeKey) throw new apiError(400, 'Hospital ID and attribute key are required');
    if (!rejectedBy) {
      throw new apiError(401, 'Unauthorized');
    }

    const attribute = await AttributeService.rejectAttribute(
      hospitalId,
      attributeKey,
      reason,
      rejectedBy
    );

    res.status(200).json(
      new apiResponse(200, attribute, 'Attribute rejected')
    );
  });

  /**
   * DELETE /hospitals/:hospitalId/attributes/:attributeKey
   * Delete attribute
   */
  deleteAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, attributeKey } = req.params;

    if (!hospitalId || !attributeKey) throw new apiError(400, 'Hospital ID and attribute key are required');

    const deleted = await AttributeService.deleteAttribute(hospitalId, attributeKey);

    if (!deleted) {
      throw new apiError(404, 'Attribute not found');
    }

    res.status(200).json(
      new apiResponse(200, { deleted: true }, 'Attribute deleted')
    );
  });
}

export default new AttributeController();
