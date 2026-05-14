import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';
import panelAttributeDefinitionService from './panelAttributeDefinition.service.js';

interface PanelAttributeInput {
  panel_attribute_definition_id?: string;
  attribute_key?: string;
  value_text?: string;
  value_boolean?: boolean;
  value_date?: string;
  value_json?: any;
  value_encrypted?: string;
  document_id?: string;
}

class PanelAttributeService {
  /**
   * Fleet view: every linked panel for a hospital with all its attributes
   * folded into one round-trip. Optimised for the Panels-tab table.
   */
  async getFleetForHospital(hospitalId: string) {
    try {
      const result = await pool.query(
        `SELECT
          hp.id              AS hospital_panel_id,
          hp.panel_id        AS panel_id,
          p.name             AS panel_name,
          hp.contact         AS contact,
          hp.sheet_id        AS sheet_id,
          hp.drive_folder_id AS drive_folder_id,
          COALESCE(pat.attributes, '[]'::json) AS attributes
        FROM hospital.hospital_panels hp
        JOIN hospital.panels p ON hp.panel_id = p.id
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'id',             pa.id,
              'attribute_key',  pa.attribute_key,
              'label',          pad.label,
              'category',       pad.category,
              'data_type',      pad.data_type,
              'options',        pad.options,
              'sort_order',     pad.sort_order,
              'value_text',     pa.value_text,
              'value_boolean',  pa.value_boolean,
              'value_date',     pa.value_date,
              'value_json',     pa.value_json,
              'value_encrypted',pa.value_encrypted,
              'document_id',    pa.document_id,
              'updated_at',     pa.updated_at
            )
            ORDER BY pad.category, pad.sort_order, pad.label
          ) AS attributes
          FROM hospital.panel_attributes pa
          JOIN hospital.panel_attribute_definitions pad
            ON pa.panel_attribute_definition_id = pad.id
          WHERE pa.hospital_panel_id = hp.id
        ) pat ON true
        WHERE hp.hospital_id = $1
        ORDER BY p.name ASC`,
        [hospitalId]
      );
      return result.rows;
    } catch (err) {
      console.error('Error fetching panel fleet:', err);
      throw err;
    }
  }

  /**
   * Get all attributes for a hospital-panel relationship
   */
  async getAttributesByPanelRelationship(hospitalPanelId: string) {
    try {
      const result = await pool.query(
        `SELECT
          pa.id,
          pa.hospital_panel_id,
          pa.panel_attribute_definition_id,
          pa.attribute_key,
          pa.value_text,
          pa.value_boolean,
          pa.value_date,
          pa.value_json,
          pa.value_encrypted,
          pa.document_id,
          pa.is_valid,
          pa.validation_errors,
          pa.created_at,
          pa.updated_at,
          pad.label,
          pad.description,
          pad.category,
          pad.data_type,
          pad.options,
          pad.is_required,
          pad.validation_regex,
          COALESCE(
            json_agg(
              json_build_object(
                'id', padic.id,
                'documentId', padic.document_id,
                'fileName', hd.file_name,
                'fileSize', hd.file_size_bytes,
                'mimeType', hd.mime_type,
                'uploadedAt', padic.added_at,
                'isPrimary', padic.is_primary
              ) ORDER BY padic.is_primary DESC, padic.added_at ASC
            ) FILTER (WHERE padic.id IS NOT NULL),
            '[]'::json
          ) as documents
        FROM hospital.panel_attributes pa
        LEFT JOIN hospital.panel_attribute_definitions pad ON pa.panel_attribute_definition_id = pad.id
        LEFT JOIN hospital.panel_attribute_documents padic ON pa.id = padic.panel_attribute_id
        LEFT JOIN hospital.hospital_documents hd ON padic.document_id = hd.id
        WHERE pa.hospital_panel_id = $1
        GROUP BY pa.id, pad.id, pad.category, pad.sort_order
        ORDER BY pad.category, pad.sort_order`,
        [hospitalPanelId]
      );

      return result.rows;
    } catch (err) {
      console.error('Error fetching panel attributes:', err);
      throw err;
    }
  }

  /**
   * Get attributes by hospital and panel IDs
   */
  async getAttributesByHospitalAndPanel(hospitalId: string, panelId: string) {
    try {
      // First get the hospital_panel_id
      const panelRelResult = await pool.query(
        `SELECT id FROM hospital.hospital_panels WHERE hospital_id = $1 AND panel_id = $2`,
        [hospitalId, panelId]
      );

      if (panelRelResult.rows.length === 0) {
        throw new apiError(404, 'Hospital-panel relationship not found');
      }

      const hospitalPanelId = panelRelResult.rows[0].id;
      return await this.getAttributesByPanelRelationship(hospitalPanelId);
    } catch (err) {
      console.error('Error fetching panel attributes by IDs:', err);
      throw err;
    }
  }

  /**
   * Get specific attribute
   */
  async getAttribute(attributeId: string) {
    try {
      const result = await pool.query(
        `SELECT
          pa.id,
          pa.hospital_panel_id,
          pa.panel_attribute_definition_id,
          pa.attribute_key,
          pa.value_text,
          pa.value_boolean,
          pa.value_date,
          pa.value_json,
          pa.value_encrypted,
          pa.document_id,
          pa.is_valid,
          pa.validation_errors,
          pa.created_at,
          pa.updated_at,
          pad.label,
          pad.description,
          pad.category,
          pad.data_type,
          pad.options,
          pad.is_required,
          pad.validation_regex,
          COALESCE(
            json_agg(
              json_build_object(
                'id', padic.id,
                'documentId', padic.document_id,
                'fileName', hd.file_name,
                'fileSize', hd.file_size_bytes,
                'mimeType', hd.mime_type,
                'uploadedAt', padic.added_at,
                'isPrimary', padic.is_primary
              ) ORDER BY padic.is_primary DESC, padic.added_at ASC
            ) FILTER (WHERE padic.id IS NOT NULL),
            '[]'::json
          ) as documents
        FROM hospital.panel_attributes pa
        LEFT JOIN hospital.panel_attribute_definitions pad ON pa.panel_attribute_definition_id = pad.id
        LEFT JOIN hospital.panel_attribute_documents padic ON pa.id = padic.panel_attribute_id
        LEFT JOIN hospital.hospital_documents hd ON padic.document_id = hd.id
        WHERE pa.id = $1
        GROUP BY pa.id, pad.id`,
        [attributeId]
      );

      if (result.rows.length === 0) {
        throw new apiError(404, 'Panel attribute not found');
      }

      return result.rows[0];
    } catch (err) {
      console.error('Error fetching panel attribute:', err);
      throw err;
    }
  }

  /**
   * Create or update panel attribute value
   */
  async setAttributeValue(
    hospitalPanelId: string,
    hospitalId: string,
    panelId: string,
    input: PanelAttributeInput,
    userId?: string
  ) {
    try {
      let definitionId = input.panel_attribute_definition_id;
      let attributeKey = input.attribute_key;

      // If only key provided, look up the definition ID
      if (!definitionId && attributeKey) {
        const def = await panelAttributeDefinitionService.getDefinitionByKey(attributeKey);
        definitionId = def.id;
      }

      if (!definitionId) {
        throw new apiError(400, 'panel_attribute_definition_id or attribute_key is required');
      }

      // Get definition for key if not provided
      if (!attributeKey) {
        const def = await panelAttributeDefinitionService.getDefinitionById(definitionId);
        attributeKey = def.key;
      }

      // Check if attribute already exists
      const existingResult = await pool.query(
        `SELECT id FROM hospital.panel_attributes
         WHERE hospital_panel_id = $1 AND panel_attribute_definition_id = $2`,
        [hospitalPanelId, definitionId]
      );

      if (existingResult.rows.length > 0) {
        // Update existing
        return await this.updateAttributeValue(existingResult.rows[0].id, input, userId);
      }

      // Create new
      const result = await pool.query(
        `INSERT INTO hospital.panel_attributes
         (hospital_panel_id, panel_attribute_definition_id, hospital_id, panel_id,
          attribute_key, value_text, value_boolean, value_date, value_json,
          value_encrypted, document_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id, hospital_panel_id, attribute_key, value_text, value_boolean,
                   value_date, value_json, document_id, is_valid, created_at, updated_at`,
        [
          hospitalPanelId, definitionId, hospitalId, panelId, attributeKey,
          input.value_text || null,
          input.value_boolean !== undefined ? input.value_boolean : null,
          input.value_date || null,
          input.value_json ? JSON.stringify(input.value_json) : null,
          input.value_encrypted || null,
          input.document_id || null,
          userId || null,
          userId || null
        ]
      );

      return result.rows[0];
    } catch (err) {
      console.error('Error setting panel attribute value:', err);
      throw err;
    }
  }

  /**
   * Update panel attribute value
   */
  async updateAttributeValue(attributeId: string, input: Partial<PanelAttributeInput>, userId?: string) {
    try {
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (input.value_text !== undefined) {
        updates.push(`value_text = $${paramIndex++}`);
        values.push(input.value_text || null);
      }

      if (input.value_boolean !== undefined) {
        updates.push(`value_boolean = $${paramIndex++}`);
        values.push(input.value_boolean);
      }

      if (input.value_date !== undefined) {
        updates.push(`value_date = $${paramIndex++}`);
        values.push(input.value_date || null);
      }

      if (input.value_json !== undefined) {
        updates.push(`value_json = $${paramIndex++}`);
        values.push(input.value_json ? JSON.stringify(input.value_json) : null);
      }

      if (input.value_encrypted !== undefined) {
        updates.push(`value_encrypted = $${paramIndex++}`);
        values.push(input.value_encrypted || null);
      }

      if (input.document_id !== undefined) {
        updates.push(`document_id = $${paramIndex++}`);
        values.push(input.document_id || null);
      }

      if (updates.length === 0) {
        return await this.getAttribute(attributeId);
      }

      updates.push(`updated_at = NOW()`);
      if (userId) {
        updates.push(`updated_by = $${paramIndex++}`);
        values.push(userId);
      }

      values.push(attributeId);

      const result = await pool.query(
        `UPDATE hospital.panel_attributes
         SET ${updates.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING id, attribute_key, value_text, value_boolean, value_date,
                   value_json, document_id, is_valid, updated_at`,
        values
      );

      if (result.rows.length === 0) {
        throw new apiError(404, 'Panel attribute not found');
      }

      return result.rows[0];
    } catch (err) {
      console.error('Error updating panel attribute:', err);
      throw err;
    }
  }

  /**
   * Delete panel attribute
   */
  async deleteAttribute(attributeId: string) {
    try {
      const result = await pool.query(
        `DELETE FROM hospital.panel_attributes WHERE id = $1 RETURNING id`,
        [attributeId]
      );

      if (result.rows.length === 0) {
        throw new apiError(404, 'Panel attribute not found');
      }

      return { success: true };
    } catch (err) {
      console.error('Error deleting panel attribute:', err);
      throw err;
    }
  }

  /**
   * Bulk set multiple attributes at once
   */
  async setMultipleAttributes(
    hospitalPanelId: string,
    hospitalId: string,
    panelId: string,
    attributes: PanelAttributeInput[],
    userId?: string
  ) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const results = [];
      for (const attr of attributes) {
        const result = await this.setAttributeValue(
          hospitalPanelId,
          hospitalId,
          panelId,
          attr,
          userId
        );
        results.push(result);
      }

      await client.query('COMMIT');
      return results;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error setting multiple panel attributes:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get attributes with complete hospital-panel info
   */
  async getCompleteAttributeInfo(hospitalId: string, panelId: string) {
    try {
      // Get hospital-panel relationship first
      const panelRelResult = await pool.query(
        `SELECT hp.id, hp.hospital_id, hp.panel_id, h.name as hospital_name, p.name as panel_name,
                hp.whatsapp_group_id, hp.sheet_id, hp.drive_folder_id
         FROM hospital.hospital_panels hp
         LEFT JOIN hospital.hospitals h ON hp.hospital_id = h.id
         LEFT JOIN hospital.panels p ON hp.panel_id = p.id
         WHERE hp.hospital_id = $1 AND hp.panel_id = $2`,
        [hospitalId, panelId]
      );

      if (panelRelResult.rows.length === 0) {
        throw new apiError(404, 'Hospital-panel relationship not found');
      }

      const hospitalPanel = panelRelResult.rows[0];
      const attributes = await this.getAttributesByPanelRelationship(hospitalPanel.id);

      return {
        hospital_panel: {
          id: hospitalPanel.id,
          hospital_id: hospitalPanel.hospital_id,
          panel_id: hospitalPanel.panel_id,
          hospital_name: hospitalPanel.hospital_name,
          panel_name: hospitalPanel.panel_name,
          whatsapp_group_id: hospitalPanel.whatsapp_group_id,
          sheet_id: hospitalPanel.sheet_id,
          drive_folder_id: hospitalPanel.drive_folder_id
        },
        panel_attributes: attributes
      };
    } catch (err) {
      console.error('Error fetching complete attribute info:', err);
      throw err;
    }
  }

  /**
   * Atomic update: update attribute value + link/unlink documents in a transaction
   * Ensures data consistency - either all operations succeed or all fail
   */
  async updateAttributeWithDocumentsAtomic(
    hospitalPanelId: string,
    attributeId: string,
    attributeInput: Partial<PanelAttributeInput>,
    documentIdsToLink: string[] = [],
    documentIdsToUnlink: string[] = [],
    userId?: string
  ) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      console.log('🔄 Starting transaction for attribute update with documents');

      // 1. Update the attribute value
      if (Object.keys(attributeInput).length > 0) {
        const updates: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (attributeInput.value_text !== undefined) {
          updates.push(`value_text = $${paramIndex++}`);
          values.push(attributeInput.value_text || null);
        }
        if (attributeInput.value_boolean !== undefined) {
          updates.push(`value_boolean = $${paramIndex++}`);
          values.push(attributeInput.value_boolean || null);
        }
        if (attributeInput.value_date !== undefined) {
          updates.push(`value_date = $${paramIndex++}`);
          values.push(attributeInput.value_date || null);
        }
        if (attributeInput.value_json !== undefined) {
          updates.push(`value_json = $${paramIndex++}`);
          values.push(attributeInput.value_json ? JSON.stringify(attributeInput.value_json) : null);
        }
        if (attributeInput.value_encrypted !== undefined) {
          updates.push(`value_encrypted = $${paramIndex++}`);
          values.push(attributeInput.value_encrypted || null);
        }
        if (attributeInput.document_id !== undefined) {
          updates.push(`document_id = $${paramIndex++}`);
          values.push(attributeInput.document_id || null);
        }

        if (updates.length > 0) {
          updates.push(`updated_by = $${paramIndex}`);
          values.push(userId || null);
          values.push(attributeId);

          const updateQuery = `
            UPDATE hospital.panel_attributes
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id = $${paramIndex + 1}
            RETURNING id, attribute_key, updated_at
          `;

          const result = await client.query(updateQuery, values);
          console.log(`✅ Attribute updated: ${result.rows[0]?.attribute_key}`);
        }
      }

      // 2. Link new documents
      for (const docId of documentIdsToLink) {
        console.log(`🔗 Linking document: ${docId}`);
        await client.query(
          `INSERT INTO hospital.panel_attribute_documents
           (panel_attribute_id, document_id, is_primary)
           VALUES ($1, $2, FALSE)
           ON CONFLICT (panel_attribute_id, document_id) DO NOTHING`,
          [attributeId, docId]
        );
      }

      // 3. Unlink documents
      for (const docId of documentIdsToUnlink) {
        console.log(`🔓 Unlinking document: ${docId}`);
        await client.query(
          `DELETE FROM hospital.panel_attribute_documents
           WHERE panel_attribute_id = $1 AND document_id = $2`,
          [attributeId, docId]
        );
      }

      await client.query('COMMIT');
      console.log('✅ Transaction committed successfully');

      // Fetch and return updated attribute
      return await this.getAttribute(attributeId);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ Transaction rolled back due to error:', err);
      throw err;
    } finally {
      client.release();
    }
  }
}

export default new PanelAttributeService();
