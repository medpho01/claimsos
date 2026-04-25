import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';

interface ValidatorProfileInput {
  userId: string;
  fullName: string;
  idType: 'aadhar' | 'pan' | 'driver_license' | 'passport';
  idNumber: string;
  phone: string;
  email: string;
  coverageStates?: string[];
  coverageCities?: string[];
  specializationCategories?: string[];
}

class ValidatorService {
  /**
   * Create or register a new validator profile
   */
  async createValidatorProfile(input: ValidatorProfileInput) {
    const {
      userId,
      fullName,
      idType,
      idNumber,
      phone,
      email,
      coverageStates = [],
      coverageCities = [],
      specializationCategories = []
    } = input;

    // Check if validator profile already exists
    const existingValidator = await pool.query(
      `SELECT id FROM validator_profiles WHERE user_id = $1`,
      [userId]
    );

    if (existingValidator.rows.length > 0) {
      throw new apiError(409, 'Validator profile already exists for this user');
    }

    // Create validator profile with pending verification status
    const result = await pool.query(
      `INSERT INTO validator_profiles (
        user_id,
        full_name,
        id_type,
        id_number,
        phone,
        email,
        coverage_states,
        coverage_cities,
        specialization_categories,
        verification_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
      RETURNING *`,
      [
        userId,
        fullName,
        idType,
        idNumber,
        phone,
        email,
        coverageStates,
        coverageCities,
        specializationCategories
      ]
    );

    return this.formatValidatorProfile(result.rows[0]);
  }

  /**
   * Get validator profile by user ID
   */
  async getValidatorProfileByUserId(userId: string) {
    const result = await pool.query(
      `SELECT * FROM validator_profiles WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Validator profile not found');
    }

    return this.formatValidatorProfile(result.rows[0]);
  }

  /**
   * Get validator profile by validator ID
   */
  async getValidatorProfile(validatorId: string) {
    const result = await pool.query(
      `SELECT vp.*,
              u.first_name, u.last_name, u.email as user_email, u.phone as user_phone
       FROM validator_profiles vp
       LEFT JOIN users u ON vp.user_id = u.id
       WHERE vp.id = $1`,
      [validatorId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Validator not found');
    }

    return this.formatValidatorProfile(result.rows[0]);
  }

  /**
   * Get all validators with optional filtering
   */
  async listValidators(
    status?: string,
    isActive?: boolean,
    page: number = 1,
    limit: number = 20
  ) {
    const offset = (page - 1) * limit;

    let query = `
      SELECT vp.*,
             u.first_name, u.last_name, u.email,
             COUNT(DISTINCT vv.id) as total_visits,
             COUNT(DISTINCT CASE WHEN vv.visit_status = 'completed' THEN vv.id END) as completed_visits
      FROM validator_profiles vp
      LEFT JOIN users u ON vp.user_id = u.id
      LEFT JOIN verification_visits vv ON vp.id = vv.validator_id
      WHERE 1=1
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND vp.verification_status = $${paramIndex++}`;
      params.push(status);
    }

    if (isActive !== undefined) {
      query += ` AND vp.is_active = $${paramIndex++}`;
      params.push(isActive);
    }

    query += ` GROUP BY vp.id, u.id`;
    query += ` ORDER BY vp.created_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM validator_profiles WHERE 1=1`;
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (status) {
      countQuery += ` AND verification_status = $${countParamIndex++}`;
      countParams.push(status);
    }

    if (isActive !== undefined) {
      countQuery += ` AND is_active = $${countParamIndex++}`;
      countParams.push(isActive);
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    return {
      validators: result.rows.map(v => this.formatValidatorProfile(v)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Update validator profile
   */
  async updateValidatorProfile(validatorId: string, updates: any) {
    const updateFields = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.fullName) {
      updateFields.push(`full_name = $${paramIndex++}`);
      values.push(updates.fullName);
    }

    if (updates.phone) {
      updateFields.push(`phone = $${paramIndex++}`);
      values.push(updates.phone);
    }

    if (updates.email) {
      updateFields.push(`email = $${paramIndex++}`);
      values.push(updates.email);
    }

    if (updates.coverageStates) {
      updateFields.push(`coverage_states = $${paramIndex++}`);
      values.push(updates.coverageStates);
    }

    if (updates.coverageCities) {
      updateFields.push(`coverage_cities = $${paramIndex++}`);
      values.push(updates.coverageCities);
    }

    if (updates.specializationCategories) {
      updateFields.push(`specialization_categories = $${paramIndex++}`);
      values.push(updates.specializationCategories);
    }

    if (updateFields.length === 0) {
      return await this.getValidatorProfile(validatorId);
    }

    updateFields.push(`updated_at = NOW()`);
    values.push(validatorId);

    const result = await pool.query(
      `UPDATE validator_profiles
       SET ${updateFields.join(', ')}
       WHERE id = $${paramIndex++}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Validator not found');
    }

    return this.formatValidatorProfile(result.rows[0]);
  }

  /**
   * Verify validator profile (superadmin action)
   */
  async verifyValidatorProfile(
    validatorId: string,
    adminId: string,
    status: 'approved' | 'rejected',
    notes?: string
  ) {
    const result = await pool.query(
      `UPDATE validator_profiles
       SET verification_status = $1,
           verification_notes = $2,
           verified_by = $3,
           verified_at = NOW(),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [status, notes || null, adminId, validatorId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Validator not found');
    }

    return this.formatValidatorProfile(result.rows[0]);
  }

  /**
   * Get validators available for a hospital location
   */
  async getAvailableValidators(
    hospitalId: string,
    state: string,
    city: string
  ) {
    const result = await pool.query(
      `SELECT vp.*
       FROM validator_profiles vp
       WHERE vp.verification_status = 'approved'
       AND vp.is_active = true
       AND ($1 = ANY(vp.coverage_states) OR array_length(vp.coverage_states, 1) IS NULL)
       AND ($2 = ANY(vp.coverage_cities) OR array_length(vp.coverage_cities, 1) IS NULL)
       ORDER BY vp.completed_visits DESC, vp.created_at ASC`,
      [state, city]
    );

    return result.rows.map(v => this.formatValidatorProfile(v));
  }

  /**
   * Get validator performance metrics
   */
  async getValidatorPerformanceMetrics(validatorId: string) {
    const result = await pool.query(
      `SELECT
        vp.id,
        vp.full_name,
        vp.total_visits,
        vp.completed_visits,
        vp.average_rating,
        COUNT(DISTINCT av.id) as total_attributes_verified,
        COUNT(DISTINCT CASE WHEN av.verification_result = 'verified' THEN av.id END) as attributes_fully_verified,
        COUNT(DISTINCT CASE WHEN av.verification_result = 'partially_verified' THEN av.id END) as attributes_partially_verified,
        COUNT(DISTINCT CASE WHEN av.verification_result = 'not_verified' THEN av.id END) as attributes_not_verified,
        AVG(av.confidence_level) as average_confidence_level,
        COUNT(DISTINCT vn.id) as total_notes_created
       FROM validator_profiles vp
       LEFT JOIN verification_visits vv ON vp.id = vv.validator_id
       LEFT JOIN attribute_verifications av ON vv.id = av.visit_id
       LEFT JOIN verification_notes vn ON av.id = vn.attribute_verification_id
       WHERE vp.id = $1
       GROUP BY vp.id, vp.full_name, vp.total_visits, vp.completed_visits, vp.average_rating`,
      [validatorId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Validator not found');
    }

    return result.rows[0];
  }

  /**
   * Suspend validator account (admin action)
   */
  async suspendValidator(validatorId: string, reason: string) {
    const result = await pool.query(
      `UPDATE validator_profiles
       SET verification_status = 'suspended',
           verification_notes = $1,
           is_active = false,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [reason, validatorId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Validator not found');
    }

    return this.formatValidatorProfile(result.rows[0]);
  }

  /**
   * Format validator profile response
   */
  private formatValidatorProfile(raw: any) {
    return {
      id: raw.id,
      userId: raw.user_id,
      fullName: raw.full_name,
      idType: raw.id_type,
      idNumber: raw.id_number,
      phone: raw.phone,
      email: raw.email,
      coverageStates: raw.coverage_states || [],
      coverageCities: raw.coverage_cities || [],
      specializationCategories: raw.specialization_categories || [],
      verificationStatus: raw.verification_status,
      verificationNotes: raw.verification_notes,
      verifiedBy: raw.verified_by,
      verifiedAt: raw.verified_at,
      totalVisits: raw.total_visits || 0,
      completedVisits: raw.completed_visits || 0,
      pendingReviews: raw.pending_reviews || 0,
      averageRating: raw.average_rating,
      isActive: raw.is_active,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at
    };
  }
}

export default new ValidatorService();
