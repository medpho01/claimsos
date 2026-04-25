import { Request, Response } from 'express';
import panelAttributeDocumentService from '../Services/panelAttributeDocument.service.js';
import apiError from '../Utils/errorHandler.util.js';

// @route   GET /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents
// @desc    Get all documents for a panel attribute
// @access  Private
export const getDocuments = async (req: Request, res: Response) => {
  try {
    const { attributeId } = req.params;

    const documents = await panelAttributeDocumentService.getDocumentsByAttribute(attributeId);

    res.status(200).json({
      success: true,
      data: documents,
      message: 'Panel attribute documents fetched successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error fetching documents',
      data: null
    });
  }
};

// @route   GET /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/:docId
// @desc    Get specific document
// @access  Private
export const getDocument = async (req: Request, res: Response) => {
  try {
    const { docId } = req.params;

    const document = await panelAttributeDocumentService.getDocument(docId);

    res.status(200).json({
      success: true,
      data: document,
      message: 'Panel attribute document fetched successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error fetching document',
      data: null
    });
  }
};

// @route   POST /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents
// @desc    Add document to panel attribute
// @access  Private
export const addDocument = async (req: Request, res: Response) => {
  try {
    const { attributeId } = req.params;
    const { document_id, version, effective_date, expiry_date, is_primary } = req.body;

    if (!document_id) {
      throw new apiError(400, 'document_id is required');
    }

    const document = await panelAttributeDocumentService.addDocument(
      attributeId,
      { document_id, version, effective_date, expiry_date, is_primary }
    );

    res.status(201).json({
      success: true,
      data: document,
      message: 'Document added to panel attribute successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error adding document',
      data: null
    });
  }
};

// @route   PUT /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/:docId
// @desc    Update document metadata
// @access  Private
export const updateDocument = async (req: Request, res: Response) => {
  try {
    const { docId } = req.params;

    const document = await panelAttributeDocumentService.updateDocument(docId, req.body);

    res.status(200).json({
      success: true,
      data: document,
      message: 'Panel attribute document updated successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error updating document',
      data: null
    });
  }
};

// @route   DELETE /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/:docId
// @desc    Remove document from panel attribute
// @access  Private
export const removeDocument = async (req: Request, res: Response) => {
  try {
    const { docId } = req.params;

    const result = await panelAttributeDocumentService.removeDocument(docId);

    res.status(200).json({
      success: true,
      data: result,
      message: 'Panel attribute document removed successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error removing document',
      data: null
    });
  }
};

// @route   PUT /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/:docId/primary
// @desc    Set document as primary
// @access  Private
export const setPrimaryDocument = async (req: Request, res: Response) => {
  try {
    const { docId } = req.params;

    const result = await panelAttributeDocumentService.setPrimaryDocument(docId);

    res.status(200).json({
      success: true,
      data: result,
      message: 'Document set as primary successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error setting primary document',
      data: null
    });
  }
};

// @route   GET /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/expiring
// @desc    Get expiring documents
// @access  Private
export const getExpiringDocuments = async (req: Request, res: Response) => {
  try {
    const { attributeId } = req.params;
    const { withinDays = 30 } = req.query;

    const documents = await panelAttributeDocumentService.getExpiringDocuments(
      attributeId,
      parseInt(withinDays as string) || 30
    );

    res.status(200).json({
      success: true,
      data: documents,
      message: 'Expiring documents fetched successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error fetching expiring documents',
      data: null
    });
  }
};

// @route   GET /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/expired
// @desc    Get expired documents
// @access  Private
export const getExpiredDocuments = async (req: Request, res: Response) => {
  try {
    const { attributeId } = req.params;

    const documents = await panelAttributeDocumentService.getExpiredDocuments(attributeId);

    res.status(200).json({
      success: true,
      data: documents,
      message: 'Expired documents fetched successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error fetching expired documents',
      data: null
    });
  }
};
