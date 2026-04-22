import { Request, Response } from "express";
import masterOptionsService from "../Services/masterOptions.service.js";
import apiError from "../Utils/errorHandler.util.js";

class MasterOptionsController {
  /**
   * GET /api/master-options
   * Fetch all master options (paginated)
   */
  async getAllOptions(req: Request, res: Response) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 100;

      if (page < 1 || limit < 1) {
        return res.status(400).json({ error: "Page and limit must be positive integers" });
      }

      const result = await masterOptionsService.getAllOptions(page, limit);

      res.status(200).json({
        message: "Master options fetched successfully",
        data: result.data,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: Math.ceil(result.total / result.limit),
        },
      });
    } catch (error) {
      console.error("Error fetching master options:", error);
      if (error instanceof apiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to fetch master options" });
    }
  }

  /**
   * GET /api/master-options/by-category/:category
   * Fetch options for a specific category
   */
  async getOptionsByCategory(req: Request, res: Response) {
    try {
      const { category } = req.params;

      if (!category) {
        return res.status(400).json({ error: "Category parameter is required" });
      }

      const options = await masterOptionsService.getOptionsByCategory(category);

      res.status(200).json({
        message: `Options for category '${category}' fetched successfully`,
        data: options,
      });
    } catch (error) {
      console.error("Error fetching options by category:", error);
      if (error instanceof apiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to fetch options" });
    }
  }

  /**
   * GET /api/master-options/:id
   * Fetch a single master option by ID
   */
  async getOptionById(req: Request, res: Response) {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({ error: "ID parameter is required" });
      }

      const option = await masterOptionsService.getOptionById(id);

      res.status(200).json({
        message: "Master option fetched successfully",
        data: option,
      });
    } catch (error) {
      console.error("Error fetching master option:", error);
      if (error instanceof apiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to fetch master option" });
    }
  }

  /**
   * POST /api/master-options
   * Create a new master option (admin only)
   */
  async createOption(req: Request, res: Response) {
    try {
      const { category, code, label, description, sort_order } = req.body;

      const newOption = await masterOptionsService.createOption({
        category,
        code,
        label,
        description,
        sort_order,
      });

      res.status(201).json({
        message: "Master option created successfully",
        data: newOption,
      });
    } catch (error) {
      console.error("Error creating master option:", error);
      if (error instanceof apiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to create master option" });
    }
  }

  /**
   * PUT /api/master-options/:id
   * Update a master option (admin only)
   */
  async updateOption(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { label, description, sort_order, is_active } = req.body;

      if (!id) {
        return res.status(400).json({ error: "ID parameter is required" });
      }

      const updatedOption = await masterOptionsService.updateOption(id, {
        label,
        description,
        sort_order,
        is_active,
      });

      res.status(200).json({
        message: "Master option updated successfully",
        data: updatedOption,
      });
    } catch (error) {
      console.error("Error updating master option:", error);
      if (error instanceof apiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to update master option" });
    }
  }

  /**
   * DELETE /api/master-options/:id
   * Soft delete a master option (admin only)
   */
  async deleteOption(req: Request, res: Response) {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({ error: "ID parameter is required" });
      }

      await masterOptionsService.deleteOption(id);

      res.status(200).json({
        message: "Master option deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting master option:", error);
      if (error instanceof apiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to delete master option" });
    }
  }

  /**
   * GET /api/master-options/categories/list
   * Get all categories with their option counts
   */
  async getCategories(req: Request, res: Response) {
    try {
      const categories = await masterOptionsService.getCategories();

      res.status(200).json({
        message: "Categories fetched successfully",
        data: categories,
      });
    } catch (error) {
      console.error("Error fetching categories:", error);
      if (error instanceof apiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to fetch categories" });
    }
  }
}

export default new MasterOptionsController();
