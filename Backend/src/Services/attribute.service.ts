import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';

interface AttributeValue {
  valueBoolean?: boolean | null;
  valueInteger?: number | null;
  valueText?: string | null;
  valueDate?: string | null;
  documentId?: string;
  documentIds?: string[];
}

interface SetAttributeInput extends AttributeValue {
  hospitalId: string;
  attributeKey: string;
  certificateNumber?: string;
  issueDate?: string;
  expiresAt?: string;
  issuingAuthority?: string;
}

interface AttributeDocument {
  id: string;
  documentId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
  isPrimary: boolean;
}

class AttributeService {
  /**
   * Get attribute definition
   */
  async getAttributeDefinition(key: string) {
    const result = await pool.query(
      `SELECT * FROM hospital.attribute_definitions WHERE key = $1`,
      [key]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, `Attribute definition '${key}' not found`);
    }

    return result.rows[0];
  }

  /**
   * Get all attribute definitions (optionally filtered by category)
   */
  async getAllDefinitions(category?: string) {
    let query = `SELECT * FROM hospital.attribute_definitions WHERE is_active = true`;
    const params: any[] = [];

    if (category) {
      query += ` AND category = $1`;
      params.push(category);
    }

    query += ` ORDER BY sort_order ASC`;

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Set hospital attribute value
   * Supports both single documentId (deprecated) and documentIds array (new)
   */
  async setAttribute(input: SetAttributeInput) {
    // Validate attribute definition exists
    const attrDef = await this.getAttributeDefinition(input.attributeKey);

    // Validate data type matches
    let value = this.extractValue(input, attrDef.data_type);

    // Insert or update the attribute
    const result = await pool.query(
      `INSERT INTO hospital.hospital_attributes
       (hospital_id, attribute_key, value_boolean, value_integer, value_text, value_date,
        certificate_number, issued_at, expires_at, issuing_authority, verification_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'unverified')
       ON CONFLICT (hospital_id, attribute_key)
       DO UPDATE SET
         value_boolean = EXCLUDED.value_boolean,
         value_integer = EXCLUDED.value_integer,
         value_text = EXCLUDED.value_text,
         value_date = EXCLUDED.value_date,
         certificate_number = EXCLUDED.certificate_number,
         issued_at = EXCLUDED.issued_at,
         expires_at = EXCLUDED.expires_at,
         issuing_authority = EXCLUDED.issuing_authority,
         verification_status = 'unverified',
         updated_at = NOW()
       RETURNING *`,
      [
        input.hospitalId,
        input.attributeKey,
        value.valueBoolean,
        value.valueInteger,
        value.valueText,
        value.valueDate,
        input.certificateNumber,
        input.issueDate,
        input.expiresAt,
        input.issuingAuthority
      ]
    );

    const attributeRow = result.rows[0];

    // Handle document linking (backward compatibility with single documentId)
    if (input.documentId || input.documentIds) {
      const documentIds = input.documentIds || (input.documentId ? [input.documentId] : []);

      for (let i = 0; i < documentIds.length; i++) {
        const docId = documentIds[i];
        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(docId)) continue;

        // Add document to attribute (set first as primary for backward compatibility)
        try {
          await this.addDocumentToAttribute(
            input.hospitalId,
            attributeRow.id,
            docId,
            i === 0 // First document is primary
          );
        } catch (err) {
          // Ignore if document already linked
        }
      }
    }

    return attributeRow;
  }

  /**
   * Get hospital attribute with linked documents
   */
  async getAttribute(hospitalId: string, attributeKey: string) {
    const result = await pool.query(
      `SELECT ha.*, ad.label, ad.category, ad.data_type
       FROM hospital.hospital_attributes ha
       JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
       WHERE ha.hospital_id = $1 AND ha.attribute_key = $2`,
      [hospitalId, attributeKey]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const attribute = result.rows[0];

    // Fetch linked documents
    const docsResult = await pool.query(
      `SELECT had.id, had.document_id, hd.file_name, hd.file_size_bytes, hd.mime_type,
              hd.created_at, had.is_primary
       FROM hospital.hospital_attribute_documents had
       JOIN hospital.hospital_documents hd ON had.document_id = hd.id
       WHERE had.hospital_attribute_id = $1
       ORDER BY had.is_primary DESC, had.added_at DESC`,
      [attribute.id]
    );

    return this.formatAttributeOutput(attribute, docsResult.rows);
  }

  /**
   * Get all hospital attributes (optionally filtered by category/status)
   */
  async getHospitalAttributes(
    hospitalId: string,
    category?: string,
    verificationStatus?: string
  ) {
    let query = `
      SELECT ha.*, ad.label, ad.category, ad.data_type, ad.requires_document, ad.has_expiry
      FROM hospital.hospital_attributes ha
      JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
      WHERE ha.hospital_id = $1
    `;
    const params: any[] = [hospitalId];
    let paramIndex = 2;

    if (category) {
      query += ` AND ad.category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (verificationStatus) {
      query += ` AND ha.verification_status = $${paramIndex}`;
      params.push(verificationStatus);
      paramIndex++;
    }

    query += ` ORDER BY ad.category, ad.sort_order`;

    const result = await pool.query(query, params);

    // Fetch documents for each attribute
    const attributesWithDocs = await Promise.all(
      result.rows.map(async (row) => {
        const docsResult = await pool.query(
          `SELECT had.id, had.document_id, hd.file_name, hd.file_size_bytes, hd.mime_type,
                  hd.created_at, had.is_primary
           FROM hospital.hospital_attribute_documents had
           JOIN hospital.hospital_documents hd ON had.document_id = hd.id
           WHERE had.hospital_attribute_id = $1
           ORDER BY had.is_primary DESC, had.added_at DESC`,
          [row.id]
        );
        return this.formatAttributeOutput(row, docsResult.rows);
      })
    );

    return attributesWithDocs;
  }

  /**
   * Get attributes needing verification
   */
  async getUnverifiedAttributes(hospitalId: string) {
    const result = await pool.query(
      `SELECT ha.*, ad.label, ad.category, ad.can_verify_by_image, ad.requires_document
       FROM hospital.hospital_attributes ha
       JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
       WHERE ha.hospital_id = $1
       AND ha.verification_status IN ('unverified', 'pending_review', 'rejected')
       AND (ad.requires_document = true OR ad.can_verify_by_image = true)
       ORDER BY ad.category, ad.sort_order`,
      [hospitalId]
    );

    return result.rows;
  }

  /**
   * Get expiring attributes
   */
  async getExpiringAttributes(hospitalId: string, daysUntilExpiry: number = 90) {
    const result = await pool.query(
      `SELECT ha.*, ad.label, ad.category
       FROM hospital.hospital_attributes ha
       JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
       WHERE ha.hospital_id = $1
       AND ad.has_expiry = true
       AND ha.expires_at IS NOT NULL
       AND ha.expires_at <= CURRENT_DATE + INTERVAL '1 day' * $2
       AND ha.expires_at > CURRENT_DATE
       AND ha.verification_status NOT IN ('expired', 'rejected')
       ORDER BY ha.expires_at ASC`,
      [hospitalId, daysUntilExpiry]
    );

    return result.rows;
  }

  /**
   * Get expired attributes
   */
  async getExpiredAttributes(hospitalId: string) {
    const result = await pool.query(
      `SELECT ha.*, ad.label, ad.category
       FROM hospital.hospital_attributes ha
       JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
       WHERE ha.hospital_id = $1
       AND ad.has_expiry = true
       AND ha.expires_at IS NOT NULL
       AND ha.expires_at <= CURRENT_DATE
       AND ha.verification_status NOT IN ('expired', 'rejected')
       ORDER BY ha.expires_at DESC`,
      [hospitalId]
    );

    return result.rows;
  }

  /**
   * Mark attribute as verified
   */
  async verifyAttribute(
    hospitalId: string,
    attributeKey: string,
    verificationMethod: 'document' | 'image' | 'manual' | 'automated',
    verifiedBy: string,
    notes?: string
  ) {
    const result = await pool.query(
      `UPDATE hospital.hospital_attributes
       SET verification_status = CASE
             WHEN $3 = 'document' THEN 'verified_by_doc'
             WHEN $3 = 'image' THEN 'verified_by_image'
             WHEN $3 = 'manual' THEN 'verified_manual'
             WHEN $3 = 'automated' THEN 'automated_verified'
           END,
           verification_method = $3,
           verified_by = $4,
           verified_at = NOW(),
           verification_notes = $5,
           updated_at = NOW()
       WHERE hospital_id = $1 AND attribute_key = $2
       RETURNING *`,
      [hospitalId, attributeKey, verificationMethod, verifiedBy, notes]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute not found');
    }

    return result.rows[0];
  }

  /**
   * Reject attribute verification
   */
  async rejectAttribute(
    hospitalId: string,
    attributeKey: string,
    reason: string,
    rejectedBy: string
  ) {
    const result = await pool.query(
      `UPDATE hospital.hospital_attributes
       SET verification_status = 'rejected',
           verification_notes = $3,
           verified_by = $4,
           verified_at = NOW(),
           updated_at = NOW()
       WHERE hospital_id = $1 AND attribute_key = $2
       RETURNING *`,
      [hospitalId, attributeKey, reason, rejectedBy]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Attribute not found');
    }

    return result.rows[0];
  }

  /**
   * Delete attribute
   */
  async deleteAttribute(hospitalId: string, attributeKey: string) {
    const result = await pool.query(
      `DELETE FROM hospital.hospital_attributes
       WHERE hospital_id = $1 AND attribute_key = $2
       RETURNING *`,
      [hospitalId, attributeKey]
    );

    return result.rows.length > 0;
  }

  /**
   * Add document to attribute (creates junction table entry)
   */
  async addDocumentToAttribute(
    hospitalId: string,
    hospitalAttributeId: string,
    documentId: string,
    isPrimary: boolean = false
  ) {
    // If setting as primary, first unset all other documents as primary
    if (isPrimary) {
      await pool.query(
        `UPDATE hospital.hospital_attribute_documents
         SET is_primary = FALSE
         WHERE hospital_attribute_id = $1`,
        [hospitalAttributeId]
      );
    }

    const result = await pool.query(
      `INSERT INTO hospital.hospital_attribute_documents
       (hospital_id, hospital_attribute_id, document_id, is_primary)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (hospital_attribute_id, document_id)
       DO UPDATE SET
         is_primary = EXCLUDED.is_primary
       RETURNING id, hospital_attribute_id, document_id, is_primary, added_at`,
      [hospitalId, hospitalAttributeId, documentId, isPrimary]
    );

    return result.rows[0];
  }

  /**
   * Remove document from attribute (deletes junction table entry)
   */
  async removeDocumentFromAttribute(
    hospitalId: string,
    hospitalAttributeId: string,
    documentId: string
  ) {
    const wasPrimary = await pool.query(
      `SELECT is_primary FROM hospital.hospital_attribute_documents
       WHERE hospital_attribute_id = $1 AND document_id = $2`,
      [hospitalAttributeId, documentId]
    );

    const isPrimary = wasPrimary.rows.length > 0 && wasPrimary.rows[0].is_primary;

    const result = await pool.query(
      `DELETE FROM hospital.hospital_attribute_documents
       WHERE hospital_id = $1 AND hospital_attribute_id = $2 AND document_id = $3`,
      [hospitalId, hospitalAttributeId, documentId]
    );

    // If deleted document was primary, set another as primary
    if (isPrimary && result.rowCount && result.rowCount > 0) {
      await pool.query(
        `UPDATE hospital.hospital_attribute_documents
         SET is_primary = TRUE
         WHERE id = (
           SELECT id FROM hospital.hospital_attribute_documents
           WHERE hospital_attribute_id = $1
           ORDER BY added_at DESC
           LIMIT 1
         )`,
        [hospitalAttributeId]
      );
    }

    return { success: result.rowCount ? result.rowCount > 0 : false };
  }

  /**
   * Set a document as primary for an attribute
   */
  async setPrimaryDocument(
    hospitalId: string,
    hospitalAttributeId: string,
    documentId: string
  ) {
    // Unset all as primary
    await pool.query(
      `UPDATE hospital.hospital_attribute_documents
       SET is_primary = FALSE
       WHERE hospital_attribute_id = $1`,
      [hospitalAttributeId]
    );

    // Set the specified document as primary
    const result = await pool.query(
      `UPDATE hospital.hospital_attribute_documents
       SET is_primary = TRUE
       WHERE hospital_id = $1 AND hospital_attribute_id = $2 AND document_id = $3
       RETURNING id, hospital_attribute_id, document_id, is_primary, added_at`,
      [hospitalId, hospitalAttributeId, documentId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Document not found for this attribute');
    }

    return result.rows[0];
  }

  // Private helper methods

  private extractValue(input: AttributeValue, dataType: string): AttributeValue {
    const value: AttributeValue = {
      valueBoolean: null,
      valueInteger: null,
      valueText: null,
      valueDate: null
    };

    switch (dataType) {
      case 'boolean':
        value.valueBoolean = input.valueBoolean ?? false;
        break;
      case 'integer':
        value.valueInteger = input.valueInteger ?? null;
        break;
      case 'text':
        value.valueText = input.valueText ?? null;
        break;
      case 'date':
        value.valueDate = input.valueDate ?? null;
        break;
      case 'document':
        // Document type can also store a text description along with the document reference
        value.valueText = input.valueText ?? null;
        break;
    }

    return value;
  }

  private formatAttributeOutput(row: any, documents: any[] = []) {
    const value = this.getFormattedValue(row);

    // Format documents array
    const formattedDocs: AttributeDocument[] = documents.map(doc => ({
      id: doc.id,
      documentId: doc.document_id,
      fileName: doc.file_name,
      fileSize: doc.file_size_bytes,
      mimeType: doc.mime_type,
      uploadedAt: doc.created_at,
      isPrimary: doc.is_primary
    }));

    return {
      id: row.id,
      hospitalId: row.hospital_id,
      attributeKey: row.attribute_key,
      label: row.label,
      category: row.category,
      dataType: row.data_type,
      value,
      certificateNumber: row.certificate_number,
      issueDate: row.issued_at,
      expiresAt: row.expires_at,
      issuingAuthority: row.issuing_authority,
      documents: formattedDocs,
      verificationStatus: row.verification_status,
      verificationMethod: row.verification_method,
      verifiedAt: row.verified_at,
      verificationNotes: row.verification_notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private getFormattedValue(row: any) {
    if (row.value_boolean !== null) return row.value_boolean;
    if (row.value_integer !== null) return row.value_integer;
    if (row.value_text !== null) return row.value_text;
    if (row.value_date !== null) return row.value_date;
    return null;
  }
}

export default new AttributeService();
