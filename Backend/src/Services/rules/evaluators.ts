// =============================================================================
// M3 — pure evaluator kinds. Each is (rule, ctx) => EvalResult, deterministic,
// and emits cited evidence. No IO. See types.ts + FROZEN_CONTRACTS OD4.
// =============================================================================

import type { EvalResult, Rule, RuleContext, RuleStatus } from './types.js';
import { levenshtein, normalizeName, tokenSetRatio } from './text.js';

// ── small defensive coercions (params arrive as untyped JSONB) ──────────────
function asStringArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [];
}
function asNum(x: unknown, dflt: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : dflt;
}
function asStr(x: unknown, dflt = ''): string {
  return typeof x === 'string' ? x : dflt;
}
function isEmpty(v: unknown): boolean {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function mk(
  rule: Rule,
  status: RuleStatus,
  confidence: number,
  message: string,
  evidence?: Record<string, unknown>,
): EvalResult {
  return {
    ruleId: rule.ruleId,
    kind: rule.kind,
    status,
    severity: rule.severity,
    impact: rule.impact,
    confidence,
    message,
    ...(evidence ? { evidence } : {}),
  };
}

// ── DOCUMENT_PRESENCE — required doc categories present for this stage ──────
export function evaluateDocumentPresence(rule: Rule, ctx: RuleContext): EvalResult {
  const rawItems = Array.isArray(rule.params.requiredCategories)
    ? (rule.params.requiredCategories as unknown[])
    : [];
  const mode = asStr(rule.params.mode) === 'any' ? 'any' : 'all';
  // Each entry is a category code OR an OR-group (array): a group is satisfied
  // if ANY member is present — e.g. ['aadhaar_front','aadhaar_card','aadhaar_back']
  // all mean "Aadhaar". Lets one rule tolerate doc-category synonyms/variants.
  const groups = rawItems
    .map((item) =>
      Array.isArray(item)
        ? item.filter((x): x is string => typeof x === 'string')
        : typeof item === 'string'
          ? [item]
          : [],
    )
    .filter((g) => g.length > 0);
  if (groups.length === 0) return mk(rule, 'SKIP', 1, 'no requiredCategories configured');
  const required = groups.map((g) => g.join('|'));
  const present: string[] = [];
  const missing: string[] = [];
  for (const g of groups) {
    const hit = g.find((c) => ctx.presentCategories.includes(c));
    if (hit) present.push(hit);
    else missing.push(g.join('|'));
  }
  const ok = mode === 'all' ? missing.length === 0 : present.length > 0;
  return ok
    ? mk(rule, 'PASS', 1, `required documents present (${mode})`, { required, present, mode })
    : mk(rule, 'FAIL', 1, rule.failureMessage ?? `missing required documents: ${missing.join(', ')}`, {
        required,
        present,
        missing,
        mode,
      });
}

// ── REQUIRED_FIELDS — named fields present + non-empty on a category ────────
export function evaluateRequiredFields(rule: Rule, ctx: RuleContext): EvalResult {
  const category = asStr(rule.params.category);
  const fields = asStringArray(rule.params.fields);
  if (!category || fields.length === 0) return mk(rule, 'SKIP', 1, 'no category/fields configured');
  const catFields = ctx.fieldsByCategory[category];
  if (!catFields) {
    return mk(rule, 'FAIL', 1, rule.failureMessage ?? `no ${category} section to check fields on`, {
      category,
      missing: fields,
    });
  }
  const missing = fields.filter((f) => isEmpty(catFields[f]));
  return missing.length === 0
    ? mk(rule, 'PASS', 1, `all required fields present on ${category}`, { category, fields })
    : mk(rule, 'FAIL', 1, rule.failureMessage ?? `fields missing/empty on ${category}: ${missing.join(', ')}`, {
        category,
        missing,
      });
}

// ── FUZZY_NAME — same name across documents (token-set + edit distance) ─────
export function evaluateFuzzyName(rule: Rule, ctx: RuleContext): EvalResult {
  const warnAt = asNum(rule.params.warnAtDistance, 1); // 1..2 → warn (still PASS)
  const failAt = asNum(rule.params.failAtDistance, 3); // >=3 → review (FAIL)
  const blockAt = asNum(rule.params.blockAtDistance, 5); // >=5 + low overlap → likely different person
  const minTSR = asNum(rule.params.minTokenSetRatio, 0.5);
  const names = ctx.names;
  if (names.length < 2) return mk(rule, 'SKIP', 1, 'fewer than 2 names to compare');

  let worst = { dist: 0, tsr: 1, a: names[0], b: names[0] };
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const na = normalizeName(names[i].value);
      const nb = normalizeName(names[j].value);
      if (na === nb) continue;
      const tsr = tokenSetRatio(names[i].value, names[j].value);
      if (tsr >= 1) continue; // one name is a token-subset of the other (e.g. missing surname)
      const dist = levenshtein(na, nb);
      if (dist > worst.dist) worst = { dist, tsr, a: names[i], b: names[j] };
    }
  }

  if (worst.dist === 0) {
    return mk(rule, 'PASS', 1, 'all names agree (exact or token-subset)', {
      names: names.map((n) => `${n.sourceDocType}:${n.value}`),
    });
  }
  const evidence = {
    a: `${worst.a.sourceDocType}:${worst.a.value}`,
    b: `${worst.b.sourceDocType}:${worst.b.value}`,
    edit_distance: worst.dist,
    token_set_ratio: round3(worst.tsr),
  };
  if (worst.dist <= warnAt + 1) {
    // 1–2 char mismatch — surface the degree but don't block (PMJAY rule).
    return mk(rule, 'PASS', 0.7, `minor name mismatch (edit distance ${worst.dist})`, evidence);
  }
  if (worst.dist >= blockAt && worst.tsr < minTSR) {
    return mk(rule, 'FAIL', 0.3, rule.failureMessage ?? `names likely different persons (edit distance ${worst.dist})`, evidence);
  }
  if (worst.dist >= failAt) {
    return mk(rule, 'FAIL', 0.5, rule.failureMessage ?? `name mismatch needs review (edit distance ${worst.dist})`, evidence);
  }
  return mk(rule, 'PASS', 0.7, `name mismatch within tolerance (edit distance ${worst.dist})`, evidence);
}

// ── TEMPORAL_WINDOW — a dated doc falls within N days of an anchor ──────────
export function evaluateTemporalWindow(rule: Rule, ctx: RuleContext): EvalResult {
  const docType = asStr(rule.params.docType);
  const relativeTo = asStr(rule.params.relativeTo) === 'admission' ? 'admission' : 'discharge';
  const withinDays = asNum(rule.params.withinDays, 1);
  const direction =
    asStr(rule.params.direction) === 'before'
      ? 'before'
      : asStr(rule.params.direction) === 'after'
        ? 'after'
        : 'either';
  if (!docType) return mk(rule, 'SKIP', 1, 'no docType configured');

  const anchorIso = ctx.anchors[relativeTo];
  if (!anchorIso) return mk(rule, 'SKIP', 1, `no ${relativeTo} anchor date`);
  const anchorMs = Date.parse(anchorIso);
  if (Number.isNaN(anchorMs)) return mk(rule, 'SKIP', 1, `unparseable ${relativeTo} anchor date`);

  const docs = ctx.datedDocs.filter((d) => d.docType === docType && d.date);
  if (docs.length === 0) {
    return mk(rule, 'FAIL', 1, rule.failureMessage ?? `no dated ${docType} to satisfy the ${relativeTo} window`, {
      docType,
      relativeTo,
      withinDays,
      direction,
    });
  }
  const DAY = 86_400_000;
  const hit = docs.find((d) => {
    const ms = Date.parse(d.date as string);
    if (Number.isNaN(ms)) return false;
    const diffDays = (anchorMs - ms) / DAY; // positive ⇒ doc is BEFORE the anchor
    if (direction === 'before') return diffDays >= 0 && diffDays <= withinDays;
    if (direction === 'after') return diffDays <= 0 && -diffDays <= withinDays;
    return Math.abs(diffDays) <= withinDays;
  });
  return hit
    ? mk(rule, 'PASS', 0.9, `${docType} found within ${withinDays}d ${direction} ${relativeTo}`, {
        docType,
        matched_date: hit.date,
        anchor: anchorIso,
      })
    : mk(rule, 'FAIL', 0.9, rule.failureMessage ?? `no ${docType} within ${withinDays}d ${direction} ${relativeTo}`, {
        docType,
        relativeTo,
        withinDays,
        direction,
        candidate_dates: docs.map((d) => d.date),
      });
}
