import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';
import S3Service from './s3.service.js';

interface DocumentUploadInput {
  hospitalId: string;
  documentName: string;
  documentCategory: string;
  documentType: string;
  attributeKey?: string;
  panelEmpanelmentId?: string;
  issueDate?: string;
  expiryDate?: string;
  uploadedBy: string;
}

interface DocumentMetadata {
  id: string;
  hospitalId: string;
  documentName: string;
  documentCategory: string;
  documentType: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  s3Key: string;
  expiryDate?: string;
  uploadedBy: string;
  createdAt: string;
  attributeKey?: string;
}

class AttachmentService {
  /**
   * Upload document and create metadata record
   */
  async uploadDocument(
    buffer: Buffer,
    input: DocumentUploadInput,
    fileName: string,
    mimeType: string
  ) {
    // Validate hospital exists
    const hospitalRes = await pool.query(
      `SELECT id FROM hospital.hospitals WHERE id = $1`,
      [input.hospitalId]
    );

    if (hospitalRes.rows.length === 0) {
      throw new apiError(404, 'Hospital not found');
    }

    try {
      // Upload to S3
      const { s3Key } = await S3Service.upload(
        `hospitals/${input.hospitalId}/documents/${input.documentCategory}/${Date.now()}_${fileName}`,
        buffer,
        mimeType
      );

      // Create document record
      const docRes = await pool.query(
        `INSERT INTO hospital.hospital_documents
         (hospital_id, document_name, document_category, document_type, attribute_key,
          panel_empanelment_id, s3_key, file_name, mime_type, file_size_bytes,
          expiry_date, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          input.hospitalId,
          input.documentName,
          input.documentCategory,
          input.documentType,
          input.attributeKey,
          input.panelEmpanelmentId,
          s3Key,
          fileName,
          mimeType,
          buffer.length,
          input.expiryDate || null,
          input.uploadedBy
        ]
      );

      const document = docRes.rows[0];
      return this.formatDocumentOutput(document);
    } catch (error) {
      throw new apiError(500, `Failed to upload document: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get document metadata
   */
  async getDocument(documentId: string) {
    const result = await pool.query(
      `SELECT * FROM hospital.hospital_documents WHERE id = $1`,
      [documentId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Document not found');
    }

    return this.formatDocumentOutput(result.rows[0]);
  }

  /**
   * Get hospital documents (with optional filtering)
   */
  async getHospitalDocuments(
    hospitalId: string,
    category?: string,
    type?: string,
    attributeKey?: string
  ) {
    let query = `SELECT * FROM hospital.hospital_documents WHERE hospital_id = $1`;
    const params: any[] = [hospitalId];
    let paramIndex = 2;

    if (category) {
      query += ` AND document_category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (type) {
      query += ` AND document_type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (attributeKey) {
      query += ` AND attribute_key = $${paramIndex}`;
      params.push(attributeKey);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows.map(doc => this.formatDocumentOutput(doc));
  }

  /**
   * Get panel documents
   */
  async getPanelDocuments(panelEmpanelmentId: string) {
    const result = await pool.query(
      `SELECT hd.*, pd.doc_type, pd.is_active, pd.effective_date, pd.expiry_date
       FROM hospital.hospital_documents hd
       LEFT JOIN hospital.panel_documents pd ON hd.id = pd.document_id
       WHERE hd.panel_empanelment_id = $1
       ORDER BY hd.created_at DESC`,
      [panelEmpanelmentId]
    );

    return result.rows;
  }

  /**
   * Download document from S3
   */
  async downloadDocument(documentId: string) {
    const doc = await this.getDocument(documentId);

    try {
      const buffer = await S3Service.download(doc.s3Key);
      return {
        buffer,
        fileName: doc.fileName,
        mimeType: doc.mimeType
      };
    } catch (error) {
      throw new apiError(500, `Failed to download document: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Delete document
   */
  async deleteDocument(documentId: string) {
    const doc = await this.getDocument(documentId);

    try {
      // Delete from S3
      await S3Service.delete(doc.s3Key);

      // Delete from database
      await pool.query(
        `DELETE FROM hospital.hospital_documents WHERE id = $1`,
        [documentId]
      );

      return { deleted: true };
    } catch (error) {
      throw new apiError(500, `Failed to delete document: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Update document metadata
   */
  async updateDocumentMetadata(
    documentId: string,
    updates: Partial<{
      documentName: string;
      issueDate: string;
      expiryDate: string;
      notes: string;
    }>
  ) {
    const updateFields = [];
    const values = [];
    let paramIndex = 1;

    if (updates.documentName !== undefined) {
      updateFields.push(`document_name = $${paramIndex++}`);
      values.push(updates.documentName);
    }
    if (updates.issueDate !== undefined) {
      updateFields.push(`issue_date = $${paramIndex++}`);
      values.push(updates.issueDate || null);
    }
    if (updates.expiryDate !== undefined) {
      updateFields.push(`expiry_date = $${paramIndex++}`);
      values.push(updates.expiryDate || null);
    }
    if (updates.notes !== undefined) {
      updateFields.push(`notes = $${paramIndex++}`);
      values.push(updates.notes);
    }

    if (updateFields.length === 0) {
      return await this.getDocument(documentId);
    }

    updateFields.push(`updated_at = NOW()`);
    values.push(documentId);

    const result = await pool.query(
      `UPDATE hospital.hospital_documents
       SET ${updateFields.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Document not found');
    }

    return this.formatDocumentOutput(result.rows[0]);
  }

  /**
   * Link document to attribute
   */
  async linkToAttribute(documentId: string, attributeKey: string, hospitalId: string) {
    const updateRes = await pool.query(
      `UPDATE hospital.hospital_documents
       SET attribute_key = $2
       WHERE id = $1 AND hospital_id = $3
       RETURNING *`,
      [documentId, attributeKey, hospitalId]
    );

    if (updateRes.rows.length === 0) {
      throw new apiError(404, 'Document not found or does not belong to this hospital');
    }

    // Update attribute to reference this document
    const attrRes = await pool.query(
      `SELECT * FROM hospital.hospital_attributes
       WHERE hospital_id = $1 AND attribute_key = $2`,
      [hospitalId, attributeKey]
    );

    if (attrRes.rows.length > 0) {
      await pool.query(
        `UPDATE hospital.hospital_attributes
         SET document_id = $1
         WHERE hospital_id = $2 AND attribute_key = $3`,
        [documentId, hospitalId, attributeKey]
      );
    }

    return this.formatDocumentOutput(updateRes.rows[0]);
  }

  /**
   * Get document upload progress (for large files)
   */
  async getUploadStatus(documentId: string) {
    const result = await pool.query(
      `SELECT id, document_name, file_size_bytes, created_at FROM hospital.hospital_documents WHERE id = $1`,
      [documentId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Document not found');
    }

    const doc = result.rows[0];
    return {
      documentId: doc.id,
      fileName: doc.document_name,
      fileSize: doc.file_size_bytes,
      uploadedAt: doc.created_at,
      status: 'completed'
    };
  }

  /**
   * Get document storage usage for hospital
   */
  async getStorageUsage(hospitalId: string) {
    const result = await pool.query(
      `SELECT
        COUNT(*) as file_count,
        SUM(file_size_bytes) as total_bytes,
        COUNT(DISTINCT document_category) as categories
       FROM hospital.hospital_documents
       WHERE hospital_id = $1`,
      [hospitalId]
    );

    const stats = result.rows[0];
    const totalBytes = stats.total_bytes || 0;
    const totalMB = Math.round(totalBytes / (1024 * 1024) * 100) / 100;

    return {
      fileCount: parseInt(stats.file_count),
      totalSize: totalMB,
      totalSizeBytes: totalBytes,
      categories: parseInt(stats.categories)
    };
  }

  /**
   * Cleanup expired documents (optional policy)
   */
  async cleanupExpiredDocuments(daysAfterExpiry: number = 365) {
    const result = await pool.query(
      `DELETE FROM hospital.hospital_documents
       WHERE expiry_date IS NOT NULL
       AND expiry_date < CURRENT_DATE - INTERVAL '1 day' * $1
       RETURNING id, s3_key`,
      [daysAfterExpiry]
    );

    // Delete from S3
    for (const doc of result.rows) {
      try {
        await S3Service.delete(doc.s3_key);
      } catch (error) {
        console.error(`Failed to delete ${doc.s3_key} from S3:`, error);
      }
    }

    return { deletedCount: result.rows.length };
  }

  // Private helpers

  /**
   * Get multiple documents by IDs (batch operation)
   * Performance optimization: single query for multiple documents
   */
  async getBatchDocuments(hospitalId: string, documentIds: string[]): Promise<DocumentMetadata[]> {
    if (documentIds.length === 0) {
      return [];
    }

    // Build placeholders for parameterized query
    const placeholders = documentIds.map((_, i) => `$${i + 2}`).join(',');
    const params = [hospitalId, ...documentIds];

    const result = await pool.query(
      `SELECT * FROM hospital.hospital_documents
       WHERE hospital_id = $1 AND id IN (${placeholders})
       ORDER BY created_at DESC`,
      params
    );

    console.log(`✅ Retrieved ${result.rows.length} documents from database`);

    return result.rows.map(row => this.formatDocumentOutput(row));
  }

  private formatDocumentOutput(row: any): DocumentMetadata {
    return {
      id: row.id,
      hospitalId: row.hospital_id,
      documentName: row.document_name,
      documentCategory: row.document_category,
      documentType: row.document_type,
      fileName: row.file_name,
      mimeType: row.mime_type,
      fileSizeBytes: row.file_size_bytes,
      s3Key: row.s3_key,
      expiryDate: row.expiry_date,
      uploadedBy: row.uploaded_by,
      createdAt: row.created_at,
      attributeKey: row.attribute_key
    };
  }
}

export default new AttachmentService();
