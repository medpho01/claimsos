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
