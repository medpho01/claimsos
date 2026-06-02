/**
 * Pipeline v2 — Stage 2: Identity & episode-coherence gate.
 *
 * A DETERMINISTIC pure function over the Stage-1 page reads. It answers two
 * questions for a claim bundle:
 *   1. Do all pages belong to the SAME patient?            (cross-patient bleed)
 *   2. Do they belong to the SAME hospital stay/episode?   (foreign-episode bleed)
 *
 * The four cross-validation findings this stage encodes
 * ─────────────────────────────────────────────────────
 * E2 — Gate on STRUCTURED IDs, not names. uhid / ipd_number are stable across
 *   every page of one stay; a name is not (initials, transliteration, maiden
 *   name, OCR-era garble). EVERY false "foreign document" flag in the
 *   cross-validation came from name comparison. So a page is only quarantined
 *   for identity when it carries a structured id that CONFLICTS with the
 *   claim's dominant id — never for a name mismatch alone.
 *
 * E3 — Use other_names ROLES. A surgeon's signature, a witness on a consent
 *   form, a guardian on an ID card, a referring doctor, or an address that
 *   reads like a name are NOT the patient. Stage 1 already tags these in
 *   other_names with a role, so they are simply ignored here — they can never
 *   trigger a contamination flag.
 *
 * E1 — Foreign-EPISODE bleed (same patient, different admission). Two stays of
 *   the same uhid must not be fused into one. We detect this from the printed
 *   admission/discharge dates: a page whose admission date sits far outside the
 *   claim's dominant episode window is surfaced for review.
 *
 * E4 — LOUD abstention. A page that fails the identity check is QUARANTINED
 *   (excluded from fusion) and reported, never silently down-weighted. It is
 *   better to say "this page is a different patient, a human must look" than to
 *   let a foreign discharge summary fill a diagnosis vacuum.
 *
 * Pure + side-effect free: no DB, no LLM, no S3. Unit-tested with hand-built
 * PipelinePage fixtures.
 */

import { PipelinePage } from './types.js';

/** Per-page outcome of the gate. */
export type PageDisposition =
  | 'ok'
  | 'quarantine_foreign_id'
  | 'review_episode_outlier';

export interface PageVerdict {
  pageId: string;
  sourceDocId: string;
  disposition: PageDisposition;
  /** Human-readable reason — surfaced in the review queue. */
  reason: string;
  /** Normalised structured ids that drove the verdict, when present. */
  uhid?: string;
  ipdNumber?: string;
}

export interface IdentityGateResult {
  /** The claim's dominant (modal) structured ids — the corroboration anchor. */
  dominantUhid?: string;
  dominantIpdNumber?: string;
  /** Every distinct normalised id seen; length > 1 ⇒ a mixed bundle. */
  distinctUhids: string[];
  distinctIpdNumbers: string[];
  /** One verdict per input page, in input order. */
  verdicts: PageVerdict[];
  /** Pages that MUST be excluded from fusion (foreign patient). */
  quarantinedPageIds: string[];
  /** Pages that need human review but are not excluded (episode outliers). */
  reviewPageIds: string[];
  /**
   * true ⇔ no foreign-identity quarantine AND no id ambiguity AND a single
   * coherent episode window. Stage 7 reads this to raise the (non-blocking)
   * multiple_identities signal — it is NOT a harmonisation gate.
   */
  coherent: boolean;
  /** The dominant episode window, when admission/discharge dates were readable. */
  episodeWindow?: { admissionDay?: number; dischargeDay?: number };
}

export interface IdentityGateOptions {
  /**
   * A page whose admission date is more than this many days from the dominant
   * admission day is flagged as an episode outlier (E1). Generous by default —
   * we are catching a DIFFERENT admission (weeks/months apart), not a one-day
   * date misread.
   */
  episodeWindowDays?: number;
}

const DEFAULT_EPISODE_WINDOW_DAYS = 45;

/**
 * Normalise a structured id for comparison: trim, uppercase, strip spaces and
 * separators. Deliberately conservative — we do NOT strip leading zeros or
 * other digits, because a false SPLIT (judging one id as two) causes a false
 * quarantine, which is the exact failure mode E2 exists to prevent.
 */
function normalizeId(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.replace(/[\s\-_/.:#]/g, '').toUpperCase().trim();
  return s.length > 0 ? s : undefined;
}

/** The most frequent value (mode); ties resolved by first appearance. */
function modeOf(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  values.forEach((v, i) => {
    counts.set(v, (counts.get(v) ?? 0) + 1);
    if (!firstSeen.has(v)) firstSeen.set(v, i);
  });
  let best: string | undefined;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && firstSeen.get(v)! < firstSeen.get(best!)!)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/**
 * An OCR-read structured id that cannot be a real hospital UHID/IPD and so must
 * never become the corroboration anchor, nor drive another page's quarantine.
 * The one concrete case the cross-validation surfaced: a 10-digit Indian mobile
 * number (`6381286340`) misread into the uhid/ipd field. Such a token starts
 * 6–9 and is exactly ten digits. Real UHID/IPD keys are shorter, or carry a
 * hospital prefix (e.g. `GMH1989260`), so this predicate is deliberately narrow
 * — it rejects ONLY phone-shaped tokens, never a plausible id.
 *
 * Operates on an ALREADY-normalised id (normalizeId strips separators), so a
 * phone written as `638-128-6340` is caught too.
 */
function isPhoneLikeId(normalized: string | undefined): boolean {
  return typeof normalized === 'string' && /^[6-9]\d{9}$/.test(normalized);
}

/** Levenshtein edit distance between two strings (insert/delete/substitute). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Hamming distance for EQUAL-length strings (count of differing positions). */
function hammingDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * Are two normalised ids plausibly the SAME id read differently by OCR?
 *
 * Conservative by design: a false "same" (merging two real patients' ids) is a
 * silent cross-patient bleed, the worst outcome. So we reconcile ONLY
 * SUBSTITUTION noise (handwriting smearing a glyph), never a change in length:
 *   - EQUAL length, differing in at most a small number of positions —
 *     ≤1 for short ids (≤5 chars), ≤2 for longer ones. (Anuj's `0019H` vs
 *     `00124` are both length 5 and within tolerance.)
 *
 * A length change (an appended / inserted / removed digit) is treated as a
 * GENUINELY different number. We intentionally do NOT add a "Levenshtein ≤1"
 * fallback, because the canonical counter-example `23730` vs `237300` has
 * Levenshtein 1 (one trailing insertion) yet must stay distinct (existing-test
 * guard). For equal-length inputs, Hamming ≤1 already equals Levenshtein ≤1, so
 * nothing is lost by omitting it. `levenshtein` is kept for the softer NAME
 * similarity test below, where length drift is expected.
 */
function idsReconcilable(a: string, b: string): boolean {
  if (a === b) return true;
  // Equal-length: tolerate a couple of substituted glyphs.
  if (a.length === b.length) {
    const diffs = hammingDistance(a, b);
    const tolerance = a.length <= 5 ? 1 : 2;
    return diffs <= tolerance;
  }
  // Different length: NOT reconcilable (e.g. 23730 vs 237300 stay distinct).
  return false;
}

/**
 * Collapse a list of normalised ids into reconciliation CLUSTERS: two ids share
 * a cluster when `idsReconcilable` (transitively). Returns the cluster count —
 * the basis for coherence (one patient's OCR-variant ids → one cluster; two
 * genuine patients → two). Operates on distinct values; order-independent.
 */
function clusterCount(ids: string[]): number {
  const distinct = [...new Set(ids)];
  const clusterOf = new Array<number>(distinct.length).fill(-1);
  let clusters = 0;
  for (let i = 0; i < distinct.length; i++) {
    if (clusterOf[i] !== -1) continue;
    clusterOf[i] = clusters;
    // Flood-fill everything reconcilable with this one (transitive closure).
    const stack = [i];
    while (stack.length) {
      const cur = stack.pop()!;
      for (let j = 0; j < distinct.length; j++) {
        if (clusterOf[j] === -1 && idsReconcilable(distinct[cur], distinct[j])) {
          clusterOf[j] = clusters;
          stack.push(j);
        }
      }
    }
    clusters++;
  }
  return clusters;
}

/**
 * Normalise a NAME for token/similarity comparison: lowercase, strip
 * punctuation and honorifics-adjacent noise to spaces, collapse whitespace.
 * Distinct from normalizeId (which is for structured keys, not prose).
 */
function normalizeName(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Significant (length ≥3) name tokens, e.g. drop "mr", "dr", initials. */
function nameTokens(raw: string | undefined): string[] {
  return normalizeName(raw)
    .split(' ')
    .filter((t) => t.length >= 3);
}

/**
 * Do two names plausibly refer to the same person despite OCR/transliteration
 * drift? True when they share ANY significant token (length ≥3), OR the whole
 * normalised strings are close (Levenshtein ratio ≥ NAME_SIM_RATIO). This is
 * the CORROBORATION test (E2): names vary wildly across a stay, so we accept a
 * weak match — its only job is to vouch for a page whose id was OCR-garbled, it
 * is never itself a quarantine trigger.
 *   - "Abhy Pal" / "AHUJ PAL" / "MR. PAN35 PAL" all share token "pal" → same.
 *   - "Khatoon" / "Ramesh Patel" share no token and are far apart → different.
 */
const NAME_SIM_RATIO = 0.6;
function namesSimilar(a: string | undefined, b: string | undefined): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const setB = new Set(tb);
  if (ta.some((t) => setB.has(t))) return true;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na.length === 0 || nb.length === 0) return false;
  const dist = levenshtein(na, nb);
  const ratio = 1 - dist / Math.max(na.length, nb.length);
  return ratio >= NAME_SIM_RATIO;
}

/**
 * Choose the most REPRESENTATIVE patient name for corroboration (the anchor the
 * conflicting-id pages are matched against).
 *
 * `modeOf` would pick the most frequent WHOLE string, ties broken by first
 * appearance. But a real bundle of one patient is often read with EVERY page's
 * name garbled differently (Anuj: "Abhi...Da" / "Abhy Pal" / "AHUJ PAL" /
 * "MR. PAN35 PAL") — no string repeats, so mode silently anoints page 1's
 * rendering. When that winner is the garbled outlier (here it dropped the real
 * surname "Pal"), corroboration is poisoned: the correctly-read pages share the
 * surname token with EACH OTHER but not with the garbled anchor, so they read
 * as a name CONFLICT and get falsely quarantined.
 *
 * Instead we pick the token-overlap MEDOID: the name whose significant tokens
 * are best corroborated by the OTHER pages' names. The true surname recurs
 * across renderings, so the medoid lands on a name that actually contains it —
 * robust to one garbled page winning a frequency tie. For the trivial cases a
 * clean majority exists, the medoid and the mode agree. Ties → first
 * appearance, matching modeOf.
 */
function representativeName(names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length === 1) return names[0];
  // How many distinct names carry each significant token (document frequency).
  const perName = names.map((n) => [...new Set(nameTokens(n))]);
  const tokenDocFreq = new Map<string, number>();
  for (const toks of perName) {
    for (const t of toks) tokenDocFreq.set(t, (tokenDocFreq.get(t) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestScore = -1;
  names.forEach((n, i) => {
    // Score = how many OTHER names corroborate this name's tokens (a token on
    // k+1 names contributes k). A garbled outlier whose tokens recur nowhere
    // scores 0 and never wins over a name carrying the recurring surname.
    let score = 0;
    for (const t of perName[i]) score += (tokenDocFreq.get(t) ?? 0) - 1;
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  });
  return best;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Best-effort parse of a printed Indian-clinical date string into a UTC day
 * number (days since epoch). Handles DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY,
 * YYYY-MM-DD, and "DD Mon YYYY". Returns null when nothing parses — callers
 * treat null as "no usable date", never as a coherence failure. Indian
 * convention (day-first) is assumed for ambiguous numeric forms.
 */
export function parseClinicalDay(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const MS_PER_DAY = 86_400_000;
  const toDay = (y: number, m: number, d: number): number | null => {
    if (m < 0 || m > 11 || d < 1 || d > 31) return null;
    const full = y < 100 ? 2000 + y : y;
    const t = Date.UTC(full, m, d);
    return Number.isNaN(t) ? null : Math.floor(t / MS_PER_DAY);
  };

  // ISO: YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (m) return toDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // DD Mon YYYY / DD-Mon-YYYY / DD/Mon/YYYY (slash-separated alpha months are
  // common on printed Indian slips, e.g. "24/Mar/2026").
  m = s.match(/\b(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s,]*(\d{2,4})\b/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, m[2].length === 4 ? 4 : 3)] ??
      MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mon !== undefined) return toDay(Number(m[3]), mon, Number(m[1]));
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY (day-first)
  m = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (m) return toDay(Number(m[3]), Number(m[2]) - 1, Number(m[1]));

  return null;
}

/** Pull the first parseable day for a given date-role from a page's read. */
function dayForRole(page: PipelinePage, role: string): number | null {
  for (const d of page.read.dates ?? []) {
    if (d.role === role) {
      const day = parseClinicalDay(d.value);
      if (day !== null) return day;
    }
  }
  return null;
}

/**
 * Run the identity & episode-coherence gate over a claim's pages.
 *
 * @param pages — every Stage-1-read page in the claim bundle.
 * @returns the per-page verdicts plus claim-level coherence + the anchor ids.
 */
export function runIdentityGate(
  pages: PipelinePage[],
  options: IdentityGateOptions = {},
): IdentityGateResult {
  const episodeWindowDays = options.episodeWindowDays ?? DEFAULT_EPISODE_WINDOW_DAYS;

  // ── 1. Establish the structured-id anchor (E2). ──
  // We collect ALL normalised ids for the RAW distinct sets (downstream
  // messaging + an existing test depend on their rawness), but the ANCHOR is
  // chosen only from WELL-FORMED (non-phone-like) ids so a misread phone number
  // can never become the corroboration key (Sunil: 6381286340).
  const uhids: string[] = [];
  const ipds: string[] = [];
  const anchorUhids: string[] = [];
  const anchorIpds: string[] = [];
  for (const p of pages) {
    const u = normalizeId(p.read.identity.uhid);
    const i = normalizeId(p.read.identity.ipd_number);
    if (u) {
      uhids.push(u);
      if (!isPhoneLikeId(u)) anchorUhids.push(u);
    }
    if (i) {
      ipds.push(i);
      if (!isPhoneLikeId(i)) anchorIpds.push(i);
    }
  }
  const dominantUhid = modeOf(anchorUhids);
  const dominantIpdNumber = modeOf(anchorIpds);
  // RAW distinct sets — never filtered/clustered (E2 rawness contract).
  const distinctUhids = [...new Set(uhids)];
  const distinctIpdNumbers = [...new Set(ipds)];

  // Dominant patient name + hospital for OCR-corroboration of conflicting ids.
  // The name uses the token-overlap MEDOID (representativeName), not a raw
  // string mode: on a bundle where every page's name is garbled differently a
  // mode tie silently picks page 1's rendering, which — if that page is the
  // garbled outlier — poisons corroboration for the correctly-read pages. The
  // hospital still uses mode (letterheads repeat verbatim). Comparison itself
  // stays tolerant (namesSimilar / case-fold).
  const patientNames = pages
    .map((p) => p.read.identity.patient_name)
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  const hospitalNames = pages
    .map((p) => p.read.identity.hospital_name)
    .filter((h): h is string => typeof h === 'string' && h.trim().length > 0);
  const dominantPatientName = representativeName(patientNames);
  const dominantHospitalName = modeOf(hospitalNames);
  const dominantHospitalKey = normalizeName(dominantHospitalName);

  // ── 2. Establish the dominant episode window (E1). ──
  const admissionDays = pages.map((p) => dayForRole(p, 'admission')).filter((d): d is number => d !== null);
  const dischargeDays = pages.map((p) => dayForRole(p, 'discharge')).filter((d): d is number => d !== null);
  const dominantAdmissionDay = admissionDays.length
    ? modeNumber(admissionDays, episodeWindowDays)
    : undefined;
  const dominantDischargeDay = dischargeDays.length
    ? modeNumber(dischargeDays, episodeWindowDays)
    : undefined;

  // ── 3. Per-page verdicts. ──
  const verdicts: PageVerdict[] = [];
  const quarantinedPageIds: string[] = [];
  const reviewPageIds: string[] = [];

  // Well-formed ids that count as DISTINCT-PATIENT signal for coherence (§4).
  // A page whose id is corroborated by name/hospital is the anchor patient read
  // with OCR drift, so its id is NOT added — only ids that genuinely stand on
  // their own (uncorroborated) contribute, and they then cluster against the
  // anchor via the same reconciler. Seed with the anchor so a lone anchor (or a
  // bundle where every page is corroborated) is one cluster, not zero-vs-one
  // ambiguity. See §4.
  const coherenceUhids: string[] = dominantUhid ? [dominantUhid] : [];
  const coherenceIpds: string[] = dominantIpdNumber ? [dominantIpdNumber] : [];

  for (const p of pages) {
    const uhid = normalizeId(p.read.identity.uhid);
    const ipdNumber = normalizeId(p.read.identity.ipd_number);

    // 3a. Foreign-identity quarantine — uhid is the primary anchor; fall back
    // to ipd_number only when the page carries no uhid. A name mismatch alone
    // is NEVER a trigger (E2); other_names are ignored entirely (E3).
    //
    // The decision is now OCR-aware (the fix). A page is quarantined ONLY when
    // ALL three hold:
    //   (a) it carries a WELL-FORMED (non-phone) structured id that does not
    //       equal the relevant anchor;
    //   (b) that id is NOT OCR-reconcilable with the anchor (idsReconcilable);
    //   (c) the page does NOT corroborate the claim — neither its patient_name
    //       is similar to the bundle's dominant name nor its hospital_name
    //       matches the bundle's dominant hospital.
    // A conflicting-but-corroborated page stays 'ok': its id is reconciled to
    // the anchor as an OCR variant of the SAME patient (Anuj). A phone-like id
    // never participates — it can be neither anchor nor quarantine trigger.

    // Which structured id (if any) is the candidate conflict signal?
    let candidateId: string | undefined;
    let candidateKind: 'uhid' | 'ipd_number' | undefined;
    let anchorForCandidate: string | undefined;
    if (uhid && !isPhoneLikeId(uhid)) {
      candidateId = uhid;
      candidateKind = 'uhid';
      anchorForCandidate = dominantUhid;
    } else if (!uhid && ipdNumber && !isPhoneLikeId(ipdNumber)) {
      candidateId = ipdNumber;
      candidateKind = 'ipd_number';
      anchorForCandidate = dominantIpdNumber;
    }

    // Corroboration (E2): does the page vouch for being the SAME patient as the
    // claim despite a differing id? A SIMILAR patient_name is the strong signal
    // (Anuj's pages all share the token "pal"). A hospital_name match is a WEAK
    // signal — every page of a bundle naturally shares the hospital letterhead,
    // even a foreign patient's — so it only corroborates when the name does NOT
    // actively contradict. A page bearing a clearly DIFFERENT well-formed name
    // is therefore never rescued by the shared letterhead (the foreign-page
    // guard), while a page with no usable name can still be vouched for by the
    // hospital.
    const nameSim = namesSimilar(p.read.identity.patient_name, dominantPatientName);
    const pageHasName = nameTokens(p.read.identity.patient_name).length > 0;
    const dominantHasName = nameTokens(dominantPatientName).length > 0;
    const nameConflict = pageHasName && dominantHasName && !nameSim;
    const hospitalMatch =
      dominantHospitalKey.length > 0 &&
      normalizeName(p.read.identity.hospital_name) === dominantHospitalKey;
    const corroborated = nameSim || (hospitalMatch && !nameConflict);

    let foreign = false;
    let reason = 'structured id matches the claim anchor';
    if (candidateId && anchorForCandidate && candidateId !== anchorForCandidate) {
      const reconcilable = idsReconcilable(candidateId, anchorForCandidate);
      if (reconcilable) {
        reason = `${candidateKind} ${candidateId} reconciled to claim anchor ${anchorForCandidate} as an OCR variant`;
      } else if (corroborated) {
        reason = `${candidateKind} ${candidateId} differs from anchor ${anchorForCandidate} but the page corroborates the claim (name/hospital) → treated as an OCR variant`;
      } else {
        foreign = true;
        reason = `${candidateKind} ${candidateId} conflicts with claim anchor ${anchorForCandidate}`;
      }
    } else if (!uhid && !ipdNumber) {
      reason = 'no structured id on page (uncorroborated, not quarantined)';
    } else if ((uhid && isPhoneLikeId(uhid)) || (!uhid && ipdNumber && isPhoneLikeId(ipdNumber))) {
      reason = 'structured id is phone-like (ignored for identity, not quarantined)';
    }

    // Coherence contribution (§4): a well-formed id only counts as an
    // independent patient signal when the page does NOT corroborate the claim.
    // A corroborated page is the anchor patient with OCR-drifted id (Anuj), so
    // it never adds a competing cluster. Quarantined pages are excluded (they
    // already force incoherence below). Phone-like ids never count.
    if (!foreign && !corroborated) {
      if (uhid && !isPhoneLikeId(uhid)) coherenceUhids.push(uhid);
      else if (!uhid && ipdNumber && !isPhoneLikeId(ipdNumber)) coherenceIpds.push(ipdNumber);
    }

    if (foreign) {
      quarantinedPageIds.push(p.page.id);
      verdicts.push({
        pageId: p.page.id,
        sourceDocId: p.page.sourceDocId,
        disposition: 'quarantine_foreign_id',
        reason,
        uhid,
        ipdNumber,
      });
      continue;
    }

    // 3b. Episode-outlier review (E1) — only when the page carries an
    // admission date AND it sits well outside the dominant window. Soft: the
    // page is flagged for review, not excluded.
    const adm = dayForRole(p, 'admission');
    if (
      adm !== null &&
      dominantAdmissionDay !== undefined &&
      Math.abs(adm - dominantAdmissionDay) > episodeWindowDays
    ) {
      reviewPageIds.push(p.page.id);
      verdicts.push({
        pageId: p.page.id,
        sourceDocId: p.page.sourceDocId,
        disposition: 'review_episode_outlier',
        reason: `admission date is ${Math.abs(adm - dominantAdmissionDay)} days from the claim's dominant episode`,
        uhid,
        ipdNumber,
      });
      continue;
    }

    verdicts.push({
      pageId: p.page.id,
      sourceDocId: p.page.sourceDocId,
      disposition: 'ok',
      reason,
      uhid,
      ipdNumber,
    });
  }

  // ── 4. Claim-level coherence. ──
  // Incoherent if any page was quarantined for a foreign id, OR the bundle's
  // structured ids do not collapse to a SINGLE patient. We measure the latter
  // from reconciliation CLUSTERS — NOT the raw distinct count — over the
  // anchor plus every UNCORROBORATED well-formed id (corroborated pages are the
  // anchor patient with OCR-drifted ids and so were folded into the anchor in
  // §3). So Anuj's four OCR renderings (all name/hospital-corroborated) →
  // one cluster → coherent; two genuinely different patients → two clusters →
  // incoherent. Phone-like tokens never participate, so a misread phone can't
  // manufacture a second cluster.
  // (The episode-window outlier path stays a soft REVIEW, never a coherence
  // failure — behaviour preserved from the prior implementation.)
  const coherent =
    quarantinedPageIds.length === 0 &&
    clusterCount(coherenceUhids) <= 1 &&
    clusterCount(coherenceIpds) <= 1;

  return {
    dominantUhid,
    dominantIpdNumber,
    distinctUhids,
    distinctIpdNumbers,
    verdicts,
    quarantinedPageIds,
    reviewPageIds,
    coherent,
    episodeWindow:
      dominantAdmissionDay !== undefined || dominantDischargeDay !== undefined
        ? { admissionDay: dominantAdmissionDay, dischargeDay: dominantDischargeDay }
        : undefined,
  };
}

/**
 * Mode of a set of day-numbers, clustering values within `tolerance` days of
 * each other. Returns the representative (earliest) day of the largest
 * cluster — robust to a one-off date misread without merging two genuine
 * admissions weeks apart.
 */
function modeNumber(days: number[], tolerance: number): number {
  const sorted = [...days].sort((a, b) => a - b);
  let bestStart = sorted[0];
  let bestCount = 0;
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
