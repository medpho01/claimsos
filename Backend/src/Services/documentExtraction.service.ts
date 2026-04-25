import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';
import S3Service from './s3.service.js';

interface ExtractionResult {
  attributeKey: string;
  value: any;
  confidence: number;
  unit?: string;
}

class DocumentExtractionService {
  private claudeApiKey: string | undefined = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  private claudeApiUrl = 'https://api.anthropic.com/v1/messages';
  private model = 'claude-3-5-sonnet-20241022';

  /**
   * Submit document for AI extraction
   */
  async submitForExtraction(documentId: string, autoApply: boolean = false) {
    // Check document exists
    const docRes = await pool.query(
      `SELECT * FROM hospital.hospital_documents WHERE id = $1`,
      [documentId]
    );

    if (docRes.rows.length === 0) {
      throw new apiError(404, 'Document not found');
    }

    const doc = docRes.rows[0];

    // Check if extraction already in progress
    const existingRes = await pool.query(
      `SELECT * FROM hospital.document_extractions WHERE document_id = $1 AND extraction_status IN ('pending', 'processing')`,
      [documentId]
    );

    if (existingRes.rows.length > 0) {
      throw new apiError(400, 'Extraction already in progress for this document');
    }

    // Create extraction record
    const extractionRes = await pool.query(
      `INSERT INTO hospital.document_extractions
       (document_id, extraction_source, extraction_status)
       VALUES ($1, 'claude_ai', 'pending')
       RETURNING *`,
      [documentId]
    );

    const extraction = extractionRes.rows[0];

    // Start async extraction
    this.performExtraction(extraction.id, documentId, doc, autoApply).catch(err => {
      console.error('[DocumentExtraction] Error:', err);
    });

    return extraction;
  }

  /**
   * Perform actual Claude AI extraction (async)
   */
  private async performExtraction(extractionId: string, documentId: string, doc: any, autoApply: boolean) {
    try {
      // Update status to processing
      await pool.query(
        `UPDATE hospital.document_extractions SET extraction_status = 'processing' WHERE id = $1`,
        [extractionId]
      );

      // Download document from S3
      const buffer = await S3Service.download(doc.s3_key);

      // Determine extraction template based on document category/type
      const template = this.getExtractionTemplate(doc.document_category, doc.document_type);

      // Call Claude API with vision capability (if PDF, convert to base64)
      const base64Content = buffer.toString('base64');
      const mimeType = this.getMimeType(doc.mime_type);

      const extractedData = await this.callClaudeAPI(
        base64Content,
        mimeType,
        template,
        doc.document_name
      );

      // Store extraction results
      await pool.query(
        `UPDATE hospital.document_extractions
         SET raw_extracted_data = $2,
             structured_data = $3,
             extraction_status = 'completed',
             updated_at = NOW()
         WHERE id = $1`,
        [extractionId, JSON.stringify(extractedData.raw), JSON.stringify(extractedData.structured)]
      );

      // Auto-apply if enabled
      if (autoApply && doc.attribute_key) {
        await this.applyExtractionToAttribute(doc.hospital_id, doc.attribute_key, extractedData.structured);
      }

      console.log(`[DocumentExtraction] Successfully extracted ${documentId}`);
    } catch (error: any) {
      // Update with error
      await pool.query(
        `UPDATE hospital.document_extractions
         SET extraction_status = 'failed',
             failure_reason = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [extractionId, error.message || 'Unknown error during extraction']
      );

      console.error(`[DocumentExtraction] Failed to extract ${documentId}:`, error);
    }
  }

  /**
   * Call Claude API with document
   */
  private async callClaudeAPI(
    base64Content: string,
    mimeType: string,
    template: string,
    documentName: string
  ) {
    if (!this.claudeApiKey) {
      throw new Error('Claude API key not configured');
    }

    const prompt = `You are a document extraction specialist. Extract structured data from the provided document.

Document: ${documentName}
Document Type: ${mimeType}

EXTRACTION TEMPLATE:
${template}

Please extract all relevant fields from the document. Return both:
1. raw: The exact text/values you found
2. structured: Cleaned and normalized values ready for database storage

Format your response as valid JSON with these two keys. Only return JSON, no other text.`;

    try {
      const response = await fetch(this.claudeApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.claudeApiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 2048,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: prompt
                },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mimeType,
                    data: base64Content
                  }
                }
              ]
            }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`Claude API error: ${response.statusText}`);
      }

      const result = await response.json() as any;
      const content = result.content[0].text;

      // Parse JSON response
      try {
        return JSON.parse(content);
      } catch (e) {
        // Try to extract JSON from response if wrapped in markdown code blocks
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[1]);
        }
        throw new Error('Failed to parse Claude response as JSON');
      }
    } catch (error) {
      throw new Error(`Claude API call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Apply extraction to hospital attribute
   */
  private async applyExtractionToAttribute(hospitalId: string, attributeKey: string, structured: any) {
    const attrRes = await pool.query(
      `SELECT * FROM hospital.attribute_definitions WHERE key = $1`,
      [attributeKey]
    );

    if (attrRes.rows.length === 0) {
      console.warn(`[DocumentExtraction] Attribute ${attributeKey} not found`);
      return;
    }

    const attrDef = attrRes.rows[0];
    let value: any = null;

    // Map extracted data to attribute based on data type
    if (attrDef.data_type === 'boolean') {
      value = this.parseBoolean(structured.value);
    } else if (attrDef.data_type === 'integer') {
      value = parseInt(structured.value);
    } else if (attrDef.data_type === 'date') {
      value = this.parseDate(structured.value);
    } else {
      value = structured.value;
    }

    // Update or create attribute
    await pool.query(
      `INSERT INTO hospital.hospital_attributes
       (hospital_id, attribute_key, value_boolean, value_integer, value_text, value_date,
        certificate_number, issued_at, expires_at, issuing_authority, verification_status)
       VALUES ($1, $2,
         CASE WHEN $3::text = 'boolean' THEN $4::boolean ELSE NULL END,
         CASE WHEN $3::text = 'integer' THEN $4::integer ELSE NULL END,
         CASE WHEN $3::text = 'text' THEN $4::text ELSE NULL END,
         CASE WHEN $3::text = 'date' THEN $4::date ELSE NULL END,
         $5, $6, $7, $8, 'pending_review')
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
         verification_status = 'pending_review',
         updated_at = NOW()`,
      [
        hospitalId,
        attributeKey,
        attrDef.data_type,
        value,
        structured.certificateNumber || null,
        structured.issueDate || null,
        structured.expiryDate || null,
        structured.issuingAuthority || null
      ]
    );
  }

  /**
   * Get extraction results
   */
  async getExtraction(extractionId: string) {
    const result = await pool.query(
      `SELECT * FROM hospital.document_extractions WHERE id = $1`,
      [extractionId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Extraction not found');
    }

    return result.rows[0];
  }

  /**
   * Review and approve extraction
   */
  async approveExtraction(extractionId: string, reviewedBy: string, mappings: any) {
    const extraction = await this.getExtraction(extractionId);

    if (extraction.extraction_status !== 'completed') {
      throw new apiError(400, 'Can only approve completed extractions');
    }

    // Update extraction as reviewed
    await pool.query(
      `UPDATE hospital.document_extractions
       SET reviewed = true, reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $1`,
      [extractionId, reviewedBy]
    );

    // Get document to find hospital and attribute
    const docRes = await pool.query(
      `SELECT * FROM hospital.hospital_documents WHERE id = $1`,
      [extraction.document_id]
    );

    const doc = docRes.rows[0];

    // Apply extractions to attributes
    for (const [attributeKey, value] of Object.entries(mappings)) {
      await this.applyExtractionToAttribute(doc.hospital_id, attributeKey, value as any);
    }

    return { approved: true, appliedTo: Object.keys(mappings).length };
  }

  // Private helper methods

  private getExtractionTemplate(category: string, documentType: string): string {
    const templates: { [key: string]: string } = {
      'compliance_cert.fire_noc': `Extract: issueDate, expiryDate, certificateNumber, issuingAuthority`,
      'compliance_cert.biomedical_waste': `Extract: issueDate, expiryDate, certificateNumber, scope`,
      'accreditation': `Extract: accreditationLevel, issueDate, expiryDate, certificateNumber`,
      'contract': `Extract: effectiveDate, expiryDate, terms, paymentTerms, preAuthValidity`,
      'mou': `Extract: startDate, endDate, keyTerms, signatories`,
      'default': `Extract all relevant information as key-value pairs`
    };

    return templates[documentType] ?? templates[category] ?? templates['default'] ?? 'Extract all relevant information as key-value pairs';
  }

  private getMimeType(mimeType: string): 'image/jpeg' | 'image/png' | 'application/pdf' {
    if (mimeType.includes('pdf')) return 'application/pdf';
    if (mimeType.includes('png')) return 'image/png';
    return 'image/jpeg'; // default
  }

  private parseBoolean(value: any): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return ['yes', 'true', '1', 'available', 'present'].includes(value.toLowerCase());
    }
    return !!value;
  }

  private parseDate(value: any): string | null {
    if (!value) return null;
    try {
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0] ?? null;
      }
    } catch (e) {
      // Fall through
    }
    return null;
  }
}

export default new DocumentExtractionService();
