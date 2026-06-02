// =============================================================================
// Auto-Context Resolver — shared contracts (M0/W0 FROZEN).
// See docs/proposals/FROZEN_CONTRACTS.md. Changing these shapes is a
// CONTRACT_DRIFT event and requires re-plan + sign-off.
//
// The resolved context {scheme, route, insurer, stage, case_type} selects which
// adjudication rules apply, with ZERO ground-ops tagging. Source-of-truth
// precedence is record -> empanelment -> dates -> derived (OD5); LLM/derived
// signals are cross-checks only and never override a record value.
// =============================================================================

/** The 19 canonical IPD stage codes — master_options(category='ipd_stage'), mig 024. */
export const IPD_STAGE_CODES = [
  'draft',
  'preauth_submitted',
  'preauth_queried',
  'preauth_query_responded',
  'preauth_approved',
  'admitted',
  'enhancements_submitted',
  'enhancements_queried',
  'enhancements_query_responded',
  'discharge_draft',
  'discharge_submitted',
  'discharge_queried',
  'discharge_query_responded',
  'discharge_approved',
  'discharged',
  'claim_filed',
  'claim_queried',
  'claim_query_responded',
  'claim_approved',
] as const;

export type IpdStage = (typeof IPD_STAGE_CODES)[number];

/** Coarse class a stage (or a document mix) belongs to. */
export type StageClass = 'preauth' | 'enhancement' | 'discharge' | 'claim' | 'other';

export type Scheme = 'PMJAY' | 'CASHLESS_EVERYWHERE' | 'NETWORK_PRIVATE' | (string & {});
export type Route = 'cashless_everywhere' | 'network';
export type CaseType = 'SURGICAL' | 'MEDICAL_MANAGEMENT' | 'UNKNOWN';

/** Where a resolved value came from, in source-of-truth precedence order. */
export type ContextSource = 'record' | 'empanelment' | 'dates' | 'derived' | 'unresolved';

/** One resolved dimension, carrying provenance + a confidence + an optional cross-check. */
export interface ContextField<T> {
  value: T | null;
  source: ContextSource;
  /** 0..1. A `derived`/low-confidence value must never drive an auto action (OD5). */
  confidence: number;
  /** A non-authoritative signal compared against the value; disagreement raises a flag. */
  crosscheck?: { agrees: boolean; with: string; note?: string };
}

export interface ResolvedContext {
  claimId: string;
  scheme: ContextField<Scheme>;
  route: ContextField<Route>;
  insurerPanelId: ContextField<string>;
  stage: ContextField<IpdStage>;
  caseType: ContextField<CaseType>;
  /** Cross-check disagreements + known gaps (e.g. 'stage_docmix_mismatch'). */
  flags: string[];
  resolverVersion: string;
}

/**
 * Pure inputs to the resolver. The caller fetches these from the DB/episode; the
 * resolver itself does NO IO (so it is deterministic and host-testable).
 */
export interface ResolveContextInput {
  claimId: string;
  ipd: {
    stage?: string | null;
    claim_filing_route?: string | null;
    panel_id?: string | null;
    admitted_at?: string | null;
    discharged_at?: string | null;
  };
  panel?: { id: string; code?: string | null; name?: string | null } | null;
  /** EAV-derived: panel_attributes.value_boolean where attribute_key='is_empanelled'. */
  isEmpanelled?: boolean | null;
  dossier?: {
    current_stage?: string | null;
    current_panel_id?: string | null;
    current_insurer_id?: string | null;
    /** { <doc_category_code>: [section_id, ...] } */
    doc_sections_by_category?: Record<string, string[]> | null;
  } | null;
  /** Harmonised episode (LLM-derived) — CROSS-CHECK ONLY for context. */
  episode?: {
    meta?: { episode_type?: string | null } | null;
    clinical_timeline?: Array<{ procedures_performed?: unknown[] | null } | null> | null;
    insurance_context?: { policy_type?: string | null; scheme_name?: string | null } | null;
  } | null;
}
