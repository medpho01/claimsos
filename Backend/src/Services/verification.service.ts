import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';
import S3Service from './s3.service.js';

interface EvidenceInput {
  hospitalAttributeId: string;
  documentId: string;
  evidenceType: 'photo' | 'document' | 'manual_confirmation';
  caption?: string;
  uploadedBy: string;
}

interface VerificationChecklistItem {
  attributeKey: string;
  label: string;
  category: string;
  isMandatory: boolean;
  requiresDocument: boolean;
  canVerifyByImage: boolean;
  currentStatus: string;
  needsAction: boolean;
}

class VerificationService {
  /**
   * Get hospital verification dashboard
   */
  async getVerificationDashboard(hospitalId: string) {
    // Get hospital profile
    const profileRes = await pool.query(
      `SELECT verification_level, verification_status FROM hospital.hospital_profile
       WHERE hospital_id = $1`,
      [hospitalId]
    );

    const profile = profileRes.rows[0];

    // Get all attributes
    const attributesRes = await pool.query(
      `SELECT ha.*, ad.label, ad.category, ad.is_mandatory_basic, ad.is_mandatory_empanelment,
              ad.requires_document, ad.can_verify_by_image
       FROM hospital.hospital_attributes ha
       JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
       WHERE ha.hospital_id = $1
       ORDER BY ad.category, ad.sort_order`,
      [hospitalId]
    );

    // Calculate verification stats
    const totalAttributes = attributesRes.rows.length;
    const verified = attributesRes.rows.filter(a =>
      ['verified_by_doc', 'verified_by_image', 'verified_manual', 'automated_verified'].includes(a.verification_status)
    ).length;
    const pending = attributesRes.rows.filter(a =>
      ['unverified', 'pending_review'].includes(a.verification_status)
    ).length;
    const rejected = attributesRes.rows.filter(a => a.verification_status === 'rejected').length;

    // Build checklists
    const basicChecklist = attributesRes.rows
      .filter(a => a.is_mandatory_basic)
      .map(a => this.formatChecklistItem(a));

    const empanelmentChecklist = attributesRes.rows
      .filter(a => a.is_mandatory_empanelment)
      .map(a => this.formatChecklistItem(a));

    // Get pending evidence reviews
    const evidenceRes = await pool.query(
      `SELECT ve.*, ad.label
       FROM hospital.verification_evidence ve
       JOIN hospital.hospital_attributes ha ON ve.attribute_id = ha.id
       JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
       WHERE ve.hospital_id = $1 AND ve.review_status = 'pending'
       ORDER BY ve.uploaded_at DESC`,
      [hospitalId]
    );

    // Get expiring certificates
    const expiringRes = await pool.query(
      `SELECT ha.*, ad.label
       FROM hospital.hospital_attributes ha
       JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
       WHERE ha.hospital_id = $1
       AND ad.has_expiry = true
       AND ha.expires_at IS NOT NULL
       AND ha.expires_at <= CURRENT_DATE + INTERVAL '90 days'
       AND ha.expires_at > CURRENT_DATE
       AND ha.verification_status NOT IN ('expired', 'rejected')
       ORDER BY ha.expires_at ASC`,
      [hospitalId]
    );

    return {
      verificationLevel: profile?.verification_level || 'none',
      verificationStatus: profile?.verification_status || 'not_submitted',
      stats: {
        total: totalAttributes,
        verified,
        pending,
        rejected,
        verificationPercentage: totalAttributes > 0 ? Math.round((verified / totalAttributes) * 100) : 0
      },
      checklists: {
        basic: basicChecklist,
        empanelment: empanelmentChecklist
      },
      pendingEvidenceReview: evidenceRes.rows.length,
      expiringCertificates: expiringRes.rows.map(r => ({
        attributeKey: r.attribute_key,
        label: r.label,
        expiresAt: r.expires_at,
        daysUntilExpiry: Math.ceil((new Date(r.expires_at).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
      }))
    };
  }

  /**
   * Submit evidence for attribute verification
   */
  async submitEvidence(input: EvidenceInput) {
    // Validate attribute exists
    const attrRes = await pool.query(
      `SELECT hospital_id FROM hospital.hospital_attributes WHERE id = $1`,
      [input.hospitalAttributeId]
    );

    if (attrRes.rows.length === 0) {
      throw new apiError(404, 'Attribute not found');
    }

    // Validate document exists
    const docRes = await pool.query(
      `SELECT * FROM hospital.hospital_documents WHERE id = $1`,
      [input.documentId]
    );

    if (docRes.rows.length === 0) {
      throw new apiError(404, 'Document not found');
    }

    // Create evidence record
    const result = await pool.query(
      `INSERT INTO hospital.verification_evidence
       (hospital_id, attribute_id, document_id, evidence_type, caption, uploaded_by, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [
        attrRes.rows[0].hospital_id,
        input.hospitalAttributeId,
        input.documentId,
        input.evidenceType,
        input.caption,
        input.uploadedBy
      ]
    );

    // Update attribute status to pending_review
    await pool.query(
      `UPDATE hospital.hospital_attributes
       SET verification_status = 'pending_review'
       WHERE id = $1`,
      [input.hospitalAttributeId]
    );

    return result.rows[0];
  }

  /**
   * Get evidence for attribute
   */
  async getAttributeEvidence(attributeId: string) {
    const result = await pool.query(
      `SELECT * FROM hospital.verification_evidence
       WHERE attribute_id = $1
       ORDER BY uploaded_at DESC`,
      [attributeId]
    );

    return result.rows;
  }

  /**
   * Review evidence
   */
  async reviewEvidence(
    evidenceId: string,
    reviewStatus: 'accepted' | 'rejected',
    reviewedBy: string,
    notes?: string
  ) {
    // Get evidence and attribute
    const evidenceRes = await pool.query(
      `SELECT ve.*, ha.hospital_id, ha.attribute_key
       FROM hospital.verification_evidence ve
       JOIN hospital.hospital_attributes ha ON ve.attribute_id = ha.id
       WHERE ve.id = $1`,
      [evidenceId]
    );

    if (evidenceRes.rows.length === 0) {
      throw new apiError(404, 'Evidence not found');
    }

    const evidence = evidenceRes.rows[0];

    // Update evidence review
    await pool.query(
      `UPDATE hospital.verification_evidence
       SET review_status = $2, reviewed_by = $3, reviewed_at = NOW(), review_notes = $4
       WHERE id = $1`,
      [evidenceId, reviewStatus, reviewedBy, notes]
    );

    // If accepted, verify the attribute
    if (reviewStatus === 'accepted') {
      const verificationMethod = evidence.evidence_type === 'photo' ? 'image' : 'document';
      await pool.query(
        `UPDATE hospital.hospital_attributes
         SET verification_status = CASE
               WHEN $3 = 'image' THEN 'verified_by_image'
               ELSE 'verified_by_doc'
             END,
             verification_method = $3,
             verified_by = $4,
             verified_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [evidence.attribute_id, evidence.attribute_key, verificationMethod, reviewedBy]
      );
    } else {
      // Mark attribute as rejected if evidence rejected
      await pool.query(
        `UPDATE hospital.hospital_attributes
         SET verification_status = 'rejected',
             verification_notes = $2,
             verified_by = $3,
             verified_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [evidence.attribute_id, notes || 'Evidence rejected by reviewer']
      );
    }

    return { reviewStatus, appliedTo: evidence.attribute_key };
  }

  /**
   * Get verification checklist
   */
  async getVerificationChecklist(hospitalId: string, type: 'basic' | 'empanelment' = 'basic') {
    const mandatoryColumn = type === 'basic' ? 'is_mandatory_basic' : 'is_mandatory_empanelment';

    const result = await pool.query(
      `SELECT ha.*, ad.label, ad.category, ad.${mandatoryColumn} as is_mandatory,
              ad.requires_document, ad.can_verify_by_image,
              COUNT(DISTINCT ve.id) as evidence_count
       FROM hospital.attribute_definitions ad
       LEFT JOIN hospital.hospital_attributes ha ON ad.key = ha.attribute_key AND ha.hospital_id = $1
       LEFT JOIN hospital.verification_evidence ve ON ha.id = ve.attribute_id
       WHERE ad.${mandatoryColumn} = true
       GROUP BY ad.key, ad.label, ad.category, ha.id, ha.verification_status
       ORDER BY ad.category, ad.sort_order`,
      [hospitalId]
    );

    return result.rows.map(r => this.formatChecklistItem(r));
  }

  /**
   * Get verification summary (for admin dashboard)
   */
  async getVerificationSummary() {
    const result = await pool.query(`
      SELECT
        h.id,
        h.name,
        hp.city,
        hp.verification_level,
        hp.verification_status,
        COUNT(DISTINCT ha.id) as total_attributes,
        COUNT(DISTINCT CASE WHEN ha.verification_status IN ('verified_by_doc', 'verified_by_image', 'verified_manual', 'automated_verified') THEN ha.id END) as verified_attributes,
        COUNT(DISTINCT CASE WHEN ha.verification_status = 'pending_review' THEN ha.id END) as pending_review,
        COUNT(DISTINCT CASE WHEN ha.verification_status = 'unverified' THEN ha.id END) as unverified,
        COUNT(DISTINCT ve.id) as pending_evidence_reviews
      FROM hospital.hospitals h
      LEFT JOIN hospital.hospital_profile hp ON h.id = hp.hospital_id
      LEFT JOIN hospital.hospital_attributes ha ON h.id = ha.hospital_id
      LEFT JOIN hospital.verification_evidence ve ON ha.id = ve.attribute_id AND ve.review_status = 'pending'
      GROUP BY h.id, h.name, hp.city, hp.verification_level, hp.verification_status
      ORDER BY hp.verification_status DESC, h.name
    `);

    return result.rows;
  }

  /**
   * Set hospital verification level (admin only)
   */
  async setVerificationLevel(
    hospitalId: string,
    verificationLevel: string,
    verificationStatus: string,
    verifiedBy: string,
    notes?: string
  ) {
    const validLevels = ['none', 'basic', 'standard', 'premium', 'finclarity_verified'];
    const validStatuses = ['not_submitted', 'pending', 'in_review', 'verified', 'revoked'];

    if (!validLevels.includes(verificationLevel)) {
      throw new apiError(400, 'Invalid verification level');
    }

    if (!validStatuses.includes(verificationStatus)) {
      throw new apiError(400, 'Invalid verification status');
    }

    const result = await pool.query(
      `UPDATE hospital.hospital_profile
       SET verification_level = $2,
           verification_status = $3,
           verified_by = $4,
           verified_at = NOW(),
           verification_notes = $5,
           updated_at = NOW()
       WHERE hospital_id = $1
       RETURNING *`,
      [hospitalId, verificationLevel, verificationStatus, verifiedBy, notes]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Hospital profile not found');
    }

    return result.rows[0];
  }

  // Private helpers

  private formatChecklistItem(row: any): VerificationChecklistItem {
    return {
      attributeKey: row.attribute_key || row.key,
      label: row.label,
      category: row.category,
      isMandatory: row.is_mandatory ?? false,
      requiresDocument: row.requires_document ?? false,
      canVerifyByImage: row.can_verify_by_image ?? false,
      currentStatus: row.verification_status || 'unverified',
      needsAction: !row.id || !['verified_by_doc', 'verified_by_image', 'verified_manual', 'automated_verified'].includes(row.verification_status)
    };
  }
}

export default new VerificationService();
