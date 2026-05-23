import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';
import ValidatorService from './validator.service.js';

interface CreateVisitInput {
  hospitalId: string;
  validatorId: string;
  scheduledDate: string;
  scheduledTime?: string;
  visitNotes?: string;
}

interface UpdateVisitInput {
  visitStatus?: string;
  visitNotes?: string;
  actualStartTime?: string;
  actualEndTime?: string;
  locationVerified?: boolean;
  validatorSelfieUrl?: string;
  documentsReviewed?: number;
  photoCount?: number;
  verificationCoverage?: string;
}

class VerificationVisitService {
  /**
   * Create a new verification visit (schedule validator to hospital)
   */
  async createVerificationVisit(input: CreateVisitInput) {
    const {
      hospitalId,
      validatorId,
      scheduledDate,
      scheduledTime,
      visitNotes
    } = input;

    // Verify hospital exists
    const hospitalRes = await pool.query(
      `SELECT id FROM hospital.hospitals WHERE id = $1`,
      [hospitalId]
    );

    if (hospitalRes.rows.length === 0) {
      throw new apiError(404, 'Hospital not found');
    }

    // Verify validator exists and is approved
    const validatorRes = await pool.query(
      `SELECT id FROM validator_profiles
       WHERE id = $1 AND verification_status = 'approved' AND is_active = true`,
      [validatorId]
    );

    if (validatorRes.rows.length === 0) {
      throw new apiError(404, 'Validator not found or not approved');
    }

    // Create visit
    const result = await pool.query(
      `INSERT INTO verification_visits (
        hospital_id,
        validator_id,
        scheduled_date,
        scheduled_time,
        visit_notes,
        visit_status
      ) VALUES ($1, $2, $3, $4, $5, 'scheduled')
      RETURNING *`,
      [hospitalId, validatorId, scheduledDate, scheduledTime || null, visitNotes || null]
    );

    return this.formatVisitResponse(result.rows[0]);
  }

  /**
   * Get visit by ID with details
   */
  async getVisit(visitId: string) {
    const result = await pool.query(
      `SELECT vv.*,
              h.name as hospital_name,
              h.city as hospital_city,
              h.state as hospital_state,
              vp.full_name as validator_name,
              vp.email as validator_email,
              vp.phone as validator_phone
       FROM verification_visits vv
       LEFT JOIN hospital.hospitals h ON vv.hospital_id = h.id
       LEFT JOIN validator_profiles vp ON vv.validator_id = vp.id
       WHERE vv.id = $1`,
      [visitId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Visit not found');
    }

    return this.formatVisitResponse(result.rows[0]);
  }

  /**
   * List visits with filtering
   */
  async listVisits(
    hospitalId?: string,
    validatorId?: string,
    status?: string,
    fromDate?: string,
    toDate?: string,
    page: number = 1,
    limit: number = 20
  ) {
    const offset = (page - 1) * limit;

    let query = `
      SELECT vv.*,
             h.name as hospital_name,
             h.city as hospital_city,
             vp.full_name as validator_name,
             COUNT(av.id) as attribute_count
      FROM verification_visits vv
      LEFT JOIN hospital.hospitals h ON vv.hospital_id = h.id
      LEFT JOIN validator_profiles vp ON vv.validator_id = vp.id
      LEFT JOIN attribute_verifications av ON vv.id = av.visit_id
      WHERE 1=1
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (hospitalId) {
      query += ` AND vv.hospital_id = $${paramIndex++}`;
      params.push(hospitalId);
    }

    if (validatorId) {
      query += ` AND vv.validator_id = $${paramIndex++}`;
      params.push(validatorId);
    }

    if (status) {
      query += ` AND vv.visit_status = $${paramIndex++}`;
      params.push(status);
    }

    if (fromDate) {
      query += ` AND vv.scheduled_date >= $${paramIndex++}`;
      params.push(fromDate);
    }

    if (toDate) {
      query += ` AND vv.scheduled_date <= $${paramIndex++}`;
      params.push(toDate);
    }

    query += ` GROUP BY vv.id, h.id, vp.id`;
    query += ` ORDER BY vv.scheduled_date DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM verification_visits WHERE 1=1`;
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (hospitalId) {
      countQuery += ` AND hospital_id = $${countParamIndex++}`;
      countParams.push(hospitalId);
    }

    if (validatorId) {
      countQuery += ` AND validator_id = $${countParamIndex++}`;
      countParams.push(validatorId);
    }

    if (status) {
      countQuery += ` AND visit_status = $${countParamIndex++}`;
      countParams.push(status);
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    return {
      visits: result.rows.map(v => this.formatVisitResponse(v)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Start a visit (validator marks as in progress)
   */
  async startVisit(visitId: string) {
    const result = await pool.query(
      `UPDATE verification_visits
       SET visit_status = 'in_progress',
           actual_start_time = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND visit_status = 'scheduled'
       RETURNING *`,
      [visitId]
    );

    if (result.rows.length === 0) {
      throw new apiError(400, 'Visit not found or cannot be started');
    }

    return this.formatVisitResponse(result.rows[0]);
  }

  /**
   * Complete a visit (validator marks as complete)
   */
  async completeVisit(visitId: string, updates: UpdateVisitInput) {
    const updateFields = ['visit_status = $1', 'actual_end_time = NOW()', 'updated_at = NOW()'];
    const values: any[] = ['completed'];
    let paramIndex = 2;

    if (updates.visitNotes) {
      updateFields.push(`visit_notes = $${paramIndex++}`);
      values.push(updates.visitNotes);
    }

    if (updates.validatorSelfieUrl) {
      updateFields.push(`validator_selfie_url = $${paramIndex++}`);
      values.push(updates.validatorSelfieUrl);
    }

    if (updates.documentsReviewed !== undefined) {
      updateFields.push(`documents_reviewed = $${paramIndex++}`);
      values.push(updates.documentsReviewed);
    }

    if (updates.photoCount !== undefined) {
      updateFields.push(`photo_count = $${paramIndex++}`);
      values.push(updates.photoCount);
    }

    if (updates.verificationCoverage) {
      updateFields.push(`verification_coverage = $${paramIndex++}`);
      values.push(updates.verificationCoverage);
    }

    if (updates.locationVerified !== undefined) {
      updateFields.push(`location_verified = $${paramIndex++}`);
      values.push(updates.locationVerified);
    }

    values.push(visitId);

    const result = await pool.query(
      `UPDATE verification_visits
       SET ${updateFields.join(', ')}
       WHERE id = $${paramIndex++} AND visit_status = 'in_progress'
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new apiError(400, 'Visit not found or cannot be completed');
    }

    const visitData = result.rows[0];

    // Update validator stats
    await pool.query(
      `UPDATE validator_profiles
       SET total_visits = total_visits + 1,
           completed_visits = completed_visits + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [visitData.validator_id]
    );

    return this.formatVisitResponse(visitData);
  }

  /**
   * Cancel a visit
   */
  async cancelVisit(visitId: string, reason?: string) {
    const result = await pool.query(
      `UPDATE verification_visits
       SET visit_status = 'cancelled',
           visit_notes = CASE WHEN $1::TEXT IS NOT NULL THEN $1 ELSE visit_notes END,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [reason || null, visitId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Visit not found');
    }

    return this.formatVisitResponse(result.rows[0]);
  }

  /**
   * Update visit for admin review
   */
  async updateVisitReview(
    visitId: string,
    reviewStatus: 'approved' | 'needs_revision' | 'rejected',
    adminId: string,
    notes?: string
  ) {
    const result = await pool.query(
      `UPDATE verification_visits
       SET admin_review_status = $1,
           admin_notes = $2,
           reviewed_by = $3,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [reviewStatus, notes || null, adminId, visitId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Visit not found');
    }

    return this.formatVisitResponse(result.rows[0]);
  }

  /**
   * Get visit summary with attribute verifications
   */
  async getVisitSummary(visitId: string) {
    const visit = await this.getVisit(visitId);

    // Get all attribute verifications for this visit
    const attributesRes = await pool.query(
      `SELECT av.*,
              ha.attribute_key,
              ad.label as attribute_label,
              ad.category
       FROM attribute_verifications av
       LEFT JOIN hospital.hospital_attributes ha ON av.hospital_attribute_id = ha.id
       LEFT JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
       WHERE av.visit_id = $1
       ORDER BY ad.category, ad.label`,
      [visitId]
    );

    return {
      visit,
      attributeVerifications: attributesRes.rows.map(av => ({
        id: av.id,
        attributeKey: av.attribute_key,
        attributeLabel: av.attribute_label,
        category: av.category,
        verificationResult: av.verification_result,
        confidenceLevel: av.confidence_level,
        attributeValueFound: av.attribute_value_found,
        attributeValueClaimed: av.attribute_value_claimed,
        discrepancyNotes: av.discrepancy_notes,
        adminReviewStatus: av.admin_review_status,
        adminNotes: av.admin_notes,
        createdAt: av.created_at
      })),
      summary: {
        totalAttributesVerified: attributesRes.rows.length,
        fullyVerified: attributesRes.rows.filter(a => a.verification_result === 'verified').length,
        partiallyVerified: attributesRes.rows.filter(a => a.verification_result === 'partially_verified').length,
        notVerified: attributesRes.rows.filter(a => a.verification_result === 'not_verified').length,
        inconclusive: attributesRes.rows.filter(a => a.verification_result === 'inconclusive').length,
        averageConfidenceLevel: attributesRes.rows.length > 0
          ? Math.round(attributesRes.rows.reduce((sum, a) => sum + (a.confidence_level || 0), 0) / attributesRes.rows.length)
          : 0
      }
    };
  }

  /**
   * Get visits pending admin review
   */
  async getVisitsPendingReview(page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT vv.*,
              h.name as hospital_name,
              h.city,
              vp.full_name as validator_name,
              COUNT(av.id) as attribute_count
       FROM verification_visits vv
       LEFT JOIN hospital.hospitals h ON vv.hospital_id = h.id
       LEFT JOIN validator_profiles vp ON vv.validator_id = vp.id
       LEFT JOIN attribute_verifications av ON vv.id = av.visit_id
       WHERE vv.admin_review_status = 'pending' AND vv.visit_status = 'completed'
       GROUP BY vv.id, h.id, vp.id
       ORDER BY vv.updated_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM verification_visits
       WHERE admin_review_status = 'pending' AND visit_status = 'completed'`
    );

    const total = parseInt(countResult.rows[0].total);

    return {
      visits: result.rows.map(v => this.formatVisitResponse(v)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Format visit response
   */
  private formatVisitResponse(raw: any) {
    return {
      id: raw.id,
      hospitalId: raw.hospital_id,
      hospitalName: raw.hospital_name,
      hospitalCity: raw.hospital_city,
      validatorId: raw.validator_id,
      validatorName: raw.validator_name,
      validatorEmail: raw.validator_email,
      validatorPhone: raw.validator_phone,
      visitStatus: raw.visit_status,
      scheduledDate: raw.scheduled_date,
      scheduledTime: raw.scheduled_time,
      actualStartTime: raw.actual_start_time,
      actualEndTime: raw.actual_end_time,
      visitNotes: raw.visit_notes,
      locationVerified: raw.location_verified,
      validatorSelfieUrl: raw.validator_selfie_url,
      documentsReviewed: raw.documents_reviewed,
      photoCount: raw.photo_count,
      verificationCoverage: raw.verification_coverage,
      adminReviewStatus: raw.admin_review_status,
      adminNotes: raw.admin_notes,
      reviewedBy: raw.reviewed_by,
      reviewedAt: raw.reviewed_at,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      attributeCount: raw.attribute_count
    };
  }
}

export default new VerificationVisitService();
