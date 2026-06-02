// =============================================================================
// M3 — stage-scoped adjudication rules engine: shared contracts (PURE).
//
// This library is the deterministic core: rules are data, each carries a `kind`
// dispatched to a pure evaluator over an in-memory RuleContext. No DB / LLM / IO
// lives here (the live fold into rulesEngineV2 is the M5 integration).
// See docs/proposals/FROZEN_CONTRACTS.md (OD4: evaluator-kind registry).
// =============================================================================

export type RuleStatus = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type Impact = 'CLAIM_REJECTION' | 'DEDUCTION' | 'QUERY' | 'WARNING' | 'INFO';

/** Deterministic evaluator kinds implemented in this library (OD4). Semantic
 *  kinds (LLM_COHERENCE / EVIDENCE_CHECK) are added later and live elsewhere. */
export type RuleKind =
  | 'DOCUMENT_PRESENCE'
  | 'REQUIRED_FIELDS'
  | 'FUZZY_NAME'
  | 'TEMPORAL_WINDOW';

/** A single rule. `params` is kind-specific and read defensively by the
 *  evaluator (rules originate as JSONB, so params is intentionally untyped). */
export interface Rule {
  ruleId: string;
  kind: RuleKind;
  params: Record<string, unknown>;
  severity: Severity;
  impact: Impact;
  mandatory?: boolean;
  /** OD4: if the evaluator's confidence is below this, the result is forced to
   *  SKIP (abstain) rather than PASS/FAIL. */
  minConfidence?: number;
  failureMessage?: string;
}

/** A value (e.g. a patient name) seen on a specific document type. */
export interface NamedValue { value: string; sourceDocType: string }
/** A document with an associated date (ISO string), for temporal rules. */
export interface DatedDoc { docType: string; date: string | null }

/** The facts a rule evaluates against — assembled (later) from the fact ledger. */
export interface RuleContext {
  stage: string | null;
  /** doc_category codes present for this claim/stage. */
  presentCategories: string[];
  /** extracted fields keyed by doc_category. */
  fieldsByCategory: Record<string, Record<string, unknown>>;
  /** the same logical value (e.g. patient name) as seen on each source doc. */
  names: NamedValue[];
  /** dated documents, for TEMPORAL_WINDOW rules. */
  datedDocs: DatedDoc[];
  /** episode anchor dates (ISO). */
  anchors: { admission: string | null; discharge: string | null };
}

/** A rule outcome, always carrying cited evidence for auditability. */
export interface EvalResult {
  ruleId: string;
  kind: RuleKind;
  status: RuleStatus;
  severity: Severity;
  impact: Impact;
  /** 0..1. Deterministic presence/field checks are 1; fuzzy/temporal vary. */
  confidence: number;
  message: string;
  evidence?: Record<string, unknown>;
}
