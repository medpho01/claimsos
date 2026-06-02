/**
 * Pipeline v2 — harness: the ground-truth contract.
 *
 * Scoring needs STRUCTURED expected values, but the cross-validation produced
 * prose audit reports (reports/agent*.md). So the harness reads a small JSON
 * file — one entry per claim — that a human (or a Claude pass over those
 * reports) fills in. Every field is OPTIONAL: the scorer only scores the fields
 * that are actually specified, so a partially-filled ground truth still yields
 * a meaningful (if narrower) accuracy number, and the file can be grown
 * incrementally as we pin down each patient.
 *
 * The file format is a JSON object keyed by claimId:
 *   {
 *     "05cf88cb-…": {
 *       "patient": "Vahid",
 *       "primary_diagnosis": "Inguinal hernia",
 *       "procedure_name": "Hernioplasty",
 *       "laterality": "Right",
 *       "admission_date": "12/02/2026",
 *       "discharge_date": "15/02/2026",
 *       "expectedQuarantinedPages": 0
 *     }
 *   }
 *
 * NOTE: the pipeline INTERPRETS, it does not adjudicate — so the ground truth
 * pins the accurate treatment-journey values and the expected page-exclusion
 * count, NOT a hold/file verdict. (Older files may still carry "expectedStatus"
 * / "expectedCanHarmonise" keys; they are simply ignored.)
 */

import * as fs from 'node:fs';

export interface ClaimGroundTruth {
  /** Human label — never scored, just for report readability. */
  patient?: string;
  primary_diagnosis?: string;
  procedure_name?: string;
  laterality?: string;
  admission_date?: string;
  discharge_date?: string;
  surgery_date?: string;
  /**
   * Expected count of pages excluded as a DIFFERENT patient's records, when
   * known. This is interpretation accuracy (did we keep only this patient's
   * journey?), not adjudication.
   */
  expectedQuarantinedPages?: number;
}

export type GroundTruthSet = Record<string, ClaimGroundTruth>;

/** Canonical episode fields the scorer compares (date fields matched by day). */
export const SCORED_EPISODE_FIELDS = [
  'primary_diagnosis',
  'procedure_name',
  'laterality',
  'admission_date',
  'discharge_date',
  'surgery_date',
] as const;

export type ScoredEpisodeField = (typeof SCORED_EPISODE_FIELDS)[number];

/** Fields scored by date-equality (day number) rather than text match. */
export const DATE_FIELDS: ReadonlySet<string> = new Set([
  'admission_date',
  'discharge_date',
  'surgery_date',
]);

/**
 * Load the ground-truth set from a JSON file. Returns an empty set if the file
 * is missing — a harness run with no ground truth still reports run states and
 * spend; it just can't score accuracy.
 */
export function loadGroundTruth(filePath: string): GroundTruthSet {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' ? parsed : {}) as GroundTruthSet;
  } catch {
    return {};
  }
}
