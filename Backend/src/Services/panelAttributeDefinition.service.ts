import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';

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
      console.error('Error fetching panel attribute definitions:', err);
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
      console.error('Error fetching panel attribute definition:', err);
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
      console.error('Error fetching panel attribute definition by key:', err);
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
      console.error('Error fetching definitions by category:', err);
      throw err;
    }
  }
}

export default new PanelAttributeDefinitionService();
