import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';

interface CreateDefinitionInput {
  key: string;
  label: string;
  category: string;
  description?: string;
  dataType: string;
  isRequired?: boolean;
  hasExpiry?: boolean;
  requiresDocument?: boolean;
  canVerifyByDocument?: boolean;
  sortOrder?: number;
  categorySortOrder?: number;
  requiresValidatorVerification?: boolean;
  autoVerifiable?: boolean;
  verificationUrlPattern?: string;
}

interface UpdateDefinitionInput {
  label?: string;
  description?: string;
  dataType?: string;
  isRequired?: boolean;
  hasExpiry?: boolean;
  requiresDocument?: boolean;
  canVerifyByDocument?: boolean;
  sortOrder?: number;
  categorySortOrder?: number;
  isActive?: boolean;
  requiresValidatorVerification?: boolean;
  autoVerifiable?: boolean;
  verificationUrlPattern?: string;
}

class DoctorAttributeDefinitionService {
  /**
   * Create new attribute definition
   */
  async createDefinition(input: CreateDefinitionInput, createdByUserId: string) {
    const {
      key,
      label,
      category,
      description,
      dataType,
      isRequired = false,
      hasExpiry = false,
      requiresDocument = false,
      canVerifyByDocument = true,
      sortOrder = 999,
      categorySortOrder = 999,
      requiresValidatorVerification = false,
      autoVerifiable = false,
      verificationUrlPattern
    } = input;

    // Check if key already exists
    const existingRes = await pool.query(
      `SELECT id FROM doctor_attribute_definitions WHERE key = $1`,
      [key]
    );

    if (existingRes.rows.length > 0) {
      throw new apiError(409, 'Attribute definition with this key already exists');
    }

    const result = await pool.query(
      `INSERT INTO doctor_attribute_definitions (
        key,
        label,
        category,
        description,
        data_type,
        is_required,
        has_expiry,
        requires_document,
        can_verify_by_document,
        sort_order,
        category_sort_order,
        requires_validator_verification,
        auto_verifiable,
        verification_url_pattern,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        key,
        label,
        category,
        description || null,
        dataType,
        isRequired,
        hasExpiry,
        requiresDocument,
        canVerifyByDocument,
        sortOrder,
        categorySortOrder,
        requiresValidatorVerification,
        autoVerifiable,
        verificationUrlPattern || null,
        createdByUserId
      ]
    );

    return this.formatDefinitionResponse(result.rows[0]);
  }

  /**
   * Get all attribute definitions
   */
  async getAllDefinitions(category?: string, isActive: boolean = true) {
    let query = `SELECT * FROM doctor_attribute_definitions WHERE is_active = $1`;
    const params: any[] = [isActive];
    let paramIndex = 2;

    if (category) {
      query += ` AND category = $${paramIndex++}`;
      params.push(category);
    }

    query += ` ORDER BY category, sort_order`;

    const result = await pool.query(query, params);

    return result.rows.map(def => this.formatDefinitionResponse(def));
  }

  /**
   * Get definitions grouped by category
   */
  async getDefinitionsByCategory(isActive: boolean = true) {
    const result = await pool.query(
      `SELECT * FROM doctor_attribute_definitions
       WHERE is_active = $1
       ORDER BY category, category_sort_order, sort_order`,
      [isActive]
    );

    // Group by category
    const grouped: Record<string, any[]> = {};
    result.rows.forEach(def => {
      if (!grouped[def.category]) {
        grouped[def.category] = [];
      }
      grouped[def.category].push(this.formatDefinitionResponse(def));
    });

    return grouped;
  }

  /**
   * Get single definition by key
   */
  async getDefinitionByKey(key: string) {
    const result = await pool.query(
      `SELECT * FROM doctor_attribute_definitions WHERE key = $1`,
      [key]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute definition not found');
    }

    return this.formatDefinitionResponse(result.rows[0]);
  }

  /**
   * Get single definition by ID
   */
  async getDefinition(id: string) {
    const result = await pool.query(
      `SELECT * FROM doctor_attribute_definitions WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute definition not found');
    }

    return this.formatDefinitionResponse(result.rows[0]);
  }

  /**
   * Update definition
   */
  async updateDefinition(id: string, updates: UpdateDefinitionInput, updatedByUserId: string) {
    const updateFields = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.label) {
      updateFields.push(`label = $${paramIndex++}`);
      values.push(updates.label);
    }

    if (updates.description !== undefined) {
      updateFields.push(`description = $${paramIndex++}`);
      values.push(updates.description);
    }

    if (updates.dataType) {
      updateFields.push(`data_type = $${paramIndex++}`);
      values.push(updates.dataType);
    }

    if (updates.isRequired !== undefined) {
      updateFields.push(`is_required = $${paramIndex++}`);
      values.push(updates.isRequired);
    }

    if (updates.hasExpiry !== undefined) {
      updateFields.push(`has_expiry = $${paramIndex++}`);
      values.push(updates.hasExpiry);
    }

    if (updates.requiresDocument !== undefined) {
      updateFields.push(`requires_document = $${paramIndex++}`);
      values.push(updates.requiresDocument);
    }

    if (updates.canVerifyByDocument !== undefined) {
      updateFields.push(`can_verify_by_document = $${paramIndex++}`);
      values.push(updates.canVerifyByDocument);
    }

    if (updates.sortOrder !== undefined) {
      updateFields.push(`sort_order = $${paramIndex++}`);
      values.push(updates.sortOrder);
    }

    if (updates.categorySortOrder !== undefined) {
      updateFields.push(`category_sort_order = $${paramIndex++}`);
      values.push(updates.categorySortOrder);
    }

    if (updates.isActive !== undefined) {
      updateFields.push(`is_active = $${paramIndex++}`);
      values.push(updates.isActive);
    }

    if (updates.requiresValidatorVerification !== undefined) {
      updateFields.push(`requires_validator_verification = $${paramIndex++}`);
      values.push(updates.requiresValidatorVerification);
    }

    if (updates.autoVerifiable !== undefined) {
      updateFields.push(`auto_verifiable = $${paramIndex++}`);
      values.push(updates.autoVerifiable);
    }

    if (updates.verificationUrlPattern !== undefined) {
      updateFields.push(`verification_url_pattern = $${paramIndex++}`);
      values.push(updates.verificationUrlPattern);
    }

    if (updateFields.length === 0) {
      return await this.getDefinition(id);
    }

    updateFields.push(`updated_by = $${paramIndex++}`);
    updateFields.push(`updated_at = NOW()`);
    values.push(updatedByUserId);
    values.push(id);

    const result = await pool.query(
      `UPDATE doctor_attribute_definitions
       SET ${updateFields.join(', ')}
       WHERE id = $${paramIndex++}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute definition not found');
    }

    return this.formatDefinitionResponse(result.rows[0]);
  }

  /**
   * Deactivate definition (soft delete)
   */
  async deactivateDefinition(id: string, updatedByUserId: string) {
    const result = await pool.query(
      `UPDATE doctor_attribute_definitions
       SET is_active = false,
           updated_by = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [updatedByUserId, id]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute definition not found');
    }

    return this.formatDefinitionResponse(result.rows[0]);
  }

  /**
   * Get definition statistics (for superadmin)
   */
  async getDefinitionStats() {
    const result = await pool.query(
      `SELECT
        category,
        COUNT(*) as total,
        COUNT(CASE WHEN is_active = true THEN 1 END) as active,
        COUNT(CASE WHEN is_required = true THEN 1 END) as required_count,
        COUNT(CASE WHEN has_expiry = true THEN 1 END) as has_expiry_count
       FROM doctor_attribute_definitions
       GROUP BY category
       ORDER BY category`
    );

    return result.rows.map(stat => ({
      category: stat.category,
      totalDefinitions: parseInt(stat.total),
      activeDefinitions: parseInt(stat.active),
      requiredFields: parseInt(stat.required_count),
      fieldsWithExpiry: parseInt(stat.has_expiry_count)
    }));
  }

  /**
   * Format definition response
   */
  private formatDefinitionResponse(raw: any) {
    return {
      id: raw.id,
      key: raw.key,
      label: raw.label,
      category: raw.category,
      description: raw.description,
      dataType: raw.data_type,
      isRequired: raw.is_required,
      hasExpiry: raw.has_expiry,
      requiresDocument: raw.requires_document,
      canVerifyByDocument: raw.can_verify_by_document,
      sortOrder: raw.sort_order,
      categorySortOrder: raw.category_sort_order,
      isActive: raw.is_active,
      requiresValidatorVerification: raw.requires_validator_verification,
      autoVerifiable: raw.auto_verifiable,
      verificationUrlPattern: raw.verification_url_pattern,
      createdBy: raw.created_by,
      updatedBy: raw.updated_by,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at
    };
  }
}

export default new DoctorAttributeDefinitionService();
