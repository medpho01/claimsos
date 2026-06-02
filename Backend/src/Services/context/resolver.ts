// =============================================================================
// M1 — Auto-Context Resolver (PURE; shadow-only).
//
// Resolves {scheme, route, insurer, stage, case_type} for a claim with ZERO
// ground-ops tagging. No DB / LLM / IO here — the caller supplies inputs, so
// this is deterministic and runnable on the host (no missing-dep imports).
//
// BOUNDARY (FROZEN_CONTRACTS OD5): this INTERPRETS context. Source-of-truth
// precedence is record -> empanelment -> dates -> derived. Episode/LLM signals
// are cross-checks only: they may set `crosscheck` / push a flag, but they never
// override a record value.
// =============================================================================

import {
  IPD_STAGE_CODES,
  type IpdStage,
  type StageClass,
  type ResolveContextInput,
  type ResolvedContext,
  type ContextField,
  type Scheme,
  type Route,
  type CaseType,
} from './types.js';

export const RESOLVER_VERSION = 'ctx.v1';

const STAGE_SET: ReadonlySet<string> = new Set(IPD_STAGE_CODES);

export function isIpdStage(s: string | null | undefined): s is IpdStage {
  return !!s && STAGE_SET.has(s);
}

export function stageClass(stage: string | null | undefined): StageClass {
  if (!stage) return 'other';
  if (stage.startsWith('preauth')) return 'preauth';
  if (stage.startsWith('enhancements')) return 'enhancement';
  if (stage.startsWith('discharge') || stage === 'discharged') return 'discharge';
  if (stage.startsWith('claim')) return 'claim';
  return 'other';
}

// Coarse stage class implied by which document categories are present.
// CROSS-CHECK ONLY — never the source of truth for stage.
const DISCHARGE_DOCS = ['discharge_summary', 'discharge_slip', 'final_bill', 'ot_notes'];
const ENHANCEMENT_DOCS = ['enhancement_request', 'enhancement_form'];
const PREAUTH_DOCS = ['preauth_form', 'pre_auth_form', 'doctor_prescription', 'prescription', 'opd_notes', 'clinician_notes', 'doctor_notes'];

export function docMixStageClass(categories: string[]): StageClass | null {
  const has = (list: string[]) => list.some((c) => categories.includes(c));
  if (has(DISCHARGE_DOCS)) return 'discharge';   // most-specific first
  if (has(ENHANCEMENT_DOCS)) return 'enhancement';
  if (has(PREAUTH_DOCS)) return 'preauth';
  return null;
}

function field<T>(
  value: T | null,
  source: ContextField<T>['source'],
  confidence: number,
  crosscheck?: ContextField<T>['crosscheck'],
): ContextField<T> {
  return crosscheck ? { value, source, confidence, crosscheck } : { value, source, confidence };
}

export function resolveContext(input: ResolveContextInput): ResolvedContext {
  const flags: string[] = [];
  const { ipd, panel, isEmpanelled, dossier, episode } = input;

  // --- ROUTE — record SoT: ipds.claim_filing_route; else empanelment ---
  let route: ContextField<Route>;
  const rawRoute = ipd.claim_filing_route ?? null;
  if (rawRoute === 'network' || rawRoute === 'cashless_everywhere') {
    route = field<Route>(rawRoute, 'record', 1);
  } else if (isEmpanelled === true) {
    route = field<Route>('network', 'empanelment', 0.7);
    flags.push('route_inferred_from_empanelment');
  } else if (isEmpanelled === false) {
    route = field<Route>('cashless_everywhere', 'empanelment', 0.7);
    flags.push('route_inferred_from_empanelment');
  } else {
    route = field<Route>(null, 'unresolved', 0);
    flags.push('route_unresolved');
  }

  // --- INSURER — record SoT: ipds.panel_id; else dossier.current_panel_id ---
  const insurerId = ipd.panel_id ?? dossier?.current_panel_id ?? null;
  const insurerPanelId = insurerId
    ? field<string>(insurerId, ipd.panel_id ? 'record' : 'derived', ipd.panel_id ? 1 : 0.6)
    : field<string>(null, 'unresolved', 0);
  if (!insurerId) flags.push('insurer_unresolved');

  // --- SCHEME — derived from panel code / scheme_name + route ---
  const panelCode = (panel?.code ?? panel?.name ?? '').toString();
  const schemeName = (episode?.insurance_context?.scheme_name ?? '').toString();
  let scheme: ContextField<Scheme>;
  const looksPmjay = /pmjay|ayushman/i.test(panelCode) || /pmjay|ayushman/i.test(schemeName);
  if (looksPmjay) {
    scheme = field<Scheme>('PMJAY', panel ? 'record' : 'derived', panel ? 0.95 : 0.6);
  } else if (route.value === 'cashless_everywhere') {
    scheme = field<Scheme>('CASHLESS_EVERYWHERE', 'derived', 0.8);
  } else if (route.value === 'network') {
    scheme = field<Scheme>('NETWORK_PRIVATE', 'derived', 0.8);
  } else if (panelCode) {
    scheme = field<Scheme>(panelCode.toUpperCase(), 'record', 0.5);
    flags.push('scheme_from_panel_code_only');
  } else {
    scheme = field<Scheme>(null, 'unresolved', 0);
    flags.push('scheme_unresolved');
  }

  // --- STAGE — record SoT: ipds.stage; else dossier.current_stage; doc-mix is cross-check ---
  const explicitStage: IpdStage | null = isIpdStage(ipd.stage)
    ? ipd.stage
    : isIpdStage(dossier?.current_stage)
      ? (dossier!.current_stage as IpdStage)
      : null;
  const categories = dossier?.doc_sections_by_category
    ? Object.keys(dossier.doc_sections_by_category)
    : [];
  const docClass = docMixStageClass(categories);

  let stage: ContextField<IpdStage>;
  if (explicitStage) {
    let crosscheck: ContextField<IpdStage>['crosscheck'] | undefined;
    if (docClass) {
      const agrees = docClass === stageClass(explicitStage);
      crosscheck = agrees
        ? { agrees, with: 'doc_mix' }
        : { agrees, with: 'doc_mix', note: `docs imply ${docClass}, stage is ${explicitStage}` };
      if (!agrees) flags.push('stage_docmix_mismatch');
    }
    // record wins even on disagreement (OD5) — the cross-check only flags.
    stage = field<IpdStage>(explicitStage, ipd.stage ? 'record' : 'derived', ipd.stage ? 1 : 0.7, crosscheck);
  } else if (docClass) {
    const repr: Record<StageClass, IpdStage | null> = {
      preauth: 'preauth_submitted',
      enhancement: 'enhancements_submitted',
      discharge: 'discharge_submitted',
      claim: 'claim_filed',
      other: null,
    };
    stage = field<IpdStage>(repr[docClass], 'derived', 0.5);
    flags.push('stage_derived_from_doc_mix');
  } else {
    stage = field<IpdStage>(null, 'unresolved', 0);
    flags.push('stage_unresolved');
  }

  // --- CASE TYPE — derived (episode_type + procedure count). The intended
  //     future SoT is an explicit admission field (not built yet) -> flagged. ---
  const episodeType = (episode?.meta?.episode_type ?? '').toString();
  const procedureCount = (episode?.clinical_timeline ?? []).reduce(
    (n, phase) => n + (phase?.procedures_performed?.length ?? 0),
    0,
  );
  let caseType: ContextField<CaseType>;
  if (/surg/i.test(episodeType)) {
    caseType = field<CaseType>('SURGICAL', 'derived', 0.85);
  } else if (/medical|conservativ|management/i.test(episodeType)) {
    caseType = field<CaseType>('MEDICAL_MANAGEMENT', 'derived', 0.85);
  } else if (procedureCount > 0) {
    caseType = field<CaseType>('SURGICAL', 'derived', 0.6);
    flags.push('case_type_from_procedure_count');
  } else if (episodeType) {
    caseType = field<CaseType>('UNKNOWN', 'derived', 0.3);
    flags.push('case_type_unrecognised');
  } else {
    caseType = field<CaseType>('UNKNOWN', 'unresolved', 0);
    flags.push('case_type_unresolved');
  }
  // case_type has no record-backed source of truth yet (see FROZEN_CONTRACTS OD1).
  flags.push('case_type_no_explicit_record');

  return {
    claimId: input.claimId,
    scheme,
    route,
    insurerPanelId,
    stage,
    caseType,
    flags,
    resolverVersion: RESOLVER_VERSION,
  };
}
