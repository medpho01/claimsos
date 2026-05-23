/**
 * PMJAY_THR_007 — Final bill must fit within the PMJAY package cap.
 *
 * Looks up the `package_cap` row in insurer_financial_limits for the rule
 * set, applies it as a ceiling against episode.financial_summary.total_billed.
 *
 * SKIP if no package_cap row exists OR no total_billed on the episode.
 */
import type { CustomFunction } from './index.js';

function getTotalBilled(episode: any): number | null {
  const candidates = [
    episode?.financial_summary?.total_billed,
    episode?.financial_summary?.total_amount,
    episode?.financial_summary?.gross_amount,
    episode?.financial_summary?.final_bill_amount,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export const validatePmjayPackageMatch: CustomFunction = async (episode, ruleContext, services) => {
  const total = getTotalBilled(episode);
  if (total == null) {
    return { status: 'SKIP', evidence: { reason: 'no total_billed on episode' }, message: null };
  }

  const result = await services.pool.query(
    `SELECT config
       FROM hospital.insurer_financial_limits
      WHERE rule_set_id = $1 AND limit_kind = 'package_cap'
      LIMIT 1`,
    [ruleContext.rule_set.id]
  );
  const row = result.rows?.[0];
  const cap = row ? Number(row.config?.limit_amount) : NaN;
  if (!Number.isFinite(cap) || cap <= 0) {
    return { status: 'SKIP', evidence: { reason: 'no package_cap configured' }, message: null };
  }

  if (total <= cap) {
    return { status: 'PASS', evidence: { total, cap }, message: null };
  }
  const overshoot = total - cap;
  return {
    status: 'FAIL',
    evidence: { total, cap, overshoot },
    message: `Final bill ${total} exceeds PMJAY package ${cap} by ${overshoot}`,
  };
};
