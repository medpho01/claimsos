/**
 * CARDIAC_005 — Pre-existing disease declaration.
 *
 * Heuristic: if the harmonised episode declares pre_existing_diseases that
 * intersect with the current diagnosis ICD prefix, check whether the policy
 * waiting period has elapsed (policy_inception_date in insurance_context).
 *
 * SKIP when neither pre_existing_diseases nor insurance_context are present.
 */
import type { CustomFunction } from './index.js';

function icdPrefix(code: any): string {
  return String(code ?? '').toUpperCase().slice(0, 3);
}

function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

export const validatePreExistingCondition: CustomFunction = async (episode) => {
  const ped: any[] = Array.isArray(episode?.diagnosis?.pre_existing_diseases)
    ? episode.diagnosis.pre_existing_diseases
    : [];
  const primaryIcd = icdPrefix(episode?.diagnosis?.primary_diagnosis?.icd_code);
  if (!primaryIcd) {
    return { status: 'SKIP', evidence: { reason: 'no primary ICD on episode' }, message: null };
  }

  const intersecting = ped.filter((p) => icdPrefix(p?.icd_code) === primaryIcd);
  if (intersecting.length === 0) {
    return { status: 'PASS', evidence: { reason: 'no overlapping pre-existing disease' }, message: null };
  }

  const inceptionStr = episode?.insurance_context?.policy_inception_date;
  const admissionStr =
    episode?.meta?.admission_date ?? episode?.clinical_timeline?.[0]?.start_at;
  const waitingMonths = Number(episode?.insurance_context?.ped_waiting_period_months ?? 48);

  if (!inceptionStr || !admissionStr) {
    return {
      status: 'FAIL',
      evidence: {
        intersecting,
        reason: 'pre-existing diagnosis overlaps primary; policy inception unknown',
      },
      message: 'Cardiac condition appears pre-existing; policy inception date not available to validate waiting period',
    };
  }

  const elapsed = monthsBetween(new Date(inceptionStr), new Date(admissionStr));
  if (elapsed >= waitingMonths) {
    return {
      status: 'PASS',
      evidence: { intersecting, elapsed_months: elapsed, waiting_months: waitingMonths },
      message: null,
    };
  }
  return {
    status: 'FAIL',
    evidence: { intersecting, elapsed_months: elapsed, waiting_months: waitingMonths },
    message: `Pre-existing disease waiting period not satisfied (${elapsed}/${waitingMonths} months elapsed)`,
  };
};
