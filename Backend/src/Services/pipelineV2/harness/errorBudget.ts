/**
 * Pipeline v2 — harness: the stage-attributed error budget.
 *
 * The scorer (scorer.ts) tells you WHICH cells missed. It does NOT tell you
 * WHICH STAGE caused each miss — and an end-to-end accuracy number on a small
 * corpus is exactly the thing that lures you into local-maxima point-fixes (you
 * "improve the pipeline" for what turns out to be a harness bug, or you sink a
 * week into the one flashy failure that's 1/8 of the real surface).
 *
 * This module is the antidote: a PURE function that, given a scored claim plus
 * the artifacts that produced it (the ClaimRunResult and the Stage-1 page
 * reads), attributes every miss to the stage that most likely caused it, using
 * only OBSERVABLE signals:
 *
 *   • READ_CEILING  — Stage 1 never read the expected value on ANY page (the
 *                     value's tokens are absent from every read). No downstream
 *                     assembly can recover a value that was never seen.
 *   • ROUTING       — the value WAS read somewhere, but the canonical slot came
 *                     out empty (Stage 4 routing / Stage 5 had no candidate).
 *   • SELECTION     — the slot holds the WRONG value in a single-identity claim:
 *                     the expected concept was seen, but fusion/promotion picked
 *                     a different candidate (the Kalksum diagnosis-promotion class).
 *   • CONTAMINATION — the slot holds a wrong value in a MIXED, under-quarantined
 *                     bundle: a different patient's pages leaked into fusion
 *                     (the Divyansh class).
 *   • READ_QUALITY  — the slot holds a wrong value but the expected concept was
 *                     never cleanly read (partial/garbled read), so it's a read
 *                     problem, not a selection problem.
 *
 * And one CLAIM-level accuracy flag (the pipeline interprets, it does not
 * adjudicate — so "over-blocking" is no longer a thing; only UNDER-quarantine,
 * which corrupts the JSON, remains a defect):
 *
 *   • QUARANTINE_UNDER — more distinct foreign identities than pages quarantined:
 *                     the gate let foreign pages through (root cause of
 *                     CONTAMINATION misses — the JSON mixes two patients).
 *
 * IMPORTANT — this is a HEURISTIC first-pass labeller, not an oracle. The token
 * signal is fooled by abbreviation-heavy clinical text (a read that says "AWMI"
 * does not contain the words "anterior"/"wall", so a real SELECTION miss can
 * look like READ_QUALITY). Every row therefore carries the raw `signals` it was
 * inferred from, so a human can confirm or reclassify — which is itself the
 * argument for growing a human-adjudicated corpus rather than trusting any
 * single auto-label. No I/O, no LLM: same inputs ⇒ same budget.
 */

import { PipelinePage } from '../types.js';
import { ClaimRunResult } from './runner.js';
import { ClaimScore, FieldScore, normalizeForMatch } from './scorer.js';
import { ScoredEpisodeField } from './groundTruth.js';

export type MissCause =
  | 'READ_CEILING'
  | 'ROUTING'
  | 'SELECTION'
  | 'CONTAMINATION'
  | 'READ_QUALITY';

export const MISS_CAUSES: readonly MissCause[] = [
  'READ_CEILING',
  'ROUTING',
  'SELECTION',
  'CONTAMINATION',
  'READ_QUALITY',
] as const;

/** Which pipeline stage each cause points at — for the report's roll-up. */
export const CAUSE_STAGE: Record<MissCause, string> = {
  READ_CEILING: 'Stage 1 (vision read)',
  ROUTING: 'Stage 4/5 (routing/fusion)',
  SELECTION: 'Stage 5 (fusion selection)',
  CONTAMINATION: 'Stage 2 (identity gate — under-quarantine)',
  READ_QUALITY: 'Stage 1 (vision read quality)',
};

export type ClaimFlag = 'QUARANTINE_UNDER';

export const CLAIM_FLAGS: readonly ClaimFlag[] = ['QUARANTINE_UNDER'] as const;

/** The observable signals a miss cause was inferred from (for human review). */
export interface MissSignals {
  /** Any ≥4-char token of the expected value appears in some page read. */
  expectedTokenSeen: boolean;
  /** ALL ≥4-char tokens of the expected value appear across the reads. */
  expectedFullySeen: boolean;
  /** The pipeline produced a (non-empty) value for this slot. */
  actualPresent: boolean;
  /** ≥2 GENUINE foreign identities (after OCR-noise cleanup) ⇒ mixed bundle. */
  mixedBundle: boolean;
  /** Fewer pages quarantined than there are genuine foreign identities. */
  underQuarantined: boolean;
}

export interface MissAttribution {
  claimId: string;
  patient?: string;
  field: ScoredEpisodeField;
  expected: string;
  actual?: string;
  cause: MissCause;
  signals: MissSignals;
}

export interface ClaimAttribution {
  claimId: string;
  patient?: string;
  /** Raw distinct id strings the gate listed (polluted by OCR noise). */
  distinctUhids: number;
  /** Genuine foreign identities after OCR-noise cleanup — the honest count. */
  foreignIdentities: number;
  quarantinedPages: number;
  /** Total rendered pages — to confirm a quarantine is a removable MINORITY. */
  totalPages: number;
  flags: ClaimFlag[];
  misses: MissAttribution[];
}

export interface ErrorBudget {
  claims: ClaimAttribution[];
  totalMisses: number;
  byCause: Record<MissCause, number>;
  /** claimIds carrying each claim-level flag. */
  flagged: Record<ClaimFlag, string[]>;
}

const MIN_TOKEN_LEN = 4;

/** The ≥4-char tokens of an expected value (1–3 char fragments can false-match). */
function expectedTokens(expected: string): string[] {
  return normalizeForMatch(expected)
    .split(' ')
    .filter((t) => t.length >= MIN_TOKEN_LEN);
}

/**
 * One normalised text blob of EVERYTHING read across the claim's pages. We
 * stringify the whole read object (transcription + every fact) so the "was this
 * value ever seen" test is robust to the read shape; the small risk that a
 * clinical token coincides with a structural JSON key is acceptable for a
 * heuristic and is why each row keeps its raw signals.
 */
function readHaystack(pages: PipelinePage[]): string {
  return normalizeForMatch(pages.map((p) => JSON.stringify(p.read ?? {})).join(' '));
}

function isPresent(actual: string | undefined): boolean {
  return actual !== undefined && actual !== null && String(actual).trim() !== '';
}

/** Uppercase, strip everything but [A-Z0-9] — the comparison form for ids. */
function normId(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Levenshtein distance, capped-small inputs (structured ids are short). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/** Two ids are the same identity OCR'd differently (1-char slip, or 2 on long ids). */
function isOcrVariant(a: string, b: string): boolean {
  const d = editDistance(a, b);
  return d <= 1 || (d <= 2 && Math.min(a.length, b.length) >= 7);
}

/**
 * Count GENUINE foreign patient identities in the gate's raw `distinctUhids`.
 *
 * The gate reconciles OCR variance internally but only exposes the raw list, so
 * we approximate its cleanup: drop placeholders (no digit, e.g.
 * "NOTFULLYVISIBLE"), drop phone/aadhaar/barcode-like runs (≥10 digits), collapse
 * OCR variants of the dominant id and of each other, and count what's left. This
 * is the discriminator between a single removable anomaly and a truly mixed
 * bundle — see the Lever-A ADR's argument that the gate should expose this
 * reconciled count directly rather than leaving the harness to re-derive it.
 */
function countForeignIdentities(distinct: string[], dominant?: string): number {
  const dom = dominant ? normId(dominant) : undefined;
  const groups: string[] = [];
  for (const raw of distinct) {
    if (!/[0-9]/.test(raw)) continue; // placeholder like NOTFULLYVISIBLE / [UNCLEARONIMAGE]
    if (raw.replace(/\D/g, '').length >= 10) continue; // phone / aadhaar / barcode, not a UHID
    const n = normId(raw);
    if (!n) continue;
    if (dom && (n === dom || isOcrVariant(n, dom))) continue; // OCR variant of the dominant id
    if (groups.some((g) => isOcrVariant(g, n))) continue; // OCR variant of an id already counted
    groups.push(n);
  }
  return groups.length;
}

/** Attribute a single missed field to its most-likely cause. */
function attributeMiss(
  claimId: string,
  patient: string | undefined,
  fs: FieldScore,
  haystack: string,
  ctx: { mixedBundle: boolean; underQuarantined: boolean },
): MissAttribution {
  const toks = expectedTokens(fs.expected);
  const expectedTokenSeen = toks.some((t) => haystack.includes(t));
  const expectedFullySeen = toks.length > 0 && toks.every((t) => haystack.includes(t));
  const actualPresent = isPresent(fs.actual);

  let cause: MissCause;
  if (!actualPresent) {
    // Empty slot: did we ever read it? If not, it's the read ceiling; if yes,
    // it was read but never reached the slot.
    cause = expectedTokenSeen ? 'ROUTING' : 'READ_CEILING';
  } else if (ctx.underQuarantined) {
    // A wrong value while foreign pages went un-quarantined ⇒ leakage.
    cause = 'CONTAMINATION';
  } else if (expectedTokenSeen) {
    // The expected concept was on a page, yet a different candidate won the slot.
    cause = 'SELECTION';
  } else {
    // A wrong value, but the expected concept was never cleanly read.
    cause = 'READ_QUALITY';
  }

  return {
    claimId,
    patient,
    field: fs.field,
    expected: fs.expected,
    actual: fs.actual,
    cause,
    signals: {
      expectedTokenSeen,
      expectedFullySeen,
      actualPresent,
      mixedBundle: ctx.mixedBundle,
      underQuarantined: ctx.underQuarantined,
    },
  };
}

/**
 * Attribute one scored claim: tag every miss with a probable cause stage, and
 * flag the claim-level quarantine pathology (over-block vs under-quarantine).
 */
export function attributeClaim(input: {
  score: ClaimScore;
  result: ClaimRunResult;
  pages: PipelinePage[];
}): ClaimAttribution {
  const { score, result, pages } = input;
  const haystack = readHaystack(pages);

  const rawDistinct = result.identity.distinctUhids;
  const quarantinedPages = result.identity.quarantinedPageIds.length;
  // distinctUhids is the RAW, pre-reconciliation id list — polluted by OCR
  // variants of one id ("UHID02561"/"UHD02561") and unreadable placeholders
  // ("NOTFULLYVISIBLE"). Count GENUINE foreign identities instead.
  const foreignIdentities = countForeignIdentities(rawDistinct, result.identity.dominantUhid);
  const mixedBundle = foreignIdentities >= 2;
  const underQuarantined = quarantinedPages < foreignIdentities;

  const misses = score.fields
    .filter((f) => !f.hit)
    .map((f) => attributeMiss(score.claimId, score.patient, f, haystack, { mixedBundle, underQuarantined }));

  const flags: ClaimFlag[] = [];
  if (underQuarantined) {
    // Foreign pages leaked into fusion — the JSON mixes two patients. The only
    // remaining claim-level defect now that the gate never over-blocks.
    flags.push('QUARANTINE_UNDER');
  }

  return {
    claimId: score.claimId,
    patient: score.patient,
    distinctUhids: rawDistinct.length,
    foreignIdentities,
    quarantinedPages,
    totalPages: pages.length,
    flags,
    misses,
  };
}

/** Roll per-claim attributions up into the corpus error budget. */
export function buildErrorBudget(claims: ClaimAttribution[]): ErrorBudget {
  const byCause = Object.fromEntries(MISS_CAUSES.map((c) => [c, 0])) as Record<MissCause, number>;
  const flagged = Object.fromEntries(CLAIM_FLAGS.map((f) => [f, [] as string[]])) as Record<
    ClaimFlag,
    string[]
  >;

  let totalMisses = 0;
  for (const c of claims) {
    for (const m of c.misses) {
      byCause[m.cause] += 1;
      totalMisses += 1;
    }
    for (const f of c.flags) flagged[f].push(c.patient ?? c.claimId);
  }

  return { claims, totalMisses, byCause, flagged };
}
