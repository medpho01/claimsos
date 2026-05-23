/**
 * Extraction Corrections Service.
 *
 * Per-claim, per-field ledger of reviewer overrides on AI-emitted extraction
 * values. Distinct from `aiCorrections.service.ts` (the KB miner firehose):
 * this table is grained to enable per-hospital / per-field accuracy math
 * and to feed the next extractor iteration with few-shot training data.
 *
 * Three consumers:
 *   1. Reviewer FE — POST /api/v1/claims/:claimId/corrections on each edit
 *   2. Per-claim drawer — GET /api/v1/claims/:claimId/corrections
 *   3. Systemic-error admin view — GET /api/v1/admin/extraction-corrections/systemic
 *      flags (hospital, field) pairs the AI is being corrected on > 3 times.
 *
 * Constructor accepts an injectable pool stub for unit tests (matches
 * aiCorrections.service.ts pattern).
 */

import type { Pool } from 'pg';

import { pool as defaultPool } from '../DB/db.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type ExtractionCorrectionTargetKind =
  | 'section_extracted_field'
  | 'harmonised_episode_field'
  | 'canonical_patient'
  | 'foreign_document_flag'
  | 'id_conflict';

export interface RecordCorrectionInput {
  claim_id: string;
  hospital_id: string;
  target_kind: ExtractionCorrectionTargetKind;
  section_id?: string;
  field_path: string;
  ai_value: unknown;
  corrected_value: unknown;
  reason?: string;
  reviewer_id?: string;
}

export interface CorrectionRow {
  id: string;
  claim_id: string;
  hospital_id: string;
  target_kind: ExtractionCorrectionTargetKind;
  section_id: string | null;
  field_path: string;
  ai_value: unknown;
  corrected_value: unknown;
  reason: string | null;
  reviewer_id: string | null;
  reviewed_at: Date;
  superseded_at: Date | null;
  superseded_by: string | null;
}

export interface SystemicErrorRow {
  hospital_id: string;
  field_path: string;
  correction_count: number;
  recent_examples: Array<{
    ai_value: unknown;
    corrected_value: unknown;
    reviewed_at: Date;
  }>;
}

// ─── Service ──────────────────────────────────────────────────────────────

export class ExtractionCorrectionsService {
  private readonly pool: Pick<Pool, 'query'>;

  constructor(pool: Pick<Pool, 'query'> = defaultPool as any) {
    this.pool = pool;
  }

  /**
   * Insert one correction row. `ai_value` / `corrected_value` are JSONB-
   * stringified so we faithfully capture object/string/number/null. We
   * deliberately do NOT swallow errors here — the caller (controller)
   * decides how to respond to a duplicate / constraint violation.
   */
  async recordCorrection(input: RecordCorrectionInput): Promise<{ id: string }> {
    // Serialise JSONB-bound fields explicitly. `undefined` collapses to
    // SQL NULL so the column stays nullable rather than the literal
    // string "undefined".
    const aiVal =
      input.ai_value === undefined ? null : JSON.stringify(input.ai_value);
    const correctedVal =
      input.corrected_value === undefined
        ? null
        : JSON.stringify(input.corrected_value);

    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO hospital.extraction_corrections (
         claim_id, hospital_id, target_kind, section_id, field_path,
         ai_value, corrected_value, reason, reviewer_id
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::jsonb, $7::jsonb, $8, $9
       )
       RETURNING id`,
      [
        input.claim_id,
        input.hospital_id,
        input.target_kind,
        input.section_id ?? null,
        input.field_path,
        aiVal,
        correctedVal,
        input.reason ?? null,
        input.reviewer_id ?? null,
      ],
    );
    const id = res.rows[0]?.id;
    if (!id) {
      throw new Error(
        'extractionCorrections.recordCorrection: no id returned from INSERT',
      );
    }
    return { id };
  }

  /**
   * Recent corrections for a single claim — backs the per-claim drawer.
   * Includes superseded rows because the drawer wants to show audit
   * history; the FE filters on `superseded_at` for display.
   */
  async listForClaim(claim_id: string): Promise<CorrectionRow[]> {
    const res = await this.pool.query<CorrectionRow>(
      `SELECT id, claim_id, hospital_id, target_kind, section_id, field_path,
              ai_value, corrected_value, reason, reviewer_id, reviewed_at,
              superseded_at, superseded_by
         FROM hospital.extraction_corrections
        WHERE claim_id = $1
        ORDER BY reviewed_at DESC`,
      [claim_id],
    );
    return res.rows ?? [];
  }

  /**
   * Group active (non-superseded) corrections by (hospital_id, field_path)
   * and return pairs with > 3 corrections — the signal that the AI is
   * consistently being corrected on that field for that hospital. These
   * are the prompt-iteration candidates.
   *
   * Returns at most `limit` rows (default 50), ordered by count DESC.
   * `recent_examples` is the most recent 3 ai_value/corrected_value
   * pairs for the group — enough to eyeball the failure mode without
   * pulling every row.
   */
  async listSystemicErrors(
    hospital_id?: string,
    limit = 50,
  ): Promise<SystemicErrorRow[]> {
    // Two-step: GROUP BY for the counts + correlated subquery for the
    // examples. Cheaper than a window function because we cap examples
    // at 3 each.
    const params: unknown[] = [];
    let whereClause = 'WHERE superseded_at IS NULL';
    if (hospital_id) {
      params.push(hospital_id);
      whereClause += ` AND hospital_id = $${params.length}`;
    }
    params.push(Math.min(Math.max(limit, 1), 500));
    const limitParamIdx = params.length;

    const res = await this.pool.query<{
      hospital_id: string;
      field_path: string;
      correction_count: string | number;
      recent_examples: Array<{
        ai_value: unknown;
        corrected_value: unknown;
        reviewed_at: string | Date;
      }>;
    }>(
      `SELECT g.hospital_id,
              g.field_path,
              g.correction_count,
              COALESCE(
                (SELECT jsonb_agg(
                          jsonb_build_object(
                            'ai_value', ec.ai_value,
                            'corrected_value', ec.corrected_value,
                            'reviewed_at', ec.reviewed_at
                          )
                          ORDER BY ec.reviewed_at DESC
                        )
                   FROM (
                     SELECT ai_value, corrected_value, reviewed_at
                       FROM hospital.extraction_corrections
                      WHERE superseded_at IS NULL
                        AND hospital_id = g.hospital_id
                        AND field_path = g.field_path
                      ORDER BY reviewed_at DESC
                      LIMIT 3
                   ) ec
                ),
                '[]'::jsonb
              ) AS recent_examples
         FROM (
           SELECT hospital_id, field_path, COUNT(*) AS correction_count
             FROM hospital.extraction_corrections
             ${whereClause}
            GROUP BY hospital_id, field_path
           HAVING COUNT(*) > 3
         ) g
        ORDER BY g.correction_count DESC
        LIMIT $${limitParamIdx}`,
      params,
    );

    return (res.rows ?? []).map((r) => ({
      hospital_id: r.hospital_id,
      field_path: r.field_path,
      correction_count: Number(r.correction_count),
      recent_examples: (r.recent_examples ?? []).map((ex) => ({
        ai_value: ex.ai_value,
        corrected_value: ex.corrected_value,
        reviewed_at:
          ex.reviewed_at instanceof Date
            ? ex.reviewed_at
            : new Date(ex.reviewed_at),
      })),
    }));
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

export const extractionCorrectionsService = new ExtractionCorrectionsService();
export default extractionCorrectionsService;
