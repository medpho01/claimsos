import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';
import { logger } from '../Utils/logger.js';

interface PanelAttributeDocumentInput {
  document_id: string;
  version?: string;
  effective_date?: string;
  expiry_date?: string;
  is_primary?: boolean;
}

class PanelAttributeDocumentService {
  /**
   * Get all documents for a panel attribute
   */
  async getDocumentsByAttribute(panelAttributeId: string) {
    try {
      const result = await pool.query(
        `SELECT
          pad.id,
          pad.panel_attribute_id,
          pad.document_id,
          pad.version,
          pad.effective_date,
          pad.expiry_date,
          pad.is_primary,
          pad.added_at,
          hd.file_name,
          hd.file_size_bytes,
          hd.mime_type,
          hd.s3_key
        FROM hospital.panel_attribute_documents pad
        LEFT JOIN hospital.hospital_documents hd ON pad.document_id = hd.id
        WHERE pad.panel_attribute_id = $1
        ORDER BY pad.is_primary DESC, pad.added_at DESC`,
        [panelAttributeId]
      );

      return result.rows;
    } catch (err) {
      logger.error({ err, panelAttributeId }, 'error fetching panel attribute documents');
      throw err;
    }
  }

  /**
   * Get specific document
   */
  async getDocument(documentId: string) {
    try {
      const result = await pool.query(
        `SELECT
          pad.id,
          pad.panel_attribute_id,
          pad.document_id,
          pad.version,
          pad.effective_date,
          pad.expiry_date,
          pad.is_primary,
          pad.added_at,
          hd.file_name,
          hd.file_size_bytes,
          hd.mime_type,
          hd.s3_key
        FROM hospital.panel_attribute_documents pad
        LEFT JOIN hospital.hospital_documents hd ON pad.document_id = hd.id
        WHERE pad.id = $1`,
        [documentId]
      );

      if (result.rows.length === 0) {
        throw new apiError(404, 'Panel attribute document not found');
      }

      return result.rows[0];
    } catch (err) {
      logger.error({ err, documentId }, 'error fetching panel attribute document');
      throw err;
    }
  }

  /**
   * Add document to panel attribute
   */
  async addDocument(panelAttributeId: string, input: PanelAttributeDocumentInput) {
    try {
      const { document_id, version, effective_date, expiry_date, is_primary } = input;

      // Verify document exists
      const docCheck = await pool.query(
        `SELECT id FROM hospital.hospital_documents WHERE id = $1`,
        [document_id]
      );

      if (docCheck.rows.length === 0) {
        throw new apiError(404, 'Document not found');
      }

      // If this is being set as primary, unset other primaries for this attribute
      if (is_primary) {
        await pool.query(
          `UPDATE hospital.panel_attribute_documents
           SET is_primary = false
           WHERE panel_attribute_id = $1 AND id != $2`,
          [panelAttributeId, '']  // We don't have the new doc ID yet, so this won't affect new inserts
        );
      }

      const result = await pool.query(
        `INSERT INTO hospital.panel_attribute_documents
         (panel_attribute_id, document_id, version, effective_date, expiry_date, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (panel_attribute_id, document_id) DO UPDATE
         SET version = $3, effective_date = $4, expiry_date = $5, is_primary = $6
         RETURNING id, version, effective_date, expiry_date, is_primary, added_at`,
        [panelAttributeId, document_id, version || null, effective_date || null, expiry_date || null, is_primary || false]
      );

      return result.rows[0];
    } catch (err) {
      logger.error({ err, panelAttributeId }, 'error adding panel attribute document');
      throw err;
    }
  }

  /**
   * Update document metadata
   */
  async updateDocument(documentId: string, input: Partial<PanelAttributeDocumentInput>) {
    try {
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (input.version !== undefined) {
        updates.push(`version = $${paramIndex++}`);
        values.push(input.version || null);
      }

      if (input.effective_date !== undefined) {
        updates.push(`effective_date = $${paramIndex++}`);
        values.push(input.effective_date || null);
      }

      if (input.expiry_date !== undefined) {
        updates.push(`expiry_date = $${paramIndex++}`);
        values.push(input.expiry_date || null);
      }

      if (input.is_primary !== undefined) {
        updates.push(`is_primary = $${paramIndex++}`);
        values.push(input.is_primary);

        // If setting as primary, unset others in same attribute
        if (input.is_primary) {
          const attrResult = await pool.query(
            `SELECT panel_attribute_id FROM hospital.panel_attribute_documents WHERE id = $1`,
            [documentId]
          );
          if (attrResult.rows.length > 0) {
            await pool.query(
              `UPDATE hospital.panel_attribute_documents
               SET is_primary = false
               WHERE panel_attribute_id = $1 AND id != $2`,
              [attrResult.rows[0].panel_attribute_id, documentId]
            );
          }
        }
      }

      if (updates.length === 0) {
        return await this.getDocument(documentId);
      }

      values.push(documentId);

      const result = await pool.query(
        `UPDATE hospital.panel_attribute_documents
         SET ${updates.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING id, version, effective_date, expiry_date, is_primary, added_at`,
        values
      );

      if (result.rows.length === 0) {
        throw new apiError(404, 'Panel attribute document not found');
      }

      return result.rows[0];
    } catch (err) {
      logger.error({ err, documentId }, 'error updating panel attribute document');
      throw err;
    }
  }

  /**
   * Remove document from panel attribute
   */
  async removeDocument(documentId: string) {
    try {
      const result = await pool.query(
        `DELETE FROM hospital.panel_attribute_documents WHERE id = $1 RETURNING id`,
        [documentId]
      );

      if (result.rows.length === 0) {
        throw new apiError(404, 'Panel attribute document not found');
      }

      return { success: true };
    } catch (err) {
      logger.error({ err, documentId }, 'error removing panel attribute document');
      throw err;
    }
  }

  /**
   * Set document as primary for an attribute
   */
  async setPrimaryDocument(documentId: string) {
    try {
      // Get the attribute first
      const docResult = await pool.query(
        `SELECT panel_attribute_id FROM hospital.panel_attribute_documents WHERE id = $1`,
        [documentId]
      );

      if (docResult.rows.length === 0) {
        throw new apiError(404, 'Document not found');
      }

      const panelAttributeId = docResult.rows[0].panel_attribute_id;

      // Unset all primary for this attribute
      await pool.query(
        `UPDATE hospital.panel_attribute_documents
         SET is_primary = false
         WHERE panel_attribute_id = $1`,
        [panelAttributeId]
      );

      // Set this document as primary
      const result = await pool.query(
        `UPDATE hospital.panel_attribute_documents
         SET is_primary = true
         WHERE id = $1
         RETURNING id, is_primary, added_at`,
        [documentId]
      );

      return result.rows[0];
    } catch (err) {
      logger.error({ err, documentId }, 'error setting primary panel attribute document');
      throw err;
    }
  }

  /**
   * Get documents expiring soon for an attribute
   */
  async getExpiringDocuments(panelAttributeId: string, withinDays: number = 30) {
    try {
      const result = await pool.query(
        `SELECT
          pad.id,
          pad.document_id,
          pad.version,
          pad.expiry_date,
          hd.file_name,
          EXTRACT(DAY FROM pad.expiry_date - CURRENT_DATE) as days_until_expiry
        FROM hospital.panel_attribute_documents pad
        LEFT JOIN hospital.hospital_documents hd ON pad.document_id = hd.id
        WHERE pad.panel_attribute_id = $1
          AND pad.expiry_date IS NOT NULL
          AND pad.expiry_date <= CURRENT_DATE + make_interval(days => $2)
          AND pad.expiry_date > CURRENT_DATE
        ORDER BY pad.expiry_date ASC`,
        [panelAttributeId, Number.isFinite(withinDays) && withinDays > 0 ? Math.floor(withinDays) : 30]
      );

      return result.rows;
    } catch (err) {
      logger.error({ err, panelAttributeId }, 'error fetching expiring panel attribute documents');
      throw err;
    }
  }

  /**
   * Get expired documents for an attribute
   */
  async getExpiredDocuments(panelAttributeId: string) {
    try {
      const result = await pool.query(
        `SELECT
          pad.id,
          pad.version,
          pad.expiry_date,
          hd.file_name
        FROM hospital.panel_attribute_documents pad
        LEFT JOIN hospital.hospital_documents hd ON pad.document_id = hd.id
        WHERE pad.panel_attribute_id = $1
          AND pad.expiry_date IS NOT NULL
          AND pad.expiry_date < CURRENT_DATE
        ORDER BY pad.expiry_date DESC`,
        [panelAttributeId]
      );

      return result.rows;
    } catch (err) {
      logger.error({ err, panelAttributeId }, 'error fetching expired panel attribute documents');
      throw err;
    }
  }
}

export default new PanelAttributeDocumentService();
