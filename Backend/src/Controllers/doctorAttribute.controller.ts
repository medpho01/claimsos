import type { Request, Response, NextFunction } from 'express';
import asyncHandler from '../Utils/asyncHandler.util.js';
import apiError from '../Utils/errorHandler.util.js';
import apiResponse from '../Utils/apiResponse.util.js';
import DoctorAttributeService from '../Services/doctorAttribute.service.js';

class DoctorAttributeController {
  /**
   * GET /doctors/:doctorId/attributes
   * Get all doctor attributes (optionally filtered by category)
   */
  getDoctorAttributes = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { doctorId } = req.params;
    const { category } = req.query;

    if (!doctorId) throw new apiError(400, 'Doctor ID is required');

    const result = await DoctorAttributeService.getDoctorAttributes(
      doctorId,
      category as string | undefined
    );

    res.status(200).json(
      new apiResponse(200, result, 'Doctor attributes retrieved')
    );
  });

  /**
   * GET /doctors/:doctorId/attributes/:attributeId
   * Get single doctor attribute
   */
  getAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { attributeId } = req.params;

    if (!attributeId) throw new apiError(400, 'Attribute ID is required');

    const attribute = await DoctorAttributeService.getAttribute(attributeId);

    res.status(200).json(
      new apiResponse(200, attribute, 'Attribute retrieved')
    );
  });

  /**
   * POST /doctors/:doctorId/attributes/:attributeKey
   * Set doctor attribute value
   */
  setAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { doctorId, attributeKey } = req.params;

    // Support both camelCase and snake_case field names
    const valueText = req.body.valueText || req.body.value_text;
    const valueDate = req.body.valueDate || req.body.value_date;
    const valueBoolean = req.body.valueBoolean !== undefined ? req.body.valueBoolean : req.body.value_boolean;
    const certificateNumber = req.body.certificateNumber || req.body.certificate_number;
    const issuingAuthority = req.body.issuingAuthority || req.body.issuing_authority;
    const issuedAt = req.body.issuedAt || req.body.issued_at;
    const expiresAt = req.body.expiresAt || req.body.expires_at;
    const documentIds = req.body.documentIds || req.body.document_ids;

    console.log('[DoctorAttributeController] setAttribute called');
    console.log('[DoctorAttributeController] Params:', { doctorId, attributeKey });
    console.log('[DoctorAttributeController] Body:', req.body);
    console.log('[DoctorAttributeController] Parsed values:', { valueText, valueDate, valueBoolean, certificateNumber, issuingAuthority, issuedAt, expiresAt, documentIds });

    if (!doctorId || !attributeKey) {
      console.log('[DoctorAttributeController] Missing doctorId or attributeKey');
      throw new apiError(400, 'Doctor ID and attribute key are required');
    }

    try {
      console.log('[DoctorAttributeController] Calling service.setAttribute...');
      const attribute = await DoctorAttributeService.setAttribute({
        doctorId,
        attributeKey,
        valueText,
        valueDate,
        valueBoolean,
        certificateNumber,
        issuingAuthority,
        issuedAt,
        expiresAt,
        documentIds: documentIds || []
      });

      console.log('[DoctorAttributeController] Service returned:', attribute);

      res.status(200).json(
        new apiResponse(200, attribute, 'Attribute set successfully')
      );

      console.log('[DoctorAttributeController] Response sent');
    } catch (err: any) {
      console.log('[DoctorAttributeController] Error:', err.message);
      throw err;
    }
  });

  /**
   * GET /doctors/:doctorId/attributes/expiring
   * Get expiring attributes (30-day warning)
   */
  getExpiringAttributes = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { doctorId } = req.params;
    const { days } = req.query;

    if (!doctorId) throw new apiError(400, 'Doctor ID is required');

    const attributes = await DoctorAttributeService.getExpiringAttributes(
      doctorId,
      parseInt(days as string) || 30
    );

    res.status(200).json(
      new apiResponse(200, attributes, `${attributes.length} attributes expiring soon`)
    );
  });

  /**
   * GET /doctors/:doctorId/attributes/expired
   * Get expired attributes
   */
  getExpiredAttributes = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { doctorId } = req.params;

    if (!doctorId) throw new apiError(400, 'Doctor ID is required');

    const attributes = await DoctorAttributeService.getExpiredAttributes(doctorId);

    res.status(200).json(
      new apiResponse(200, attributes, `${attributes.length} expired attributes`)
    );
  });

  /**
   * PUT /doctors/:doctorId/attributes/:attributeId/verify
   * Mark attribute as verified (admin action)
   */
  verifyAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { attributeId } = req.params;
    const { method, notes } = req.body;
    const verifiedBy = req.user?.id;

    if (!attributeId) throw new apiError(400, 'Attribute ID is required');
    if (!verifiedBy) {
      throw new apiError(401, 'Unauthorized');
    }

    if (!['document', 'image', 'online_lookup', 'manual', 'automated'].includes(method)) {
      throw new apiError(400, 'Invalid verification method');
    }

    const attribute = await DoctorAttributeService.verifyAttribute(
      attributeId,
      verifiedBy,
      method,
      notes
    );

    res.status(200).json(
      new apiResponse(200, attribute, 'Attribute verified successfully')
    );
  });

  /**
   * GET /doctors/:doctorId/attributes/:attributeKey/history
   * Get attribute verification history
   */
  getAttributeHistory = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { doctorId, attributeKey } = req.params;

    if (!doctorId || !attributeKey) throw new apiError(400, 'Doctor ID and attribute key are required');

    const history = await DoctorAttributeService.getAttributeHistory(doctorId, attributeKey);

    res.status(200).json(
      new apiResponse(200, history, `Retrieved ${history.length} history records`)
    );
  });

  /**
   * POST /doctors/:doctorId/attributes/:attributeId/documents
   * Add document to attribute
   */
  addDocumentToAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { doctorId, attributeId } = req.params;
    const { documentId, isPrimary } = req.body;

    if (!doctorId) throw new apiError(400, 'Doctor ID is required');
    if (!attributeId) throw new apiError(400, 'Attribute ID is required');
    if (!documentId) throw new apiError(400, 'Document ID is required');

    const result = await DoctorAttributeService.addDocumentToAttribute(
      doctorId,
      attributeId,
      documentId,
      isPrimary || false
    );

    res.status(201).json(
      new apiResponse(201, result, 'Document added to attribute')
    );
  });

  /**
   * DELETE /doctors/:doctorId/attributes/:attributeId/documents/:documentId
   * Remove document from attribute
   */
  removeDocumentFromAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { attributeId, documentId } = req.params;

    if (!attributeId || !documentId) {
      throw new apiError(400, 'Attribute ID and document ID are required');
    }

    const result = await DoctorAttributeService.removeDocumentFromAttribute(attributeId, documentId);

    res.status(200).json(
      new apiResponse(200, result, 'Document removed from attribute')
    );
  });

  /**
   * DELETE /doctors/:doctorId/attributes/:attributeId
   * Delete a doctor attribute
   */
  deleteAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { attributeId } = req.params;

    if (!attributeId) throw new apiError(400, 'Attribute ID is required');

    const result = await DoctorAttributeService.deleteAttribute(attributeId);

    res.status(200).json(
      new apiResponse(200, result, 'Attribute deleted successfully')
    );
  });
}

export default new DoctorAttributeController();
