import { pool } from "../DB/db.js";
import apiError from "../Utils/errorHandler.util.js";

interface AttributeDefinitionInput {
  key: string;
  category: string;
  label: string;
  description?: string;
  data_type: string;
  unit?: string;
  requires_document?: boolean;
  has_expiry?: boolean;
  expected_issuing_authority?: string;
  can_verify_by_image?: boolean;
  image_guidance?: string;
  is_mandatory_basic?: boolean;
  is_mandatory_empanelment?: boolean;
  sort_order?: number;
  is_active?: boolean;
}

class AttributeDefinitionService {
  /**
   * Get all attribute definitions with optional filters
   */
  async getDefinitions(filters?: {
    category?: string;
    data_type?: string;
    is_active?: boolean;
    search?: string;
  }) {
    try {
      let query = `
        SELECT * FROM hospital.attribute_definitions
        WHERE 1=1
      `;
      const params: any[] = [];
      let paramIndex = 1;

      if (filters?.category) {
        query += ` AND category = $${paramIndex}`;
        params.push(filters.category);
        paramIndex++;
      }

      if (filters?.data_type) {
        query += ` AND data_type = $${paramIndex}`;
        params.push(filters.data_type);
        paramIndex++;
      }

      if (filters?.is_active !== undefined) {
        query += ` AND is_active = $${paramIndex}`;
        params.push(filters.is_active);
        paramIndex++;
      }

      if (filters?.search) {
        query += ` AND (key ILIKE $${paramIndex} OR label ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
        params.push(`%${filters.search}%`);
        paramIndex++;
      }

      query += ` ORDER BY category, sort_order, label`;

      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      throw new apiError(500, "Error fetching attribute definitions");
    }
  }

  /**
   * Get single attribute definition by key
   */
  async getDefinitionByKey(key: string) {
    try {
      const result = await pool.query(
        `SELECT * FROM hospital.attribute_definitions WHERE key = $1`,
        [key]
      );

      if (result.rows.length === 0) {
        throw new apiError(404, "Attribute definition not found");
      }

      return result.rows[0];
    } catch (error) {
      if (error instanceof apiError) throw error;
      throw new apiError(500, "Error fetching attribute definition");
    }
  }

  /**
   * Create new attribute definition
   */
  async createDefinition(input: AttributeDefinitionInput) {
    try {
      // Validate key format: category.subcategory.name
      const keyPattern = /^[a-z0-9]+\.[a-z0-9]+(\.[a-z0-9]+)?$/;
      if (!keyPattern.test(input.key)) {
        throw new apiError(
          400,
          "Invalid key format. Use format: category.subcategory or category.subcategory.name (lowercase with dots)"
        );
      }

      // Check if key already exists
      const existingKey = await pool.query(
        `SELECT key FROM hospital.attribute_definitions WHERE key = $1`,
        [input.key]
      );

      if (existingKey.rows.length > 0) {
        throw new apiError(409, `Attribute key '${input.key}' already exists`);
      }

      // Validate required fields
      if (!input.label) {
        throw new apiError(400, "Label is required");
      }
      if (!input.category) {
        throw new apiError(400, "Category is required");
      }
      if (!input.data_type) {
        throw new apiError(400, "Data type is required");
      }

      // Insert new definition
      const result = await pool.query(
        `INSERT INTO hospital.attribute_definitions
        (key, category, label, description, data_type, unit, requires_document,
         has_expiry, expected_issuing_authority, can_verify_by_image, image_guidance,
         is_mandatory_basic, is_mandatory_empanelment, sort_order, is_active, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
        RETURNING *`,
        [
          input.key,
          input.category,
          input.label,
          input.description || null,
          input.data_type,
          input.unit || null,
          input.requires_document ?? false,
          input.has_expiry ?? false,
          input.expected_issuing_authority || null,
          input.can_verify_by_image ?? false,
          input.image_guidance || null,
          input.is_mandatory_basic ?? false,
          input.is_mandatory_empanelment ?? false,
          input.sort_order ?? 999,
          input.is_active ?? true,
        ]
      );

      return result.rows[0];
    } catch (error) {
      if (error instanceof apiError) throw error;
      throw new apiError(500, "Error creating attribute definition");
    }
  }

  /**
   * Update existing attribute definition
   */
  async updateDefinition(key: string, input: Partial<AttributeDefinitionInput>) {
    try {
      // Check if definition exists
      const existing = await this.getDefinitionByKey(key);
      if (!existing) {
        throw new apiError(404, "Attribute definition not found");
      }

      // Build dynamic update query
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      // Only allow certain fields to be updated (not key)
      const allowedFields = [
        "label",
        "description",
        "category",
        "unit",
        "requires_document",
        "has_expiry",
        "expected_issuing_authority",
        "can_verify_by_image",
        "image_guidance",
        "is_mandatory_basic",
        "is_mandatory_empanelment",
        "sort_order",
        "is_active",
      ];

      for (const field of allowedFields) {
        if (field in input && input[field as keyof AttributeDefinitionInput] !== undefined) {
          updates.push(`${field} = $${paramIndex}`);
          values.push(input[field as keyof AttributeDefinitionInput]);
          paramIndex++;
        }
      }

      if (updates.length === 0) {
        throw new apiError(400, "No fields to update");
      }

      updates.push(`updated_at = NOW()`);
      values.push(key);

      const query = `
        UPDATE hospital.attribute_definitions
        SET ${updates.join(", ")}
        WHERE key = $${paramIndex}
        RETURNING *
      `;

      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        throw new apiError(404, "Attribute definition not found");
      }

      return result.rows[0];
    } catch (error) {
      if (error instanceof apiError) throw error;
      throw new apiError(500, "Error updating attribute definition");
    }
  }

  /**
   * Delete attribute definition
   */
  async deleteDefinition(key: string) {
    try {
      // Check if definition exists
      const existing = await this.getDefinitionByKey(key);
      if (!existing) {
        throw new apiError(404, "Attribute definition not found");
      }

      // Check if definition has associated hospital attributes
      const associatedCount = await pool.query(
        `SELECT COUNT(*) as count FROM hospital.hospital_attributes WHERE attribute_key = $1`,
        [key]
      );

      if (parseInt(associatedCount.rows[0].count) > 0) {
        throw new apiError(
          422,
          `Cannot delete attribute definition. It has ${associatedCount.rows[0].count} associated hospital attributes. Deactivate instead using activate/deactivate endpoint.`
        );
      }

      // Delete the definition
      const result = await pool.query(
        `DELETE FROM hospital.attribute_definitions WHERE key = $1 RETURNING *`,
        [key]
      );

      return result.rows[0];
    } catch (error) {
      if (error instanceof apiError) throw error;
      throw new apiError(500, "Error deleting attribute definition");
    }
  }

  /**
   * Activate attribute definition
   */
  async activateDefinition(key: string) {
    try {
      const result = await pool.query(
        `UPDATE hospital.attribute_definitions
         SET is_active = true, updated_at = NOW()
         WHERE key = $1
         RETURNING *`,
        [key]
      );

      if (result.rows.length === 0) {
        throw new apiError(404, "Attribute definition not found");
      }

      return result.rows[0];
    } catch (error) {
      if (error instanceof apiError) throw error;
      throw new apiError(500, "Error activating attribute definition");
    }
  }

  /**
   * Deactivate attribute definition
   */
  async deactivateDefinition(key: string) {
    try {
      const result = await pool.query(
        `UPDATE hospital.attribute_definitions
         SET is_active = false, updated_at = NOW()
         WHERE key = $1
         RETURNING *`,
        [key]
      );

      if (result.rows.length === 0) {
        throw new apiError(404, "Attribute definition not found");
      }

      return result.rows[0];
    } catch (error) {
      if (error instanceof apiError) throw error;
      throw new apiError(500, "Error deactivating attribute definition");
    }
  }

  /**
   * Validate key uniqueness
   */
  async validateKeyUniqueness(key: string, excludeKey?: string) {
    try {
      let query = `SELECT COUNT(*) as count FROM hospital.attribute_definitions WHERE key = $1`;
      const params = [key];

      if (excludeKey) {
        query += ` AND key != $2`;
        params.push(excludeKey);
      }

      const result = await pool.query(query, params);
      const isDuplicate = parseInt(result.rows[0].count) > 0;

      return {
        isUnique: !isDuplicate,
        message: isDuplicate ? "Key already exists" : "Key is unique",
      };
    } catch (error) {
      throw new apiError(500, "Error validating key uniqueness");
    }
  }

  /**
   * Get categories
   */
  async getCategories() {
    try {
      const result = await pool.query(
        `SELECT DISTINCT category FROM hospital.attribute_definitions WHERE is_active = true ORDER BY category`
      );
      return result.rows.map((r) => r.category);
    } catch (error) {
      throw new apiError(500, "Error fetching categories");
    }
  }

  /**
   * Get data types
   */
  async getDataTypes() {
    try {
      const result = await pool.query(
        `SELECT DISTINCT data_type FROM hospital.attribute_definitions WHERE is_active = true ORDER BY data_type`
      );
      return result.rows.map((r) => r.data_type);
    } catch (error) {
      throw new apiError(500, "Error fetching data types");
    }
  }
}

export default new AttributeDefinitionService();
