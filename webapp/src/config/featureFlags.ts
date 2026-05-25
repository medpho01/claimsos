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
  /** "Filings & Communications" tab inside PatientDetail (insurer email + timeline).
   *  Coupled with hospitalInsuranceInterfaces — without the interfaces tab the user
   *  has no way to connect a Gmail mailbox, so flip these two together. */
  patientFilings: true,
  /** "Insurance Interfaces" tab inside Hospital Configuration (Gmail OAuth + insurer routing).
   *  Pilot rollout (2026-05-23): OAuth app is in Testing mode, hospital users must be
   *  explicitly added to the test-user allowlist in Google Cloud Console. They'll see
   *  an "unverified app" warning during connect — proceed via Advanced. Full Google
   *  verification (brand + CASA) is in flight for the broader rollout. */
  hospitalInsuranceInterfaces: true,
} as const;
