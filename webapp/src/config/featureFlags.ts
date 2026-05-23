/**
 * Feature flags for hiding work-in-progress surfaces from production users.
 *
 * Build-time constants for now — flip `false` → `true` and rebuild the
 * webapp to re-enable. See the `/architecture` ADR for the longer-term
 * plan to drive these from `/api/v1/config/features` so flipping doesn't
 * require a frontend rebuild.
 *
 * Naming convention: <surface>.<feature>. Keep flags in one object so
 * future search-and-replace stays trivial.
 */
export const FEATURE_FLAGS = {
  /** "AI Summary" tab inside PatientDetail (intelligence layer review surface). */
  patientAiSummary: false,
  /** "Filings & Communications" tab inside PatientDetail (insurer email + timeline). */
  patientFilings: false,
  /** "Insurance Interfaces" tab inside Hospital Configuration (Gmail OAuth + insurer routing). */
  hospitalInsuranceInterfaces: false,
} as const;
