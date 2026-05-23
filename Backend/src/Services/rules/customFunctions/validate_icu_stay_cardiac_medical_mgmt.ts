/**
 * CARDIAC_003 — ICU stay > 3 days during medical management requires
 * justification. We treat "justification present" as: daily_progress notes
 * count >= 3 inside the ICU phase (proxy — once richer narrative grading
 * lands in Wave 9 we can sharpen this).
 *
 * SKIP when the episode is not MEDICAL_MANAGEMENT or has no ICU phase.
 */
import type { CustomFunction } from './index.js';

function sumIcuDays(episode: any): { icu_days: number; progress_notes: number } {
  const tl = Array.isArray(episode?.clinical_timeline) ? episode.clinical_timeline : [];
  let icuDays = 0;
  let progressNotes = 0;
  for (const phase of tl) {
    const code = String(phase?.phase_code ?? '').toUpperCase();
    const isIcu = code === 'ICU' || code === 'ICU_STAY' || /ICU/.test(code);
    const roomCat = String(phase?.room_category ?? '').toUpperCase();
    if (isIcu || roomCat === 'ICU') {
      const dur = phase?.duration;
      if (dur && typeof dur === 'object') {
        const v = Number(dur.value);
        if (Number.isFinite(v)) {
          if (dur.unit === 'DAYS') icuDays += v;
          else if (dur.unit === 'HOURS') icuDays += v / 24;
        }
      } else if (Number.isFinite(Number(phase?.days))) {
        icuDays += Number(phase.days);
      }
      const dp = Array.isArray(phase?.daily_progress) ? phase.daily_progress.length : 0;
      progressNotes += dp;
    }
  }
  return { icu_days: icuDays, progress_notes: progressNotes };
}

export const validateIcuStayCardiacMedicalMgmt: CustomFunction = async (episode) => {
  const episodeType = String(episode?.meta?.episode_type ?? '').toUpperCase();
  if (episodeType !== 'MEDICAL_MANAGEMENT') {
    return { status: 'SKIP', evidence: { reason: `episode_type=${episodeType}` }, message: null };
  }
  const { icu_days, progress_notes } = sumIcuDays(episode);
  if (icu_days <= 0) {
    return { status: 'SKIP', evidence: { reason: 'no ICU stay detected' }, message: null };
  }
  if (icu_days <= 3) {
    return { status: 'PASS', evidence: { icu_days, progress_notes }, message: null };
  }
  if (progress_notes >= 3) {
    return { status: 'PASS', evidence: { icu_days, progress_notes, justified: true }, message: null };
  }
  return {
    status: 'FAIL',
    evidence: { icu_days, progress_notes, justified: false },
    message: `ICU stay of ${icu_days.toFixed(1)} days lacks adequate progress-note justification`,
  };
};
