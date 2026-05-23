/**
 * CARDIAC_004 / ORTHO room caps — verify room category in clinical_timeline
 * matches insurance_context.room_eligibility (or a tier rank). When the
 * harmonised episode has no room_eligibility we SKIP; richer logic lands
 * after Wave 9 policy ingestion.
 */
import type { CustomFunction } from './index.js';

const ROOM_RANK: Record<string, number> = {
  GENERAL_WARD: 1,
  TWIN_SHARING: 2,
  SHARED: 2,
  SINGLE_PRIVATE: 3,
  SINGLE_PRIVATE_AC: 3,
  PRIVATE: 3,
  DELUXE: 4,
  SUITE: 5,
  ICU: 99, // ICU rooms are governed by separate caps; ignore for eligibility comparison
};

function normalizeRoom(s: any): string {
  return String(s ?? '').toUpperCase().replace(/[\s-]+/g, '_');
}

function highestRoomCategoryUsed(episode: any): string | null {
  const tl = Array.isArray(episode?.clinical_timeline) ? episode.clinical_timeline : [];
  let bestRank = -1;
  let best: string | null = null;
  for (const phase of tl) {
    const cat = normalizeRoom(phase?.room_category);
    if (!cat) continue;
    if (cat === 'ICU') continue;
    const rank = ROOM_RANK[cat] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = cat;
    }
  }
  return best;
}

export const validateRoomEligibility: CustomFunction = async (episode) => {
  const eligibility = normalizeRoom(episode?.insurance_context?.room_eligibility);
  if (!eligibility) {
    return {
      status: 'SKIP',
      evidence: { reason: 'insurance_context.room_eligibility absent on harmonised episode' },
      message: null,
    };
  }
  const used = highestRoomCategoryUsed(episode);
  if (!used) {
    return {
      status: 'SKIP',
      evidence: { reason: 'no room_category in clinical_timeline' },
      message: null,
    };
  }
  const eligibleRank = ROOM_RANK[eligibility] ?? 0;
  const usedRank = ROOM_RANK[used] ?? 0;
  if (usedRank <= eligibleRank) {
    return {
      status: 'PASS',
      evidence: { eligibility, used, eligible_rank: eligibleRank, used_rank: usedRank },
      message: null,
    };
  }
  return {
    status: 'FAIL',
    evidence: { eligibility, used, eligible_rank: eligibleRank, used_rank: usedRank },
    message: `Room category ${used} exceeds eligibility ${eligibility}; proportionate deduction applies`,
  };
};
