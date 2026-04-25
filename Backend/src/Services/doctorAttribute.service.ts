import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';

interface SetAttributeInput {
  doctorId: string;
  attributeKey: string;
  valueText?: string;
  valueDate?: string;
  valueBoolean?: boolean;
  certificateNumber?: string;
  issuingAuthority?: string;
  issuedAt?: string;
  expiresAt?: string;
  documentIds?: string[];
}

class DoctorAttributeService {
  /**
   * Set or update a doctor attribute (MIRRORED FROM WORKING hospital.attribute.service)
   */
  async setAttribute(input: SetAttributeInput) {
    const {
      doctorId,
      attributeKey,
      valueText,
      valueDate,
      valueBoolean,
      certificateNumber,
      issuingAuthority,
      issuedAt,
      expiresAt,
      documentIds = []
    } = input;

    // Validate attribute definition exists
    const attrDef = await this.getAttributeDefinition(attributeKey);

    // Ensure doctor exists
    const doctorCheck = await pool.query(
      'SELECT id FROM doctors WHERE id = $1',
      [doctorId]
    );
    if (doctorCheck.rows.length === 0) {
      throw new apiError(404, 'Doctor not found');
    }

    // Insert or update the attribute (ON CONFLICT handles both cases)
    const result = await pool.query(
      `INSERT INTO doctor_attributes
       (doctor_id, attribute_key, value_text, value_date, value_boolean,
        certificate_number, issuing_authority, issued_at, expires_at, verification_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unverified')
       ON CONFLICT (doctor_id, attribute_key)
       DO UPDATE SET
         value_text = EXCLUDED.value_text,
         value_date = EXCLUDED.value_date,
         value_boolean = EXCLUDED.value_boolean,
         certificate_number = EXCLUDED.certificate_number,
         issuing_authority = EXCLUDED.issuing_authority,
         issued_at = EXCLUDED.issued_at,
         expires_at = EXCLUDED.expires_at,
         verification_status = 'unverified',
         updated_at = NOW()
       RETURNING *`,
      [
        doctorId,
        attributeKey,
        valueText || null,
        valueDate || null,
        valueBoolean !== undefined ? valueBoolean : null,
        certificateNumber || null,
        issuingAuthority || null,
        issuedAt || null,
        expiresAt || null
      ]
    );

    const attributeRow = result.rows[0];

    // Handle document linking (same logic as hospital attributes)
    if (documentIds && Array.isArray(documentIds) && documentIds.length > 0) {
      // Validate UUID format for each document
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      for (let i = 0; i < documentIds.length; i++) {
        const docId = documentIds[i];
        if (!uuidRegex.test(docId)) {
          console.warn(`Invalid UUID format for document: ${docId}`);
          continue;
        }

        // Add document to attribute
        try {
          await this.addDocumentToAttribute(
            doctorId,
            attributeRow.id,
            docId,
            i === 0 // First document is primary
          );
        } catch (err) {
          console.warn(`Failed to link document ${docId}:`, err);
          // Continue processing other documents
        }
      }
    }

    return this.formatAttributeResponse(attributeRow);
  }

  /**
   * Get attribute definition - validates it exists
   */
  async getAttributeDefinition(key: string) {
    const result = await pool.query(
      `SELECT * FROM doctor_attribute_definitions WHERE key = $1 AND is_active = true`,
      [key]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, `Attribute definition '${key}' not found`);
    }

    return result.rows[0];
  }

  /**
   * Add document to attribute (creates junction table entry) - SAME AS HOSPITAL
   */
  async addDocumentToAttribute(
    doctorId: string,
    doctorAttributeId: string,
    documentId: string,
    isPrimary: boolean = false
  ) {
    console.log('[LINK DOC] START: doctorId=%s, attrId=%s, docId=%s', doctorId, doctorAttributeId, documentId);

    // Verify attribute exists
    const attrRes = await pool.query(
      `SELECT id FROM doctor_attributes WHERE id = $1 AND doctor_id = $2`,
      [doctorAttributeId, doctorId]
    );
    console.log('[LINK DOC] Attribute check - found:', attrRes.rowCount);
    if (attrRes.rowCount === 0) {
      throw new Error(`Attribute ${doctorAttributeId} not found for doctor ${doctorId}`);
    }

    // Verify document exists
    const docRes = await pool.query(
      `SELECT id FROM doctor_doc WHERE id = $1 AND doctor_id = $2`,
      [documentId, doctorId]
    );
    console.log('[LINK DOC] Document check - found:', docRes.rowCount);
    if (docRes.rowCount === 0) {
      throw new Error(`Document ${documentId} not found for doctor ${doctorId}`);
    }

    // If setting as primary, first unset all others
    if (isPrimary) {
      console.log('[LINK DOC] Unsetting primary for other documents...');
      await pool.query(
        `UPDATE hospital.doctor_attribute_documents
         SET is_primary = FALSE
         WHERE doctor_attribute_id = $1`,
        [doctorAttributeId]
      );
    }

    console.log('[LINK DOC] Inserting into junction table...');
    const result = await pool.query(
      `INSERT INTO hospital.doctor_attribute_documents
       (doctor_attribute_id, document_id, is_primary)
       VALUES ($1, $2, $3)
       ON CONFLICT (doctor_attribute_id, document_id)
       DO UPDATE SET
         is_primary = EXCLUDED.is_primary
       RETURNING id, doctor_attribute_id, document_id, is_primary, added_at`,
      [doctorAttributeId, documentId, isPrimary]
    );

    console.log('[LINK DOC] SUCCESS - rows:', result.rowCount);
    return result.rows[0];
  }

  /**
   * Get doctor attribute by ID
   */
  async getAttribute(attributeId: string) {
    const result = await pool.query(
      `SELECT da.*, dad.label, dad.category, dad.data_type
       FROM doctor_attributes da
       LEFT JOIN doctor_attribute_definitions dad ON da.attribute_key = dad.key
       WHERE da.id = $1`,
      [attributeId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute not found');
    }

    const attr = result.rows[0];

    // Get documents
    const docsRes = await pool.query(
      `SELECT dad.id, dad.document_id, dad.is_primary, dad.document_type,
              hd.file_name, hd.file_size_bytes, hd.mime_type
       FROM doctor_attribute_documents dad
       LEFT JOIN hospital.hospital_documents hd ON dad.document_id = hd.id
       WHERE dad.doctor_attribute_id = $1
       ORDER BY dad.is_primary DESC, dad.added_at DESC`,
      [attributeId]
    );

    return {
      ...this.formatAttributeResponse(attr),
      label: attr.label,
      category: attr.category,
      dataType: attr.data_type,
      documents: docsRes.rows.map(d => ({
        id: d.id,
        documentId: d.document_id,
        fileName: d.file_name,
        fileSize: d.file_size_bytes,
        mimeType: d.mime_type,
        isPrimary: d.is_primary,
        documentType: d.document_type
      }))
    };
  }

  /**
   * Get all attributes for a doctor
   */
  async getDoctorAttributes(doctorId: string, category?: string) {
    let query = `
      SELECT da.*, dad.label, dad.category, dad.data_type, dad.has_expiry
      FROM doctor_attributes da
      LEFT JOIN doctor_attribute_definitions dad ON da.attribute_key = dad.key
      WHERE da.doctor_id = $1
    `;

    const params: any[] = [doctorId];
    let paramIndex = 2;

    if (category) {
      query += ` AND dad.category = $${paramIndex++}`;
      params.push(category);
    }

    query += ` ORDER BY dad.category, dad.sort_order`;

    const result = await pool.query(query, params);

    // Get documents for each attribute
    const attributesWithDocs = await Promise.all(
      result.rows.map(async (attr) => {
        const docsRes = await pool.query(
          `SELECT dad.id, dad.document_id, dad.is_primary, dad.document_type,
                  dd.file_name, dd.file_size as file_size_bytes, dd.mime_type, dd.s3_link
           FROM doctor_attribute_documents dad
           LEFT JOIN doctor_doc dd ON dad.document_id = dd.id
           WHERE dad.doctor_attribute_id = $1`,
          [attr.id]
        );

        return {
          ...this.formatAttributeResponse(attr),
          label: attr.label,
          category: attr.category,
          dataType: attr.data_type,
          hasExpiry: attr.has_expiry,
          documents: docsRes.rows.map(d => ({
            id: d.id,
            documentId: d.document_id,
            fileName: d.file_name,
            fileSize: d.file_size_bytes,
            mimeType: d.mime_type,
            s3Url: d.s3_link,
            isPrimary: d.is_primary,
            documentType: d.document_type
          }))
        };
      })
    );

    // Group by category
    const grouped: Record<string, any[]> = {};
    attributesWithDocs.forEach(attr => {
      if (!grouped[attr.category]) {
        grouped[attr.category] = [];
      }
      grouped[attr.category].push(attr);
    });

    return { attributes: attributesWithDocs, grouped };
  }

  /**
   * Verify an attribute (admin action)
   */
  async verifyAttribute(
    attributeId: string,
    adminId: string,
    verificationMethod: string,
    notes?: string
  ) {
    const result = await pool.query(
      `UPDATE doctor_attributes
       SET verification_status = 'verified_by_doc',
           verification_method = $1,
           verified_by = $2,
           verified_at = NOW(),
           verification_notes = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [verificationMethod, adminId, notes || null, attributeId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute not found');
    }

    return this.formatAttributeResponse(result.rows[0]);
  }

  /**
   * Get attribute verification history
   */
  async getAttributeHistory(doctorId: string, attributeKey: string) {
    const result = await pool.query(
      `SELECT da.*, dad.label, dad.category
       FROM doctor_attributes da
       LEFT JOIN doctor_attribute_definitions dad ON da.attribute_key = dad.key
       WHERE da.doctor_id = $1 AND da.attribute_key = $2
       ORDER BY da.created_at DESC`,
      [doctorId, attributeKey]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute not found');
    }

    return result.rows.map(attr => ({
      ...this.formatAttributeResponse(attr),
      label: attr.label,
      category: attr.category
    }));
  }

  /**
   * Check expiring attributes
   */
  async getExpiringAttributes(doctorId: string, daysThreshold: number = 30) {
    const result = await pool.query(
      `SELECT da.*, dad.label, dad.category
       FROM doctor_attributes da
       LEFT JOIN doctor_attribute_definitions dad ON da.attribute_key = dad.key
       WHERE da.doctor_id = $1
       AND da.expires_at IS NOT NULL
       AND da.expires_at <= NOW() + INTERVAL '${daysThreshold} days'
       AND da.expires_at > NOW()
       ORDER BY da.expires_at ASC`,
      [doctorId]
    );

    return result.rows.map(attr => ({
      ...this.formatAttributeResponse(attr),
      label: attr.label,
      category: attr.category,
      daysUntilExpiry: Math.ceil(
        (new Date(attr.expires_at).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
      )
    }));
  }

  /**
   * Get expired attributes
   */
  async getExpiredAttributes(doctorId: string) {
    const result = await pool.query(
      `SELECT da.*, dad.label, dad.category
       FROM doctor_attributes da
       LEFT JOIN doctor_attribute_definitions dad ON da.attribute_key = dad.key
       WHERE da.doctor_id = $1
       AND da.expires_at IS NOT NULL
       AND da.expires_at <= NOW()
       ORDER BY da.expires_at DESC`,
      [doctorId]
    );

    return result.rows.map(attr => ({
      ...this.formatAttributeResponse(attr),
      label: attr.label,
      category: attr.category,
      expiredSince: Math.ceil(
        (new Date().getTime() - new Date(attr.expires_at).getTime()) / (1000 * 60 * 60 * 24)
      )
    }));
  }

  /**
   * Remove document from attribute
   */
  async removeDocumentFromAttribute(attributeId: string, documentId: string) {
    const result = await pool.query(
      `DELETE FROM doctor_attribute_documents
       WHERE doctor_attribute_id = $1 AND document_id = $2
       RETURNING id`,
      [attributeId, documentId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Document link not found');
    }

    return { deleted: true };
  }

  /**
   * Delete a doctor attribute
   */
  async deleteAttribute(attributeId: string) {
    // First delete all associated documents
    await pool.query(
      `DELETE FROM doctor_attribute_documents WHERE doctor_attribute_id = $1`,
      [attributeId]
    );

    // Then delete the attribute itself
    const result = await pool.query(
      `DELETE FROM doctor_attributes WHERE id = $1 RETURNING id`,
      [attributeId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute not found');
    }

    return { deleted: true };
  }

  /**
   * Format attribute response
   */
  private formatAttributeResponse(raw: any) {
    return {
      id: raw.id,
      doctorId: raw.doctor_id,
      attributeKey: raw.attribute_key,
      valueText: raw.value_text,
      valueDate: raw.value_date,
      valueBoolean: raw.value_boolean,
      certificateNumber: raw.certificate_number,
      issuingAuthority: raw.issuing_authority,
      issuedAt: raw.issued_at,
      expiresAt: raw.expires_at,
      verificationStatus: raw.verification_status,
      verificationMethod: raw.verification_method,
      verificationNotes: raw.verification_notes,
      verifiedBy: raw.verified_by,
      verifiedAt: raw.verified_at,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at
    };
  }
}

export default new DoctorAttributeService();
