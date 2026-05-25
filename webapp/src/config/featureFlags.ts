/**
 * Feature flags for hiding work-in-progress surfaces from production users.
 *
 * TWO LAYERS of gating:
 *   1. Global on/off  — FEATURE_FLAGS object. Build-time. Off means
 *      nobody sees the surface, regardless of role.
 *   2. Role restriction — SUPERADMIN_ONLY set. Lists keys that are
 *      additionally restricted to role='superadmin' even when the
 *      global flag is on. Use this for features that exist in prod
 *      but are still in supervised pilot (e.g. Gmail integration
 *      before Google verification completes; AI before broader QA).
 *
 * To use in a component, call the hook:
 *
 *     const aiSummaryEnabled = useFeatureFlag('patientAiSummary');
 *     if (!aiSummaryEnabled) return null;
 *
 * The hook handles both layers. Don't read FEATURE_FLAGS directly
 * from JSX unless you intentionally want to bypass the role check
 * (e.g. in non-user-facing contexts like analytics tracking).
 *
 * Migrating from this to a runtime config endpoint is the long-term
 * plan (see /architecture ADR) — the hook abstraction means call
 * sites won't have to change again.
 */
import { useAuth } from '@/context/AuthContext';

export const FEATURE_FLAGS = {
  /** "AI Summary" tab + "Run AI Analysis" button on PatientDetail. */
  patientAiSummary: true,
  /** "Filings & Communications" tab on PatientDetail (insurer email + timeline). */
  patientFilings: true,
  /** "Insurance Interfaces" tab inside Hospital Configuration (Gmail OAuth + insurer routing). */
  hospitalInsuranceInterfaces: true,
} as const;

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

/**
 * Keys that are visible to role='superadmin' only, even when their
 * global flag in FEATURE_FLAGS is true.
 *
 * 2026-05-23 pilot rationale:
 *   - patientAiSummary: AI pipeline is live but not yet QA'd for hospital-
 *     facing rollout. Superadmins exercise it to gather feedback.
 *   - patientFilings + hospitalInsuranceInterfaces: Google OAuth app is
 *     in Testing mode, only allowlisted test users can connect. Hiding
 *     from hospital roles prevents broken-connect-flow support tickets.
 *
 * Remove a key from this set when the corresponding feature is ready for
 * its end-user audience (hospital admins / hospital users).
 */
const SUPERADMIN_ONLY: ReadonlySet<FeatureFlagKey> = new Set([
  'patientAiSummary',
  'patientFilings',
  'hospitalInsuranceInterfaces',
]);

/**
 * Resolve a feature flag for the current user. Reactive — re-renders
 * when role changes (e.g. role switch after re-login).
 *
 * Returns false when:
 *   - The global flag in FEATURE_FLAGS is false, OR
 *   - The key is in SUPERADMIN_ONLY and the user isn't a superadmin
 */
export function useFeatureFlag(key: FeatureFlagKey): boolean {
  const { user } = useAuth();
  if (!FEATURE_FLAGS[key]) return false;
  if (SUPERADMIN_ONLY.has(key) && user?.role !== 'superadmin') return false;
  return true;
}
