/**
 * PMJAY_THR_008 / generic — LOS within expected benchmark + tolerance.
 *
 * Looks up insurer_los_benchmarks by procedure code (primary procedure on
 * episode) and compares actual LOS. Beyond expected+tolerance, FAIL.
 * Beyond justification_required_beyond also FAIL (sharper message).
 */
import type { CustomFunction } from './index.js';

function getActualLos(episode: any): number | null {
  const candidates = [
    episode?.meta?.length_of_stay_days,
    episode?.clinical_summary?.total_los_days,
    episode?.length_of_stay_days,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const adm = episode?.meta?.admission_date;
  const dis = episode?.meta?.discharge_date;
  if (adm && dis) {
    const ms = new Date(dis).getTime() - new Date(adm).getTime();
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms / (1000 * 60 * 60 * 24));
  }
  return null;
}

function getPrimaryProcedureCode(episode: any): string | null {
  const proc =
    episode?.procedures_performed?.[0] ??
    episode?.procedure?.primary_procedure ??
    episode?.procedures?.[0];
  if (!proc) return null;
  const code = proc.procedure_code ?? proc.code ?? proc.cpt_code;
  return code ? String(code) : null;
}

export const validateLosAgainstBenchmark: CustomFunction = async (episode, ruleContext, services) => {
  const los = getActualLos(episode);
  if (los == null) {
    return { status: 'SKIP', evidence: { reason: 'no LOS or admission/discharge dates on episode' }, message: null };
  }
  const procedureCode = getPrimaryProcedureCode(episode);
  if (!procedureCode) {
    return { status: 'SKIP', evidence: { reason: 'no primary procedure code on episode' }, message: null };
  }
  const result = await services.pool.query(
    `SELECT procedure_code, procedure_name, expected_los_days, tolerance_days, justification_required_beyond
       FROM hospital.insurer_los_benchmarks
      WHERE rule_set_id = $1 AND procedure_code = $2
      LIMIT 1`,
    [ruleContext.rule_set.id, procedureCode]
  );
  const row = result.rows?.[0];
  if (!row) {
    return {
      status: 'SKIP',
      evidence: { reason: `no benchmark for procedure ${procedureCode}` },
      message: null,
    };
  }
  const expected = Number(row.expected_los_days);
  const tolerance = Number(row.tolerance_days ?? 0);
  const justBeyond = Number(row.justification_required_beyond ?? expected + tolerance);
  if (!Number.isFinite(expected)) {
    return { status: 'SKIP', evidence: { reason: 'benchmark expected_los_days non-numeric' }, message: null };
  }
  if (los <= expected + tolerance) {
    return { status: 'PASS', evidence: { los, expected, tolerance }, message: null };
  }
  return {
    status: 'FAIL',
    evidence: { los, expected, tolerance, justification_required_beyond: justBeyond, procedure_code: procedureCode },
    message: `LOS ${los} exceeds expected ${expected} (+${tolerance} tolerance) for ${procedureCode}`,
  };
};
