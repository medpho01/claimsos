/**
 * Pipeline v2 — harness: the scorer.
 *
 * A PURE function set that grades a deterministic `ClaimRunResult` (the output
 * of `runClaim`) against the structured ground truth for that claim. It scores
 * two independent things:
 *
 *   1. EPISODE FIELDS — did fusion land the right value in each canonical slot
 *      the ground truth pinned (diagnosis, procedure, laterality, the three
 *      episode dates)? Only fields actually specified in the ground truth are
 *      scored, so a partially-filled truth still yields a meaningful (narrower)
 *      accuracy number.
 *
 *   2. PAGE EXCLUSION — did the identity gate exclude the EXPECTED number of a
 *      different patient's pages? This is interpretation accuracy (did the JSON
 *      cover only this patient's journey?), NOT a hold/file verdict — the
 *      pipeline interprets, the rules layer adjudicates.
 *
 * Matching is intentionally tolerant of the surface noise a vision read leaves
 * behind, WITHOUT being so loose it counts a wrong value as right:
 *   • text fields  — normalise (lowercase, strip punctuation, collapse spaces)
 *                    then accept exact-equal OR one being a substring of the
 *                    other (a 4+ char containment, so "hernia" ⊂ "inguinal
 *                    hernia" passes but a 1-char fluke can't).
 *   • date fields  — parse both to a clinical day-number and compare by DAY, so
 *                    "12/02/2026" == "12-02-2026" == "12 Feb 2026".
 *   • laterality   — compare through the same Left/Right/Bilateral normaliser
 *                    the extractor uses, so "Rt." == "Right".
 *
 * No I/O, no LLM — same inputs ⇒ same scores. The CLI (run.ts) feeds real
 * ClaimRunResults in; the unit tests feed hand-built ones.
 */

import { FusedEpisode, FusedField } from '../fusion.service.js';
import { parseClinicalDay } from '../identityGate.service.js';
import { normalizeLaterality } from '../extraction.service.js';
import { ClaimRunResult } from './runner.js';
import {
  ClaimGroundTruth,
  SCORED_EPISODE_FIELDS,
  ScoredEpisodeField,
  DATE_FIELDS,
} from './groundTruth.js';

/** Per-field grade for one canonical slot the ground truth specified. */
export interface FieldScore {
  field: ScoredEpisodeField;
  expected: string;
  /** The fused value, or undefined when the pipeline produced no value. */
  actual?: string;
  hit: boolean;
}

/** Full grade for one claim. `*Hit` checks are null when GT didn't specify. */
export interface ClaimScore {
  claimId: string;
  /** Human label for report readability. */
  patient?: string;
  /** One entry per scored episode field (only those the GT pinned). */
  fields: FieldScore[];
  scoredFields: number;
  fieldHits: number;
  /** hits / scored, or null when the GT pinned no episode fields. */
  fieldAccuracy: number | null;
  // ── page-exclusion expectation (null when the GT didn't pin it) ──
  quarantineExpected?: number;
  quarantineActual: number;
  quarantineHit: boolean | null;
}

/** Per-field aggregate across the corpus. */
export interface CorpusFieldBreakdown {
  field: ScoredEpisodeField;
  scored: number;
  hits: number;
  /** hits / scored, 0 when the field was never pinned. */
  accuracy: number;
}

/** Corpus-level roll-up of every ClaimScore. */
export interface CorpusScore {
  claims: number;
  /** Claims that pinned at least one episode field. */
  scoredClaims: number;
  totalScoredFields: number;
  totalFieldHits: number;
  /** Overall field accuracy, or null when nothing was pinned anywhere. */
  fieldAccuracy: number | null;
  byField: CorpusFieldBreakdown[];
  quarantineScored: number;
  quarantineHits: number;
}

/** Lowercase, strip non-alphanumerics to single spaces, collapse + trim. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tolerant text match: exact normalised-equality, or a containment of at least
 * 4 characters (so a real clinical phrase that's a superset/subset of the
 * expected one still counts, but a trivial 1–3 char overlap can't false-pass).
 */
function textMatch(expected: string, actual: string): boolean {
  const e = normalizeForMatch(expected);
  const a = normalizeForMatch(actual);
  if (!e || !a) return false;
  if (e === a) return true;
  // OCR often splits or fuses a single clinical token ("Poly trauma" vs
  // "Polytrauma"); a space-only difference is the same value.
  if (e.replace(/ /g, '') === a.replace(/ /g, '')) return true;
  const shorter = e.length <= a.length ? e : a;
  const longer = shorter === e ? a : e;
  return shorter.length >= 4 && longer.includes(shorter);
}

/** Date match by parsed clinical day-number; falls back to text on parse miss. */
function dateMatch(expected: string, actual: string): boolean {
  const e = parseClinicalDay(expected);
  const a = parseClinicalDay(actual);
  if (e === null || a === null) return textMatch(expected, actual);
  return e === a;
}

/** Laterality match through the canonical Left/Right/Bilateral normaliser. */
function lateralityMatch(expected: string, actual: string): boolean {
  return normalizeLaterality(expected) === normalizeLaterality(actual);
}

/** Dispatch a field to its appropriate matcher. */
export function matchField(field: ScoredEpisodeField, expected: string, actual: string): boolean {
  if (DATE_FIELDS.has(field)) return dateMatch(expected, actual);
  if (field === 'laterality') return lateralityMatch(expected, actual);
  return textMatch(expected, actual);
}

/** Read a single-value canonical slot off the fused episode. */
function episodeValue(episode: FusedEpisode, field: ScoredEpisodeField): string | undefined {
  const slot = (episode as Record<string, FusedField | undefined>)[field];
  return slot?.value;
}

/**
 * Grade one claim's ClaimRunResult against its ground truth.
 *
 * Only fields the ground truth specifies are scored. A specified field whose
 * fused value is missing counts as a MISS (the pipeline failed to produce a
 * value the truth expected) rather than being skipped.
 */
export function scoreClaim(
  claimId: string,
  expected: ClaimGroundTruth,
  result: ClaimRunResult,
): ClaimScore {
  const fields: FieldScore[] = [];
  for (const field of SCORED_EPISODE_FIELDS) {
    const rawExpected = expected[field];
    if (rawExpected === undefined || rawExpected === null || String(rawExpected).trim() === '') {
      continue; // not pinned ⇒ not scored
    }
    const exp = String(rawExpected);
    const actual = episodeValue(result.episode, field);
    const hit = actual !== undefined && matchField(field, exp, actual);
    fields.push({ field, expected: exp, actual, hit });
  }

  const scoredFields = fields.length;
  const fieldHits = fields.filter((f) => f.hit).length;
  const fieldAccuracy = scoredFields > 0 ? fieldHits / scoredFields : null;

  const quarantineActual = result.identity.quarantinedPageIds.length;
  const quarantineExpected = expected.expectedQuarantinedPages;
  const quarantineHit =
    quarantineExpected === undefined ? null : quarantineActual === quarantineExpected;

  return {
    claimId,
    patient: expected.patient,
    fields,
    scoredFields,
    fieldHits,
    fieldAccuracy,
    quarantineExpected,
    quarantineActual,
    quarantineHit,
  };
}

/** Aggregate per-claim scores into the corpus roll-up + per-field breakdown. */
export function scoreCorpus(scores: ClaimScore[]): CorpusScore {
  const byField = new Map<ScoredEpisodeField, { scored: number; hits: number }>();
  for (const f of SCORED_EPISODE_FIELDS) byField.set(f, { scored: 0, hits: 0 });

  let totalScoredFields = 0;
  let totalFieldHits = 0;
  let scoredClaims = 0;
  let quarantineScored = 0;
  let quarantineHits = 0;

  for (const s of scores) {
    if (s.scoredFields > 0) scoredClaims += 1;
    totalScoredFields += s.scoredFields;
    totalFieldHits += s.fieldHits;
    for (const fs of s.fields) {
      const agg = byField.get(fs.field)!;
      agg.scored += 1;
      if (fs.hit) agg.hits += 1;
    }
    if (s.quarantineHit !== null) {
      quarantineScored += 1;
      if (s.quarantineHit) quarantineHits += 1;
    }
  }

  return {
    claims: scores.length,
    scoredClaims,
    totalScoredFields,
    totalFieldHits,
    fieldAccuracy: totalScoredFields > 0 ? totalFieldHits / totalScoredFields : null,
    byField: SCORED_EPISODE_FIELDS.map((field) => {
      const agg = byField.get(field)!;
      return {
        field,
        scored: agg.scored,
        hits: agg.hits,
        accuracy: agg.scored > 0 ? agg.hits / agg.scored : 0,
      };
    }),
    quarantineScored,
    quarantineHits,
  };
}
