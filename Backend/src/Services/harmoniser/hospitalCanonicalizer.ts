/**
 * Hospital-name canonicalizer for the Harmoniser.
 *
 * Background
 * ──────────
 * The iter5 accuracy bench surfaced cases where the AI-extracted
 * hospital_context.hospital_name on a harmonised episode differs from
 * the authoritative hospital row in `hospital.hospitals`:
 *
 *   • LLM read: "Akshay Heart Hospital"    → DB row: "Akshaya Hospital"
 *   • LLM read: "Jigyasa Hospital"          → DB row: "Jigyasa Super
 *                                              Speciality Hospital"
 *
 * Worse, these wrong-spelling variants break the downstream harmoniser
 * — episodes from the same hospital fail to dedup against each other
 * because their hospital_name strings aren't identical.
 *
 * Strategy
 * ────────
 * We already KNOW which hospital the claim belongs to (every IPD row
 * carries `hospital_id`, threaded through to `harmonise()`). The DB
 * row's `name` column is the source of truth. The LLM-extracted name
 * is, at best, an OCR-of-letterhead snapshot — at worst, a foreign
 * referral letterhead that the H4 identity gate didn't catch.
 *
 * Therefore: ALWAYS emit the DB row's name. Keep the LLM-extracted
 * value in validation_metadata for the reviewer to audit; flag the
 * episode as "suspicious" when the strings diverge a lot, so a sweep
 * can decide if the wrong document was attached to this claim.
 *
 * Tolerance
 * ─────────
 * The DB lookup is async and may fail (network blip, pool exhaustion,
 * row deleted). In every failure mode we return the LLM-extracted
 * name unchanged with match_confidence='none' and match_distance=1 —
 * the harmoniser must keep functioning, since this canonicalizer is
 * a downstream cleanup, not a load-bearing primitive.
 */

import type { Pool } from 'pg';

import { pool as defaultPool } from '../../DB/db.js';
import { logger } from '../../Utils/logger.js';

export type HospitalCanonicalizationResult = {
  canonical_name: string;
  llm_extracted: string | null;
  match_distance: number;
  match_confidence: 'high' | 'medium' | 'low' | 'none';
};

// ─── Normalisation ────────────────────────────────────────────────────────

/**
 * Lowercase + strip punctuation + collapse whitespace. We deliberately
 * KEEP all tokens (do not pull a "distinctive token" the way the
 * patient-identity module does) — hospital names typically need the
 * full string to compare meaningfully ("Jigyasa Hospital" vs
 * "Jigyasa Super Speciality Hospital" must produce a non-zero
 * distance).
 */
function normaliseHospitalName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Levenshtein ──────────────────────────────────────────────────────────

/**
 * Plain Levenshtein edit distance (insert/delete/substitute = 1).
 * Two-row DP, O(min(a,b)) memory.
 *
 * Self-contained — does NOT import from patientIdentity.ts so that
 * module remains free to evolve its name-comparison logic for patient
 * identities (which use different normalisation rules) without
 * affecting hospital-name canonicalisation.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (a.length > b.length) {
    const t = a;
    a = b;
    b = t;
  }
  let prev: number[] = new Array(a.length + 1);
  let cur: number[] = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    cur[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[i] = Math.min(cur[i - 1] + 1, prev[i] + 1, prev[i - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[a.length];
}

/**
 * Normalised distance in [0..1]. 0 = identical, 1 = entirely different.
 *   distance = edit_distance / max(|a|,|b|)
 *
 * Both inputs are normalised through {@link normaliseHospitalName}.
 * Two empty inputs are considered fully different (distance 1).
 */
function normalisedHospitalDistance(a: string, b: string): number {
  const na = normaliseHospitalName(a);
  const nb = normaliseHospitalName(b);
  if (!na || !nb) return 1;
  if (na === nb) return 0;
  const d = levenshtein(na, nb);
  return d / Math.max(na.length, nb.length);
}

function bucketConfidence(
  distance: number,
): 'high' | 'medium' | 'low' {
  if (distance <= 0.15) return 'high';
  if (distance <= 0.4) return 'medium';
  return 'low';
}

// ─── DB lookup ────────────────────────────────────────────────────────────

/**
 * Resolve the canonical hospital name for a given hospital_id. Returns
 * `null` if the row doesn't exist (or the lookup blew up — caller
 * treats both cases the same). Errors are LOGGED, not thrown.
 *
 * Pool is injectable for unit tests; defaults to the shared app pool.
 */
async function lookupCanonicalName(
  hospital_id: string,
  pool: Pool = defaultPool,
): Promise<string | null> {
  try {
    const res = await pool.query<{ name: string | null }>(
      `SELECT name FROM hospital.hospitals WHERE id = $1`,
      [hospital_id],
    );
    const name = res.rows[0]?.name ?? null;
    if (!name || name.trim() === '') return null;
    return name;
  } catch (err) {
    logger.warn(
      { err, hospital_id },
      'hospitalCanonicalizer: lookupCanonicalName failed — falling back to LLM-extracted',
    );
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Canonicalise the hospital name on a harmonised episode against the
 * authoritative `hospital.hospitals.name` for the claim's hospital_id.
 *
 * Behaviour:
 *   • DB row found       → ALWAYS return DB name as canonical_name.
 *                          match_confidence reflects how close the LLM
 *                          guess was. 'low' means the strings diverge
 *                          a lot — likely a foreign letterhead.
 *   • DB row missing /
 *     lookup errored     → fall back to LLM-extracted name, match_confidence='none'.
 *                          The harmoniser keeps working; only behaviour
 *                          change is no canonicalisation that turn.
 *   • LLM extracted null → DB name returned (if available),
 *                          match_distance=1, match_confidence='none'.
 *
 * The `pool` argument is optional and exists for unit-testing —
 * production callers should omit it so the shared app pool is used.
 */
export async function canonicalizeHospitalName(
  hospital_id: string,
  llmExtractedName: string | null,
  pool: Pool = defaultPool,
): Promise<HospitalCanonicalizationResult> {
  const canonical = await lookupCanonicalName(hospital_id, pool);

  // DB lookup failed or row missing — keep LLM value, no canonicalisation.
  if (!canonical) {
    return {
      canonical_name: (llmExtractedName ?? '').trim() || '',
      llm_extracted: llmExtractedName ?? null,
      match_distance: 1,
      match_confidence: 'none',
    };
  }

  // LLM produced no name — nothing to compare, but we still return the
  // authoritative one. match_confidence='none' tells the reviewer the
  // canonical name was NOT validated against an extraction.
  if (llmExtractedName == null || llmExtractedName.trim() === '') {
    return {
      canonical_name: canonical,
      llm_extracted: llmExtractedName ?? null,
      match_distance: 1,
      match_confidence: 'none',
    };
  }

  const distance = normalisedHospitalDistance(canonical, llmExtractedName);
  return {
    canonical_name: canonical,
    llm_extracted: llmExtractedName,
    match_distance: distance,
    match_confidence: bucketConfidence(distance),
  };
}

// Internal helpers exported for unit tests only.
export const __internal = {
  normaliseHospitalName,
  normalisedHospitalDistance,
  levenshtein,
  bucketConfidence,
};
