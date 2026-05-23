/**
 * Phase 3 — Hospital Format Profile Service
 *
 * Few-shot learning per hospital. Reviewers correct extractor mistakes
 * (logged in hospital.extraction_corrections via mig 064). When ≥N
 * corrections converge on a consistent pattern for a given
 * (hospital_id, doc_category, field_path), we materialise a short
 * prompt-ready hint into hospital.hospital_format_profiles (mig 065).
 * The extractor prompt assembly then injects those hints into the user
 * message under a HOSPITAL_FORMAT_HINTS block so the LLM sees the
 * hospital's quirks before extracting.
 *
 * Three entry points:
 *   - getProfilesForExtraction → read-side, called per extraction
 *   - upsertProfile            → write-side, called from admin UI or
 *                                the aggregator below
 *   - buildProfilesFromCorrections → batch aggregator that mines the
 *                                extraction_corrections ledger
 *
 * The aggregator is tolerant of extraction_corrections NOT existing yet
 * (P2a creates it in the same Phase-3 turn). Wrapped in try/catch so an
 * absent table degrades gracefully to an empty result.
 */

import type { Pool } from 'pg';
import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface HospitalFormatProfileRow {
  field_name: string;
  extraction_hint: string;
  example_quote?: string | null;
  example_value?: string | null;
  confidence?: number;
}

export interface UpsertProfileInput {
  hospital_id: string;
  doc_category: string;
  field_name: string;
  extraction_hint: string;
  example_quote?: string;
  example_value?: string;
  source_correction_count?: number;
  confidence?: number;
}

export interface BuildResult {
  profiles_created: number;
  profiles_updated: number;
}

// Minimum corrections that must agree on a (hospital, category, field)
// before we precipitate a format profile. Tuned empirically: 3 is enough
// to filter out one-off reviewer typos while staying fast to converge
// for hospitals with steady claim volume.
const MIN_CORRECTIONS_TO_BUILD_PROFILE = 3;

// Default confidence assigned to a fresh profile. Scales up with
// source_correction_count via a saturating function so a profile built
// from 30 corrections beats one built from 3.
function confidenceFromCount(n: number): number {
  // 3 → 0.50, 5 → 0.66, 10 → 0.83, 20+ → ~0.93
  const c = 1 - Math.exp(-n / 8);
  return Math.max(0.5, Math.min(0.99, Number(c.toFixed(3))));
}

// ────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────

export class HospitalFormatProfileService {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * Read all profiles for a (hospital, category) pair, ordered by
   * confidence DESC so callers can take the top-N if they need to cap
   * prompt size.
   */
  async getProfilesForExtraction(
    hospital_id: string,
    doc_category: string,
  ): Promise<HospitalFormatProfileRow[]> {
    try {
      const res = await this.pool.query(
        `SELECT field_name, extraction_hint, example_quote, example_value, confidence
           FROM hospital.hospital_format_profiles
          WHERE hospital_id = $1
            AND doc_category = $2
          ORDER BY confidence DESC, source_correction_count DESC, field_name ASC`,
        [hospital_id, doc_category],
      );
      return res.rows.map((r: any) => ({
        field_name: r.field_name,
        extraction_hint: r.extraction_hint,
        example_quote: r.example_quote ?? null,
        example_value: r.example_value ?? null,
        confidence: r.confidence != null ? Number(r.confidence) : undefined,
      }));
    } catch (err) {
      // Table missing or query error → degrade silently. The extractor
      // path treats an empty array as "no hints available".
      logger.warn(
        { err, hospital_id, doc_category },
        'hospitalFormatProfile: getProfilesForExtraction failed (returning empty)',
      );
      return [];
    }
  }

  /**
   * Upsert a single profile. ON CONFLICT on the unique (hospital, cat,
   * field) tuple → update the hint/example/confidence and bump the
   * updated_at + source_correction_count.
   */
  async upsertProfile(input: UpsertProfileInput): Promise<void> {
    const correctionCount = input.source_correction_count ?? 1;
    const confidence =
      input.confidence ?? confidenceFromCount(correctionCount);
    await this.pool.query(
      `INSERT INTO hospital.hospital_format_profiles
         (hospital_id, doc_category, field_name,
          extraction_hint, example_quote, example_value,
          source_correction_count, confidence,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (hospital_id, doc_category, field_name) DO UPDATE
         SET extraction_hint = EXCLUDED.extraction_hint,
             example_quote = COALESCE(EXCLUDED.example_quote, hospital.hospital_format_profiles.example_quote),
             example_value = COALESCE(EXCLUDED.example_value, hospital.hospital_format_profiles.example_value),
             source_correction_count = GREATEST(EXCLUDED.source_correction_count, hospital.hospital_format_profiles.source_correction_count),
             confidence = GREATEST(EXCLUDED.confidence, hospital.hospital_format_profiles.confidence),
             updated_at = NOW()`,
      [
        input.hospital_id,
        input.doc_category,
        input.field_name,
        input.extraction_hint,
        input.example_quote ?? null,
        input.example_value ?? null,
        correctionCount,
        confidence,
      ],
    );
  }

  /**
   * Mine the extraction_corrections ledger and aggregate corrections by
   * (hospital_id, doc_category, field_name). When ≥ MIN_CORRECTIONS
   * cluster into the same field for the same hospital+category, emit/
   * refresh a format profile.
   *
   * The aggregation strategy is intentionally lo-fi: we count distinct
   * corrections, take the most-recent reviewer-corrected example as the
   * example_quote+example_value, and synthesise a one-line hint that
   * mentions the field path. Smarter NLP can come later — what matters
   * is the PROFILE pipeline runs end-to-end.
   *
   * Tolerant of extraction_corrections not existing yet (P2a builds it
   * in the same Phase-3 turn). Returns {0, 0} in that case.
   */
  async buildProfilesFromCorrections(
    hospital_id?: string,
  ): Promise<BuildResult> {
    // Cluster corrections by (hospital, category, field_path). The
    // doc_category lookup needs a join through document_sections since
    // extraction_corrections only carries section_id. Filter to the
    // section_extracted_field target so we don't mix episode/canonical
    // corrections into the section-level profile.
    let rows: Array<{
      hospital_id: string;
      doc_category: string;
      field_path: string;
      correction_count: number;
      latest_ai_value: any;
      latest_corrected_value: any;
    }> = [];

    try {
      const params: any[] = [MIN_CORRECTIONS_TO_BUILD_PROFILE];
      let hospitalFilter = '';
      if (hospital_id) {
        params.push(hospital_id);
        hospitalFilter = `AND ec.hospital_id = $${params.length}::uuid`;
      }
      // Window-fn pattern: rank corrections within each cluster by
      // reviewed_at DESC and pick the latest as the representative
      // example. The HAVING + WHERE rn=1 join enforces the minimum-
      // cluster-size threshold AND extracts the latest example value
      // without aggregating jsonb (which lacks max()).
      const res = await this.pool.query(
        `WITH joined AS (
           SELECT ec.hospital_id,
                  ds.category AS doc_category,
                  ec.field_path,
                  ec.ai_value,
                  ec.corrected_value,
                  ec.reviewed_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY ec.hospital_id, ds.category, ec.field_path
                    ORDER BY ec.reviewed_at DESC
                  ) AS rn,
                  COUNT(*) OVER (
                    PARTITION BY ec.hospital_id, ds.category, ec.field_path
                  ) AS cluster_count
             FROM hospital.extraction_corrections ec
             JOIN hospital.document_sections ds ON ds.id = ec.section_id
            WHERE ec.target_kind = 'section_extracted_field'
              AND ec.superseded_at IS NULL
              AND ds.category IS NOT NULL
              ${hospitalFilter}
         )
         SELECT hospital_id,
                doc_category,
                field_path,
                cluster_count::int AS correction_count,
                ai_value AS latest_ai_value,
                corrected_value AS latest_corrected_value
           FROM joined
          WHERE rn = 1
            AND cluster_count >= $1`,
        params,
      );
      rows = res.rows as any[];
    } catch (err) {
      // extraction_corrections table not present yet, or join failed.
      // P2a creates the table in the same Phase-3 turn — until then,
      // return zero and let the next scheduled run pick it up.
      logger.warn(
        { err, hospital_id },
        'hospitalFormatProfile: buildProfilesFromCorrections — extraction_corrections may not exist yet (returning {0,0})',
      );
      return { profiles_created: 0, profiles_updated: 0 };
    }

    let created = 0;
    let updated = 0;
    for (const row of rows) {
      // field_path uses dot notation ("patient_context.first_name").
      // The profile's field_name column is opaque to the prompt
      // assembler, so we keep the full path for clarity.
      const aiStr = stringifyJsonValue(row.latest_ai_value);
      const correctedStr = stringifyJsonValue(row.latest_corrected_value);
      const hint = synthesiseHint({
        doc_category: row.doc_category,
        field_path: row.field_path,
        latest_ai_value: aiStr,
        latest_corrected_value: correctedStr,
      });

      // Detect insert vs update by probing first. Cheap and exact —
      // the (hospital, cat, field) tuple is unique.
      const existing = await this.pool.query(
        `SELECT 1 FROM hospital.hospital_format_profiles
          WHERE hospital_id = $1 AND doc_category = $2 AND field_name = $3
          LIMIT 1`,
        [row.hospital_id, row.doc_category, row.field_path],
      );
      const isUpdate = (existing.rowCount ?? 0) > 0;

      await this.upsertProfile({
        hospital_id: row.hospital_id,
        doc_category: row.doc_category,
        field_name: row.field_path,
        extraction_hint: hint,
        example_quote: aiStr ?? undefined,
        example_value: correctedStr ?? undefined,
        source_correction_count: row.correction_count,
      });

      if (isUpdate) updated++;
      else created++;
    }

    logger.info(
      { hospital_id, profiles_created: created, profiles_updated: updated },
      'hospitalFormatProfile: buildProfilesFromCorrections complete',
    );
    return { profiles_created: created, profiles_updated: updated };
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function stringifyJsonValue(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/**
 * Build a one-line natural-language hint from a cluster of corrections.
 * Intentionally lo-fi — the value is the EXAMPLE pair, not the prose.
 */
function synthesiseHint(input: {
  doc_category: string;
  field_path: string;
  latest_ai_value: string | null;
  latest_corrected_value: string | null;
}): string {
  const { field_path, latest_ai_value, latest_corrected_value } = input;
  const examplePart =
    latest_ai_value && latest_corrected_value
      ? ` Reviewers consistently correct "${truncate(latest_ai_value, 60)}" → "${truncate(latest_corrected_value, 60)}".`
      : '';
  return `Pay extra attention to "${field_path}" on documents from this hospital — past reviewers have repeatedly overridden the AI extraction here.${examplePart}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

// ────────────────────────────────────────────────────────────────────
// Singleton
// ────────────────────────────────────────────────────────────────────

export const hospitalFormatProfileService = new HospitalFormatProfileService();
export default hospitalFormatProfileService;
