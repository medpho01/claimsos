import { pool } from "../DB/db.js";
import apiError from "../Utils/errorHandler.util.js";

interface MasterOption {
  id: string;
  category: string;
  code: string;
  label: string;
  description?: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface CreateMasterOptionInput {
  category: string;
  code: string;
  label: string;
  description?: string;
  sort_order?: number;
}

interface UpdateMasterOptionInput {
  label?: string;
  description?: string;
  sort_order?: number;
  is_active?: boolean;
}

class MasterOptionsService {
  /**
   * Get all master options (with pagination)
   */
  async getAllOptions(
    page: number = 1,
    limit: number = 100
  ): Promise<{ data: MasterOption[]; total: number; page: number; limit: number }> {
    try {
      const offset = (page - 1) * limit;

      const [dataResult, countResult] = await Promise.all([
        pool.query(
          `SELECT * FROM hospital.master_options
           WHERE is_active = true
           ORDER BY category, sort_order, label
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM hospital.master_options WHERE is_active = true`),
      ]);

      return {
        data: dataResult.rows as MasterOption[],
        total: parseInt(countResult.rows[0].count),
        page,
        limit,
      };
    } catch (error) {
      throw new apiError(500, "Failed to fetch master options");
    }
  }

  /**
   * Get options by category
   */
  async getOptionsByCategory(category: string): Promise<MasterOption[]> {
    try {
      const result = await pool.query(
        `SELECT * FROM hospital.master_options
         WHERE category = $1 AND is_active = true
         ORDER BY sort_order, label`,
        [category]
      );

      return result.rows as MasterOption[];
    } catch (error) {
      console.error(`Database error fetching options for category ${category}:`, error);
      throw new apiError(500, `Failed to fetch options for category: ${category}`);
    }
  }

  /**
   * Get a single master option by ID
   */
  async getOptionById(id: string): Promise<MasterOption> {
    try {
      const result = await pool.query(
        `SELECT * FROM hospital.master_options WHERE id = $1`,
        [id]
      );

      if (result.rowCount === 0) {
        throw new apiError(404, "Master option not found");
      }

      return result.rows[0] as MasterOption;
    } catch (error) {
      if (error instanceof apiError) {
        throw error;
      }
      throw new apiError(500, "Failed to fetch master option");
    }
  }

  /**
   * Create a new master option
   */
  async createOption(input: CreateMasterOptionInput): Promise<MasterOption> {
    try {
      // Validate required fields
      if (!input.category || !input.code || !input.label) {
        throw new apiError(400, "Missing required fields: category, code, label");
      }

      // Check for duplicate (category, code) combination
      const existingResult = await pool.query(
        `SELECT id FROM hospital.master_options
         WHERE category = $1 AND code = $2`,
        [input.category, input.code]
      );

      if (existingResult.rowCount > 0) {
        throw new apiError(
          409,
          `Option with code '${input.code}' already exists in category '${input.category}'`
        );
      }

      const sortOrder = input.sort_order || 999;

      const result = await pool.query(
        `INSERT INTO hospital.master_options (category, code, label, description, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [input.category, input.code, input.label, input.description || null, sortOrder]
      );

      return result.rows[0] as MasterOption;
    } catch (error) {
      if (error instanceof apiError) {
        throw error;
      }
      throw new apiError(500, "Failed to create master option");
    }
  }

  /**
   * Update a master option
   */
  async updateOption(id: string, input: UpdateMasterOptionInput): Promise<MasterOption> {
    try {
      // Verify option exists
      const existingResult = await pool.query(
        `SELECT * FROM hospital.master_options WHERE id = $1`,
        [id]
      );

      if (existingResult.rowCount === 0) {
        throw new apiError(404, "Master option not found");
      }

      const existing = existingResult.rows[0];

      // Build dynamic update query
      const updates: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (input.label !== undefined) {
        updates.push(`label = $${paramCount++}`);
        values.push(input.label);
      }

      if (input.description !== undefined) {
        updates.push(`description = $${paramCount++}`);
        values.push(input.description);
      }

      if (input.sort_order !== undefined) {
        updates.push(`sort_order = $${paramCount++}`);
        values.push(input.sort_order);
      }

      if (input.is_active !== undefined) {
        updates.push(`is_active = $${paramCount++}`);
        values.push(input.is_active);
      }

      // Always update the updated_at timestamp
      updates.push(`updated_at = NOW()`);

      if (updates.length === 1) {
        // Only updated_at was set, nothing to update
        return existing as MasterOption;
      }

      values.push(id);
      const query = `UPDATE hospital.master_options
                     SET ${updates.join(", ")}
                     WHERE id = $${paramCount}
                     RETURNING *`;

      const result = await pool.query(query, values);
      return result.rows[0] as MasterOption;
    } catch (error) {
      if (error instanceof apiError) {
        throw error;
      }
      throw new apiError(500, "Failed to update master option");
    }
  }

  /**
   * Delete a master option (hard delete - permanent removal)
   * Hard delete is used instead of soft delete for master options to allow code reuse
   */
  async deleteOption(id: string): Promise<void> {
    try {
      const result = await pool.query(
        `DELETE FROM hospital.master_options
         WHERE id = $1
         RETURNING id`,
        [id]
      );

      if (result.rowCount === 0) {
        throw new apiError(404, "Master option not found");
      }
    } catch (error) {
      if (error instanceof apiError) {
        throw error;
      }
      throw new apiError(500, "Failed to delete master option");
    }
  }

  /**
   * Get all categories (with counts)
   */
  async getCategories(): Promise<Array<{ category: string; count: number }>> {
    try {
      const result = await pool.query(
        `SELECT category, COUNT(*) as count
         FROM hospital.master_options
         WHERE is_active = true
         GROUP BY category
         ORDER BY category`
      );

      return result.rows.map((row) => ({
        category: row.category,
        count: parseInt(row.count),
      }));
    } catch (error) {
      throw new apiError(500, "Failed to fetch categories");
    }
  }
}

export default new MasterOptionsService();
