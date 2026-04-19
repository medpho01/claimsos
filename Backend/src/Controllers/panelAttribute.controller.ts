import { Request, Response } from 'express';
import panelAttributeService from '../Services/panelAttribute.service.js';
import apiError from '../Utils/errorHandler.util.js';

// @route   GET /api/v1/hospitals/:hospitalId/panels/:panelId/attributes
// @desc    Get all attributes for a hospital-panel relationship
// @access  Private
export const getAttributes = async (req: Request, res: Response) => {
  try {
    const { hospitalId, panelId } = req.params;

    const attributes = await panelAttributeService.getAttributesByHospitalAndPanel(hospitalId, panelId);

    res.status(200).json({
      success: true,
      data: attributes,
      message: 'Panel attributes fetched successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error fetching attributes',
      data: null
    });
  }
};

// @route   GET /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId
// @desc    Get specific panel attribute
// @access  Private
export const getAttribute = async (req: Request, res: Response) => {
  try {
    const { attributeId } = req.params;

    const attribute = await panelAttributeService.getAttribute(attributeId);

    res.status(200).json({
      success: true,
      data: attribute,
      message: 'Panel attribute fetched successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error fetching attribute',
      data: null
    });
  }
};

// @route   POST /api/v1/hospitals/:hospitalId/panels/:panelId/attributes
// @desc    Create or update panel attribute
// @access  Private
export const setAttributeValue = async (req: Request, res: Response) => {
  try {
    const { hospitalId, panelId } = req.params;
    const { hospital_panel_id, ...attributeData } = req.body;

    if (!hospital_panel_id) {
      throw new apiError(400, 'hospital_panel_id is required');
    }

    const userId = (req as any).user?.id;

    const attribute = await panelAttributeService.setAttributeValue(
      hospital_panel_id,
      hospitalId,
      panelId,
      attributeData,
      userId
    );

    res.status(201).json({
      success: true,
      data: attribute,
      message: 'Panel attribute set successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error setting attribute',
      data: null
    });
  }
};

// @route   PUT /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId
// @desc    Update panel attribute value
// @access  Private
export const updateAttributeValue = async (req: Request, res: Response) => {
  try {
    const { attributeId } = req.params;
    const userId = (req as any).user?.id;

    const attribute = await panelAttributeService.updateAttributeValue(attributeId, req.body, userId);

    res.status(200).json({
      success: true,
      data: attribute,
      message: 'Panel attribute updated successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error updating attribute',
      data: null
    });
  }
};

// @route   DELETE /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId
// @desc    Delete panel attribute
// @access  Private
export const deleteAttribute = async (req: Request, res: Response) => {
  try {
    const { attributeId } = req.params;

    const result = await panelAttributeService.deleteAttribute(attributeId);

    res.status(200).json({
      success: true,
      data: result,
      message: 'Panel attribute deleted successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error deleting attribute',
      data: null
    });
  }
};

// @route   POST /api/v1/hospitals/:hospitalId/panels/:panelId/attributes/bulk
// @desc    Set multiple attributes at once
// @access  Private
export const setMultipleAttributes = async (req: Request, res: Response) => {
  try {
    const { hospitalId, panelId } = req.params;
    const { hospital_panel_id, attributes } = req.body;

    if (!hospital_panel_id || !Array.isArray(attributes)) {
      throw new apiError(400, 'hospital_panel_id and attributes array are required');
    }

    const userId = (req as any).user?.id;

    const results = await panelAttributeService.setMultipleAttributes(
      hospital_panel_id,
      hospitalId,
      panelId,
      attributes,
      userId
    );

    res.status(201).json({
      success: true,
      data: results,
      message: 'Panel attributes set successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error setting attributes',
      data: null
    });
  }
};

// @route   GET /api/v1/hospitals/:hospitalId/panels/:panelId/details
// @desc    Get complete panel information (all attributes)
// @access  Private
export const getCompleteInfo = async (req: Request, res: Response) => {
  try {
    const { hospitalId, panelId } = req.params;

    const info = await panelAttributeService.getCompleteAttributeInfo(hospitalId, panelId);

    res.status(200).json({
      success: true,
      data: info,
      message: 'Complete panel information fetched successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error fetching panel information',
      data: null
    });
  }
};
