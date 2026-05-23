/**
 * ORTHO_006 — Physiotherapy coverage requires (a) prescription in
 * discharge_medications / treatment_plan, AND (b) ≥1 mention of 'physio'
 * inside daily_progress notes.
 *
 * SKIP if the episode shows no physiotherapy charge at all (rule is moot).
 */
import type { CustomFunction } from './index.js';

function hasPrescription(episode: any): boolean {
  const meds: any[] = Array.isArray(episode?.discharge_medications)
    ? episode.discharge_medications
    : [];
  if (meds.some((m) => /PHYSIO/i.test(String(m?.name ?? m?.drug ?? m?.description ?? '')))) {
    return true;
  }
  const plan = episode?.treatment_plan;
  if (plan) {
    const planStr = typeof plan === 'string' ? plan : JSON.stringify(plan);
    if (/PHYSIO/i.test(planStr)) return true;
  }
  return false;
}

function hasProgressMention(episode: any): boolean {
  const tl = Array.isArray(episode?.clinical_timeline) ? episode.clinical_timeline : [];
  for (const phase of tl) {
    const dp = Array.isArray(phase?.daily_progress) ? phase.daily_progress : [];
    for (const note of dp) {
      const text = typeof note === 'string' ? note : JSON.stringify(note ?? {});
      if (/PHYSIO/i.test(text)) return true;
    }
  }
  return false;
}

function hasPhysioCharge(episode: any): boolean {
  const items: any[] = Array.isArray(episode?.financial_summary?.line_items)
    ? episode.financial_summary.line_items
    : Array.isArray(episode?.financial_summary?.breakdown?.physiotherapy_charges)
    ? episode.financial_summary.breakdown.physiotherapy_charges
    : [];
  if (items.some((i) => /PHYSIO/i.test(String(i?.description ?? i?.name ?? '')))) return true;
  const explicit = episode?.financial_summary?.breakdown?.physiotherapy_charges;
  if (explicit && typeof explicit === 'object' && Number(explicit.total) > 0) return true;
  return false;
}

export const validatePhysiotherapyPrescription: CustomFunction = async (episode) => {
  if (!hasPhysioCharge(episode)) {
    return { status: 'SKIP', evidence: { reason: 'no physiotherapy charge present' }, message: null };
  }
  const prescription = hasPrescription(episode);
  const progress = hasProgressMention(episode);
  if (prescription && progress) {
    return { status: 'PASS', evidence: { prescription, progress }, message: null };
  }
  return {
    status: 'FAIL',
    evidence: { prescription, progress },
    message: 'Physiotherapy charges require both doctor\'s prescription and supporting progress notes',
  };
};
