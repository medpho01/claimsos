import { Request, Response } from 'express';
import panelAttributeDefinitionService from '../Services/panelAttributeDefinition.service.js';

// @route   GET /api/v1/admin/panel-attributes/definitions
// @desc    Get all panel attribute definitions
// @access  Private/Admin
export const getAllDefinitions = async (req: Request, res: Response) => {
  try {
    const { category } = req.query;

    const definitions = await panelAttributeDefinitionService.getAllDefinitions(category as string | undefined);

    res.status(200).json({
      success: true,
      data: definitions,
      message: 'Panel attribute definitions fetched successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error fetching definitions',
      data: null
    });
  }
};

// @route   GET /api/v1/admin/panel-attributes/definitions/by-category
// @desc    Get definitions grouped by category
// @access  Private/Admin
export const getDefinitionsByCategory = async (req: Request, res: Response) => {
  try {
    const definitions = await panelAttributeDefinitionService.getDefinitionsByCategory();

    res.status(200).json({
      success: true,
      data: definitions,
      message: 'Panel attribute definitions by category fetched successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error fetching definitions',
      data: null
    });
  }
};

// @route   GET /api/v1/admin/panel-attributes/definitions/:id
// @desc    Get specific panel attribute definition
// @access  Private/Admin
export const getDefinition = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const definition = await panelAttributeDefinitionService.getDefinitionById(id);

    res.status(200).json({
      success: true,
      data: definition,
      message: 'Panel attribute definition fetched successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error fetching definition',
      data: null
    });
  }
};

// @route   POST /api/v1/admin/panel-attributes/definitions
// @desc    Create new panel attribute definition
// @access  Private/Superadmin
export const createDefinition = async (req: Request, res: Response) => {
  try {
    const definition = await panelAttributeDefinitionService.createDefinition(req.body);

    res.status(201).json({
      success: true,
      data: definition,
      message: 'Panel attribute definition created successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error creating definition',
      data: null
    });
  }
};

// @route   PUT /api/v1/admin/panel-attributes/definitions/:id
// @desc    Update panel attribute definition
// @access  Private/Superadmin
export const updateDefinition = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const definition = await panelAttributeDefinitionService.updateDefinition(id, req.body);

    res.status(200).json({
      success: true,
      data: definition,
      message: 'Panel attribute definition updated successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error updating definition',
      data: null
    });
  }
};

// @route   DELETE /api/v1/admin/panel-attributes/definitions/:id
// @desc    Delete panel attribute definition
// @access  Private/Superadmin
export const deleteDefinition = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const definition = await panelAttributeDefinitionService.deleteDefinition(id);

    res.status(200).json({
      success: true,
      data: definition,
      message: 'Panel attribute definition deleted successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error deleting definition',
      data: null
    });
  }
};

// @route   PATCH /api/v1/admin/panel-attributes/definitions/:id/activate
// @desc    Activate panel attribute definition
// @access  Private/Superadmin
export const activateDefinition = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const definition = await panelAttributeDefinitionService.activateDefinition(id);

    res.status(200).json({
      success: true,
      data: definition,
      message: 'Panel attribute definition activated successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error activating definition',
      data: null
    });
  }
};

// @route   PATCH /api/v1/admin/panel-attributes/definitions/:id/deactivate
// @desc    Deactivate panel attribute definition
// @access  Private/Superadmin
export const deactivateDefinition = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const definition = await panelAttributeDefinitionService.deactivateDefinition(id);

    res.status(200).json({
      success: true,
      data: definition,
      message: 'Panel attribute definition deactivated successfully'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error deactivating definition',
      data: null
    });
  }
};

// @route   POST /api/v1/admin/panel-attributes/definitions/validate-key
// @desc    Validate key uniqueness
// @access  Private/Superadmin
export const validateKey = async (req: Request, res: Response) => {
  try {
    const { key, excludeId } = req.body;

    if (!key) {
      return res.status(400).json({
        success: false,
        error: 'Key is required',
        data: null
      });
    }

    const validation = await panelAttributeDefinitionService.validateKeyUniqueness(key, excludeId);

    res.status(200).json({
      success: true,
      data: validation,
      message: 'Key validation completed'
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error validating key',
      data: null
    });
  }
};
