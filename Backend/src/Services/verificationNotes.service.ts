import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';

interface CreateNoteInput {
  attributeVerificationId: string;
  visitId: string;
  noteType: 'observation' | 'discrepancy' | 'concern' | 'positive_finding' | 'equipment_status' | 'facility_condition';
  title: string;
  description: string;
  metadata?: Record<string, any>;
  photoUrl?: string;
  createdBy: string;
}

class VerificationNotesService {
  /**
   * Create a verification note
   */
  async createNote(input: CreateNoteInput) {
    const {
      attributeVerificationId,
      visitId,
      noteType,
      title,
      description,
      metadata = {},
      photoUrl,
      createdBy
    } = input;

    // Verify attribute verification exists
    const attrVerRes = await pool.query(
      `SELECT id FROM attribute_verifications WHERE id = $1`,
      [attributeVerificationId]
    );

    if (attrVerRes.rows.length === 0) {
      throw new apiError(404, 'Attribute verification not found');
    }

    // Verify visit exists
    const visitRes = await pool.query(
      `SELECT id FROM verification_visits WHERE id = $1`,
      [visitId]
    );

    if (visitRes.rows.length === 0) {
      throw new apiError(404, 'Visit not found');
    }

    // Create note
    const result = await pool.query(
      `INSERT INTO verification_notes (
        attribute_verification_id,
        visit_id,
        note_type,
        title,
        description,
        metadata,
        photo_url,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        attributeVerificationId,
        visitId,
        noteType,
        title,
        description,
        JSON.stringify(metadata),
        photoUrl || null,
        createdBy
      ]
    );

    return this.formatNote(result.rows[0]);
  }

  /**
   * Get note by ID
   */
  async getNote(noteId: string) {
    const result = await pool.query(
      `SELECT vn.*,
              u.first_name, u.last_name, u.email
       FROM verification_notes vn
       LEFT JOIN users u ON vn.created_by = u.id
       WHERE vn.id = $1`,
      [noteId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Note not found');
    }

    return this.formatNote(result.rows[0]);
  }

  /**
   * Get all notes for an attribute verification
   */
  async getNotesForAttributeVerification(attributeVerificationId: string) {
    const result = await pool.query(
      `SELECT vn.*,
              u.first_name, u.last_name, u.email
       FROM verification_notes vn
       LEFT JOIN users u ON vn.created_by = u.id
       WHERE vn.attribute_verification_id = $1
       ORDER BY vn.created_at DESC`,
      [attributeVerificationId]
    );

    return result.rows.map(n => this.formatNote(n));
  }

  /**
   * Get all notes for a visit
   */
  async getNotesForVisit(visitId: string) {
    const result = await pool.query(
      `SELECT vn.*,
              u.first_name, u.last_name, u.email,
              ad.label as attribute_label
       FROM verification_notes vn
       LEFT JOIN users u ON vn.created_by = u.id
       LEFT JOIN attribute_verifications av ON vn.attribute_verification_id = av.id
       LEFT JOIN hospital.attribute_definitions ad ON av.attribute_key = ad.key
       WHERE vn.visit_id = $1
       ORDER BY vn.note_type, vn.created_at DESC`,
      [visitId]
    );

    return result.rows.map(n => ({
      ...this.formatNote(n),
      attributeLabel: n.attribute_label
    }));
  }

  /**
   * Get notes by type
   */
  async getNotesByType(
    visitId: string,
    noteType: string
  ) {
    const result = await pool.query(
      `SELECT vn.*,
              u.first_name, u.last_name
       FROM verification_notes vn
       LEFT JOIN users u ON vn.created_by = u.id
       WHERE vn.visit_id = $1 AND vn.note_type = $2
       ORDER BY vn.created_at DESC`,
      [visitId, noteType]
    );

    return result.rows.map(n => this.formatNote(n));
  }

  /**
   * Get discrepancy notes for a hospital (potential issues)
   */
  async getHospitalDiscrepancies(hospitalId: string) {
    const result = await pool.query(
      `SELECT vn.*,
              vv.scheduled_date,
              vp.full_name as validator_name,
              av.attribute_key,
              ad.label as attribute_label,
              av.attribute_value_claimed,
              av.attribute_value_found
       FROM verification_notes vn
       JOIN attribute_verifications av ON vn.attribute_verification_id = av.id
       JOIN verification_visits vv ON vn.visit_id = vv.id
       JOIN validator_profiles vp ON vv.validator_id = vp.id
       LEFT JOIN hospital.attribute_definitions ad ON av.attribute_key = ad.key
       WHERE vv.hospital_id = $1
       AND vn.note_type IN ('discrepancy', 'concern')
       ORDER BY vv.scheduled_date DESC, vn.created_at DESC`,
      [hospitalId]
    );

    return result.rows.map(n => ({
      ...this.formatNote(n),
      validationDate: n.scheduled_date,
      validatorName: n.validator_name,
      attributeKey: n.attribute_key,
      attributeLabel: n.attribute_label,
      claimedValue: n.attribute_value_claimed,
      foundValue: n.attribute_value_found
    }));
  }

  /**
   * Update note
   */
  async updateNote(noteId: string, updates: any) {
    const updateFields = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.title) {
      updateFields.push(`title = $${paramIndex++}`);
      values.push(updates.title);
    }

    if (updates.description) {
      updateFields.push(`description = $${paramIndex++}`);
      values.push(updates.description);
    }

    if (updates.metadata) {
      updateFields.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(updates.metadata));
    }

    if (updateFields.length === 0) {
      return await this.getNote(noteId);
    }

    updateFields.push(`updated_at = NOW()`);
    values.push(noteId);

    const result = await pool.query(
      `UPDATE verification_notes
       SET ${updateFields.join(', ')}
       WHERE id = $${paramIndex++}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Note not found');
    }

    return this.formatNote(result.rows[0]);
  }

  /**
   * Delete note
   */
  async deleteNote(noteId: string) {
    const result = await pool.query(
      `DELETE FROM verification_notes WHERE id = $1 RETURNING id`,
      [noteId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Note not found');
    }

    return { deleted: true, id: noteId };
  }

  /**
   * Get notes summary by type for a visit
   */
  async getVisitNotesSummary(visitId: string) {
    const result = await pool.query(
      `SELECT
        note_type,
        COUNT(*) as count
       FROM verification_notes
       WHERE visit_id = $1
       GROUP BY note_type
       ORDER BY count DESC`,
      [visitId]
    );

    const summary: Record<string, number> = {};
    result.rows.forEach(row => {
      summary[row.note_type] = parseInt(row.count);
    });

    return summary;
  }

  /**
   * Generate verification report JSON from notes
   */
  async generateVerificationReport(visitId: string) {
    // Get visit details
    const visitRes = await pool.query(
      `SELECT vv.*,
              h.name as hospital_name,
              h.city, h.state,
              vp.full_name as validator_name,
              vp.email as validator_email,
              vp.phone as validator_phone
       FROM verification_visits vv
       LEFT JOIN hospital.hospitals h ON vv.hospital_id = h.id
       LEFT JOIN validator_profiles vp ON vv.validator_id = vp.id
       WHERE vv.id = $1`,
      [visitId]
    );

    if (visitRes.rows.length === 0) {
      throw new apiError(404, 'Visit not found');
    }

    const visit = visitRes.rows[0];

    // Get all attribute verifications with notes
    const verificationsRes = await pool.query(
      `SELECT av.*,
              ad.label as attribute_label,
              ad.category,
              COALESCE(
                JSON_AGG(
                  JSON_BUILD_OBJECT(
                    'id', vn.id,
                    'type', vn.note_type,
                    'title', vn.title,
                    'description', vn.description,
                    'metadata', vn.metadata,
                    'photoUrl', vn.photo_url,
                    'createdAt', vn.created_at
                  )
                ) FILTER (WHERE vn.id IS NOT NULL),
                '[]'::json
              ) as notes
       FROM attribute_verifications av
       LEFT JOIN hospital.attribute_definitions ad ON av.attribute_key = ad.key
       LEFT JOIN verification_notes vn ON av.id = vn.attribute_verification_id
       WHERE av.visit_id = $1
       GROUP BY av.id, ad.label, ad.category
       ORDER BY ad.category, ad.label`,
      [visitId]
    );

    return {
      reportMetadata: {
        generatedAt: new Date().toISOString(),
        visitId: visit.id,
        reportVersion: '1.0'
      },
      visitor: {
        name: visit.validator_name,
        email: visit.validator_email,
        phone: visit.validator_phone,
        visitedAt: visit.actual_start_time,
        endedAt: visit.actual_end_time
      },
      hospital: {
        name: visit.hospital_name,
        city: visit.city,
        state: visit.state,
        locationVerified: visit.location_verified,
        validatorSelfieUrl: visit.validator_selfie_url
      },
      visitSummary: {
        status: visit.visit_status,
        scheduledDate: visit.scheduled_date,
        documentsReviewed: visit.documents_reviewed,
        photosTaken: visit.photo_count,
        verificationCoverage: visit.verification_coverage
      },
      attributeVerifications: verificationsRes.rows.map(av => ({
        id: av.id,
        attributeKey: av.attribute_key,
        attributeLabel: av.attribute_label,
        category: av.category,
        verificationResult: av.verification_result,
        confidenceLevel: av.confidence_level,
        valueClaimed: av.attribute_value_claimed,
        valueFound: av.attribute_value_found,
        discrepancies: av.discrepancy_notes,
        photos: av.photo_urls,
        notes: JSON.parse(av.notes)
      })),
      summary: {
        totalAttributesVerified: verificationsRes.rows.length,
        fullyVerified: verificationsRes.rows.filter(a => a.verification_result === 'verified').length,
        partiallyVerified: verificationsRes.rows.filter(a => a.verification_result === 'partially_verified').length,
        notVerified: verificationsRes.rows.filter(a => a.verification_result === 'not_verified').length,
        inconclusive: verificationsRes.rows.filter(a => a.verification_result === 'inconclusive').length
      }
    };
  }

  /**
   * Format note response
   */
  private formatNote(raw: any) {
    return {
      id: raw.id,
      attributeVerificationId: raw.attribute_verification_id,
      visitId: raw.visit_id,
      noteType: raw.note_type,
      title: raw.title,
      description: raw.description,
      metadata: typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : raw.metadata,
      photoUrl: raw.photo_url,
      createdBy: raw.created_by,
      createdByName: raw.first_name && raw.last_name ? `${raw.first_name} ${raw.last_name}` : null,
      createdByEmail: raw.email,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at
    };
  }
}

export default new VerificationNotesService();
