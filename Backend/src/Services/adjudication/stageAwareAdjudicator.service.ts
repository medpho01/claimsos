// =============================================================================
// M4 + M5 — Stage-aware adjudicator (the LIVE fold).
//
// For a claim: resolve context → select the most-specific rule set by
// {scheme,route,insurer,stage,case_type} → build a RuleContext from the
// harmonised episode + canonical document_sections → run the pure M3 engine →
// persist per-stage rule outcomes + the 4-layer hypothesis.
//
// Reuses the pure libraries (Services/context, Services/rules) for all logic;
// only the DB IO lives here. Interpret/recommend only — it produces a readiness
// + recommended_action signal, never an auto hold/file (FROZEN_CONTRACTS OD5).
// =============================================================================

import { pool as defaultPool } from '../../DB/db.js';
import { loadResolveContextInput } from '../context/loader.js';
import { resolveContext, docMixStageClass } from '../context/resolver.js';
import { selectRuleSet, type RuleSetMeta, type SelectionContext } from '../rules/selection.js';
import { evaluateRules, summarizeReadiness } from '../rules/engine.js';
import type { DatedDoc, EvalResult, NamedValue, Rule, RuleContext } from '../rules/types.js';

export interface Queryable {
  query(text: string, params?: any[]): Promise<{ rows: any[] }>;
}

// Field-key conventions, mirrored from harmonisation.service.ts.
const NAME_KEYS = ['patient_name', 'name', 'full_name', 'beneficiary_name'];
const DATE_KEYS = [
  'report_date', 'test_date', 'bill_date', 'date', 'collected_on', 'sample_date',
  'admission_date', 'date_of_admission', 'discharge_date', 'date_of_discharge', 'performed_at',
];

// Representative stage code per coarse doc-mix class (fallback when neither
// ipds.stage nor the dossier carries a stage).
const REPR_STAGE: Record<string, string | null> = {
  preauth: 'preauth_submitted',
  enhancement: 'enhancements_submitted',
  discharge: 'discharge_submitted',
  claim: 'claim_filed',
  other: null,
};

function normIso(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})$/); // DD/MM/YYYY | DD-MM-YYYY
  if (m) {
    const d = m[1], mo = m[2];
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00Z`;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function phaseDate(episode: any, phaseCode: string): string | null {
  const tl = Array.isArray(episode?.clinical_timeline) ? episode.clinical_timeline : [];
  const ph = tl.find((p: any) => String(p?.phase_code ?? '').toUpperCase() === phaseCode);
  return normIso(ph?.start_datetime) ?? null;
}

async function fetchInsurerCode(db: Queryable, claimId: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT COALESCE(p.code, p.name) AS code
       FROM hospital.ipds i
       LEFT JOIN hospital.claim_dossiers cd ON cd.claim_id = i.id
       LEFT JOIN hospital.panels p ON p.id = COALESCE(cd.current_panel_id, i.panel_id)
      WHERE i.id = $1`,
    [claimId],
  );
  return rows[0]?.code ?? null;
}

async function loadCandidateRuleSets(db: Queryable): Promise<RuleSetMeta[]> {
  const { rows } = await db.query(
    `SELECT id, rule_set_id, status, insurer_code,
            applicable_schemes, applicable_routes, applicable_stages,
            applicable_case_types, applicable_treatments, applicable_specialties
       FROM hospital.insurer_rule_sets
      WHERE status = 'live'`,
  );
  return rows.map((r) => ({
    id: r.id,
    ruleSetId: r.rule_set_id,
    status: r.status,
    insurerCode: r.insurer_code ?? null,
    schemes: r.applicable_schemes ?? [],
    routes: r.applicable_routes ?? [],
    stages: r.applicable_stages ?? [],
    caseTypes: r.applicable_case_types ?? [],
    treatments: r.applicable_treatments ?? [],
    specialties: r.applicable_specialties ?? [],
  }));
}

async function loadRules(db: Queryable, ruleSetUuid: string): Promise<Rule[]> {
  const { rows } = await db.query(
    `SELECT rule_id, kind, severity, impact, mandatory, min_confidence, failure_message, validation_logic
       FROM hospital.insurance_rules
      WHERE rule_set_id = $1 AND enabled = true AND kind IS NOT NULL
      ORDER BY order_index`,
    [ruleSetUuid],
  );
  return rows.map((r) => ({
    ruleId: r.rule_id,
    kind: r.kind,
    severity: r.severity,
    impact: r.impact,
    mandatory: r.mandatory ?? false,
    minConfidence: r.min_confidence != null ? Number(r.min_confidence) : undefined,
    failureMessage: r.failure_message ?? undefined,
    // The kind-specific params live in the existing validation_logic JSONB column.
    params: r.validation_logic && typeof r.validation_logic === 'object' ? r.validation_logic : {},
  }));
}

async function buildRuleContext(
  db: Queryable,
  claimId: string,
  stage: string | null,
  episode: any,
): Promise<RuleContext> {
  const { rows: secs } = await db.query(
    `SELECT category, extracted_fields
       FROM hospital.document_sections
      WHERE claim_id = $1 AND dedup_of IS NULL AND category IS NOT NULL`,
    [claimId],
  );
  const presentCategories = [...new Set<string>(secs.map((s) => s.category))];
  const fieldsByCategory: Record<string, Record<string, unknown>> = {};
  const names: NamedValue[] = [];
  const datedDocs: DatedDoc[] = [];
  for (const s of secs) {
    const f = s.extracted_fields && typeof s.extracted_fields === 'object' ? s.extracted_fields : {};
    fieldsByCategory[s.category] = { ...(fieldsByCategory[s.category] ?? {}), ...f };
    for (const k of NAME_KEYS) {
      const v = f[k];
      if (typeof v === 'string' && v.trim()) {
        names.push({ value: v.trim(), sourceDocType: s.category });
        break;
      }
    }
    for (const k of DATE_KEYS) {
      const iso = normIso(f[k]);
      if (iso) {
        datedDocs.push({ docType: s.category, date: iso });
        break;
      }
    }
  }
  const anchors = {
    admission: normIso(episode?.stay_summary?.admission_datetime) ?? phaseDate(episode, 'ADMISSION'),
    discharge: normIso(episode?.stay_summary?.discharge_datetime) ?? phaseDate(episode, 'DISCHARGE'),
  };
  return { stage, presentCategories, fieldsByCategory, names, datedDocs, anchors };
}

export interface AdjudicationResult {
  ok: boolean;
  reason?: string;
  claimId: string;
  stage: string | null;
  context?: { scheme: string | null; route: string | null; insurer: string | null; caseType: string | null };
  ruleSetId?: string | null;
  readinessScore?: number | null;
  recommendedAction?: string;
  results?: EvalResult[];
}

async function persistEvaluations(
  db: Queryable,
  claimId: string,
  stage: string,
  ruleSetUuid: string,
  results: EvalResult[],
): Promise<void> {
  for (const e of results) {
    await db.query(
      `INSERT INTO hospital.claim_rule_evaluations
         (claim_id, stage, rule_set_id, rule_id, status, severity, impact, evidence, message, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW())
       ON CONFLICT (claim_id, stage, rule_set_id, rule_id) DO UPDATE SET
         status = EXCLUDED.status, severity = EXCLUDED.severity, impact = EXCLUDED.impact,
         evidence = EXCLUDED.evidence, message = EXCLUDED.message, evaluated_at = NOW()`,
      [claimId, stage, ruleSetUuid, e.ruleId, e.status, e.severity, e.impact, JSON.stringify(e.evidence ?? null), e.message],
    );
  }
}

async function persistHypothesis(
  db: Queryable,
  claimId: string,
  stage: string,
  layers: { l1: unknown; l2: unknown; l3: unknown; l4: unknown },
): Promise<void> {
  await db.query(
    `INSERT INTO hospital.claim_hypothesis
       (claim_id, stage, layer1_documents, layer2_content, layer3_rules, layer4_readiness, resolver_version)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7)
     ON CONFLICT (claim_id, stage) DO UPDATE SET
       layer1_documents = EXCLUDED.layer1_documents, layer2_content = EXCLUDED.layer2_content,
       layer3_rules = EXCLUDED.layer3_rules, layer4_readiness = EXCLUDED.layer4_readiness,
       resolver_version = EXCLUDED.resolver_version, updated_at = NOW()`,
    [claimId, stage, JSON.stringify(layers.l1), JSON.stringify(layers.l2), JSON.stringify(layers.l3), JSON.stringify(layers.l4), 'adj.v1'],
  );
}

/** Run the stage-aware adjudication for a claim and persist the result. */
export async function adjudicateClaim(claimId: string, db: Queryable = defaultPool): Promise<AdjudicationResult> {
  const input = await loadResolveContextInput(claimId, db);
  if (!input) return { ok: false, reason: 'no_claim', claimId, stage: null };

  const ctx = resolveContext(input);
  const insurer = await fetchInsurerCode(db, claimId);

  const ruleCtx = await buildRuleContext(db, claimId, ctx.stage.value, input.episode);
  // Stage source-of-truth is ipds.stage / dossier.current_stage (via the
  // resolver). When both are absent — common on this corpus — fall back to the
  // ACTUAL document categories present (the dossier's doc map is often empty).
  let stage: string | null = ctx.stage.value;
  if (!stage) {
    const cls = docMixStageClass(ruleCtx.presentCategories);
    stage = cls ? (REPR_STAGE[cls] ?? null) : null;
    ruleCtx.stage = stage;
  }
  const stageKey = stage ?? '';
  const selCtx: SelectionContext = {
    scheme: ctx.scheme.value,
    route: ctx.route.value,
    insurer,
    stage,
    caseType: ctx.caseType.value,
    treatment: (input.episode?.meta?.episode_type ?? null) as string | null,
    specialty: ((input.episode as any)?.hospital_context?.specialty ?? null) as string | null,
  };
  const contextOut = { scheme: ctx.scheme.value, route: ctx.route.value, insurer, caseType: ctx.caseType.value };
  const layer1 = { stage, present_categories: ruleCtx.presentCategories };
  const layer2 = { fields_by_category: ruleCtx.fieldsByCategory, names: ruleCtx.names, dated_docs: ruleCtx.datedDocs, anchors: ruleCtx.anchors };

  const chosen = selectRuleSet(await loadCandidateRuleSets(db), selCtx);
  if (!chosen) {
    const layer4 = { readiness_score: null, applicable: false, no_match: true, recommended_action: 'review', context: contextOut };
    await persistHypothesis(db, claimId, stageKey, { l1: layer1, l2: layer2, l3: [], l4: layer4 });
    return { ok: true, claimId, stage, context: contextOut, ruleSetId: null, readinessScore: null, recommendedAction: 'review', results: [] };
  }

  const rules = await loadRules(db, chosen.id);
  if (rules.length === 0) {
    // Selected set carries no deterministic (kind'd) rules — e.g. a legacy
    // validation_logic-only pack. Report honestly, not a misleading score 100.
    const layer4 = {
      readiness_score: null,
      applicable: false,
      no_kinded_rules: true,
      rule_set: chosen.ruleSetId,
      recommended_action: 'review',
      context: contextOut,
    };
    await persistHypothesis(db, claimId, stageKey, { l1: layer1, l2: layer2, l3: [], l4: layer4 });
    return { ok: true, claimId, stage, context: contextOut, ruleSetId: chosen.ruleSetId, readinessScore: null, recommendedAction: 'review', results: [] };
  }
  const results = evaluateRules(rules, ruleCtx);
  const readiness = summarizeReadiness(results);
  const recommendedAction =
    readiness.blocking.length > 0 ? 'request_doc' : readiness.warnings.length > 0 ? 'review' : 'file_now';
  const layer4 = {
    readiness_score: readiness.score,
    blocking: readiness.blocking,
    warnings: readiness.warnings,
    errored: readiness.errored,
    recommended_action: recommendedAction,
    rule_set: chosen.ruleSetId,
    context: contextOut,
  };

  await persistEvaluations(db, claimId, stageKey, chosen.id, results);
  await persistHypothesis(db, claimId, stageKey, { l1: layer1, l2: layer2, l3: results, l4: layer4 });

  return {
    ok: true,
    claimId,
    stage,
    context: contextOut,
    ruleSetId: chosen.ruleSetId,
    readinessScore: readiness.score,
    recommendedAction,
    results,
  };
}
