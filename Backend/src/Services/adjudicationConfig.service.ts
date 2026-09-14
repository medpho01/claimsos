/**
 * Per-panel adjudication config and the non-payables catalog.
 *
 * Both exist because the domain refuses to be a constant:
 *
 *   Deadlines differ per panel. Four TPAs publish four different claim-file
 *   windows (2, 7, 15 and 30 days) and two contradict themselves inside their
 *   own documents. Any hard-coded number is wrong for most panels.
 *
 *   Non-payable matching is an alias problem, not a name problem. Billing
 *   systems write "GLOVES", "SURGICAL GLOVES", "GLOVE PAIR STERILE" for one
 *   catalogued item, so aliases are learned from real bills rather than
 *   guessed.
 */

import { pool as defaultPool } from '../DB/db.js';
import type { Pool } from 'pg';

export interface PanelAdjudicationConfig {
  panel_id: string;
  preauth_decision_hours: number | null;
  enhancement_decision_hours: number | null;
  final_auth_decision_hours: number | null;
  claim_file_days: number | null;
  query_reply_days: number | null;
  enhancement_silence_is_denial: boolean;
  terminology_aliases: Record<string, string>;
  proportionate_exempt_heads: string[];
  non_payable_lists: string[];
  source_note: string | null;
}

export interface NonPayableItem {
  id: string;
  item_name: string;
  list_number: string;
  aliases: string[];
  panel_id: string | null;
  notes: string | null;
  is_active: boolean;
}

/** The full IRDAI catalog size, for the coverage readout. Counted from
 *  IRDAI/HLT/REG/CIR/176/09/2019 Annexure-I: 68 + 37 + 23 + 18. */
export const IRDAI_TOTAL_ITEMS = 146;

export class AdjudicationConfigService {
  constructor(private readonly pool: Pool = defaultPool as Pool) {}

  // ── Panel config ─────────────────────────────────────────────────────────

  /** Every panel, with its config when one exists. LEFT JOIN so unconfigured
   *  panels are visible rather than hidden — an unconfigured panel is the case
   *  that most needs attention. */
  async listPanelConfigs() {
    const { rows } = await this.pool.query(
      `SELECT p.id AS panel_id, p.panel_name, p.panel_type,
              c.preauth_decision_hours, c.enhancement_decision_hours,
              c.final_auth_decision_hours, c.claim_file_days, c.query_reply_days,
              c.enhancement_silence_is_denial,
              COALESCE(c.terminology_aliases, '{}'::jsonb) AS terminology_aliases,
              COALESCE(c.proportionate_exempt_heads, ARRAY[]::TEXT[]) AS proportionate_exempt_heads,
              COALESCE(c.non_payable_lists, ARRAY['I','II','III','IV']::TEXT[]) AS non_payable_lists,
              c.source_note,
              (c.panel_id IS NOT NULL) AS configured
         FROM hospital.panels p
         LEFT JOIN hospital.panel_adjudication_config c ON c.panel_id = p.id
        ORDER BY p.panel_name`,
    );
    return rows;
  }

  async upsertPanelConfig(
    panelId: string,
    patch: Partial<PanelAdjudicationConfig>,
    updatedBy?: string,
  ) {
    const exists = await this.pool.query('SELECT 1 FROM hospital.panels WHERE id = $1', [panelId]);
    if (!exists.rowCount) throw new Error(`unknown panel: ${panelId}`);

    // A deadline of 0 would silently fail every timeliness check. NULL means
    // "unknown for this panel" and skips the rule; 0 means "no time at all",
    // which is never what anyone intends to type.
    for (const key of [
      'preauth_decision_hours', 'enhancement_decision_hours',
      'final_auth_decision_hours', 'claim_file_days', 'query_reply_days',
    ] as const) {
      const v = patch[key];
      if (v != null && Number(v) <= 0) {
        throw new Error(`${key} must be greater than 0, or left empty if unknown`);
      }
    }

    const { rows } = await this.pool.query(
      `INSERT INTO hospital.panel_adjudication_config
         (panel_id, preauth_decision_hours, enhancement_decision_hours,
          final_auth_decision_hours, claim_file_days, query_reply_days,
          enhancement_silence_is_denial, terminology_aliases,
          proportionate_exempt_heads, non_payable_lists, source_note, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (panel_id) DO UPDATE SET
         preauth_decision_hours        = EXCLUDED.preauth_decision_hours,
         enhancement_decision_hours    = EXCLUDED.enhancement_decision_hours,
         final_auth_decision_hours     = EXCLUDED.final_auth_decision_hours,
         claim_file_days               = EXCLUDED.claim_file_days,
         query_reply_days              = EXCLUDED.query_reply_days,
         enhancement_silence_is_denial = EXCLUDED.enhancement_silence_is_denial,
         terminology_aliases           = EXCLUDED.terminology_aliases,
         proportionate_exempt_heads    = EXCLUDED.proportionate_exempt_heads,
         non_payable_lists             = EXCLUDED.non_payable_lists,
         source_note                   = EXCLUDED.source_note,
         updated_by                    = EXCLUDED.updated_by
       RETURNING *`,
      [
        panelId,
        patch.preauth_decision_hours ?? null,
        patch.enhancement_decision_hours ?? null,
        patch.final_auth_decision_hours ?? null,
        patch.claim_file_days ?? null,
        patch.query_reply_days ?? null,
        patch.enhancement_silence_is_denial ?? false,
        JSON.stringify(patch.terminology_aliases ?? {}),
        patch.proportionate_exempt_heads ?? [],
        patch.non_payable_lists ?? ['I', 'II', 'III', 'IV'],
        patch.source_note ?? null,
        updatedBy ?? null,
      ],
    );
    return rows[0];
  }

  // ── Non-payables ─────────────────────────────────────────────────────────

  async listNonPayables(search?: string) {
    const params: unknown[] = [];
    let where = 'is_active';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND (lower(item_name) LIKE $${params.length}
                   OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) LIKE $${params.length}))`;
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM hospital.non_payable_items
        WHERE ${where} ORDER BY list_number, item_name`,
      params,
    );

    const { rows: counts } = await this.pool.query(
      `SELECT list_number, count(*)::int n FROM hospital.non_payable_items
        WHERE panel_id IS NULL AND is_active GROUP BY 1`,
    );
    const seeded = counts.reduce((a: number, r: any) => a + r.n, 0);

    return {
      items: rows as NonPayableItem[],
      coverage: {
        seeded,
        irdai_total: IRDAI_TOTAL_ITEMS,
        // Surfaced so nobody reads a quiet result as a clean bill. A line
        // matching nothing in a partial catalog is not evidence it is payable.
        complete: seeded >= IRDAI_TOTAL_ITEMS,
        by_list: counts,
      },
    };
  }

  async upsertNonPayable(item: Partial<NonPayableItem> & { item_name: string; list_number: string }) {
    if (!['I', 'II', 'III', 'IV', 'PANEL'].includes(item.list_number)) {
      throw new Error(`unknown list_number: ${item.list_number}`);
    }
    if (item.id) {
      const { rows } = await this.pool.query(
        `UPDATE hospital.non_payable_items
            SET item_name = $2, list_number = $3, aliases = $4, notes = $5, is_active = $6,
                updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [item.id, item.item_name, item.list_number, item.aliases ?? [], item.notes ?? null, item.is_active !== false],
      );
      return rows[0];
    }
    const { rows } = await this.pool.query(
      `INSERT INTO hospital.non_payable_items (item_name, list_number, aliases, panel_id, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [item.item_name, item.list_number, item.aliases ?? [], item.panel_id ?? null, item.notes ?? null],
    );
    return rows[0];
  }

  /**
   * Bill lines that match nothing in the catalog.
   *
   * The alias-learning loop: rather than guessing how a billing system spells
   * an item, show what it actually wrote and let someone attach it. Ranked by
   * frequency because the common spellings are worth catching first.
   */
  async unmatchedBillLines(limit = 50) {
    const { rows } = await this.pool.query(
      `WITH lines AS (
         SELECT lower(trim(li->>'particulars')) AS particulars, count(*)::int AS occurrences
           FROM hospital.document_sections s
           CROSS JOIN LATERAL jsonb_array_elements(
             COALESCE(s.extracted_fields->'line_items', '[]'::jsonb)) li
          WHERE s.category IN ('final_bill','pharmacy_bill','interim_bill')
            AND li->>'particulars' IS NOT NULL
            AND length(trim(li->>'particulars')) > 2
          GROUP BY 1
       )
       SELECT l.particulars, l.occurrences
         FROM lines l
        WHERE NOT EXISTS (
          SELECT 1 FROM hospital.non_payable_items n
           WHERE n.is_active
             AND (l.particulars LIKE '%' || lower(n.item_name) || '%'
                  OR EXISTS (SELECT 1 FROM unnest(n.aliases) a
                              WHERE l.particulars LIKE '%' || lower(a) || '%'))
        )
        ORDER BY l.occurrences DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  }
}

export default new AdjudicationConfigService();
