import type { Pool, PoolClient } from 'pg';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import apiError from '../Utils/errorHandler.util.js';

// Both Pool and PoolClient expose the same .query() signature.
type Queryable = Pool | PoolClient;

/**
 * Panel Defaults Service
 *
 * Owns the lifecycle of `panel_default_attributes` — the SOP-derived
 * default values per panel — and the mechanism that pre-fills
 * `panel_attributes` rows when a hospital enables a new panel.
 *
 * The expected flow:
 *   1. SOP seed (migration 016) populates panel_default_attributes.
 *   2. When a hospital is enrolled in a panel (hospital_panels row created),
 *      `applyDefaults()` is called to copy each default into panel_attributes
 *      for that (hospital_panel × definition) pair.
 *   3. Hospital admin can subsequently override any value via the existing
 *      panel-attribute UI.
 *
 * Idempotency: applyDefaults uses INSERT ... ON CONFLICT DO NOTHING so
 * re-running is safe. Hospital edits are never overwritten.
 *
 * Some special attribute keys carry a CODE rather than a UUID:
 *   - 'preauth_form_template_id' has the form template's CODE as default;
 *     resolved to the actual UUID at runtime via preauth_form_templates.
 *   - 'mou_template_id' has the MoU template's CODE as default; resolved
 *     similarly.
 * Resolution is done in this service before insert so panel_attributes
 * stores the resolved UUID.
 */

interface ApplyDefaultsResult {
  hospital_panel_id: string;
  panel_id: string;
  total_defaults: number;
  attributes_inserted: number;
  attributes_skipped: number;     // already had a value
  attributes_failed: string[];    // attribute keys that errored
}

class PanelDefaultsService {
  /**
   * Apply the SOP-derived defaults for a given panel to a specific
   * hospital_panel row. Skips attributes the hospital has already set.
   *
   * Run inside a transaction when called from a larger operation —
   * pass the client; otherwise it runs against the pool.
   */
  async applyDefaults(
    hospitalPanelId: string,
    panelId: string,
    hospitalId: string,
    db: Queryable = pool,
    userId?: string
  ): Promise<ApplyDefaultsResult> {
    const result: ApplyDefaultsResult = {
      hospital_panel_id: hospitalPanelId,
      panel_id: panelId,
      total_defaults: 0,
      attributes_inserted: 0,
      attributes_skipped: 0,
      attributes_failed: [],
    };

    try {
      // Pull all defaults for this panel along with their definition key.
      // We need the key to apply special resolution (CODE → UUID) for
      // preauth_form_template_id and mou_template_id.
      const defaultsRes = await db.query(
        `SELECT
           pda.id                                AS default_id,
           pda.panel_attribute_definition_id     AS definition_id,
           pda.default_value_text,
           pda.default_value_boolean,
           pda.default_value_date,
           pda.default_value_json,
           pad.key                               AS attribute_key,
           pad.data_type
         FROM hospital.panel_default_attributes pda
         JOIN hospital.panel_attribute_definitions pad
           ON pad.id = pda.panel_attribute_definition_id
         WHERE pda.panel_id = $1`,
        [panelId]
      );

      result.total_defaults = defaultsRes.rowCount ?? 0;

      for (const row of defaultsRes.rows) {
        try {
          // Resolve CODE → UUID for the two special keys.
          let resolvedText = row.default_value_text;
          if (resolvedText) {
            if (row.attribute_key === 'preauth_form_template_id') {
              const lookup = await db.query(
                `SELECT id FROM hospital.preauth_form_templates WHERE code = $1 LIMIT 1`,
                [resolvedText]
              );
              resolvedText = lookup.rows[0]?.id ?? null;
              if (!resolvedText) {
                logger.warn(
                  { panelId, code: row.default_value_text },
                  'preauth_form_template not found for code; skipping default'
                );
                continue;
              }
            } else if (row.attribute_key === 'mou_template_id') {
              const lookup = await db.query(
                `SELECT id FROM hospital.mou_templates WHERE code = $1 LIMIT 1`,
                [resolvedText]
              );
              resolvedText = lookup.rows[0]?.id ?? null;
              if (!resolvedText) {
                logger.warn(
                  { panelId, code: row.default_value_text },
                  'mou_template not found for code; skipping default'
                );
                continue;
              }
            }
          }

          // Insert; skip if hospital already has a value for this attribute.
          const insertRes = await db.query(
            `INSERT INTO hospital.panel_attributes
               (hospital_panel_id, panel_attribute_definition_id, hospital_id,
                panel_id, attribute_key,
                value_text, value_boolean, value_date, value_json,
                created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
             ON CONFLICT (hospital_panel_id, panel_attribute_definition_id)
               DO NOTHING
             RETURNING id`,
            [
              hospitalPanelId,
              row.definition_id,
              hospitalId,
              panelId,
              row.attribute_key,
              resolvedText,
              row.default_value_boolean,
              row.default_value_date,
              row.default_value_json ? JSON.stringify(row.default_value_json) : null,
              userId ?? null,
            ]
          );

          if ((insertRes.rowCount ?? 0) > 0) {
            result.attributes_inserted++;
          } else {
            result.attributes_skipped++;
          }
        } catch (err) {
          logger.error(
            { err, attribute_key: row.attribute_key, panelId },
            'failed to apply default for attribute'
          );
          result.attributes_failed.push(row.attribute_key);
        }
      }

      logger.info(
        {
          hospitalPanelId,
          panelId,
          inserted: result.attributes_inserted,
          skipped: result.attributes_skipped,
          failed: result.attributes_failed.length,
        },
        'panel defaults applied'
      );

      return result;
    } catch (err) {
      logger.error({ err, hospitalPanelId, panelId }, 'applyDefaults failed');
      throw err;
    }
  }

  /**
   * Re-apply defaults across ALL existing hospital_panels rows for a given
   * panel. Used after an SOP refresh that added new defaults — fills in
   * gaps without touching values hospitals have already set.
   */
  async applyDefaultsToAllHospitals(panelId: string): Promise<{
    panel_id: string;
    hospitals_processed: number;
    total_attributes_inserted: number;
  }> {
    try {
      const hospitalsRes = await pool.query(
        `SELECT id, hospital_id FROM hospital.hospital_panels WHERE panel_id = $1`,
        [panelId]
      );

      let totalInserted = 0;
      for (const row of hospitalsRes.rows) {
        const res = await this.applyDefaults(row.id, panelId, row.hospital_id);
        totalInserted += res.attributes_inserted;
      }

      return {
        panel_id: panelId,
        hospitals_processed: hospitalsRes.rowCount ?? 0,
        total_attributes_inserted: totalInserted,
      };
    } catch (err) {
      logger.error({ err, panelId }, 'applyDefaultsToAllHospitals failed');
      throw err;
    }
  }

  /**
   * Read defaults for a panel — used by admin UIs to display "SOP says X".
   */
  async getDefaultsForPanel(panelId: string) {
    try {
      const result = await pool.query(
        `SELECT
           pda.id,
           pda.panel_attribute_definition_id,
           pad.key            AS attribute_key,
           pad.label,
           pad.category,
           pad.data_type,
           pda.default_value_text,
           pda.default_value_boolean,
           pda.default_value_date,
           pda.default_value_json,
           pda.source,
           pda.sop_version,
           pda.seeded_at
         FROM hospital.panel_default_attributes pda
         JOIN hospital.panel_attribute_definitions pad
           ON pad.id = pda.panel_attribute_definition_id
         WHERE pda.panel_id = $1
         ORDER BY pad.category, pad.sort_order, pad.label`,
        [panelId]
      );
      return result.rows;
    } catch (err) {
      logger.error({ err, panelId }, 'getDefaultsForPanel failed');
      throw err;
    }
  }

  /**
   * Upsert a single default. Used by admin UIs that let Finclarity admin
   * adjust the SOP defaults manually.
   */
  async upsertDefault(input: {
    panel_id: string;
    panel_attribute_definition_id: string;
    default_value_text?: string | null;
    default_value_boolean?: boolean | null;
    default_value_date?: string | null;
    default_value_json?: any;
    source?: string;
    sop_version?: string;
    seed_notes?: string;
  }) {
    try {
      const result = await pool.query(
        `INSERT INTO hospital.panel_default_attributes
           (panel_id, panel_attribute_definition_id,
            default_value_text, default_value_boolean,
            default_value_date, default_value_json,
            source, sop_version, seed_notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (panel_id, panel_attribute_definition_id)
           DO UPDATE SET
             default_value_text    = EXCLUDED.default_value_text,
             default_value_boolean = EXCLUDED.default_value_boolean,
             default_value_date    = EXCLUDED.default_value_date,
             default_value_json    = EXCLUDED.default_value_json,
             source                = EXCLUDED.source,
             sop_version           = EXCLUDED.sop_version,
             seed_notes            = EXCLUDED.seed_notes,
             updated_at            = NOW()
         RETURNING id, panel_id, panel_attribute_definition_id, source, sop_version`,
        [
          input.panel_id,
          input.panel_attribute_definition_id,
          input.default_value_text ?? null,
          input.default_value_boolean ?? null,
          input.default_value_date ?? null,
          input.default_value_json ? JSON.stringify(input.default_value_json) : null,
          input.source ?? 'manual',
          input.sop_version ?? null,
          input.seed_notes ?? null,
        ]
      );

      if ((result.rowCount ?? 0) === 0) {
        throw new apiError(500, 'failed to upsert panel default');
      }
      return result.rows[0];
    } catch (err) {
      logger.error({ err, input }, 'upsertDefault failed');
      throw err;
    }
  }
}

export default new PanelDefaultsService();
