// =============================================================================
// M3 — pure text utilities for fuzzy name matching (no deps).
//
// Indian claim documents need more than raw edit distance: the SAME person
// appears as "Bhuri" on one doc and "Bhuri Ahmad" on another (missing surname),
// and transliteration varies ("Mohammad"/"Mohd"/"Muhammad"). So we combine a
// length-normalized Levenshtein distance with a token-set overlap ratio — the
// ratio rescues partial-name / subset cases that edit distance alone would
// wrongly flag as a different person.
// =============================================================================

const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'smt', 'shri', 'sri', 'km', 'kum',
  'master', 'baby', 'late', 'm/s', 'b/o', 's/o', 'w/o', 'd/o', 'c/o',
]);

/** lowercase, strip punctuation → spaces, collapse whitespace. */
export function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** normalized name tokens with honorifics + relational prefixes removed. */
export function nameTokens(raw: string): string[] {
  return normalizeName(raw).split(' ').filter((t) => t.length > 0 && !HONORIFICS.has(t));
}

/** Classic iterative-DP Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Fraction of the SMALLER token set that also appears in the larger set.
 * 1.0 means one name's tokens are a subset of the other's (e.g. a missing
 * surname) — strong evidence of the same person, not a conflict.
 */
export function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}
