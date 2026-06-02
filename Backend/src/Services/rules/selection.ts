// =============================================================================
// M3 — pure rule-set selection. Given candidate rule sets (mirroring the
// migration-068 columns) and a resolved claim context, pick the single
// most-specific LIVE rule set. No IO.
//
// Convention: an EMPTY dimension array = wildcard (the rule set applies to any
// value of that dimension). A non-empty array must INCLUDE the context value to
// match. Specificity = sum of weights for each dimension matched non-trivially,
// so insurer+stage+scheme-specific packs beat generic ones.
// =============================================================================

export interface RuleSetMeta {
  id: string;
  ruleSetId: string;
  status: 'draft' | 'live' | 'deprecated';
  insurerCode: string | null;
  schemes: string[];
  routes: string[];
  stages: string[];
  caseTypes: string[];
  treatments: string[];
  specialties: string[];
}

export interface SelectionContext {
  scheme: string | null;
  route: string | null;
  insurer: string | null;
  stage: string | null;
  caseType: string | null;
  treatment?: string | null;
  specialty?: string | null;
}

/** non-empty dim must include the value; empty dim = wildcard. */
function dimOk(dim: string[], v: string | null | undefined): boolean {
  return dim.length === 0 || (v != null && dim.includes(v));
}

/** weight contributed only when the dim is a non-trivial (non-wildcard) match. */
function spec(dim: string[], v: string | null | undefined, weight: number): number {
  return dim.length > 0 && v != null && dim.includes(v) ? weight : 0;
}

export function scoreRuleSet(rs: RuleSetMeta, ctx: SelectionContext): number {
  return (
    spec(rs.stages, ctx.stage, 4) +
    (rs.insurerCode != null && rs.insurerCode === ctx.insurer ? 4 : 0) +
    spec(rs.schemes, ctx.scheme, 3) +
    spec(rs.caseTypes, ctx.caseType, 2) +
    spec(rs.routes, ctx.route, 1) +
    spec(rs.treatments, ctx.treatment, 1) +
    spec(rs.specialties, ctx.specialty, 1)
  );
}

/** The single most-specific LIVE rule set whose every dimension is compatible
 *  with the context, or null if none match. Ties break toward the higher
 *  ruleSetId (stable, deterministic). */
export function selectRuleSet(candidates: RuleSetMeta[], ctx: SelectionContext): RuleSetMeta | null {
  const matches = candidates.filter(
    (c) =>
      c.status === 'live' &&
      (c.insurerCode == null || c.insurerCode === ctx.insurer) &&
      dimOk(c.schemes, ctx.scheme) &&
      dimOk(c.routes, ctx.route) &&
      dimOk(c.stages, ctx.stage) &&
      dimOk(c.caseTypes, ctx.caseType),
  );
  if (matches.length === 0) return null;
  let best = matches[0];
  let bestScore = scoreRuleSet(best, ctx);
  for (let i = 1; i < matches.length; i++) {
    const s = scoreRuleSet(matches[i], ctx);
    if (s > bestScore || (s === bestScore && matches[i].ruleSetId > best.ruleSetId)) {
      best = matches[i];
      bestScore = s;
    }
  }
  return best;
}
