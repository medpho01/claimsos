/**
 * Patient identity anchoring & cross-document validation helpers for the
 * Harmoniser (Task H4 + H10 from the 30-patient smoke test).
 *
 * Why this exists
 * ───────────────
 * The Sadbhawana smoke test surfaced two systemic failure modes the
 * harmoniser was silent on:
 *
 *   • FOREIGN documents in a patient's bundle (Babbu's PDF contained a
 *     full X-ray for "MR PAPPU" — different patient; Aman Faiz's bundle
 *     had a consent for "Mrs. Begum Faiz"; Vahadur's had an unrelated
 *     traffic-violation affidavit for "Smt. ANUPMA VERMA"). The
 *     pipeline silently absorbed those sections into the wrong claim.
 *
 *   • SPOUSAL CROSS-LEAK across separate claims that share a household
 *     (Vahid + Bhuri ended up with identical admission/discharge times
 *     and crossed Aadhaar numbers).
 *
 * Both failures collapse to the same root cause: no per-claim canonical
 * patient identity, no anchor against which other-section names get
 * checked.
 *
 * Approach
 * ────────
 * 1.  Compute one canonical patient identity per claim from the
 *     highest-trust ID documents (aadhaar, pmjay card, BIS family tree,
 *     admission form). Cluster candidate names by normalised
 *     Levenshtein similarity. The cluster with the most weight wins,
 *     ties broken by which matches the ipds.first_name seed.
 *
 * 2.  Walk every other section, look for a patient_name-like field.
 *     Score it against the canonical:
 *        ≤ 0.3 distance     → keep, no flag
 *        0.3 < d ≤ 0.5     → keep, weak-match flag
 *        > 0.5             → drop & record as foreign_documents[]
 *
 * 3.  After clustering, cross-check the ID docs themselves for
 *     identity-mismatch (Task H10). Hamshiran's pmjay_card was for
 *     "JOGINDER SINGH" — that doc is dropped and logged loudly.
 *
 * Hindi-transliteration tolerance
 * ───────────────────────────────
 * Sunil / Suneel / Sunneel must match. We compare on the most
 * distinctive token (typically the given name) and use a normalised
 * Levenshtein threshold. Last names are commonly missing or written
 * differently across documents, so we don't insist on a multi-token
 * match.
 *
 * Pure functions only — no DB or LLM calls. The harmonisation service
 * orchestrates the inputs and writes validation_metadata.
 */

import type { HarmoniserSectionInput } from '../llm/prompts/harmoniser.v1.js';

// ─── String normalisation ──────────────────────────────────────────────

/**
 * Aggressive name normalisation: lowercase, strip honorifics, collapse
 * whitespace, drop punctuation. We're trying to make
 *   "Mr. Suneel Singh "  and  "suneel singh"
 * compare identically.
 */
export function normaliseName(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  // Strip common honorifics — keep this small; we only want to remove
  // tokens that are unambiguously titles.
  s = s.replace(
    /^(mr|mrs|ms|miss|smt|shri|sri|dr|md|mohd|mohammad)\.?\s+/,
    '',
  );
  // Drop punctuation, collapse whitespace.
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Pick the "most distinctive token" from a name for comparison. Given
 * names tend to differ across docs less than family names (different
 * languages, abbreviations, full vs short). We pick the longest token
 * which is typically the given name in transliterated Hindi.
 *
 * Returns the empty string for empty input.
 */
export function distinctiveToken(name: string): string {
  const norm = normaliseName(name);
  if (!norm) return '';
  const tokens = norm.split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return norm;
  // Pick the longest token; on a tie, the first one. This favours the
  // given name for Indian-name conventions where the first token is
  // typically the most stable across docs.
  let best = tokens[0]!;
  for (const t of tokens) if (t.length > best.length) best = t;
  return best;
}

// ─── Levenshtein ───────────────────────────────────────────────────────

/**
 * Plain Levenshtein edit distance (insert/delete/substitute = 1).
 * Iterative DP, two-row variant to stay O(min(a,b)) memory.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Ensure a is the shorter — saves memory.
  if (a.length > b.length) {
    const t = a;
    a = b;
    b = t;
  }
  let prev = new Array(a.length + 1);
  let cur = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    cur[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[i] = Math.min(
        cur[i - 1] + 1,
        prev[i] + 1,
        prev[i - 1] + cost,
      );
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[a.length];
}

/**
 * Normalised distance in [0..1]. 0 = identical, 1 = completely different.
 * Computed as edit_distance / max(|a|,|b|).
 *
 * Both inputs are normalised through {@link normaliseName} + reduced to
 * their distinctive token before comparison. Two empty inputs are
 * considered different (distance 1) — we never want to claim a match on
 * missing data.
 */
export function normalisedNameDistance(a: string, b: string): number {
  const ta = distinctiveToken(a);
  const tb = distinctiveToken(b);
  if (!ta || !tb) return 1;
  if (ta === tb) return 0;
  const d = levenshtein(ta, tb);
  return d / Math.max(ta.length, tb.length);
}

// ─── Candidate extraction from a section ───────────────────────────────

/**
 * Sections whose extractor fields carry an authoritative patient name.
 * These are weighted highest when picking the canonical identity.
 */
const ID_DOC_CATEGORIES: ReadonlySet<string> = new Set([
  'aadhaar_card',
  'aadhaar_front',
  'aadhaar_back',
  'pmjay_card',
  'pmjay_bis_family_tree',
]);

/**
 * Sections that carry the patient name but are LESS authoritative — the
 * name is typically transcribed by hospital staff and prone to typos.
 */
const ADMISSION_DOC_CATEGORIES: ReadonlySet<string> = new Set([
  'admission_form',
  'admission_note',
  'admission_notes',
  'discharge_summary',
  'discharge_slip',
  'surgical_discharge_slip',
  'patient_registration_form',
  'abha_card',
]);

/**
 * Clinical sections that often carry the patient name as a header field
 * (typed in by hospital staff). Weighted lower than ID/admission docs
 * but still vote — they are the ONLY signal in claims where the bundle
 * lacks proper KYC docs (e.g. only blood_test_reports/xray_reports
 * carry "Mr. TAUKID" while the lone aadhaar is for a family member).
 */
const CLINICAL_DOC_CATEGORIES: ReadonlySet<string> = new Set([
  'blood_test_reports',
  'xray_reports',
  'serology_reports',
  'biopsy_reports',
  'histopathology_reports',
  'ct_scan_reports',
  'mri_reports',
  'ultrasound_reports',
  'abg_reports',
  'progress_notes',
  'opd_notes',
  'ot_notes',
  'ot_notes_and_photos',
  'procedure_notes',
  'surgery_notes',
  'clinician_notes',
  'consultation_notes',
  'daily_clinical_notes',
  'nursing_charts',
  'medication_charts',
  'surgery_consent_form',
  'anaesthesia_consent',
  'consent',
  'investigations',
  'post_op_reports',
  'post_surgery_diagnostics',
  'surgical_checklist',
]);

/**
 * Field keys we look at for the GENERIC case (one field per section).
 * The first non-empty wins. Mirrors the extractor's typical schema.
 *
 * NOTE: `head_of_family` is INTENTIONALLY EXCLUDED from this list —
 * it is the family-head name (BHURI on Indra Dev's family tree), NOT
 * the actual patient. Sections that expose head_of_family are handled
 * by the per-category logic below which uses `family_members` (matched
 * against the ipds seed) instead.
 */
const NAME_FIELDS: ReadonlyArray<string> = [
  'patient_name',
  'full_name',
  'holder_name',
  'name',
  'beneficiary_name',
];

/**
 * Categories where we MUST NOT use head_of_family / holder_name / etc.
 * as a patient-name candidate (they carry the family-head's name, not
 * the patient's). For these categories, the patient name is recovered
 * from `family_members` via the seed-name matcher in
 * {@link extractCandidateNameForSection}.
 */
const FAMILY_HEAD_CATEGORIES: ReadonlySet<string> = new Set([
  'pmjay_bis_family_tree',
  'ration_card',
]);

/**
 * Pick the patient name candidate from a `family_members` comma-list
 * by fuzzy-matching against the seed name. Returns null when the seed
 * is missing or no member is within distance threshold.
 *
 * Example: seed="Indra Dev", family_members="Bhuri, Dalchand, Inder Dev,
 * Vinit" → "Inder Dev".
 */
export function pickFamilyMemberMatchingSeed(
  membersRaw: unknown,
  seedName: string | null | undefined,
): string | null {
  if (!seedName || typeof membersRaw !== 'string') return null;
  const members = membersRaw
    .split(/[,;]/)
    .map((m) => m.trim())
    .filter((m) => m.length >= 2);
  if (!members.length) return null;
  // Slightly looser threshold (0.45) than the cluster matcher's 0.3.
  // The ipds seed and the PMJAY family-tree entry are typically two
  // different transliterations of the same Hindi name (Indra Dev vs
  // Inder Dev — normalised edit distance 0.4). We're matching against
  // a known-small candidate set (≤ ~10 family members) so the
  // false-positive risk is much lower than for the section-vote
  // clustering threshold.
  let best: { name: string; d: number } | null = null;
  for (const m of members) {
    const d = normalisedNameDistance(m, seedName);
    if (d <= 0.45 && (best === null || d < best.d)) {
      best = { name: m, d };
    }
  }
  return best?.name ?? null;
}

/**
 * Extract the best candidate name from a section's extracted_fields,
 * with per-category logic:
 *
 *   - For `pmjay_bis_family_tree` / `ration_card`: use the seed name
 *     to pick the matching `family_members` entry. We DON'T use
 *     `head_of_family` blindly — it's the family head, not the patient.
 *
 *   - For everything else: fall back to {@link NAME_FIELDS} in order.
 *
 * `seedName` is optional. When omitted, family-head categories yield
 * null (we'd rather have no candidate than the wrong one).
 */
export function extractCandidateNameForSection(
  section: HarmoniserSectionInput,
  seedName?: string | null,
): string | null {
  const f: any = section.extracted_fields;
  if (!f || typeof f !== 'object') return null;

  if (section.category && FAMILY_HEAD_CATEGORIES.has(section.category)) {
    return pickFamilyMemberMatchingSeed(f.family_members, seedName);
  }

  for (const key of NAME_FIELDS) {
    const v = f[key];
    if (typeof v === 'string' && v.trim().length >= 2) return v.trim();
  }
  return null;
}

/**
 * Legacy single-arg shim. Retained for backwards compatibility with
 * cross-validation code that doesn't have a seed in scope. Does NOT
 * apply family-head filtering; callers in identity-mismatch paths
 * compare ID-doc names pairwise so picking head_of_family there is
 * fine (mismatch detection only fires on multi-source disagreement).
 */
export function extractCandidateName(
  section: HarmoniserSectionInput,
): string | null {
  const f: any = section.extracted_fields;
  if (!f || typeof f !== 'object') return null;
  for (const key of NAME_FIELDS) {
    const v = f[key];
    if (typeof v === 'string' && v.trim().length >= 2) return v.trim();
  }
  // For pmjay_bis_family_tree / ration_card we'll still surface
  // head_of_family here (legacy callers depend on it); the voter no
  // longer goes through this path.
  if (typeof f.head_of_family === 'string' && f.head_of_family.trim().length >= 2) {
    return f.head_of_family.trim();
  }
  if (typeof f.beneficiary_name === 'string' && f.beneficiary_name.trim().length >= 2) {
    return f.beneficiary_name.trim();
  }
  return null;
}

/** Source weight for canonical-identity voting. */
function sectionWeight(category: string | null | undefined): number {
  if (!category) return 0;
  if (ID_DOC_CATEGORIES.has(category)) return 3;
  if (ADMISSION_DOC_CATEGORIES.has(category)) return 2;
  if (CLINICAL_DOC_CATEGORIES.has(category)) return 1;
  return 0;
}

// ─── Canonical patient identity ────────────────────────────────────────

export interface CanonicalPatient {
  /** The canonical name (verbatim from the most-trusted source). */
  name: string;
  /** Voting score — sum of section weights that agreed with the canonical. */
  weight: number;
  /** Total weight observed across all candidates (for confidence ratio). */
  total_weight: number;
  /** Bucketed similarity confidence: 0..1 (weight / total_weight). */
  confidence: number;
  /** Section ids that voted for the canonical cluster. */
  supporting_section_ids: string[];
  /**
   * True when we couldn't anchor with high confidence — set when no
   * cluster matched the ipds seed within the strict threshold, OR when
   * the winning cluster has only a single weak vote and no seed
   * corroboration. Downstream readers should treat the name as a hint,
   * not gospel.
   */
  uncertain: boolean;
  /** Optional explanation of why we set uncertain=true. */
  uncertain_reason?: string;
  /**
   * The ipds seed name that the voter was anchored against. Useful for
   * audit logs / reviewer UI.
   */
  seed_name: string | null;
}

/**
 * Compute the canonical patient identity for a claim. Returns null when
 * NO section yielded a candidate name AND no seed is available.
 *
 * Voting model (May 2026 rewrite, post-bleed-incident):
 *
 * 1.  Extract candidate names per-section. For pmjay_bis_family_tree /
 *     ration_card we DO NOT use `head_of_family` — that's the family
 *     head, not the patient. Instead we match the seed against the
 *     `family_members` list to find the patient's entry.
 *
 * 2.  Cluster candidates by Levenshtein similarity (threshold 0.3).
 *
 * 3.  SEED PRIOR: when a seed (ipds.first_name) is available, any
 *     cluster whose representative or members are within 0.3 of the
 *     seed gets a +5 weight boost. This dominates two-vote noise from
 *     the wrong-family-head or wrong-aadhaar scenarios.
 *
 * 4.  If a seed exists but NO cluster matches it within 0.3, we mark
 *     the result `uncertain=true`. Reviewers see the canonical block
 *     flagged so they can spot-check before adjudication.
 *
 * 5.  When only the seed is available (no candidates at all), we
 *     synthesise a canonical from the seed with low confidence and
 *     uncertain=true rather than returning null. Returning null caused
 *     the harmoniser to silently disable identity gating altogether,
 *     which was the failure mode for Anvi (xray_reports for "HINA
 *     PARVEEN" was the only candidate, and it was a foreign doc).
 */
export function findCanonicalPatient(
  sections: HarmoniserSectionInput[],
  seedName?: string | null,
): CanonicalPatient | null {
  const seed = (seedName ?? '').trim() || null;

  interface Cand {
    raw: string;
    weight: number;
    section_id: string;
    category: string | null;
  }
  const candidates: Cand[] = [];
  for (const s of sections) {
    const w = sectionWeight(s.category);
    if (w === 0) continue;
    const n = extractCandidateNameForSection(s, seed);
    if (!n) continue;
    candidates.push({
      raw: n,
      weight: w,
      section_id: s.section_id,
      category: s.category ?? null,
    });
  }

  // Cluster by similarity. Greedy: walk candidates in weight-desc order,
  // attach to first cluster within MATCH_THRESHOLD, else start a new
  // cluster. Threshold 0.3 == "≤30% normalised edit distance".
  const MATCH_THRESHOLD = 0.3;
  // Seed-prior matching is looser than cluster matching because the
  // hospital-records seed ("Indra Dev") and KYC-doc forms ("INDER
  // DEV") routinely differ by 0.4 due to transliteration. We only use
  // the boosted weight to settle ties / overcome 1-2 noise votes —
  // the cluster itself is still chosen by raw vote weight from real
  // documents.
  const SEED_MATCH_THRESHOLD = 0.45;
  const SEED_PRIOR_BOOST = 5;

  candidates.sort((a, b) => b.weight - a.weight);

  interface Cluster {
    representative: string;
    weight: number;
    section_ids: string[];
    members: string[];
    seed_matched: boolean;
    /** weight before applying seed-prior boost (for confidence math) */
    rawWeight: number;
  }
  const clusters: Cluster[] = [];
  for (const c of candidates) {
    let attached = false;
    for (const cl of clusters) {
      if (normalisedNameDistance(c.raw, cl.representative) <= MATCH_THRESHOLD) {
        cl.weight += c.weight;
        cl.rawWeight += c.weight;
        cl.section_ids.push(c.section_id);
        cl.members.push(c.raw);
        attached = true;
        break;
      }
    }
    if (!attached) {
      clusters.push({
        representative: c.raw,
        weight: c.weight,
        rawWeight: c.weight,
        section_ids: [c.section_id],
        members: [c.raw],
        seed_matched: false,
      });
    }
  }

  // Apply seed prior: if seed matches a cluster's representative or any
  // member within SEED_MATCH_THRESHOLD, boost that cluster. This makes
  // ipds.first_name a strong anchor without being absolute.
  let seedMatchedAnyCluster = false;
  if (seed) {
    for (const cl of clusters) {
      let matches = normalisedNameDistance(cl.representative, seed) <= SEED_MATCH_THRESHOLD;
      if (!matches) {
        for (const m of cl.members) {
          if (normalisedNameDistance(m, seed) <= SEED_MATCH_THRESHOLD) {
            matches = true;
            break;
          }
        }
      }
      if (matches) {
        cl.seed_matched = true;
        cl.weight += SEED_PRIOR_BOOST;
        seedMatchedAnyCluster = true;
      }
    }
  }

  // No candidates at all → synthesise from seed if available.
  if (!clusters.length) {
    if (!seed) return null;
    return {
      name: seed,
      weight: 0,
      total_weight: 0,
      confidence: 0,
      supporting_section_ids: [],
      uncertain: true,
      uncertain_reason: 'no_candidate_names_seed_only',
      seed_name: seed,
    };
  }

  // Pick the highest-weight cluster. Tiebreak prefers seed-matched
  // cluster then closeness to seed.
  clusters.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (a.seed_matched !== b.seed_matched) return a.seed_matched ? -1 : 1;
    if (seed) {
      return (
        normalisedNameDistance(a.representative, seed) -
        normalisedNameDistance(b.representative, seed)
      );
    }
    return 0;
  });
  const winner = clusters[0]!;
  const totalRawWeight = clusters.reduce((acc, c) => acc + c.rawWeight, 0);

  // Prefer a winner-member that's closest to the seed — handles the
  // Divyansh case (cluster contains "DVYANSH"; seed="Divyansh" →
  // we'd rather emit the seed spelling than the OCR-corrupted form).
  // If the seed itself is at least as close to the cluster as any
  // member, use the seed verbatim — its capitalisation/punctuation is
  // typically the cleaner display form.
  let displayName = winner.representative;
  if (seed && winner.seed_matched) {
    let bestD = normalisedNameDistance(displayName, seed);
    let chooseSeed = false;
    for (const m of winner.members) {
      const d = normalisedNameDistance(m, seed);
      if (d < bestD) {
        bestD = d;
        displayName = m;
      }
    }
    // If no member is closer to the seed than 0.15, use the seed name
    // directly (it's effectively the canonical spelling we have on
    // record). This collapses "DVYANSH" → "Divyansh".
    if (bestD > 0.1) {
      chooseSeed = true;
    }
    if (chooseSeed) {
      displayName = seed;
    }
  }

  // Determine uncertainty.
  let uncertain = false;
  let uncertainReason: string | undefined;
  if (seed && !seedMatchedAnyCluster) {
    uncertain = true;
    uncertainReason = 'no_cluster_matched_ipds_seed';
    // P0 safety: when the ipds seed (the hospital's master-record
    // patient name) doesn't match ANY clustered candidate, we
    // explicitly DO NOT confidently emit any candidate name — that's
    // the exact failure mode that resolved Anvi → "HINA PARVEEN"
    // (the only candidate was from foreign xray_reports for a
    // different patient). Prefer the seed itself as the canonical;
    // adjudication-downstream still sees uncertain=true, and the
    // reviewer can correct from there. Returning the seed protects
    // against bleed-to-wrong-beneficiary which is the worst-case
    // outcome.
    displayName = seed;
  } else if (!seed && winner.rawWeight <= 1) {
    uncertain = true;
    uncertainReason = 'single_weak_vote_no_seed';
  } else if (winner.rawWeight <= 1 && !winner.seed_matched) {
    uncertain = true;
    uncertainReason = 'single_weak_vote';
  }

  const confidence = totalRawWeight === 0
    ? (winner.seed_matched ? 0.5 : 0)
    : winner.rawWeight / totalRawWeight;

  return {
    name: displayName,
    weight: winner.weight,
    total_weight: totalRawWeight,
    confidence,
    supporting_section_ids: winner.section_ids,
    uncertain,
    uncertain_reason: uncertainReason,
    seed_name: seed,
  };
}

// ─── Foreign-document filtering ────────────────────────────────────────

export type IdentityVerdict =
  | { decision: 'keep'; distance: number; observed_name: string | null }
  | { decision: 'weak'; distance: number; observed_name: string }
  | { decision: 'drop'; distance: number; observed_name: string };

/**
 * Compare a section's candidate patient_name to the canonical. Returns
 * a verdict the harmoniser can act on.
 *
 *   ≤ 0.3 → keep
 *   0.3 < d ≤ 0.5 → weak (keep + flag)
 *   > 0.5 → drop (foreign document)
 *
 * Sections with no patient_name field receive 'keep' (we can't gate on
 * data we don't have — they're treated as supportive evidence whose
 * identity is asserted by file bundling).
 */
export function classifySectionIdentity(
  section: HarmoniserSectionInput,
  canonical: CanonicalPatient,
): IdentityVerdict {
  const observed = extractCandidateName(section);
  if (!observed) {
    return { decision: 'keep', distance: 0, observed_name: null };
  }
  const d = normalisedNameDistance(observed, canonical.name);
  if (d <= 0.3) return { decision: 'keep', distance: d, observed_name: observed };
  if (d <= 0.5) return { decision: 'weak', distance: d, observed_name: observed };
  return { decision: 'drop', distance: d, observed_name: observed };
}

// ─── Identity cross-validation (Task H10) ──────────────────────────────

export interface IdentityMismatch {
  field_a: string;
  field_b: string;
  value_a: string;
  value_b: string;
  distance: number;
}

export interface WrongPmjayCard {
  section_id: string;
  observed_holder: string;
  canonical_name: string;
  distance: number;
}

export interface IdentityValidationResult {
  /** Pairs of ID-doc names that disagree past the 0.4 threshold. */
  mismatches: IdentityMismatch[];
  /**
   * pmjay_card sections whose holder name is a completely different
   * person (> 0.6 normalised distance from canonical). The harmoniser
   * should DROP these sections from the episode.
   */
  wrong_pmjay_cards: WrongPmjayCard[];
}

/**
 * Cross-check the names on the high-trust ID documents and flag
 * inconsistencies. Drives Task H10: identity mismatch validation.
 *
 *   • Pairwise compare every aadhaar_front / pmjay_card / pmjay_bis_family_tree
 *     name. If two disagree by > 0.4 normalised distance, append to
 *     mismatches[]. (The caller turns this into validation_metadata.identity_mismatch.)
 *
 *   • Any pmjay_card holder that diverges from canonical by > 0.6 is
 *     declared a "wrong card" — the section is logged & should be
 *     dropped from the episode entirely.
 */
export function crossValidateIdentity(
  sections: HarmoniserSectionInput[],
  canonical: CanonicalPatient,
): IdentityValidationResult {
  const mismatches: IdentityMismatch[] = [];
  const wrongPmjay: WrongPmjayCard[] = [];

  // Collect (field-label, value) tuples from high-trust ID sections.
  interface IdSample {
    field: string;
    value: string;
    section_id: string;
    category: string;
  }
  const samples: IdSample[] = [];
  for (const s of sections) {
    if (!s.category || !ID_DOC_CATEGORIES.has(s.category)) continue;
    const f: any = s.extracted_fields;
    if (!f || typeof f !== 'object') continue;
    for (const key of NAME_FIELDS) {
      const v = f[key];
      if (typeof v === 'string' && v.trim().length >= 2) {
        samples.push({
          field: `${s.category}.${key}`,
          value: v.trim(),
          section_id: s.section_id,
          category: s.category,
        });
        break; // one canonical name per section
      }
    }
  }

  // Pairwise mismatch detection (threshold 0.4).
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i]!;
      const b = samples[j]!;
      const d = normalisedNameDistance(a.value, b.value);
      if (d > 0.4) {
        mismatches.push({
          field_a: a.field,
          field_b: b.field,
          value_a: a.value,
          value_b: b.value,
          distance: d,
        });
      }
    }
  }

  // pmjay_card wrong-holder detection (threshold 0.6 from canonical).
  for (const s of samples) {
    if (s.category !== 'pmjay_card') continue;
    const d = normalisedNameDistance(s.value, canonical.name);
    if (d > 0.6) {
      wrongPmjay.push({
        section_id: s.section_id,
        observed_holder: s.value,
        canonical_name: canonical.name,
        distance: d,
      });
    }
  }

  return { mismatches, wrong_pmjay_cards: wrongPmjay };
}
