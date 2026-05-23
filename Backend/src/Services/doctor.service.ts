import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';

interface DoctorRegistrationInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  primarySpecialization?: string;
  secondarySpecializations?: string[];
  nmcRegistrationNumber?: string;
  stateRegistrationNumber?: string;
}

interface DoctorUpdateInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  primarySpecialization?: string;
  secondarySpecializations?: string[];
  nmcRegistrationNumber?: string;
  stateRegistrationNumber?: string;
  profilePhotoUrl?: string;
  isPublicProfileEnabled?: boolean;
}

class DoctorService {
  /**
   * Register a new doctor (self-registration)
   */
  async registerDoctor(input: DoctorRegistrationInput, userId?: string) {
    const {
      firstName,
      lastName,
      email,
      phone,
      primarySpecialization,
      secondarySpecializations = [],
      nmcRegistrationNumber,
      stateRegistrationNumber
    } = input;

    // Check if email already exists
    const existingDoctorRes = await pool.query(
      `SELECT id FROM doctors WHERE email = $1`,
      [email]
    );

    if (existingDoctorRes.rows.length > 0) {
      throw new apiError(409, 'Email already registered');
    }

    // Create doctor profile
    const result = await pool.query(
      `INSERT INTO doctors (
        first_name,
        last_name,
        email,
        phone,
        primary_specialization,
        secondary_specializations,
        nmc_registration_number,
        state_registration_number,
        registration_status,
        registration_method,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        firstName,
        lastName,
        email,
        phone || null,
        primarySpecialization || null,
        secondarySpecializations,
        nmcRegistrationNumber || null,
        stateRegistrationNumber || null,
        userId ? 'active' : 'pending_verification',
        userId ? 'self_registered' : 'admin_created',
        userId || null
      ]
    );

    return this.formatDoctorResponse(result.rows[0]);
  }

  /**
   * Get doctor profile by ID
   */
  async getDoctorProfile(doctorId: string) {
    const result = await pool.query(
      `SELECT * FROM doctors WHERE id = $1`,
      [doctorId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Doctor not found');
    }

    return this.formatDoctorResponse(result.rows[0]);
  }

  /**
   * Get doctor profile with all attributes
   */
  async getDoctorProfileWithAttributes(doctorId: string) {
    const doctorRes = await pool.query(
      `SELECT * FROM doctors WHERE id = $1`,
      [doctorId]
    );

    if (doctorRes.rows.length === 0) {
      throw new apiError(404, 'Doctor not found');
    }

    const doctor = doctorRes.rows[0];

    // Get all attributes
    const attributesRes = await pool.query(
      `SELECT da.*, dad.label, dad.category, dad.data_type
       FROM doctor_attributes da
       LEFT JOIN doctor_attribute_definitions dad ON da.attribute_key = dad.key
       WHERE da.doctor_id = $1
       ORDER BY dad.category, dad.sort_order`,
      [doctorId]
    );

    return {
      ...this.formatDoctorResponse(doctor),
      attributes: attributesRes.rows.map(attr => ({
        id: attr.id,
        attributeKey: attr.attribute_key,
        label: attr.label,
        category: attr.category,
        dataType: attr.data_type,
        valueText: attr.value_text,
        valueDate: attr.value_date,
        valueBoolean: attr.value_boolean,
        certificateNumber: attr.certificate_number,
        issuingAuthority: attr.issuing_authority,
        issuedAt: attr.issued_at,
        expiresAt: attr.expires_at,
        verificationStatus: attr.verification_status,
        verificationMethod: attr.verification_method,
        verificationNotes: attr.verification_notes,
        createdAt: attr.created_at,
        updatedAt: attr.updated_at
      }))
    };
  }

  /**
   * Search for doctors
   */
  async searchDoctors(
    query?: string,
    specialization?: string,
    nmcNumber?: string,
    page: number = 1,
    limit: number = 20
  ) {
    const offset = (page - 1) * limit;

    let sqlQuery = `
      SELECT * FROM doctors WHERE is_public_profile_enabled = true OR registration_status = 'active'
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (query) {
      sqlQuery += ` AND (first_name ILIKE $${paramIndex} OR last_name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      params.push(`%${query}%`);
      paramIndex++;
    }

    if (specialization) {
      sqlQuery += ` AND (primary_specialization ILIKE $${paramIndex} OR $${paramIndex} = ANY(secondary_specializations))`;
      params.push(`%${specialization}%`);
      paramIndex++;
    }

    if (nmcNumber) {
      sqlQuery += ` AND nmc_registration_number = $${paramIndex}`;
      params.push(nmcNumber);
      paramIndex++;
    }

    sqlQuery += ` ORDER BY first_name, last_name`;
    sqlQuery += ` LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);

    const result = await pool.query(sqlQuery, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM doctors WHERE is_public_profile_enabled = true OR registration_status = 'active'`;
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (query) {
      countQuery += ` AND (first_name ILIKE $${countParamIndex} OR last_name ILIKE $${countParamIndex} OR email ILIKE $${countParamIndex})`;
      countParams.push(`%${query}%`);
      countParamIndex++;
    }

    if (specialization) {
      countQuery += ` AND (primary_specialization ILIKE $${countParamIndex} OR $${countParamIndex} = ANY(secondary_specializations))`;
      countParams.push(`%${specialization}%`);
      countParamIndex++;
    }

    if (nmcNumber) {
      countQuery += ` AND nmc_registration_number = $${countParamIndex}`;
      countParams.push(nmcNumber);
      countParamIndex++;
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    return {
      doctors: result.rows.map(d => this.formatDoctorResponse(d)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Get hospital's doctors
   */
  async getHospitalDoctors(hospitalId: string, page: number = 1, limit: number = 50) {
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT hd.*, d.*
       FROM hospital_doctors hd
       JOIN doctors d ON hd.doctor_id = d.id
       WHERE hd.hospital_id = $1 AND hd.status = 'active'
       ORDER BY d.first_name, d.last_name
       LIMIT $2 OFFSET $3`,
      [hospitalId, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM hospital_doctors WHERE hospital_id = $1 AND status = 'active'`,
      [hospitalId]
    );

    const total = parseInt(countResult.rows[0].total);

    return {
      doctors: result.rows.map(row => ({
        ...this.formatDoctorResponse(row),
        hospitalDoctorId: row.id,
        employmentType: row.employment_type,
        department: row.department,
        designation: row.designation,
        startDate: row.start_date,
        endDate: row.end_date,
        hospitalStatus: row.status,
        employeeId: row.employee_id,
        hospitalPhone: row.hospital_phone,
        hospitalEmail: row.hospital_email
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Update doctor profile
   */
  async updateDoctor(doctorId: string, updates: DoctorUpdateInput) {
    const updateFields = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.firstName) {
      updateFields.push(`first_name = $${paramIndex++}`);
      values.push(updates.firstName);
    }

    if (updates.lastName) {
      updateFields.push(`last_name = $${paramIndex++}`);
      values.push(updates.lastName);
    }

    if (updates.email !== undefined) {
      updateFields.push(`email = $${paramIndex++}`);
      values.push(updates.email);
    }

    if (updates.phone !== undefined) {
      updateFields.push(`phone = $${paramIndex++}`);
      values.push(updates.phone);
    }

    if (updates.primarySpecialization !== undefined) {
      updateFields.push(`primary_specialization = $${paramIndex++}`);
      values.push(updates.primarySpecialization);
    }

    if (updates.secondarySpecializations !== undefined) {
      updateFields.push(`secondary_specializations = $${paramIndex++}`);
      values.push(updates.secondarySpecializations);
    }

    if (updates.nmcRegistrationNumber !== undefined) {
      updateFields.push(`nmc_registration_number = $${paramIndex++}`);
      values.push(updates.nmcRegistrationNumber);
    }

    if (updates.stateRegistrationNumber !== undefined) {
      updateFields.push(`state_registration_number = $${paramIndex++}`);
      values.push(updates.stateRegistrationNumber);
    }

    if (updates.profilePhotoUrl !== undefined) {
      updateFields.push(`profile_photo_url = $${paramIndex++}`);
      values.push(updates.profilePhotoUrl);
    }

    if (updates.isPublicProfileEnabled !== undefined) {
      updateFields.push(`is_public_profile_enabled = $${paramIndex++}`);
      values.push(updates.isPublicProfileEnabled);
    }

    if (updateFields.length === 0) {
      return await this.getDoctorProfile(doctorId);
    }

    updateFields.push(`updated_at = NOW()`);
    values.push(doctorId);

    const result = await pool.query(
      `UPDATE doctors
       SET ${updateFields.join(', ')}
       WHERE id = $${paramIndex++}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Doctor not found');
    }

    return this.formatDoctorResponse(result.rows[0]);
  }

  /**
   * Verify doctor registration (superadmin action)
   */
  async verifyDoctor(doctorId: string, adminId: string) {
    const result = await pool.query(
      `UPDATE doctors
       SET registration_status = 'active',
           verified_by = $1,
           verified_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND registration_status = 'pending_verification'
       RETURNING *`,
      [adminId, doctorId]
    );

    if (result.rows.length === 0) {
      throw new apiError(400, 'Doctor not found or already verified');
    }

    return this.formatDoctorResponse(result.rows[0]);
  }

  /**
   * Suspend doctor account
   */
  async suspendDoctor(doctorId: string, reason: string) {
    const result = await pool.query(
      `UPDATE doctors
       SET registration_status = 'suspended',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [doctorId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Doctor not found');
    }

    return this.formatDoctorResponse(result.rows[0]);
  }

  /**
   * List all doctors (admin)
   */
  async listDoctors(
    status?: string,
    page: number = 1,
    limit: number = 20
  ) {
    const offset = (page - 1) * limit;

    let query = `SELECT * FROM doctors WHERE 1=1`;
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND registration_status = $${paramIndex++}`;
      params.push(status);
    }

    query += ` ORDER BY created_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM doctors WHERE 1=1`;
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (status) {
      countQuery += ` AND registration_status = $${countParamIndex++}`;
      countParams.push(status);
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    return {
      doctors: result.rows.map(d => this.formatDoctorResponse(d)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Generate share link for doctor profile
   */
  async generateShareLink(doctorId: string, userId: string, expiresInDays?: number) {
    // Verify doctor exists
    const doctor = await pool.query('SELECT id FROM hospital.doctors WHERE id = $1', [doctorId]);
    if (doctor.rows.length === 0) {
      throw new Error('Doctor not found');
    }

    // Generate random token
    const crypto = await import('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null;

    const result = await pool.query(
      `INSERT INTO hospital.doctor_share_tokens
       (token, doctor_id, is_active, expires_at, created_by)
       VALUES ($1, $2, true, $3, $4)
       RETURNING *`,
      [token, doctorId, expiresAt, userId]
    );

    const shareToken = result.rows[0];
    const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5001';

    return {
      id: shareToken.id,
      token: shareToken.token,
      shareUrl: `${baseUrl}/public-doctor/${token}`,
      isActive: shareToken.is_active,
      expiresAt: shareToken.expires_at,
      maxViews: shareToken.max_views,
      viewCount: shareToken.view_count,
      lastViewedAt: shareToken.last_viewed_at,
      createdAt: shareToken.created_at
    };
  }

  /**
   * Get share links for doctor
   */
  async getShareLinks(doctorId: string, userId: string) {
    // Verify doctor exists
    const doctor = await pool.query('SELECT id FROM hospital.doctors WHERE id = $1', [doctorId]);
    if (doctor.rows.length === 0) {
      throw new Error('Doctor not found');
    }

    const result = await pool.query(
      `SELECT * FROM hospital.doctor_share_tokens
       WHERE doctor_id = $1
       ORDER BY created_at DESC`,
      [doctorId]
    );

    const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5001';

    return result.rows.map(token => ({
      id: token.id,
      token: token.token,
      shareUrl: `${baseUrl}/public-doctor/${token.token}`,
      isActive: token.is_active,
      expiresAt: token.expires_at,
      isExpired: token.expires_at ? new Date(token.expires_at) < new Date() : false,
      maxViews: token.max_views,
      viewCount: token.view_count,
      lastViewedAt: token.last_viewed_at,
      createdAt: token.created_at
    }));
  }

  /**
   * Revoke share link
   */
  async revokeShareLink(doctorId: string, linkId: string, userId: string) {
    const result = await pool.query(
      `DELETE FROM hospital.doctor_share_tokens
       WHERE id = $1 AND doctor_id = $2
       RETURNING id`,
      [linkId, doctorId]
    );

    if (result.rows.length === 0) {
      throw new Error('Share link not found');
    }

    return true;
  }

  /**
   * Access public profile via share token
   */
  async accessPublicProfile(token: string) {
    // Get share token
    const tokenRes = await pool.query(
      `SELECT * FROM hospital.doctor_share_tokens
       WHERE token = $1 AND is_active = true`,
      [token]
    );

    if (tokenRes.rows.length === 0) {
      throw new Error('Share link not found or inactive');
    }

    const shareToken = tokenRes.rows[0];

    // Check expiry
    if (shareToken.expires_at && new Date(shareToken.expires_at) < new Date()) {
      throw new Error('Share link has expired');
    }

    // Check max views
    if (shareToken.max_views && shareToken.view_count >= shareToken.max_views) {
      throw new Error('Share link view limit reached');
    }

    // Get doctor profile with attributes
    const profile = await this.getDoctorProfileWithAttributes(shareToken.doctor_id);

    // Update view count and last accessed
    await pool.query(
      `UPDATE hospital.doctor_share_tokens
       SET view_count = view_count + 1, last_viewed_at = NOW()
       WHERE id = $1`,
      [shareToken.id]
    );

    return profile;
  }

  /**
   * Get public doctor directory (filtered)
   */
  async getPublicDirectory(query?: string, specialization?: string, status?: string, page: number = 1, limit: number = 12) {
    const offset = (page - 1) * limit;
    const params = [];
    let paramIndex = 1;
    let whereClause = 'WHERE is_public_profile_enabled = true AND registration_status = $1';
    params.push('active');
    paramIndex++;

    if (query) {
      whereClause += ` AND (first_name ILIKE $${paramIndex} OR last_name ILIKE $${paramIndex} OR nmc_registration_number ILIKE $${paramIndex})`;
      params.push(`%${query}%`);
      paramIndex++;
    }

    if (specialization) {
      whereClause += ` AND primary_specialization = $${paramIndex}`;
      params.push(specialization);
      paramIndex++;
    }

    if (status) {
      whereClause += ` AND registration_status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    // Get doctors
    const result = await pool.query(
      `SELECT * FROM hospital.doctors
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM hospital.doctors ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    return {
      doctors: result.rows.map(d => this.formatDoctorResponse(d)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Format doctor response
   */
  private formatDoctorResponse(raw: any) {
    return {
      id: raw.id,
      firstName: raw.first_name,
      lastName: raw.last_name,
      fullName: `${raw.first_name} ${raw.last_name}`,
      email: raw.email,
      phone: raw.phone,
      profilePhotoUrl: raw.profile_photo_url,
      nmcRegistrationNumber: raw.nmc_registration_number,
      stateRegistrationNumber: raw.state_registration_number,
      primarySpecialization: raw.primary_specialization,
      secondarySpecializations: raw.secondary_specializations || [],
      registrationStatus: raw.registration_status,
      registrationMethod: raw.registration_method,
      verifiedBy: raw.verified_by,
      verifiedAt: raw.verified_at,
      isPublicProfileEnabled: raw.is_public_profile_enabled,
      createdBy: raw.created_by,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at
    };
  }
}

export default new DoctorService();
