import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';

interface CreateAttributeVerificationInput {
  visitId: string;
  hospitalAttributeId: string;
  attributeKey: string;
  verificationResult: 'verified' | 'partially_verified' | 'not_verified' | 'inconclusive';
  confidenceLevel?: number;
  attributeValueFound?: string;
  attributeValueClaimed?: string;
  discrepancyNotes?: string;
  isEquipmentOperational?: boolean;
  facilityConditionNotes?: string;
  documentIds?: string[];
  photoUrls?: string[];
}

class AttributeVerificationService {
  /**
   * Create an attribute verification record for a visit
   */
  async createAttributeVerification(input: CreateAttributeVerificationInput) {
    const {
      visitId,
      hospitalAttributeId,
      attributeKey,
      verificationResult,
      confidenceLevel,
      attributeValueFound,
      attributeValueClaimed,
      discrepancyNotes,
      isEquipmentOperational,
      facilityConditionNotes,
      documentIds = [],
      photoUrls = []
    } = input;

    // Verify visit exists
    const visitRes = await pool.query(
      `SELECT id FROM verification_visits WHERE id = $1`,
      [visitId]
    );

    if (visitRes.rows.length === 0) {
      throw new apiError(404, 'Visit not found');
    }

    // Verify hospital attribute exists
    const attrRes = await pool.query(
      `SELECT id FROM hospital.hospital_attributes WHERE id = $1`,
      [hospitalAttributeId]
    );

    if (attrRes.rows.length === 0) {
      throw new apiError(404, 'Hospital attribute not found');
    }

    // Create verification record
    const result = await pool.query(
      `INSERT INTO attribute_verifications (
        visit_id,
        hospital_attribute_id,
        attribute_key,
        verification_result,
        confidence_level,
        attribute_value_found,
        attribute_value_claimed,
        discrepancy_notes,
        is_equipment_operational,
        facility_condition_notes,
        document_ids,
        photo_urls,
        admin_review_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
      RETURNING *`,
      [
        visitId,
        hospitalAttributeId,
        attributeKey,
        verificationResult,
        confidenceLevel || null,
        attributeValueFound || null,
        attributeValueClaimed || null,
        discrepancyNotes || null,
        isEquipmentOperational !== undefined ? isEquipmentOperational : null,
        facilityConditionNotes || null,
        documentIds,
        photoUrls
      ]
    );

    return this.formatAttributeVerification(result.rows[0]);
  }

  /**
   * Get attribute verification by ID
   */
  async getAttributeVerification(verificationId: string) {
    const result = await pool.query(
      `SELECT av.*,
              ad.label as attribute_label,
              ad.category as attribute_category,
              ad.data_type
       FROM attribute_verifications av
       LEFT JOIN hospital.attribute_definitions ad ON av.attribute_key = ad.key
       WHERE av.id = $1`,
      [verificationId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute verification not found');
    }

    return this.formatAttributeVerification(result.rows[0]);
  }

  /**
   * Get all verifications for a visit
   */
  async getVisitAttributeVerifications(visitId: string) {
    const result = await pool.query(
      `SELECT av.*,
              ad.label as attribute_label,
              ad.category as attribute_category
       FROM attribute_verifications av
       LEFT JOIN hospital.attribute_definitions ad ON av.attribute_key = ad.key
       WHERE av.visit_id = $1
       ORDER BY ad.category, ad.label`,
      [visitId]
    );

    return result.rows.map(av => this.formatAttributeVerification(av));
  }

  /**
   * Get all verifications for a hospital attribute across all visits
   */
  async getAttributeVerificationHistory(hospitalAttributeId: string) {
    const result = await pool.query(
      `SELECT av.*,
              vv.id as visit_id,
              vv.scheduled_date,
              vp.full_name as validator_name,
              h.name as hospital_name
       FROM attribute_verifications av
       JOIN verification_visits vv ON av.visit_id = vv.id
       JOIN validator_profiles vp ON vv.validator_id = vp.id
       JOIN hospital.hospitals h ON vv.hospital_id = h.id
       WHERE av.hospital_attribute_id = $1
       ORDER BY vv.scheduled_date DESC`,
      [hospitalAttributeId]
    );

    return result.rows.map(av => ({
      ...this.formatAttributeVerification(av),
      visitDate: av.scheduled_date,
      validatorName: av.validator_name,
      hospitalName: av.hospital_name
    }));
  }

  /**
   * Get verification statistics for hospital
   */
  async getHospitalVerificationStatistics(hospitalId: string) {
    const result = await pool.query(
      `SELECT
        COUNT(DISTINCT av.id) as total_attributes_verified,
        COUNT(DISTINCT CASE WHEN av.verification_result = 'verified' THEN av.id END) as fully_verified,
        COUNT(DISTINCT CASE WHEN av.verification_result = 'partially_verified' THEN av.id END) as partially_verified,
        COUNT(DISTINCT CASE WHEN av.verification_result = 'not_verified' THEN av.id END) as not_verified,
        COUNT(DISTINCT CASE WHEN av.verification_result = 'inconclusive' THEN av.id END) as inconclusive,
        AVG(av.confidence_level) as average_confidence_level,
        COUNT(DISTINCT vv.id) as total_visits,
        COUNT(DISTINCT CASE WHEN vv.visit_status = 'completed' THEN vv.id END) as completed_visits
       FROM verification_visits vv
       LEFT JOIN attribute_verifications av ON vv.visit_id = av.visit_id
       WHERE vv.hospital_id = $1`,
      [hospitalId]
    );

    const stats = result.rows[0];

    return {
      totalAttributesVerified: parseInt(stats.total_attributes_verified) || 0,
      fullyVerified: parseInt(stats.fully_verified) || 0,
      partiallyVerified: parseInt(stats.partially_verified) || 0,
      notVerified: parseInt(stats.not_verified) || 0,
      inconclusive: parseInt(stats.inconclusive) || 0,
      averageConfidenceLevel: stats.average_confidence_level ? parseFloat(stats.average_confidence_level) : 0,
      totalVisits: parseInt(stats.total_visits) || 0,
      completedVisits: parseInt(stats.completed_visits) || 0,
      verificationPercentage: parseInt(stats.total_attributes_verified) > 0
        ? Math.round((parseInt(stats.fully_verified) / parseInt(stats.total_attributes_verified)) * 100)
        : 0
    };
  }

  /**
   * Update attribute verification
   */
  async updateAttributeVerification(verificationId: string, updates: any) {
    const updateFields = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.verificationResult) {
      updateFields.push(`verification_result = $${paramIndex++}`);
      values.push(updates.verificationResult);
    }

    if (updates.confidenceLevel !== undefined) {
      updateFields.push(`confidence_level = $${paramIndex++}`);
      values.push(updates.confidenceLevel);
    }

    if (updates.attributeValueFound) {
      updateFields.push(`attribute_value_found = $${paramIndex++}`);
      values.push(updates.attributeValueFound);
    }

    if (updates.attributeValueClaimed) {
      updateFields.push(`attribute_value_claimed = $${paramIndex++}`);
      values.push(updates.attributeValueClaimed);
    }

    if (updates.discrepancyNotes) {
      updateFields.push(`discrepancy_notes = $${paramIndex++}`);
      values.push(updates.discrepancyNotes);
    }

    if (updates.photoUrls) {
      updateFields.push(`photo_urls = $${paramIndex++}`);
      values.push(updates.photoUrls);
    }

    if (updateFields.length === 0) {
      return await this.getAttributeVerification(verificationId);
    }

    updateFields.push(`updated_at = NOW()`);
    values.push(verificationId);

    const result = await pool.query(
      `UPDATE attribute_verifications
       SET ${updateFields.join(', ')}
       WHERE id = $${paramIndex++}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute verification not found');
    }

    return this.formatAttributeVerification(result.rows[0]);
  }

  /**
   * Review attribute verification (admin action)
   */
  async reviewAttributeVerification(
    verificationId: string,
    reviewStatus: 'approved' | 'needs_revision' | 'rejected',
    adminNotes?: string
  ) {
    const result = await pool.query(
      `UPDATE attribute_verifications
       SET admin_review_status = $1,
           admin_notes = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [reviewStatus, adminNotes || null, verificationId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute verification not found');
    }

    return this.formatAttributeVerification(result.rows[0]);
  }

  /**
   * Get verifications pending admin review
   */
  async getVerificationsPendingReview(
    hospitalId?: string,
    page: number = 1,
    limit: number = 20
  ) {
    const offset = (page - 1) * limit;

    let query = `
      SELECT av.*,
             ad.label as attribute_label,
             ad.category,
             vv.scheduled_date,
             h.name as hospital_name,
             vp.full_name as validator_name
       FROM attribute_verifications av
       LEFT JOIN hospital.attribute_definitions ad ON av.attribute_key = ad.key
       JOIN verification_visits vv ON av.visit_id = vv.id
       JOIN hospital.hospitals h ON vv.hospital_id = h.id
       JOIN validator_profiles vp ON vv.validator_id = vp.id
       WHERE av.admin_review_status = 'pending'
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (hospitalId) {
      query += ` AND vv.hospital_id = $${paramIndex++}`;
      params.push(hospitalId);
    }

    query += ` ORDER BY vv.scheduled_date DESC, av.created_at ASC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM attribute_verifications WHERE admin_review_status = 'pending'`;
    const countParams: any[] = [];

    if (hospitalId) {
      countQuery += ` AND visit_id IN (SELECT id FROM verification_visits WHERE hospital_id = $1)`;
      countParams.push(hospitalId);
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    return {
      verifications: result.rows.map(av => ({
        ...this.formatAttributeVerification(av),
        attributeLabel: av.attribute_label,
        category: av.category,
        validationDate: av.scheduled_date,
        hospitalName: av.hospital_name,
        validatorName: av.validator_name
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
   * Format attribute verification response
   */
  private formatAttributeVerification(raw: any) {
    return {
      id: raw.id,
      visitId: raw.visit_id,
      hospitalAttributeId: raw.hospital_attribute_id,
      attributeKey: raw.attribute_key,
      attributeLabel: raw.attribute_label,
      verificationResult: raw.verification_result,
      confidenceLevel: raw.confidence_level,
      attributeValueFound: raw.attribute_value_found,
      attributeValueClaimed: raw.attribute_value_claimed,
      discrepancyNotes: raw.discrepancy_notes,
      isEquipmentOperational: raw.is_equipment_operational,
      facilityConditionNotes: raw.facility_condition_notes,
      documentIds: raw.document_ids || [],
      photoUrls: raw.photo_urls || [],
      adminReviewStatus: raw.admin_review_status,
      adminNotes: raw.admin_notes,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at
    };
  }
}

export default new AttributeVerificationService();
