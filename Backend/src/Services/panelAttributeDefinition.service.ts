import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';
import { logger } from '../Utils/logger.js';

interface PanelAttributeDefinitionInput {
  key: string;
  label: string;
  description?: string;
  category?: string;
  data_type: 'text' | 'textarea' | 'email' | 'phone' | 'url' | 'date' | 'boolean' | 'single_select' | 'multi_select' | 'file' | 'json' | 'encrypted_text';
  options?: Record<string, string>;
  validation_regex?: string;
  validation_min_length?: number;
  validation_max_length?: number;
  is_required?: boolean;
  is_unique?: boolean;
  default_value?: string;
  sort_order?: number;
  is_active?: boolean;
}

class PanelAttributeDefinitionService {
  /**
   * Get all panel attribute definitions (with optional filtering)
   */
  async getAllDefinitions(category?: string, isActive: boolean = true) {
    try {
      let query = `
        SELECT id, key, label, description, category, data_type, options,
               validation_regex, validation_min_length, validation_max_length,
               is_required, is_unique, default_value, sort_order, is_active,
               created_at, updated_at
        FROM hospital.panel_attribute_definitions
        WHERE 1=1
      `;
      const params: any[] = [];

      if (isActive !== null && isActive !== undefined) {
        params.push(isActive);
        query += ` AND is_active = $${params.length}`;
      }

      if (category) {
        params.push(category);
        query += ` AND category = $${params.length}`;
      }

      query += ` ORDER BY category, sort_order ASC`;

      const result = await pool.query(query, params);
      return result.rows;
    } catch (err) {
      logger.error({ err }, 'error fetching panel attribute definitions');
      throw err;
    }
  }

  /**
   * Get definition by ID
   */
  async getDefinitionById(id: string) {
    try {
      const result = await pool.query(
        `SELECT id, key, label, description, category, data_type, options,
                validation_regex, validation_min_length, validation_max_length,
                is_required, is_unique, default_value, sort_order, is_active,
                created_at, updated_at
         FROM hospital.panel_attribute_definitions
         WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new apiError(404, 'Panel attribute definition not found');
      }

      return result.rows[0];
    } catch (err) {
      logger.error({ err }, 'error fetching panel attribute definition');
      throw err;
    }
  }

  /**
   * Get definition by key
   */
  async getDefinitionByKey(key: string) {
    try {
      const result = await pool.query(
        `SELECT id, key, label, description, category, data_type, options,
                validation_regex, validation_min_length, validation_max_length,
                is_required, is_unique, default_value, sort_order, is_active,
                created_at, updated_at
         FROM hospital.panel_attribute_definitions
         WHERE key = $1`,
        [key]
      );

      if (result.rows.length === 0) {
        throw new apiError(404, 'Panel attribute definition not found');
      }

      return result.rows[0];
    } catch (err) {
      logger.error({ err }, 'error fetching panel attribute definition by key');
      throw err;
    }
  }

  /**
   * Get all definitions grouped by category
   */
  async getDefinitionsByCategory() {
    try {
      const result = await pool.query(
        `SELECT category,
                json_agg(
                  json_build_object(
                    'id', id,
                    'key', key,
                    'label', label,
                    'description', description,
                    'data_type', data_type,
                    'options', options,
                    'is_required', is_required,
                    'sort_order', sort_order
                  ) ORDER BY sort_order
                ) as definitions
         FROM hospital.panel_attribute_definitions
         WHERE is_active = true
         GROUP BY category
         ORDER BY category`
      );

      return result.rows;
    } catch (err) {
      logger.error({ err }, 'error fetching panel attribute definitions by category');
      throw err;
    }
  }

  /**
   * Create new panel attribute definition
   */
  async createDefinition(input: PanelAttributeDefinitionInput) {
    try {
      // Validate key format: lowercase with underscores
      const keyPattern = /^[a-z0-9_]+$/;
      if (!keyPattern.test(input.key)) {
        throw new apiError(
          400,
          "Invalid key format. Use lowercase letters, numbers, and underscores only"
        );
      }

      // Check if key already exists
      const existingKey = await pool.query(
        `SELECT id FROM hospital.panel_attribute_definitions WHERE key = $1`,
        [input.key]
      );

      if (existingKey.rows.length > 0) {
        throw new apiError(409, `Key '${input.key}' already exists`);
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

      // Validate regex if provided
      if (input.validation_regex) {
        try {
          new RegExp(input.validation_regex);
        } catch (e) {
          throw new apiError(400, "Invalid regex pattern");
        }
      }

      // Insert new definition
      const result = await pool.query(
        `INSERT INTO hospital.panel_attribute_definitions
        (key, category, label, description, data_type, options, validation_regex,
         validation_min_length, validation_max_length, is_required, is_unique,
         default_value, sort_order, is_active, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
        RETURNING *`,
        [
          input.key,
          input.category,
          input.label,
          input.description || null,
          input.data_type,
          input.options ? JSON.stringify(input.options) : null,
          input.validation_regex || null,
          input.validation_min_length || null,
          input.validation_max_length || null,
          input.is_required ?? false,
          input.is_unique ?? false,
          input.default_value || null,
          input.sort_order ?? 999,
          input.is_active ?? true,
        ]
      );

      // Parse JSON fields
      const definition = result.rows[0];
      if (definition.options && typeof definition.options === "string") {
        definition.options = JSON.parse(definition.options);
      }
      return definition;
    } catch (err) {
      logger.error({ err }, 'error creating panel attribute definition');
      throw err;
    }
  }

  /**
   * Update panel attribute definition
   */
  async updateDefinition(id: string, input: Partial<PanelAttributeDefinitionInput>) {
    try {
      // Check if definition exists
      const existing = await this.getDefinitionById(id);
      if (!existing) {
        throw new apiError(404, "Panel attribute definition not found");
      }

      // Validate regex if provided
      if (input.validation_regex) {
        try {
          new RegExp(input.validation_regex);
        } catch (e) {
          throw new apiError(400, "Invalid regex pattern");
        }
      }

      // Build dynamic update query
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      const allowedFields = [
        "label",
        "description",
        "category",
        "data_type",
        "options",
        "validation_regex",
        "validation_min_length",
        "validation_max_length",
        "is_required",
        "is_unique",
        "default_value",
        "sort_order",
        "is_active",
      ];

      for (const field of allowedFields) {
        if (field in input && input[field as keyof PanelAttributeDefinitionInput] !== undefined) {
          const value = input[field as keyof PanelAttributeDefinitionInput];
          // Handle JSON serialization for options
          if (field === "options" && value && typeof value === "object") {
            updates.push(`${field} = $${paramIndex}`);
            values.push(JSON.stringify(value));
          } else {
            updates.push(`${field} = $${paramIndex}`);
            values.push(value);
          }
          paramIndex++;
        }
      }

      if (updates.length === 0) {
        throw new apiError(400, "No fields to update");
      }

      updates.push(`updated_at = NOW()`);
      values.push(id);

      const query = `
        UPDATE hospital.panel_attribute_definitions
        SET ${updates.join(", ")}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        throw new apiError(404, "Panel attribute definition not found");
      }

      // Parse JSON fields
      const definition = result.rows[0];
      if (definition.options && typeof definition.options === "string") {
        definition.options = JSON.parse(definition.options);
      }
      return definition;
    } catch (err) {
      logger.error({ err }, 'error updating panel attribute definition');
      throw err;
    }
  }

  /**
   * Delete panel attribute definition
   */
  async deleteDefinition(id: string) {
    try {
      // Check if definition exists
      const existing = await this.getDefinitionById(id);
      if (!existing) {
        throw new apiError(404, "Panel attribute definition not found");
      }

      // Check for associated attributes
      const associatedCount = await pool.query(
        `SELECT COUNT(*) as count FROM hospital.panel_attributes WHERE panel_attribute_definition_id = $1`,
        [id]
      );

      if (parseInt(associatedCount.rows[0].count) > 0) {
        throw new apiError(
          422,
          `Cannot delete definition. It has ${associatedCount.rows[0].count} associated panel attributes. Deactivate instead.`
        );
      }

      // Delete the definition
      const result = await pool.query(
        `DELETE FROM hospital.panel_attribute_definitions WHERE id = $1 RETURNING *`,
        [id]
      );

      // Parse JSON fields
      const definition = result.rows[0];
      if (definition.options && typeof definition.options === "string") {
        definition.options = JSON.parse(definition.options);
      }
      return definition;
    } catch (err) {
      logger.error({ err }, 'error deleting panel attribute definition');
      throw err;
    }
  }

  /**
   * Activate panel attribute definition
   */
  async activateDefinition(id: string) {
    try {
      const result = await pool.query(
        `UPDATE hospital.panel_attribute_definitions
         SET is_active = true, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new apiError(404, "Panel attribute definition not found");
      }

      // Parse JSON fields
      const definition = result.rows[0];
      if (definition.options && typeof definition.options === "string") {
        definition.options = JSON.parse(definition.options);
      }
      return definition;
    } catch (err) {
      logger.error({ err }, 'error activating panel attribute definition');
      throw err;
    }
  }

  /**
   * Deactivate panel attribute definition
   */
  async deactivateDefinition(id: string) {
    try {
      const result = await pool.query(
        `UPDATE hospital.panel_attribute_definitions
         SET is_active = false, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new apiError(404, "Panel attribute definition not found");
      }

      // Parse JSON fields
      const definition = result.rows[0];
      if (definition.options && typeof definition.options === "string") {
        definition.options = JSON.parse(definition.options);
      }
      return definition;
    } catch (err) {
      logger.error({ err }, 'error deactivating panel attribute definition');
      throw err;
    }
  }

  /**
   * Validate key uniqueness
   */
  async validateKeyUniqueness(key: string, excludeId?: string) {
    try {
      let query = `SELECT COUNT(*) as count FROM hospital.panel_attribute_definitions WHERE key = $1`;
      const params = [key];

      if (excludeId) {
        query += ` AND id != $2`;
        params.push(excludeId);
      }

      const result = await pool.query(query, params);
      const isDuplicate = parseInt(result.rows[0].count) > 0;

      return {
        isUnique: !isDuplicate,
        message: isDuplicate ? "Key already exists" : "Key is unique",
      };
    } catch (err) {
      logger.error({ err }, 'error validating panel attribute definition key uniqueness');
      throw err;
    }
  }
}

export default new PanelAttributeDefinitionService();
