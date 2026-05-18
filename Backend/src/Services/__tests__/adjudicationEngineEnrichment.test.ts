/**
 * Unit tests for AdjudicationEngine.enrichWithIntelligence — Wave 4C.
 *
 * The Wave 3B adjudicationEngine.test.ts file is owned by an earlier wave
 * and we must NOT modify it. This file covers the new Wave 4 enrichment
 * path: KB pattern matcher injection, episodic memory injection, the
 * ReasoningAgent heuristic, the env kill switch, and graceful no-op
 * behaviour when deps are null.
 *
 * Run with:
 *   npx tsx --test src/Services/__tests__/adjudicationEngineEnrichment.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AdjudicationEngine,
  __resetIntelligenceCacheForTests,
  type DossierServiceLike,
  type EventDispatcherLike,
  type RulesEngineLike,
  type KbPatternMatcherLike,
  type EpisodicMemoryLike,
  type ReasoningAgentLike,
} from '../adjudicationEngine.service.js';
import type { ClaimDossier } from '../claimDossierProjector.service.js';

const CLAIM_ID = '22222222-2222-2222-2222-222222222222';

// ─── Reusable stubs (lifted from adjudicationEngine.test.ts pattern) ─────

function makeDossier(overrides: Partial<ClaimDossier> = {}): ClaimDossier {
  return {
    claim_id: CLAIM_ID,
    last_event_id: null,
    last_event_at: null,
    version: 0,
    current_stage: 'admitted',
    current_panel_id: 'panel-1',
    current_insurer_id: 'insurer-1',
    patient_summary: {
      procedure: 'Lap Chole',
      primary_diagnosis: 'Cholelithiasis',
    } as any,
    amounts: null,
    doc_sections_by_category: { discharge_summary: ['s-1'] },
    doc_sufficiency_per_stage: null,
    events_summary: [],
    inbound_emails: [],
    outbound_submissions: [],
    active_queries: [],
    pending_actions: [],
    active_adjudication: null,
    ai_drafts_pending: [],
    matched_kb_patterns: [],
    case_embedding_state: null,
    closed_at: null,
    closure_outcome: null,
    retrospective_summary: null,
    updated_at: new Date(0),
    ...overrides,
  };
}

function makePoolStub() {
  let lastInsertParams: any[] | null = null;
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      // Cache probe — return empty so we always go through the insert.
      if (
        /FROM hospital\.adjudication_reports/.test(sql) &&
        /AND dossier_state_hash = /.test(sql)
      ) {
        return { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO hospital\.adjudication_reports/.test(sql)) {
        lastInsertParams = params;
        // The insert RETURNs the new row. We synthesise from the params
        // so downstream assertions read the merged enrichment.
        return {
          rowCount: 1,
          rows: [
            {
              id: 'report-x',
              claim_id: params[0],
              target_stage: params[1],
              readiness_score: params[2],
              readiness_bucket: params[3],
              recommended_action: params[4],
              blocking_gaps: JSON.parse(params[5]),
              warnings: JSON.parse(params[6]),
              predicted_outcome: params[7] ? JSON.parse(params[7]) : null,
              citations: JSON.parse(params[8]),
              kb_matches: JSON.parse(params[9]),
              episodic_refs: JSON.parse(params[10]),
              reasoning: params[11],
              generated_at: new Date(),
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  return {
    pool,
    getLastInsertParams: () => lastInsertParams,
  };
}

function makeDossierStub(d: ClaimDossier | null): DossierServiceLike {
  return {
    async getDossier() {
      return d;
    },
  } as any;
}

function makeRulesStub(opts: {
  score: number;
  warnings?: any[];
  blocking_gaps?: any[];
}): RulesEngineLike {
  return {
    async evaluate() {
      return {
        ready: opts.score >= 0.8,
        readiness_score: opts.score,
        blocking_gaps: opts.blocking_gaps ?? [],
        warnings: opts.warnings ?? [],
        info: [],
      };
    },
  } as any;
}

function makeDispatcherStub(): EventDispatcherLike {
  return {
    async dispatch() {
      return { id: 'evt-x', deduped: false };
    },
  } as any;
}

interface KbStubReturn {
  matcher: KbPatternMatcherLike;
  callCount: () => number;
}
function makeKbStub(matches: any[]): KbStubReturn {
  let calls = 0;
  return {
    matcher: {
      async match() {
        calls += 1;
        return matches as any;
      },
    },
    callCount: () => calls,
  };
}

interface EpStubReturn {
  em: EpisodicMemoryLike;
  callCount: () => number;
}
function makeEpStub(cases: any[]): EpStubReturn {
  let calls = 0;
  return {
    em: {
      async retrieve() {
        calls += 1;
        return cases as any;
      },
    },
    callCount: () => calls,
  };
}

interface ReasonStubReturn {
  agent: ReasoningAgentLike;
  callCount: () => number;
  lastInput: () => any;
}
function makeReasoningStub(out: any): ReasonStubReturn {
  let calls = 0;
  let last: any = null;
  return {
    agent: {
      async reason(input) {
        calls += 1;
        last = input;
        return {
          output: out,
          costInr: 0.8,
          tierEscalated: false,
        };
      },
    },
    callCount: () => calls,
    lastInput: () => last,
  };
}

function defaultAgentOutput(overrides: any = {}) {
  return {
    readiness_verdict: 'almost_ready',
    delta_to_rules: { agrees: true, reason: null },
    predicted_outcome: {
      approval_probability: 0.7,
      expected_amount_inr: 50000,
      expected_deduction_pct: 0.1,
      p_query: 0.4,
      expected_deductions: [],
    },
    recommended_action: 'review',
    reasoning: 'Default reasoning text from stub.',
    citations: {
      rule_ids: ['R-extra'],
      pattern_ids: ['P-X'],
      case_ids: ['C-extra'],
    },
    uncertainty_notes: null,
    ...overrides,
  };
}

// Make sure each test starts with a clean intelligence-cache.
test.beforeEach(() => {
  __resetIntelligenceCacheForTests();
  delete process.env.INTELLIGENCE_ENRICHMENT;
});

// ─── Heuristic: NOT fire reasoning ───────────────────────────────────────

test('enrich: low warnings + no contradicting kb → reasoning NOT called', async () => {
  const dossier = makeDossier();
  const { pool, getLastInsertParams } = makePoolStub();
  const rules = makeRulesStub({ score: 0.9, warnings: [{ rule_id: 'R-1' }] });
  const kb = makeKbStub([
    { id: 'P-1', confidence: 0.7, prediction: { outcome: 'approved' } },
  ]);
  const ep = makeEpStub([{ claim_id: 'C-1', similarity: 0.9 }]);
  const rs = makeReasoningStub(defaultAgentOutput());

  const engine = new AdjudicationEngine(
    pool as any,
    makeDossierStub(dossier),
    rules,
    makeDispatcherStub(),
    { kbMatcher: kb.matcher, episodicMemory: ep.em, reasoningAgent: rs.agent },
  );

  await engine.run({ claim_id: CLAIM_ID });

  assert.equal(kb.callCount(), 1, 'kb matcher should fire');
  assert.equal(ep.callCount(), 1, 'episodic should fire');
  assert.equal(rs.callCount(), 0, 'reasoning should NOT fire');

  // The persisted row should still carry kb_matches + episodic_refs +
  // their citations, but no predicted_outcome / reasoning.
  const params = getLastInsertParams();
  assert.ok(params);
  const citations = JSON.parse(params![8] as string);
  assert.deepEqual(citations.pattern_ids, ['P-1']);
  assert.deepEqual(citations.case_ids, ['C-1']);
  assert.equal(params![7], null, 'predicted_outcome should be null');
  assert.equal(params![11], null, 'reasoning should be null');
});

// ─── Heuristic: 2+ warnings → fire ───────────────────────────────────────

test('enrich: 2+ warnings → reasoning IS called and merges output', async () => {
  const dossier = makeDossier();
  const { pool, getLastInsertParams } = makePoolStub();
  const rules = makeRulesStub({
    score: 0.7,
    warnings: [{ rule_id: 'R-A' }, { rule_id: 'R-B' }],
  });
  const kb = makeKbStub([{ id: 'P-1', confidence: 0.6, prediction: {} }]);
  const ep = makeEpStub([{ claim_id: 'C-1', similarity: 0.8 }]);
  const rs = makeReasoningStub(
    defaultAgentOutput({
      recommended_action: 'request_doc', // different from rules-derived
      uncertainty_notes: 'limited prior cases',
    }),
  );

  const engine = new AdjudicationEngine(
    pool as any,
    makeDossierStub(dossier),
    rules,
    makeDispatcherStub(),
    { kbMatcher: kb.matcher, episodicMemory: ep.em, reasoningAgent: rs.agent },
  );

  await engine.run({ claim_id: CLAIM_ID });

  assert.equal(rs.callCount(), 1, 'reasoning should fire');

  // ReasoningAgent received the kb and episodic results.
  const input = rs.lastInput();
  assert.equal(input.kb_matches.length, 1);
  assert.equal(input.episodic_cases.length, 1);
  assert.equal(input.target_stage, 'pre_auth');

  // Persisted row carries the reasoning output.
  const params = getLastInsertParams();
  assert.equal(params![4], 'request_doc', 'recommended_action overridden');
  const predicted = JSON.parse(params![7] as string);
  assert.equal(predicted.approval_probability, 0.7);
  // Reasoning text contains override note + uncertainty.
  assert.match(params![11] as string, /override/i);
  assert.match(params![11] as string, /Uncertainty:/i);
  // Citations include the agent's additions.
  const citations = JSON.parse(params![8] as string);
  assert.ok(citations.pattern_ids.includes('P-1'));
  assert.ok(citations.pattern_ids.includes('P-X'));
  assert.ok(citations.case_ids.includes('C-extra'));
});

// ─── Heuristic: 3 kb_matches with contradiction → fire ───────────────────

test('enrich: 3 kb_matches with contradiction → reasoning IS called', async () => {
  const dossier = makeDossier();
  const { pool } = makePoolStub();
  const rules = makeRulesStub({ score: 0.9, warnings: [] });
  // Three matches; outcomes disagree (approved vs queried) — should
  // trigger the contradiction branch.
  const kb = makeKbStub([
    { id: 'P-1', confidence: 0.8, prediction: { outcome: 'approved' } },
    { id: 'P-2', confidence: 0.7, prediction: { outcome: 'queried' } },
    { id: 'P-3', confidence: 0.6, prediction: { outcome: 'approved' } },
  ]);
  const ep = makeEpStub([]);
  const rs = makeReasoningStub(defaultAgentOutput());

  const engine = new AdjudicationEngine(
    pool as any,
    makeDossierStub(dossier),
    rules,
    makeDispatcherStub(),
    { kbMatcher: kb.matcher, episodicMemory: ep.em, reasoningAgent: rs.agent },
  );

  await engine.run({ claim_id: CLAIM_ID });
  assert.equal(rs.callCount(), 1, 'contradicting kb fires reasoning');
});

// ─── Heuristic: 3 kb_matches WITHOUT contradiction → do not fire ─────────

test('enrich: 3 kb_matches with agreeing predictions → reasoning NOT fired', async () => {
  const dossier = makeDossier();
  const { pool } = makePoolStub();
  const rules = makeRulesStub({ score: 0.9, warnings: [] });
  const kb = makeKbStub([
    { id: 'P-1', confidence: 0.8, prediction: { outcome: 'approved' } },
    { id: 'P-2', confidence: 0.7, prediction: { outcome: 'approved' } },
    { id: 'P-3', confidence: 0.6, prediction: { outcome: 'approved' } },
  ]);
  const ep = makeEpStub([]);
  const rs = makeReasoningStub(defaultAgentOutput());

  const engine = new AdjudicationEngine(
    pool as any,
    makeDossierStub(dossier),
    rules,
    makeDispatcherStub(),
    { kbMatcher: kb.matcher, episodicMemory: ep.em, reasoningAgent: rs.agent },
  );

  await engine.run({ claim_id: CLAIM_ID });
  assert.equal(rs.callCount(), 0, 'agreeing kb does not fire reasoning');
});

// ─── Heuristic: explicit useReasoning override ───────────────────────────

test('enrich: input.useReasoning=true forces reasoning even with no warnings', async () => {
  const dossier = makeDossier();
  const { pool } = makePoolStub();
  const rules = makeRulesStub({ score: 0.95, warnings: [] });
  const kb = makeKbStub([]);
  const ep = makeEpStub([]);
  const rs = makeReasoningStub(defaultAgentOutput());

  const engine = new AdjudicationEngine(
    pool as any,
    makeDossierStub(dossier),
    rules,
    makeDispatcherStub(),
    { kbMatcher: kb.matcher, episodicMemory: ep.em, reasoningAgent: rs.agent },
  );

  await engine.run({ claim_id: CLAIM_ID, useReasoning: true });
  assert.equal(rs.callCount(), 1, 'useReasoning=true overrides heuristic');
});

// ─── Env kill switch ─────────────────────────────────────────────────────

test('enrich: INTELLIGENCE_ENRICHMENT=off skips enrichment entirely', async () => {
  process.env.INTELLIGENCE_ENRICHMENT = 'off';

  const dossier = makeDossier();
  const { pool, getLastInsertParams } = makePoolStub();
  const rules = makeRulesStub({
    score: 0.5,
    warnings: [{ rule_id: 'R-A' }, { rule_id: 'R-B' }],
  });
  const kb = makeKbStub([{ id: 'P-1', confidence: 0.7, prediction: {} }]);
  const ep = makeEpStub([{ claim_id: 'C-1', similarity: 0.9 }]);
  const rs = makeReasoningStub(defaultAgentOutput());

  const engine = new AdjudicationEngine(
    pool as any,
    makeDossierStub(dossier),
    rules,
    makeDispatcherStub(),
    { kbMatcher: kb.matcher, episodicMemory: ep.em, reasoningAgent: rs.agent },
  );

  await engine.run({ claim_id: CLAIM_ID });

  // None of the intelligence deps were touched.
  assert.equal(kb.callCount(), 0);
  assert.equal(ep.callCount(), 0);
  assert.equal(rs.callCount(), 0);

  // The persisted row carries v0-shape stubs.
  const params = getLastInsertParams();
  assert.deepEqual(JSON.parse(params![9] as string), []); // kb_matches
  assert.deepEqual(JSON.parse(params![10] as string), []); // episodic_refs
  assert.equal(params![7], null); // predicted_outcome
  assert.equal(params![11], null); // reasoning
});

// ─── Graceful no-op: null deps simulate missing sibling modules ──────────

test('enrich: null kb/episodic/reasoning deps no-op gracefully (v0-shape report still written)', async () => {
  const dossier = makeDossier();
  const { pool, getLastInsertParams } = makePoolStub();
  const rules = makeRulesStub({
    score: 0.6,
    warnings: [{ rule_id: 'R-A' }, { rule_id: 'R-B' }],
  });

  const engine = new AdjudicationEngine(
    pool as any,
    makeDossierStub(dossier),
    rules,
    makeDispatcherStub(),
    // Inject null for every intelligence dep — same as if the sibling
    // modules failed to import.
    { kbMatcher: null, episodicMemory: null, reasoningAgent: null },
  );

  // Should not throw.
  await engine.run({ claim_id: CLAIM_ID });

  const params = getLastInsertParams();
  assert.ok(params, 'report still persisted');
  assert.deepEqual(JSON.parse(params![9] as string), []);
  assert.deepEqual(JSON.parse(params![10] as string), []);
  assert.equal(params![7], null);
  assert.equal(params![11], null);
  // The rules-derived recommended_action survives (0.6 score → almost,
  // 2 warnings → review).
  assert.equal(params![4], 'review');
});

// ─── Graceful no-op: reasoning throws but kb/episodic still recorded ─────

test('enrich: reasoning throws → kb/episodic still recorded, predicted_outcome null', async () => {
  const dossier = makeDossier();
  const { pool, getLastInsertParams } = makePoolStub();
  const rules = makeRulesStub({
    score: 0.6,
    warnings: [{ rule_id: 'R-A' }, { rule_id: 'R-B' }],
  });
  const kb = makeKbStub([{ id: 'P-1', confidence: 0.7, prediction: {} }]);
  const ep = makeEpStub([{ claim_id: 'C-1', similarity: 0.9 }]);
  const failingAgent: ReasoningAgentLike = {
    async reason() {
      throw new Error('sonnet outage');
    },
  };

  const engine = new AdjudicationEngine(
    pool as any,
    makeDossierStub(dossier),
    rules,
    makeDispatcherStub(),
    { kbMatcher: kb.matcher, episodicMemory: ep.em, reasoningAgent: failingAgent },
  );

  await engine.run({ claim_id: CLAIM_ID });

  const params = getLastInsertParams();
  // KB / episodic survived.
  assert.equal(JSON.parse(params![9] as string).length, 1);
  assert.equal(JSON.parse(params![10] as string).length, 1);
  const citations = JSON.parse(params![8] as string);
  assert.deepEqual(citations.pattern_ids, ['P-1']);
  assert.deepEqual(citations.case_ids, ['C-1']);
  // Reasoning failed → predicted_outcome stays null, reasoning null.
  assert.equal(params![7], null);
  assert.equal(params![11], null);
});
