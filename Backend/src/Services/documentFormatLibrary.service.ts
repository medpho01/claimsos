/**
 * Phase 3 — Document Format Library Service
 *
 * pHash-based layout fingerprinting. Given an incoming document's
 * representative pHash (first canonical section, first page), find the
 * closest known format for this hospital. If none, register the layout
 * as a new format for future detection.
 *
 * Current scope (THIS migration): just BUILD the library. The bundle
 * classifier calls matchFormat → registerNewFormat to populate the
 * library and stash the format label in document_sections.notes.
 * Later iterations will route matches to a deterministic field-position
 * extractor or hospital-specific extractor; this service is the
 * prerequisite.
 *
 * pHash comparison: hamming distance over hex-encoded perceptual hashes.
 * Threshold ≤ 5 bits (out of 64) for a "match" — empirically separates
 * "same layout, slightly different fill-in" from "different form".
 */

import type { Pool } from 'pg';
import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface MatchFormatResult {
  matched: boolean;
  format_id?: string;
  format_label?: string;
  hamming_distance?: number;
}

export interface RegisterFormatInput {
  hospital_id: string;
  doc_category?: string | null;
  representative_phash: string;
  sample_section_id?: string;
  format_label?: string;
}

// Hamming distance threshold (in bits) under which two pHashes are
// considered the same layout. 64-bit pHashes from our perceptualHash
// util → 5/64 ≈ 7.8% bit drift, which empirically tolerates fill-in
// variation (different patient name, different date) while still
// catching genuinely different layouts.
const HAMMING_MATCH_THRESHOLD = 5;

// Cap on sample_section_ids per row to keep row width bounded.
const MAX_SAMPLE_IDS_PER_FORMAT = 10;

// ────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────

export class DocumentFormatLibraryService {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * Find the closest known format for a hospital given the pHashes of
   * the incoming document's pages. We compare the FIRST non-null pHash
   * against every registered representative_phash for the hospital and
   * return the one with the smallest hamming distance, IF ≤ threshold.
   *
   * Empty library or no pHash → {matched: false}.
   */
  async matchFormat(
    hospital_id: string,
    page_phashes: string[],
  ): Promise<MatchFormatResult> {
    const probe = (page_phashes ?? []).find((h) => h && h.length > 0);
    if (!probe) {
      return { matched: false };
    }
    try {
      const res = await this.pool.query(
        `SELECT id, format_label, representative_phash
           FROM hospital.document_format_library
          WHERE hospital_id = $1`,
        [hospital_id],
      );
      let best: {
        id: string;
        label: string;
        distance: number;
      } | null = null;
      for (const row of res.rows as Array<{
        id: string;
        format_label: string;
        representative_phash: string;
      }>) {
        const d = hammingDistanceHex(probe, row.representative_phash);
        if (d < 0) continue; // mismatched lengths → skip
        if (best == null || d < best.distance) {
          best = { id: row.id, label: row.format_label, distance: d };
        }
      }
      if (best && best.distance <= HAMMING_MATCH_THRESHOLD) {
        return {
          matched: true,
          format_id: best.id,
          format_label: best.label,
          hamming_distance: best.distance,
        };
      }
      return { matched: false, hamming_distance: best?.distance };
    } catch (err) {
      logger.warn(
        { err, hospital_id },
        'documentFormatLibrary: matchFormat failed (returning unmatched)',
      );
      return { matched: false };
    }
  }

  /**
   * Insert a new format row for the (hospital, phash) tuple. UNIQUE on
   * that pair means a race between two concurrent registrations
   * collapses cleanly via ON CONFLICT DO UPDATE (we bump
   * occurrence_count and add the sample_section_id).
   *
   * Returns the format_id.
   */
  async registerNewFormat(input: RegisterFormatInput): Promise<string> {
    const label =
      input.format_label ??
      buildAutoLabel(
        input.hospital_id,
        input.doc_category ?? null,
        input.representative_phash,
      );
    const sampleArr = input.sample_section_id
      ? [input.sample_section_id]
      : [];

    const res = await this.pool.query(
      `INSERT INTO hospital.document_format_library
         (hospital_id, doc_category, format_label,
          representative_phash, sample_section_ids,
          occurrence_count, last_seen, created_at)
       VALUES ($1, $2, $3, $4, $5::uuid[], 1, NOW(), NOW())
       ON CONFLICT (hospital_id, representative_phash) DO UPDATE
         SET occurrence_count = hospital.document_format_library.occurrence_count + 1,
             last_seen = NOW(),
             sample_section_ids = (
               SELECT ARRAY(
                 SELECT DISTINCT unnest(
                   hospital.document_format_library.sample_section_ids
                   || EXCLUDED.sample_section_ids
                 )
                 LIMIT ${MAX_SAMPLE_IDS_PER_FORMAT}
               )
             )
       RETURNING id`,
      [
        input.hospital_id,
        input.doc_category ?? null,
        label,
        input.representative_phash,
        sampleArr,
      ],
    );
    return (res.rows[0] as any).id as string;
  }

  /**
   * Bump occurrence_count and last_seen for a known format when it
   * matches an incoming document. Called by the bundle classifier on a
   * successful matchFormat.
   */
  async incrementOccurrence(format_id: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE hospital.document_format_library
            SET occurrence_count = occurrence_count + 1,
                last_seen = NOW()
          WHERE id = $1`,
        [format_id],
      );
    } catch (err) {
      logger.warn(
        { err, format_id },
        'documentFormatLibrary: incrementOccurrence failed (non-fatal)',
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Hamming distance between two hex-encoded pHash strings. Returns -1 if
 * the strings differ in length (caller treats that as "skip").
 *
 * Same hash length → XOR each nibble, popcount the result, sum.
 */
export function hammingDistanceHex(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return -1;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const xa = parseInt(a[i]!, 16);
    const xb = parseInt(b[i]!, 16);
    if (Number.isNaN(xa) || Number.isNaN(xb)) return -1;
    let xor = xa ^ xb;
    while (xor) {
      dist += xor & 1;
      xor >>>= 1;
    }
  }
  return dist;
}

function buildAutoLabel(
  hospital_id: string,
  doc_category: string | null,
  phash: string,
): string {
  const cat = doc_category ?? 'unknown';
  const shortHash = phash.slice(0, 8);
  const shortHospital = hospital_id.slice(0, 8);
  return `${shortHospital}:${cat}:${shortHash}`;
}

// ────────────────────────────────────────────────────────────────────
// Singleton
// ────────────────────────────────────────────────────────────────────

export const documentFormatLibraryService = new DocumentFormatLibraryService();
export default documentFormatLibraryService;
