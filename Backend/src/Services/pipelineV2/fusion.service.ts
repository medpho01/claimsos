/**
 * Pipeline v2 — Stage 5: Authority-ranked deterministic fusion.
 *
 * This replaces the legacy harmoniser MEGA-CALL (one big LLM prompt that read
 * every section's facts and "decided" the episode). That call was the single
 * largest source of non-determinism and cross-section contamination: it could
 * be talked into promoting a chief complaint to a diagnosis, inverting
 * laterality, or fusing a stale page's date. Stage 5 makes the fusion a PURE,
 * AUDITABLE function — no LLM, no model judgement, just a fixed authority order
 * over doc types plus confidence × legibility tie-breaks.
 *
 * The rule, per canonical field (see FIELD_AUTHORITY in types.ts):
 *   1. Prefer the candidate from the MOST authoritative doc type for that field
 *      (discharge document wins the final diagnosis — the D3 fix; the OT note
 *      wins procedure + laterality — the laterality-inversion fix).
 *   2. Within the best authority tier, prefer the highest confidence × page
 *      legibility.
 *   3. Break remaining ties deterministically by page id (stable output).
 *
 * Corroboration, not just selection: when ≥2 sources AGREE on the winning
 * value, the fused confidence is nudged up; when distinct values COMPETE the
 * slot is marked `contested` and every losing candidate is retained so Stage 6
 * / the review queue can show the conflict instead of hiding it.
 *
 * Single-value slots (diagnosis, procedure, laterality, the three episode
 * dates, blood group, policy/insurer, bill total, DOB) fuse to ONE winner.
 * Multi-value slots (secondary diagnoses, medications, implants, lab values,
 * vitals, complaints, findings, allergies, anaesthesia) collapse to the set of
 * DISTINCT values, each carrying the provenance of its best source.
 */

import {
  SectionFact,
  CanonicalField,
  authorityRank,
  UNRANKED_AUTHORITY,
} from './types.js';
import { parseClinicalDay } from './identityGate.service.js';

/** A canonical slot after fusion: the winning value plus full audit trail. */
export interface FusedField {
  field: CanonicalField;
  value: string;
  /** doc_type of the winning source. */
  sourceDocType: string;
  /** DerivedPage id of the winning source — provenance for audit. */
  sourcePageId: string;
  /** Verbatim quote backing the winning value, when present. */
  quote?: string;
  /** Fused 0..1 confidence (winner conf × legibility, agreement-boosted). */
  confidence: number;
  /** Authority rank of the winning doc type for this field (lower = better). */
  authorityRank: number;
  /** false ⇔ the winner came only from an unranked/unknown doc type. */
  fromAuthoritativeSource: boolean;
  /** true ⇔ ≥2 DISTINCT values competed for this slot. */
  contested: boolean;
  /** Every candidate (winner first), for the review queue / audit. */
  candidates: FusedCandidate[];
}

export interface FusedCandidate {
  value: string;
  sourceDocType: string;
  sourcePageId: string;
  confidence: number;
  authorityRank: number;
}

/** The fused episode — canonical-shaped, provenance-bearing, audit-complete. */
export interface FusedEpisode {
  // ── single-value slots ──
  primary_diagnosis?: FusedField;
  procedure_name?: FusedField;
  laterality?: FusedField;
  admission_date?: FusedField;
  discharge_date?: FusedField;
  surgery_date?: FusedField;
  date_of_birth?: FusedField;
  blood_group?: FusedField;
  policy_number?: FusedField;
  insurer_name?: FusedField;
  bill_total?: FusedField;
  // ── multi-value slots ──
  secondary_diagnosis: FusedField[];
  medications: FusedField[];
  implants: FusedField[];
  lab_values: FusedField[];
  vitals: FusedField[];
  complaints: FusedField[];
  findings: FusedField[];
  allergies: FusedField[];
  anaesthesia: FusedField[];
  // ── audit ──
  /** Fields where distinct values competed — surfaced for review. */
  conflicts: { field: CanonicalField; values: string[] }[];
  /**
   * DISTINCT `sourceDocType` values across ALL fused facts in this episode —
   * i.e. which kinds of document the bundle actually contained. Stage 6 uses
   * this to tell "no authoritative diagnosis source exists in the bundle"
   * (harmonise-with-flag) apart from "an authoritative source exists but the
   * winner came from elsewhere" (abstain, the D3 rule). OPTIONAL so existing
   * hand-built fixtures still compile.
   */
  presentDocTypes?: string[];
}

const SINGLE_VALUE_FIELDS: CanonicalField[] = [
  'primary_diagnosis',
  'procedure_name',
  'laterality',
  'admission_date',
  'discharge_date',
  'surgery_date',
  'date_of_birth',
  'blood_group',
  'policy_number',
  'insurer_name',
  'bill_total',
];

const MULTI_VALUE_FIELDS: CanonicalField[] = [
  'secondary_diagnosis',
  'medication',
  'implant',
  'lab_value',
  'vital',
  'complaint',
  'finding',
  'allergy',
  'anaesthesia',
];

/**
 * Single-value DATE slots that describe THIS episode's clinical timeline. Used to
 * compute an episode reference day, so an equal-authority date candidate read with
 * a mistyped year/era (OCR "2020" for "2026") can be demoted BELOW a plausible-era
 * rival even when its raw confidence is marginally higher. `date_of_birth` is
 * intentionally EXCLUDED — a DOB is legitimately years/decades from the admission
 * and must never be judged against the episode window.
 */
const EPISODE_DATE_FIELDS = new Set<CanonicalField>([
  'admission_date',
  'discharge_date',
  'surgery_date',
]);

/**
 * A date candidate further than this many days from the episode reference day is
 * treated as an era outlier (a likely year/era misread) and demoted below
 * plausible-era candidates within the SAME authority tier. ~2 years: comfortably
 * wider than any real inpatient episode, tight enough to catch a wrong year.
 * Doubles as the clustering tolerance when deriving the reference day.
 */
const DATE_ERA_OUTLIER_DAYS = 730;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
const scoreOf = (f: SectionFact): number => clamp01(f.confidence) * clamp01(f.pageLegibility);

/**
 * Representative day of the dominant temporal cluster among `days`, clustering
 * values within `tolerance` days of each other (modeNumber-style — see
 * identityGate.service.ts). Returns the earliest day of the largest cluster, but
 * ONLY when that cluster has ≥2 members — i.e. when at least two dated reads
 * actually corroborate an era. With no corroboration (every date isolated) there
 * is no trustworthy reference, so it returns undefined and the caller leaves date
 * fusion unchanged. Robust to a MINORITY of misread/era-shifted dates; it does
 * not adjudicate between two equally-sized era clusters (returns the earlier, but
 * the ≥2 gate means that only happens when each era is itself corroborated).
 */
function corroboratedClusterDay(days: number[], tolerance: number): number | undefined {
  if (days.length < 2) return undefined;
  const sorted = [...days].sort((a, b) => a - b);
  let bestStart: number | undefined;
  let bestCount = 1; // a lone date is not corroboration — must beat 1 to count
  for (let i = 0; i < sorted.length; i++) {
    let count = 0;
    for (let j = i; j < sorted.length && sorted[j] - sorted[i] <= tolerance; j++) count++;
    if (count > bestCount) {
      bestCount = count;
      bestStart = sorted[i];
    }
  }
  return bestStart;
}

/**
 * The episode's reference day for era tie-breaking: the representative day of the
 * dominant cluster of all admission/discharge/surgery date candidates across the
 * bundle. Returns undefined when no episode date parses or none corroborate, in
 * which case era tie-breaking is inert and fusion is unchanged.
 */
function episodeReferenceDay(facts: SectionFact[]): number | undefined {
  const days: number[] = [];
  for (const f of facts) {
    if (!EPISODE_DATE_FIELDS.has(f.field)) continue;
    const day = parseClinicalDay(f.value);
    if (day !== null) days.push(day);
  }
  return corroboratedClusterDay(days, DATE_ERA_OUTLIER_DAYS);
}

/** true ⇔ this fact is an episode-date read implausibly far from the episode era. */
function isEraOutlier(field: CanonicalField, f: SectionFact, referenceDay?: number): boolean {
  if (referenceDay === undefined || !EPISODE_DATE_FIELDS.has(field)) return false;
  const day = parseClinicalDay(f.value);
  if (day === null) return false; // unparseable → don't penalise; let score decide
  return Math.abs(day - referenceDay) > DATE_ERA_OUTLIER_DAYS;
}

/**
 * Order a group of competing facts by the fusion rule: authority asc, then — for
 * episode-date slots with a known reference day — era plausibility (a candidate
 * implausibly far from the episode's dominant date cluster sorts last), then
 * score desc, then page id asc (deterministic).
 *
 * The era key sits strictly BELOW authority (it never overrides a more
 * authoritative source) and ABOVE score. It is inert unless `referenceDay` is
 * defined AND the field is an episode-date slot. Because it is only a tie-break,
 * a lone candidate — even an era outlier — still wins (nothing to lose to), and
 * if EVERY candidate is an outlier the key is uniform and score decides exactly
 * as before; so a genuine one-off correct date is never discarded.
 */
function rankGroup(
  field: CanonicalField,
  group: SectionFact[],
  referenceDay?: number,
): { f: SectionFact; rank: number; score: number; era: number }[] {
  return group
    .map((f) => ({
      f,
      rank: authorityRank(field, f.sourceDocType),
      score: scoreOf(f),
      era: isEraOutlier(field, f, referenceDay) ? 1 : 0,
    }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.era - b.era ||
        b.score - a.score ||
        a.f.sourcePageId.localeCompare(b.f.sourcePageId),
    );
}

function toCandidate(r: { f: SectionFact; rank: number }): FusedCandidate {
  return {
    value: r.f.value,
    sourceDocType: r.f.sourceDocType,
    sourcePageId: r.f.sourcePageId,
    confidence: clamp01(r.f.confidence),
    authorityRank: r.rank,
  };
}

/** Fuse a group of facts for ONE single-value slot into a winner. */
function fuseSingle(field: CanonicalField, group: SectionFact[], referenceDay?: number): FusedField {
  const ranked = rankGroup(field, group, referenceDay);
  const winner = ranked[0];
  const distinctValues = new Set(group.map((f) => norm(f.value)));
  const agreeing = group.filter((f) => norm(f.value) === norm(winner.f.value)).length;
  // Corroboration boost: +0.04 per extra agreeing source, capped at +0.1.
  const boost = Math.min(0.1, 0.04 * (agreeing - 1));
  return {
    field,
    value: winner.f.value,
    sourceDocType: winner.f.sourceDocType,
    sourcePageId: winner.f.sourcePageId,
    quote: winner.f.quote,
    confidence: clamp01(winner.score + boost),
    authorityRank: winner.rank,
    fromAuthoritativeSource: winner.rank < UNRANKED_AUTHORITY,
    contested: distinctValues.size > 1,
    candidates: ranked.map(toCandidate),
  };
}

/**
 * Fuse a group for a multi-value slot: collapse to DISTINCT values, each with
 * its best source. Sorted by fused confidence desc so the strongest items lead.
 */
function fuseMulti(field: CanonicalField, group: SectionFact[]): FusedField[] {
  const byValue = new Map<string, SectionFact[]>();
  for (const f of group) {
    const key = norm(f.value);
    if (!key) continue;
    (byValue.get(key) ?? byValue.set(key, []).get(key)!).push(f);
  }
  const out: FusedField[] = [];
  for (const facts of byValue.values()) {
    // A distinct value is never "contested" with itself; reuse fuseSingle and
    // clear the contested flag (any contest is across DIFFERENT values, which
    // for a multi-value slot is expected, not a conflict).
    const fused = fuseSingle(field, facts);
    fused.contested = false;
    out.push(fused);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Deterministically fuse Stage-4 SectionFacts into a canonical episode.
 *
 * @param facts — SectionFacts from Stage 4 (already excluding quarantined
 *   pages). EXIF/upload timestamps never reach here — Stage 1 doesn't emit
 *   them and Stage 4 only routes admission/discharge/surgery/dob roles.
 */
export function fuseEpisode(facts: SectionFact[]): FusedEpisode {
  const byField = new Map<CanonicalField, SectionFact[]>();
  for (const f of facts) {
    (byField.get(f.field) ?? byField.set(f.field, []).get(f.field)!).push(f);
  }

  const episode: FusedEpisode = {
    secondary_diagnosis: [],
    medications: [],
    implants: [],
    lab_values: [],
    vitals: [],
    complaints: [],
    findings: [],
    allergies: [],
    anaesthesia: [],
    conflicts: [],
  };

  // One reference day for the whole episode (dominant cluster of admission/
  // discharge/surgery date reads). Used only to demote era-outlier date
  // candidates within their authority tier; undefined ⇒ no-op.
  const referenceDay = episodeReferenceDay(facts);

  for (const field of SINGLE_VALUE_FIELDS) {
    const group = byField.get(field);
    if (group && group.length) {
      const fused = fuseSingle(field, group, referenceDay);
      (episode as Record<string, unknown>)[field] = fused;
      if (fused.contested) {
        episode.conflicts.push({
          field,
          values: [...new Set(group.map((f) => f.value))],
        });
      }
    }
  }

  // Multi-value slots route to their plural episode keys.
  const MULTI_KEY: Record<string, keyof FusedEpisode> = {
    secondary_diagnosis: 'secondary_diagnosis',
    medication: 'medications',
    implant: 'implants',
    lab_value: 'lab_values',
    vital: 'vitals',
    complaint: 'complaints',
    finding: 'findings',
    allergy: 'allergies',
    anaesthesia: 'anaesthesia',
  };
  for (const field of MULTI_VALUE_FIELDS) {
    const group = byField.get(field);
    if (group && group.length) {
      (episode as Record<string, unknown>)[MULTI_KEY[field]] = fuseMulti(field, group);
    }
  }

  // Record the DISTINCT doc types present across ALL fused facts so Stage 6 can
  // distinguish "no authoritative source exists" from "winner came from a
  // non-authoritative page despite one existing".
  episode.presentDocTypes = [...new Set(facts.map((f) => f.sourceDocType))];

  return episode;
}
