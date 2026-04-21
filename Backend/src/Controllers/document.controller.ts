import type { Request, Response, NextFunction } from 'express';
import asyncHandler from '../Utils/asyncHandler.util.js';
import apiError from '../Utils/errorHandler.util.js';
import apiResponse from '../Utils/apiResponse.util.js';
import AttachmentService from '../Services/attachment.service.js';
import DocumentExtractionService from '../Services/documentExtraction.service.js';

class DocumentController {
  /**
   * POST /hospitals/:hospitalId/documents/upload
   * Upload document and create metadata
   */
  uploadDocument = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const { documentName, documentCategory, documentType, attributeKey, issueDate, expiryDate } = req.body;
    const userId = req.user?.id;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');
    if (!req.file) {
      throw new apiError(400, 'No file provided');
    }

    if (!documentName || !documentCategory || !documentType) {
      throw new apiError(400, 'documentName, documentCategory, and documentType are required');
    }

    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    const document = await AttachmentService.uploadDocument(
      req.file.buffer,
      {
        hospitalId,
        documentName,
        documentCategory,
        documentType,
        attributeKey,
        uploadedBy: userId,
        issueDate,
        expiryDate
      },
      req.file.originalname,
      req.file.mimetype
    );

    res.status(201).json(
      new apiResponse(201, document, 'Document uploaded successfully')
    );
  });

  /**
   * GET /hospitals/:hospitalId/documents
   * Get hospital documents (with optional filtering)
   */
  getDocuments = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const { category, type, attributeKey } = req.query;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const documents = await AttachmentService.getHospitalDocuments(
      hospitalId,
      category as string | undefined,
      type as string | undefined,
      attributeKey as string | undefined
    );

    res.status(200).json(
      new apiResponse(200, documents, `Retrieved ${documents.length} documents`)
    );
  });

  /**
   * GET /hospitals/:hospitalId/documents/:documentId
   * Get document metadata
   */
  getDocument = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { documentId } = req.params;

    if (!documentId) throw new apiError(400, 'Document ID is required');

    const document = await AttachmentService.getDocument(documentId);

    res.status(200).json(
      new apiResponse(200, document, 'Document metadata retrieved')
    );
  });

  /**
   * GET /hospitals/:hospitalId/documents/:documentId/download
   * Download document from S3
   */
  downloadDocument = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { documentId } = req.params;

    if (!documentId) throw new apiError(400, 'Document ID is required');

    const { buffer, fileName, mimeType } = await AttachmentService.downloadDocument(documentId);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  });

  /**
   * PUT /hospitals/:hospitalId/documents/:documentId
   * Update document metadata
   */
  updateDocument = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { documentId } = req.params;
    const { documentName, issueDate, expiryDate, notes } = req.body;

    if (!documentId) throw new apiError(400, 'Document ID is required');

    const document = await AttachmentService.updateDocumentMetadata(documentId, {
      documentName,
      issueDate,
      expiryDate,
      notes
    });

    res.status(200).json(
      new apiResponse(200, document, 'Document updated successfully')
    );
  });

  /**
   * DELETE /hospitals/:hospitalId/documents/:documentId
   * Delete document
   */
  deleteDocument = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { documentId } = req.params;

    if (!documentId) throw new apiError(400, 'Document ID is required');

    await AttachmentService.deleteDocument(documentId);

    res.status(200).json(
      new apiResponse(200, { deleted: true }, 'Document deleted')
    );
  });

  /**
   * POST /hospitals/:hospitalId/documents/:documentId/extract
   * Submit document for AI extraction
   */
  submitForExtraction = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { documentId } = req.params;
    const { autoApply } = req.body;

    if (!documentId) throw new apiError(400, 'Document ID is required');

    const extraction = await DocumentExtractionService.submitForExtraction(documentId, autoApply);

    res.status(201).json(
      new apiResponse(201, extraction, 'Document submitted for extraction')
    );
  });

  /**
   * GET /hospitals/:hospitalId/documents/:documentId/extraction
   * Get extraction status and results
   */
  getExtraction = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { documentId } = req.params;

    if (!documentId) throw new apiError(400, 'Document ID is required');

    // Get document first to find extraction
    const document = await AttachmentService.getDocument(documentId);

    const extraction = await DocumentExtractionService.getExtraction(document.id);

    res.status(200).json(
      new apiResponse(200, extraction, 'Extraction retrieved')
    );
  });

  /**
   * POST /hospitals/:hospitalId/documents/:documentId/extraction/approve
   * Review and approve extraction
   */
  approveExtraction = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { documentId } = req.params;
    const { mappings } = req.body;
    const reviewedBy = req.user?.id;

    if (!documentId) throw new apiError(400, 'Document ID is required');
    if (!reviewedBy) {
      throw new apiError(401, 'Unauthorized');
    }

    // For now, just return success - in real impl would get extraction ID and approve
    res.status(200).json(
      new apiResponse(200, { approved: true }, 'Extraction approved')
    );
  });

  /**
   * PUT /hospitals/:hospitalId/documents/:documentId/link/:attributeKey
   * Link document to attribute
   */
  linkToAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, documentId, attributeKey } = req.params;

    if (!hospitalId || !documentId || !attributeKey) throw new apiError(400, 'Hospital ID, document ID, and attribute key are required');

    const document = await AttachmentService.linkToAttribute(documentId, attributeKey, hospitalId);

    res.status(200).json(
      new apiResponse(200, document, 'Document linked to attribute')
    );
  });

  /**
   * GET /hospitals/:hospitalId/documents/storage-usage
   * Get storage statistics
   */
  getStorageUsage = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const usage = await AttachmentService.getStorageUsage(hospitalId);

    res.status(200).json(
      new apiResponse(200, usage, 'Storage usage retrieved')
    );
  });

  /**
   * GET /hospitals/:hospitalId/documents/batch?ids=id1,id2,id3
   * Fetch multiple document metadata in a single request
   * Performance optimization: eliminates N+1 queries
   */
  getBatchDocuments = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const { ids } = req.query;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');
    if (!ids) throw new apiError(400, 'Document IDs required (comma-separated)');

    // Parse comma-separated IDs
    const idArray = (ids as string).split(',').filter(id => id.trim());
    if (idArray.length === 0) throw new apiError(400, 'At least one document ID required');

    // Limit batch size to prevent abuse
    const MAX_BATCH_SIZE = 100;
    if (idArray.length > MAX_BATCH_SIZE) {
      throw new apiError(400, `Maximum ${MAX_BATCH_SIZE} documents per batch request`);
    }

    console.log(`📦 Fetching batch of ${idArray.length} documents`);

    const documents = await AttachmentService.getBatchDocuments(hospitalId, idArray);

    res.status(200).json(
      new apiResponse(200, documents, `Retrieved ${documents.length} documents`)
    );
  });
}

export default new DocumentController();
