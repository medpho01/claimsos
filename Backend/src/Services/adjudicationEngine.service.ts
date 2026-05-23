/**
 * Sprint 3, Wave 3B — Adjudication Engine v0
 *
 * The AdjudicationEngine is the second-stage "should we file this?" reasoner.
 * It consumes the ClaimDossier projection (Wave 1) and the RulesEngine result
 * (Wave 3A — lane in flight) and emits a structured AdjudicationReport that
 * the cockpit, the action dispatcher, and ops humans all read.
 *
 * What this v0 does:
 *   - Loads the dossier for a claim.
 *   - Resolves a target_stage if the caller didn't supply one (inferTargetStage
 *     from current_stage + dossier-shape hints).
 *   - Hashes the dossier-shaped inputs the engine actually depends on. Same
 *     hash → cached report returned (no re-evaluation).
 *   - Calls RulesEngine.evaluate to get readiness_score, blocking_gaps,
 *     warnings, and rule citations.
 *   - Buckets the score, derives a recommended_action, persists the report,
 *     and dispatches a typed adjudication_run event for the timeline /
 *     downstream listeners.
 *
 * What v0 does NOT do (Wave 4):
 *   - KB pattern matching (kb_matches stays []).
 *   - Episodic memory lookup (episodic_refs stays []).
 *   - LLM-based reasoning narrative (reasoning stays null).
 *   - Predicted outcome { amount, p_query, p_deduction, expected_deductions }
 *     (predicted_outcome stays null).
 *   - The "escalate_to_human" branch is gated behind a heuristic we'll wire
 *     up once we have scope_resolution conflicts to flag on. For now no run
 *     produces that recommended_action.
 *
 * RulesEngine coupling: at the time of writing Wave 3A is in-flight on its own
 * lane. We import from `./rulesEngine.service.js` assuming it lands at that
 * path. If you're reading this before Lane A lands, the import will resolve
 * once that lane merges — we deliberately don't stub it here to avoid having
 * to delete the stub at integration time.
 */

import { createHash } from 'crypto';
import type { Pool } from 'pg';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import claimDossierService, {
  type ClaimDossier,
} from './claimDossier.service.js';
import { eventDispatcher } from './events/eventDispatcher.service.js';
// Wave 3A lane (RulesEngine) is imported *lazily* (see lazyRulesEngine
// below). Eager-importing at module top would crash this file's tests on
// branches where Lane A hasn't merged yet — and the tests don't exercise
// the rules engine anyway, they inject a stub. Production code path
// follows the lazy load on first run() call.
//
// Same lazy story for Wave 4A (KbPatternMatcher), Wave 4B (EpisodicMemory),
// and Wave 4C (ReasoningAgent) — see lazyKbMatcher / lazyEpisodicMemory /
// lazyReasoningAgent below. enrichWithIntelligence() gracefully no-ops when
// any of these dynamic imports fail (sibling lanes not merged yet, test
// env without DB, etc.) so the v0 report still gets written.

// ─── Versioning constants ────────────────────────────────────────────────
export const ENGINE_VERSION = 'v0';
export const RULES_VERSION = 'v1';
export const INTELLIGENCE_VERSION = 'v1';

// ─── Public types ────────────────────────────────────────────────────────

export type ReadinessBucket = 'ready' | 'almost' | 'blocked';
export type RecommendedAction =
  | 'file_now'
  | 'request_doc'
  | 'review'
  | 'wait'
  | 'escalate_to_human';

export interface AdjudicationReport {
  id: string;
  claim_id: string;
  target_stage: string;
  readiness_score: number;
  readiness_bucket: ReadinessBucket;
  recommended_action: RecommendedAction;
  blocking_gaps: any[];
  warnings: any[];
  predicted_outcome: any | null;
  citations: { rule_ids: string[]; pattern_ids: string[]; case_ids: string[] };
  kb_matches: any[];
  episodic_refs: any[];
  reasoning: string | null;
  generated_at: Date;
}

export interface RunInput {
  claim_id: string;
  target_stage?: string;
  force?: boolean;
  /**
   * Wave 4C override — force the ReasoningAgent to fire even if the
   * heuristic would otherwise skip it. Used by the cockpit "re-evaluate
   * with reasoning" button and by ops debug tooling. Defaults to false:
   * the heuristic decides.
   */
  useReasoning?: boolean;
  /**
   * Hospital id for cost accounting on the ReasoningAgent LLM call.
   * Optional — when absent we record the call against the claim only.
   */
  hospital_id?: string;
}

export interface GetHistoryOpts {
  limit?: number;
  target_stage?: string;
}

// ─── inferTargetStage ────────────────────────────────────────────────────
// Tiny static map from current_stage → "what stage are we trying to reach
// next?". Kept exported + pure so unit tests can lock in the table without
// having to instantiate the whole engine.
//
// The map intentionally covers only the well-known happy-path stages we use
// today (Wave 0/1 vocabulary). Anything we don't recognise defaults to
// 'pre_auth' — a safe choice because the engine will then evaluate readiness
// against pre-auth requirements, which is the typical first gate in any
// claim's lifecycle.
//
// Special cases:
//   - From 'pre_auth_pending': if there are active queries on the dossier we
//     route to 'query_reply' (we owe the insurer a response), else we stay
//     at 'pre_auth' (still waiting on the insurer).
//   - From 'approved': if discharge docs are present in the dossier we route
//     to 'discharge_filing'; otherwise we stay 'approved' (waiting on
//     discharge to actually happen).
export function inferTargetStage(
  currentStage: string | null | undefined,
  dossier: ClaimDossier,
): string {
  const cs = (currentStage ?? '').toLowerCase();

  // Target stage values are master_options.code from category='ipd_stage'
  // (migration 024 seeds 'preauth_submitted', 'preauth_query_responded',
  // 'discharge_submitted', etc). stage_requirements.target_stage references
  // these codes. We map current_stage → target ipd_stage code so rules
  // can match.

  if (cs === 'pre_auth_pending' || cs === 'preauth_submitted') {
    if ((dossier.active_queries ?? []).length > 0) return 'preauth_query_responded';
    return 'preauth_submitted';
  }

  if (cs === 'admitted' || cs === 'pre_admission' || cs === '') {
    return 'preauth_submitted';
  }

  if (cs === 'query_raised' || cs === 'preauth_query_raised') return 'preauth_query_responded';

  if (cs === 'approved' || cs === 'preauth_approved') {
    const sections = dossier.doc_sections_by_category ?? {};
    const hasDischarge =
      Array.isArray((sections as any)['discharge_summary']) &&
      (sections as any)['discharge_summary'].length > 0;
    if (hasDischarge) return 'discharge_submitted';
    return 'preauth_approved';
  }

  if (cs === 'enhancement_needed') return 'enhancement_submitted';
  if (cs === 'final_filing_drafted') return 'final_submitted';

  // Anything we don't recognise → start at the gate.
  return 'preauth_submitted';
}

// ─── Dossier hashing ─────────────────────────────────────────────────────
// We hash only the fields the engine actually reads, in a stable
// canonical-JSON form. New engine inputs → bump RULES_VERSION (or the
// hash shape) so we don't accidentally return a stale cached report.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(
        (k) => JSON.stringify(k) + ':' + stableStringify((value as any)[k]),
      )
      .join(',') +
    '}'
  );
}

export function hashDossierState(
  dossier: ClaimDossier,
  target_stage: string,
): string {
  const subset = {
    current_stage: dossier.current_stage,
    doc_sections_by_category: dossier.doc_sections_by_category,
    active_queries: (dossier.active_queries ?? []).map((q) => ({
      query_id: q.query_id,
      deficiency_type: q.deficiency_type ?? null,
    })),
    current_panel_id: dossier.current_panel_id,
    current_insurer_id: dossier.current_insurer_id,
    target_stage,
  };
  return createHash('sha256').update(stableStringify(subset)).digest('hex');
}

// ─── DB row shape ────────────────────────────────────────────────────────
interface ReportRow {
  id: string;
  claim_id: string;
  target_stage: string;
  readiness_score: number;
  readiness_bucket: ReadinessBucket;
  recommended_action: RecommendedAction;
  blocking_gaps: any;
  warnings: any;
  predicted_outcome: any;
  citations: any;
  kb_matches: any;
  episodic_refs: any;
  reasoning: string | null;
  generated_at: Date;
}

function rowToReport(row: ReportRow): AdjudicationReport {
  const citations = (row.citations ?? {}) as Partial<
    AdjudicationReport['citations']
  >;
  return {
    id: row.id,
    claim_id: row.claim_id,
    target_stage: row.target_stage,
    readiness_score: row.readiness_score,
    readiness_bucket: row.readiness_bucket,
    recommended_action: row.recommended_action,
    blocking_gaps: Array.isArray(row.blocking_gaps) ? row.blocking_gaps : [],
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    predicted_outcome: row.predicted_outcome ?? null,
    citations: {
      rule_ids: Array.isArray(citations.rule_ids) ? citations.rule_ids : [],
      pattern_ids: Array.isArray(citations.pattern_ids)
        ? citations.pattern_ids
        : [],
      case_ids: Array.isArray(citations.case_ids) ? citations.case_ids : [],
    },
    kb_matches: Array.isArray(row.kb_matches) ? row.kb_matches : [],
    episodic_refs: Array.isArray(row.episodic_refs) ? row.episodic_refs : [],
    reasoning: row.reasoning ?? null,
    generated_at: row.generated_at,
  };
}

const SELECT_COLS = `
  id, claim_id, target_stage,
  readiness_score, readiness_bucket, recommended_action,
  blocking_gaps, warnings, predicted_outcome,
  citations, kb_matches, episodic_refs,
  reasoning, generated_at
`;

// ─── Bucket / action derivation ──────────────────────────────────────────
export function bucketize(score: number): ReadinessBucket {
  if (score >= 80) return 'ready';
  if (score >= 50) return 'almost';
  return 'blocked';
}

export function deriveRecommendedAction(args: {
  bucket: ReadinessBucket;
  blocking_gaps_count: number;
  warnings_count: number;
  has_active_queries: boolean;
}): RecommendedAction {
  // Active queries are an unconditional override — the insurer is waiting
  // on us for a document, that's what the user has to act on regardless of
  // the rules engine's score.
  if (args.has_active_queries) return 'request_doc';

  if (args.bucket === 'blocked') return 'request_doc';

  if (args.bucket === 'almost') {
    if (args.blocking_gaps_count > 0) return 'request_doc';
    if (args.warnings_count > 0) return 'review';
    return 'review';
  }

  // bucket === 'ready'
  return 'file_now';
}

// ─── Service ─────────────────────────────────────────────────────────────

export interface RulesEngineLike {
  evaluate(input: {
    claim_id: string;
    target_stage: string;
    dossier_snapshot: ClaimDossier;
    procedure_code?: string | null;
    diagnosis_class?: string | null;
  }): Promise<{
    ready: boolean;
    readiness_score: number; // 0..1
    blocking_gaps: Array<{ rule_id?: string; [k: string]: any }>;
    warnings: Array<{ rule_id?: string; [k: string]: any }>;
    info?: Array<{ rule_id?: string; [k: string]: any }>;
    scope_resolution?: any;
  }>;
}

export interface DossierServiceLike {
  getDossier(claim_id: string): Promise<ClaimDossier | null>;
}

export interface EventDispatcherLike {
  dispatch(input: {
    kind: 'adjudication_run';
    claimId: string;
    payload: {
      report_id: string;
      target_stage: string;
      readiness: number; // 0..1
      blocking_gaps_count: number;
      warnings_count: number;
    };
  }): Promise<{ id: string; deduped: boolean }>;
}

/**
 * Lazy import of the RulesEngine — Wave 3A lane. Resolved on first run()
 * call so unit tests on branches where Lane A isn't merged yet can still
 * import this module and inject a stub via the constructor.
 *
 * At integration time, RulesEngine will resolve via the dynamic import
 * below to `./rulesEngine.service.js`. If you're seeing a runtime "module
 * not found" here in production, the integration sprint forgot to land
 * Lane A first.
 */
let cachedRulesEngine: RulesEngineLike | null = null;
async function lazyRulesEngine(): Promise<RulesEngineLike> {
  if (cachedRulesEngine) return cachedRulesEngine;
  const mod: any = await import('./rulesEngine.service.js');
  const Ctor = mod.RulesEngine ?? mod.default;
  cachedRulesEngine = new Ctor() as RulesEngineLike;
  return cachedRulesEngine;
}

// ─── Wave 4 intelligence layer types & lazy loaders ──────────────────────
// These mirror the shapes Wave 4A (KbPatternMatcher) and Wave 4B
// (EpisodicMemory) are landing in sibling lanes. We depend on the
// service contracts, not the modules — if the sibling lanes haven't
// merged yet, the dynamic imports throw, enrichWithIntelligence catches,
// and the report falls back to v0 stubs (kb_matches=[], episodic_refs=[],
// reasoning=null, predicted_outcome=null). This is the graceful no-op
// the spec calls for.
export interface KbMatchedPatternLike {
  id: string;
  pattern_type?: string;
  title?: string;
  description?: string;
  prediction?: unknown;
  confidence?: number;
  evidence_count?: number;
}

export interface KbPatternMatcherLike {
  match(input: {
    claim_id: string;
    dossier: ClaimDossier;
    procedure_code?: string | null;
    diagnosis_class?: string | null;
  }): Promise<KbMatchedPatternLike[]>;
}

export interface RetrievedCaseLike {
  claim_id: string;
  similarity: number;
  summary?: string;
  metadata?: Record<string, unknown>;
  outcome?: unknown;
}

export interface EpisodicMemoryLike {
  retrieve(input: {
    claim_id: string;
    dossier: ClaimDossier;
    k: number;
    filters?: Record<string, unknown>;
  }): Promise<RetrievedCaseLike[]>;
}

export interface ReasoningAgentLike {
  reason(input: {
    claim_id: string;
    hospital_id: string;
    dossier: ClaimDossier;
    target_stage: string;
    rule_evaluation: any;
    kb_matches: KbMatchedPatternLike[];
    episodic_cases: RetrievedCaseLike[];
  }): Promise<{
    output: {
      readiness_verdict: 'ready' | 'almost_ready' | 'blocked';
      delta_to_rules: { agrees: boolean; reason: string | null };
      predicted_outcome: {
        approval_probability: number;
        expected_amount_inr: number | null;
        expected_deduction_pct: number | null;
        p_query: number;
        expected_deductions: Array<{
          reason: string;
          amount_inr: number | null;
          likelihood: number;
        }>;
      };
      recommended_action: RecommendedAction;
      reasoning: string;
      citations: {
        rule_ids: string[];
        pattern_ids: string[];
        case_ids: string[];
      };
      uncertainty_notes: string | null;
    };
    costInr: number;
    tierEscalated: boolean;
  }>;
}

let cachedKbMatcher: KbPatternMatcherLike | null | undefined = undefined;
async function lazyKbMatcher(): Promise<KbPatternMatcherLike | null> {
  if (cachedKbMatcher !== undefined) return cachedKbMatcher;
  try {
    const mod: any = await import('./kbPatternMatcher.service.js');
    const Ctor = mod.KbPatternMatcher ?? mod.default;
    cachedKbMatcher = typeof Ctor === 'function' ? new Ctor() : Ctor;
  } catch (err) {
    logger.warn(
      { err },
      'adjudicationEngine: kbPatternMatcher.service not available — kb enrichment disabled'
    );
    cachedKbMatcher = null;
  }
  return cachedKbMatcher;
}

let cachedEpisodicMemory: EpisodicMemoryLike | null | undefined = undefined;
async function lazyEpisodicMemory(): Promise<EpisodicMemoryLike | null> {
  if (cachedEpisodicMemory !== undefined) return cachedEpisodicMemory;
  try {
    const mod: any = await import('./episodicMemory.service.js');
    const Ctor = mod.EpisodicMemory ?? mod.default;
    cachedEpisodicMemory = typeof Ctor === 'function' ? new Ctor() : Ctor;
  } catch (err) {
    logger.warn(
      { err },
      'adjudicationEngine: episodicMemory.service not available — episodic enrichment disabled'
    );
    cachedEpisodicMemory = null;
  }
  return cachedEpisodicMemory;
}

let cachedReasoningAgent: ReasoningAgentLike | null | undefined = undefined;
async function lazyReasoningAgent(): Promise<ReasoningAgentLike | null> {
  if (cachedReasoningAgent !== undefined) return cachedReasoningAgent;
  try {
    const mod: any = await import('./reasoningAgent.service.js');
    // ReasoningAgent ships a default singleton — prefer it so we
    // share the prompt cache state across calls.
    cachedReasoningAgent = (mod.default ?? null) as ReasoningAgentLike | null;
    if (!cachedReasoningAgent && typeof mod.ReasoningAgent === 'function') {
      cachedReasoningAgent = new mod.ReasoningAgent() as ReasoningAgentLike;
    }
  } catch (err) {
    logger.warn(
      { err },
      'adjudicationEngine: reasoningAgent.service not available — reasoning disabled'
    );
    cachedReasoningAgent = null;
  }
  return cachedReasoningAgent;
}

// Test-only escape hatch: reset the lazy cache between tests so each
// test can inject its own stubs without cross-contamination.
export function __resetIntelligenceCacheForTests(): void {
  cachedKbMatcher = undefined;
  cachedEpisodicMemory = undefined;
  cachedReasoningAgent = undefined;
}

export class AdjudicationEngine {
  // Constructor injection mirrors EmailIntelligenceService — tests pass
  // stubs; production code uses the default singletons. `rules` may be
  // null to defer instantiation to first use (default singleton path).
  // Same lazy story for the Wave 4 intelligence deps: pass `null`
  // (the default) and the engine dynamic-imports the sibling services
  // on first use; if those imports fail (sibling lane not merged, test
  // env without DB) enrichment gracefully no-ops with a warn log.
  // Wave 4 intelligence deps use a tri-state:
  //   - undefined: not explicitly set → lazy-load the sibling module
  //   - null:      explicitly disabled → graceful no-op (test fixture
  //                  for simulating "sibling module not available")
  //   - object:    explicit override (test stub or production injection)
  private readonly rules: RulesEngineLike | null;
  private readonly kbMatcherDep: KbPatternMatcherLike | null | undefined;
  private readonly episodicMemoryDep: EpisodicMemoryLike | null | undefined;
  private readonly reasoningAgentDep: ReasoningAgentLike | null | undefined;
  constructor(
    private readonly pool: Pick<Pool, 'query'> = defaultPool,
    private readonly dossiers: DossierServiceLike = claimDossierService,
    rules: RulesEngineLike | null = null,
    private readonly dispatcher: EventDispatcherLike = eventDispatcher as unknown as EventDispatcherLike,
    intelligence: {
      kbMatcher?: KbPatternMatcherLike | null;
      episodicMemory?: EpisodicMemoryLike | null;
      reasoningAgent?: ReasoningAgentLike | null;
    } = {},
  ) {
    this.rules = rules;
    this.kbMatcherDep = intelligence.kbMatcher;
    this.episodicMemoryDep = intelligence.episodicMemory;
    this.reasoningAgentDep = intelligence.reasoningAgent;
  }

  private async getRules(): Promise<RulesEngineLike> {
    if (this.rules) return this.rules;
    return await lazyRulesEngine();
  }

  /**
   * Lazily resolve a Wave 4 dep. Order:
   *   1. constructor injection (any value — including explicit null,
   *      which the test suite uses to simulate "sibling module not
   *      available")
   *   2. dynamic import of the sibling service module
   *   3. null (enrichment no-ops for this dep — warn already logged)
   */
  private async getKbMatcher(): Promise<KbPatternMatcherLike | null> {
    if (this.kbMatcherDep !== undefined) return this.kbMatcherDep;
    return await lazyKbMatcher();
  }
  private async getEpisodicMemory(): Promise<EpisodicMemoryLike | null> {
    if (this.episodicMemoryDep !== undefined) return this.episodicMemoryDep;
    return await lazyEpisodicMemory();
  }
  private async getReasoningAgent(): Promise<ReasoningAgentLike | null> {
    if (this.reasoningAgentDep !== undefined) return this.reasoningAgentDep;
    return await lazyReasoningAgent();
  }

  // ────────────────────────────────────────────────────────────────────
  // run
  // ────────────────────────────────────────────────────────────────────

  async run(input: RunInput): Promise<AdjudicationReport> {
    // (a) Dossier — no dossier means we have nothing to adjudicate on.
    const dossier = await this.dossiers.getDossier(input.claim_id);
    if (!dossier) {
      throw new Error(`no dossier for claim ${input.claim_id}`);
    }

    // (b) Resolve target_stage.
    const target_stage =
      input.target_stage ?? inferTargetStage(dossier.current_stage, dossier);

    // (c) Cache key.
    const dossier_state_hash = hashDossierState(dossier, target_stage);

    // (d) Cache probe (unless force=true).
    if (!input.force) {
      const cached = await this.findByHash(
        input.claim_id,
        target_stage,
        dossier_state_hash,
      );
      if (cached) {
        logger.debug(
          {
            claim_id: input.claim_id,
            target_stage,
            dossier_state_hash,
            report_id: cached.id,
          },
          'adjudicationEngine: cache hit',
        );
        return cached;
      }
    }

    // (e) Rules engine evaluation. procedure_code / diagnosis_class are
    //     plucked from patient_summary if available — the dossier shape
    //     only has free-text procedure/diagnosis today, so we pass them
    //     as-is and let the rules engine deal with normalisation.
    const procedure_code =
      (dossier.patient_summary?.procedure as string | null | undefined) ?? null;
    const diagnosis_class =
      (dossier.patient_summary?.primary_diagnosis as
        | string
        | null
        | undefined) ?? null;

    const rules = await this.getRules();
    const rulesResult = await rules.evaluate({
      claim_id: input.claim_id,
      target_stage,
      dossier_snapshot: dossier,
      procedure_code,
      diagnosis_class,
    });

    // RulesEngine returns 0..100 already (the actual Wave 3A implementation
    // clamps to that range — confirmed at integration time). Clamp + round
    // defensively in case a future RulesEngine version returns 0..1.
    const rawScore = rulesResult.readiness_score ?? 0;
    const normalizedScore = rawScore <= 1 && rawScore > 0 ? rawScore * 100 : rawScore;
    const readiness_score = clampInt(Math.round(normalizedScore), 0, 100);
    const readiness_bucket = bucketize(readiness_score);

    const blocking_gaps = rulesResult.blocking_gaps ?? [];
    const warnings = rulesResult.warnings ?? [];

    const recommended_action = deriveRecommendedAction({
      bucket: readiness_bucket,
      blocking_gaps_count: blocking_gaps.length,
      warnings_count: warnings.length,
      has_active_queries: (dossier.active_queries ?? []).length > 0,
    });

    // (h) Citations: v0 only carries rule ids from blocking_gaps + warnings.
    //     pattern_ids / case_ids fill in during enrichWithIntelligence.
    const rule_ids = collectRuleIds([
      ...blocking_gaps,
      ...warnings,
      ...(rulesResult.info ?? []),
    ]);
    const citations = {
      rule_ids,
      pattern_ids: [] as string[],
      case_ids: [] as string[],
    };

    // (i) Wave 4 enrichment — KB pattern matches, episodic refs, and
    //     (conditionally) the ReasoningAgent narrative + prediction.
    //     enrichWithIntelligence mutates the draft in place and returns
    //     the (possibly-overridden) recommended_action.
    const draft: EnrichmentDraft = {
      recommended_action,
      predicted_outcome: null as any,
      citations,
      kb_matches: [] as any[],
      episodic_refs: [] as any[],
      reasoning: null as string | null,
    };
    await this.enrichWithIntelligence(draft, {
      claim_id: input.claim_id,
      hospital_id: input.hospital_id ?? null,
      dossier,
      target_stage,
      rule_evaluation: rulesResult,
      useReasoning: input.useReasoning === true,
    });

    // (k) Insert; cache collision is a no-op return-existing.
    const generated_by = input.force ? 'manual_replay' : 'engine';
    const report = await this.insertOrFetch({
      claim_id: input.claim_id,
      target_stage,
      readiness_score,
      readiness_bucket,
      recommended_action: draft.recommended_action,
      blocking_gaps,
      warnings,
      predicted_outcome: draft.predicted_outcome,
      citations: draft.citations,
      kb_matches: draft.kb_matches,
      episodic_refs: draft.episodic_refs,
      reasoning: draft.reasoning,
      dossier_state_hash,
      generated_by,
    });

    // (l) Fire-and-await the typed event. Dispatcher is idempotency-safe
    //     and the event_type schema expects readiness as 0..1 — pass the
    //     un-scaled value.
    try {
      await this.dispatcher.dispatch({
        kind: 'adjudication_run',
        claimId: input.claim_id,
        payload: {
          report_id: report.id,
          target_stage,
          readiness: readiness_score / 100,
          blocking_gaps_count: blocking_gaps.length,
          warnings_count: warnings.length,
        },
      });
    } catch (err) {
      // Event dispatch failures must not poison the report. The report
      // is already persisted; downstream catch-up can re-emit if needed.
      logger.warn(
        { err, claim_id: input.claim_id, report_id: report.id },
        'adjudicationEngine: event dispatch failed (report still committed)',
      );
    }

    return report;
  }

  // ────────────────────────────────────────────────────────────────────
  // Wave 4 — enrichWithIntelligence
  // ────────────────────────────────────────────────────────────────────
  //
  // Folds KB pattern matches, episodic similar-case retrieval, and
  // (conditionally) the ReasoningAgent's narrative + prediction into
  // the adjudication draft right before persistence.
  //
  // Heuristic for invoking the ReasoningAgent (Wave 4C v1):
  //   We ONLY fire the Sonnet call when the rules-only answer is
  //   genuinely ambiguous OR the caller explicitly asked. The agent
  //   costs ~₹0.80 per call so volume matters. Concretely we fire when:
  //     (a) input.useReasoning === true (operator clicked "re-evaluate
  //         with reasoning" or ops debug tool requested it), OR
  //     (b) the rules engine returned >= 2 warnings (multiple soft
  //         signals → likely need synthesis), OR
  //     (c) we retrieved >= 3 kb matches AND at least two of their
  //         predictions disagree (contradicting priors → must reconcile).
  //   Otherwise we skip — predicted_outcome stays null and
  //   recommended_action is whatever the rules-derived deriveRecommendedAction
  //   produced.
  //
  // Env kill switch:
  //   INTELLIGENCE_ENRICHMENT=off bypasses this entire method. Used
  //   when KB / episodic / LLM is in a known bad state (corrupt index,
  //   Anthropic outage, etc.). When off, the report still gets written
  //   with v0-shape stubs.
  //
  // Graceful no-op:
  //   Each dep is fetched via the lazy loader, which returns null if
  //   the sibling module isn't importable. Each step then skips that
  //   sub-task with a warn log; the report still gets written.
  private async enrichWithIntelligence(
    draft: EnrichmentDraft,
    ctx: {
      claim_id: string;
      hospital_id: string | null;
      dossier: ClaimDossier;
      target_stage: string;
      rule_evaluation: any;
      useReasoning: boolean;
    },
  ): Promise<void> {
    // (i.0) Env kill switch.
    const flag = (process.env.INTELLIGENCE_ENRICHMENT ?? 'on').toLowerCase();
    if (flag === 'off' || flag === 'false' || flag === '0') {
      logger.debug(
        { claim_id: ctx.claim_id },
        'adjudicationEngine.enrichWithIntelligence: skipped (env kill switch)',
      );
      return;
    }

    const procedure_code =
      (ctx.dossier.patient_summary?.procedure as string | null | undefined) ??
      null;
    const diagnosis_class =
      (ctx.dossier.patient_summary?.primary_diagnosis as
        | string
        | null
        | undefined) ?? null;

    // (i.1) KB pattern matcher (Wave 4A).
    let kb_matches: KbMatchedPatternLike[] = [];
    try {
      const matcher = await this.getKbMatcher();
      if (matcher) {
        kb_matches = await matcher.match({
          claim_id: ctx.claim_id,
          dossier: ctx.dossier,
          procedure_code,
          diagnosis_class,
        });
        draft.kb_matches = kb_matches;
        for (const m of kb_matches) {
          if (m?.id) draft.citations.pattern_ids.push(m.id);
        }
      }
    } catch (err) {
      logger.warn(
        { err, claim_id: ctx.claim_id },
        'adjudicationEngine.enrichWithIntelligence: kbMatcher.match threw — continuing without KB enrichment',
      );
    }

    // (i.2) Episodic memory retrieve (Wave 4B).
    let episodic_cases: RetrievedCaseLike[] = [];
    try {
      const em = await this.getEpisodicMemory();
      if (em) {
        episodic_cases = await em.retrieve({
          claim_id: ctx.claim_id,
          dossier: ctx.dossier,
          k: 5,
        });
        draft.episodic_refs = episodic_cases;
        for (const c of episodic_cases) {
          if (c?.claim_id) draft.citations.case_ids.push(c.claim_id);
        }
      }
    } catch (err) {
      logger.warn(
        { err, claim_id: ctx.claim_id },
        'adjudicationEngine.enrichWithIntelligence: episodicMemory.retrieve threw — continuing without episodic enrichment',
      );
    }

    // (i.3) Decide whether to fire the ReasoningAgent.
    const warningsCount = Array.isArray(ctx.rule_evaluation?.warnings)
      ? ctx.rule_evaluation.warnings.length
      : 0;
    const kbHasContradiction = detectKbContradiction(kb_matches);
    const shouldReason =
      ctx.useReasoning ||
      warningsCount >= 2 ||
      (kb_matches.length >= 3 && kbHasContradiction);

    if (!shouldReason) {
      logger.debug(
        {
          claim_id: ctx.claim_id,
          warningsCount,
          kb_matches: kb_matches.length,
          kbHasContradiction,
        },
        'adjudicationEngine.enrichWithIntelligence: reasoning skipped (heuristic)',
      );
      return;
    }

    // (i.4) Run the ReasoningAgent.
    try {
      const agent = await this.getReasoningAgent();
      if (!agent) return; // lazy loader already warned
      const result = await agent.reason({
        claim_id: ctx.claim_id,
        hospital_id: ctx.hospital_id ?? '',
        dossier: ctx.dossier,
        target_stage: ctx.target_stage,
        rule_evaluation: ctx.rule_evaluation,
        kb_matches,
        episodic_cases,
      });

      // (i.5) Merge ReasoningAgent output into the draft.
      // predicted_outcome is fully owned by the agent (it's the only
      // signal-source that produces a number).
      draft.predicted_outcome = result.output.predicted_outcome;

      // Override recommended_action ONLY when the agent disagrees with
      // the rules-derived suggestion. The narrative carries the "why".
      let mergedReasoning = result.output.reasoning;
      if (result.output.recommended_action !== draft.recommended_action) {
        mergedReasoning =
          `[override] rules suggested ${draft.recommended_action}; agent recommended ${result.output.recommended_action}. ` +
          mergedReasoning;
        draft.recommended_action = result.output.recommended_action;
      }
      if (result.output.uncertainty_notes) {
        mergedReasoning += `\n\nUncertainty: ${result.output.uncertainty_notes}`;
      }
      draft.reasoning = mergedReasoning;

      // Append the agent's citations — dedupe via Set.
      const ruleIdSet = new Set(draft.citations.rule_ids);
      for (const rid of result.output.citations.rule_ids ?? []) ruleIdSet.add(rid);
      const patternIdSet = new Set(draft.citations.pattern_ids);
      for (const pid of result.output.citations.pattern_ids ?? [])
        patternIdSet.add(pid);
      const caseIdSet = new Set(draft.citations.case_ids);
      for (const cid of result.output.citations.case_ids ?? []) caseIdSet.add(cid);
      draft.citations = {
        rule_ids: Array.from(ruleIdSet),
        pattern_ids: Array.from(patternIdSet),
        case_ids: Array.from(caseIdSet),
      };
    } catch (err) {
      // ReasoningAgent threw (schema validation, provider outage, budget
      // block, etc.). The report still ships with kb_matches + episodic_refs
      // populated but predicted_outcome=null and reasoning=null — the
      // cockpit's "no AI prediction available" state.
      logger.warn(
        { err, claim_id: ctx.claim_id },
        'adjudicationEngine.enrichWithIntelligence: reasoningAgent.reason threw — falling back to rules-only',
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Reads
  // ────────────────────────────────────────────────────────────────────

  async getLatest(
    claim_id: string,
    target_stage?: string,
  ): Promise<AdjudicationReport | null> {
    const params: any[] = [claim_id];
    let where = `claim_id = $1`;
    if (target_stage) {
      params.push(target_stage);
      where += ` AND target_stage = $${params.length}`;
    }
    const res = await this.pool.query<ReportRow>(
      `SELECT ${SELECT_COLS}
         FROM hospital.adjudication_reports
        WHERE ${where}
        ORDER BY generated_at DESC
        LIMIT 1`,
      params,
    );
    if ((res.rowCount ?? 0) === 0) return null;
    return rowToReport(res.rows[0]!);
  }

  async getHistory(
    claim_id: string,
    opts: GetHistoryOpts = {},
  ): Promise<AdjudicationReport[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: any[] = [claim_id];
    let where = `claim_id = $1`;
    if (opts.target_stage) {
      params.push(opts.target_stage);
      where += ` AND target_stage = $${params.length}`;
    }
    params.push(limit);
    const res = await this.pool.query<ReportRow>(
      `SELECT ${SELECT_COLS}
         FROM hospital.adjudication_reports
        WHERE ${where}
        ORDER BY generated_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(rowToReport);
  }

  // ────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────

  private async findByHash(
    claim_id: string,
    target_stage: string,
    dossier_state_hash: string,
  ): Promise<AdjudicationReport | null> {
    const res = await this.pool.query<ReportRow>(
      `SELECT ${SELECT_COLS}
         FROM hospital.adjudication_reports
        WHERE claim_id = $1
          AND target_stage = $2
          AND dossier_state_hash = $3
          AND rules_version = $4
          AND engine_version = $5
        LIMIT 1`,
      [claim_id, target_stage, dossier_state_hash, RULES_VERSION, ENGINE_VERSION],
    );
    if ((res.rowCount ?? 0) === 0) return null;
    return rowToReport(res.rows[0]!);
  }

  /**
   * Insert a fresh report row. The unique constraint on (claim_id,
   * target_stage, dossier_state_hash, rules_version, engine_version) makes
   * concurrent runs of the same input collapse to a single row — the
   * winner's RETURNING fires, the loser's INSERT no-ops and we SELECT
   * the existing row back. Same shape as the event dispatcher's
   * idempotency-aware insert.
   */
  private async insertOrFetch(args: {
    claim_id: string;
    target_stage: string;
    readiness_score: number;
    readiness_bucket: ReadinessBucket;
    recommended_action: RecommendedAction;
    blocking_gaps: any[];
    warnings: any[];
    predicted_outcome: any | null;
    citations: AdjudicationReport['citations'];
    kb_matches: any[];
    episodic_refs: any[];
    reasoning: string | null;
    dossier_state_hash: string;
    generated_by: string;
  }): Promise<AdjudicationReport> {
    const insertSql = `
      INSERT INTO hospital.adjudication_reports (
        claim_id, target_stage,
        readiness_score, readiness_bucket, recommended_action,
        blocking_gaps, warnings, predicted_outcome,
        citations, kb_matches, episodic_refs,
        reasoning,
        dossier_state_hash, rules_version, engine_version,
        generated_by
      ) VALUES (
        $1, $2,
        $3, $4, $5,
        $6::jsonb, $7::jsonb, $8::jsonb,
        $9::jsonb, $10::jsonb, $11::jsonb,
        $12,
        $13, $14, $15,
        $16
      )
      ON CONFLICT ON CONSTRAINT uq_ar_dedup DO NOTHING
      RETURNING ${SELECT_COLS}
    `;
    const params = [
      args.claim_id,
      args.target_stage,
      args.readiness_score,
      args.readiness_bucket,
      args.recommended_action,
      JSON.stringify(args.blocking_gaps),
      JSON.stringify(args.warnings),
      args.predicted_outcome === null
        ? null
        : JSON.stringify(args.predicted_outcome),
      JSON.stringify(args.citations),
      JSON.stringify(args.kb_matches),
      JSON.stringify(args.episodic_refs),
      args.reasoning,
      args.dossier_state_hash,
      RULES_VERSION,
      ENGINE_VERSION,
      args.generated_by,
    ];
    const inserted = await this.pool.query<ReportRow>(insertSql, params);
    if ((inserted.rowCount ?? 0) > 0) {
      return rowToReport(inserted.rows[0]!);
    }

    // Conflict — read back the winner.
    const existing = await this.findByHash(
      args.claim_id,
      args.target_stage,
      args.dossier_state_hash,
    );
    if (!existing) {
      throw new Error(
        `adjudicationEngine: conflict swallowed but prior row missing for (${args.claim_id}, ${args.target_stage})`,
      );
    }
    return existing;
  }
}

// ─── Wave 4 enrichment draft ─────────────────────────────────────────────
// Internal scratch shape mutated by enrichWithIntelligence and then
// persisted by insertOrFetch. Not exported — callers see the final
// AdjudicationReport.
interface EnrichmentDraft {
  recommended_action: RecommendedAction;
  predicted_outcome: any | null;
  citations: AdjudicationReport['citations'];
  kb_matches: any[];
  episodic_refs: any[];
  reasoning: string | null;
}

/**
 * Heuristic: do the top-N KB pattern predictions contradict each other?
 * "Contradiction" is defined loosely — we look at the `prediction` shape
 * (per Wave 4A's KbMatchedPattern contract) and flag a contradiction
 * when:
 *   - two patterns predict different `outcome` strings (one says
 *     'approved', another says 'queried'), OR
 *   - two patterns' numeric expected_deduction_pct values differ by
 *     >0.25 absolute.
 * Caller passes only the top patterns to keep this cheap. Used by the
 * "should we fire the ReasoningAgent" heuristic; a false positive just
 * means we burn an extra Sonnet call, a false negative means we silently
 * skip reasoning — we lean toward firing (false positive) since
 * adjudications-per-claim is bounded and Sonnet cost is acceptable.
 */
function detectKbContradiction(matches: KbMatchedPatternLike[]): boolean {
  if (!matches || matches.length < 2) return false;
  const outcomes = new Set<string>();
  const deductions: number[] = [];
  for (const m of matches.slice(0, 5)) {
    const pred: any = m.prediction;
    if (!pred || typeof pred !== 'object') continue;
    if (typeof pred.outcome === 'string') outcomes.add(pred.outcome);
    const dp =
      typeof pred.expected_deduction_pct === 'number'
        ? pred.expected_deduction_pct
        : null;
    if (dp !== null && Number.isFinite(dp)) deductions.push(dp);
  }
  if (outcomes.size >= 2) return true;
  if (deductions.length >= 2) {
    const min = Math.min(...deductions);
    const max = Math.max(...deductions);
    if (max - min > 0.25) return true;
  }
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function collectRuleIds(items: Array<{ rule_id?: string }>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = item?.rule_id;
    if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// ─── Default singleton ───────────────────────────────────────────────────
// Wired to the default pool / dossier service / rules engine / dispatcher.
// Controllers and workers import this directly.
export default new AdjudicationEngine();
