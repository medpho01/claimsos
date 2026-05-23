/**
 * Unit tests for ReasoningAgent — Sprint 4, Wave 4C.
 *
 * Uses node:test. Run with:
 *   npx tsx --test src/Services/__tests__/reasoningAgent.test.ts
 *
 * Approach: ReasoningAgent takes LlmClient + costAccounting + optional
 * summariseDossier as constructor deps, so we inject mocks. No
 * Anthropic SDK, no DB, no Wave 4B import — everything fabricated.
 *
 * Coverage:
 *   - reason() happy path: inputs flow through, output is the validated
 *     ReasoningAgentOutput, costAccounting.recordCall fires once.
 *   - Zod validation failure path: LlmSchemaValidationError surfaces.
 *   - computeReasoningCacheKey: deterministic across calls with same
 *     inputs; differs when any signature changes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ReasoningAgent,
  REASONING_AGENT_VERSION,
  computeReasoningCacheKey,
  __setEpisodicSummariserForTests,
} from '../reasoningAgent.service.js';
import type { LlmClient } from '../llm/LlmClient.js';
import { LlmSchemaValidationError } from '../llm/LlmClient.js';
import type { ClaimDossier } from '../claimDossierProjector.service.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

const CLAIM_ID = '11111111-1111-1111-1111-111111111111';
const HOSPITAL_ID = 'hosp-1';

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
      name: 'Test Patient',
      uhid: 'UHID-1',
      room: 'Twin Sharing',
      primary_diagnosis: 'Acute Appendicitis',
      procedure: 'Laparoscopic Appendectomy',
    },
    amounts: { claimed: 75000 },
    doc_sections_by_category: { discharge_summary: ['sec-1'] },
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

const VALID_OUTPUT = {
  readiness_verdict: 'almost_ready' as const,
  delta_to_rules: { agrees: true, reason: null },
  predicted_outcome: {
    approval_probability: 0.78,
    expected_amount_inr: 68000,
    expected_deduction_pct: 0.09,
    p_query: 0.35,
    expected_deductions: [
      { reason: 'room_rent_cap', amount_inr: 4000, likelihood: 0.7 },
    ],
  },
  recommended_action: 'review' as const,
  reasoning:
    'Rule R-12 flags missing ICP attachment. Episodic case C-883 shows insurers query this panel for ICP 60% of the time on appendectomy.',
  citations: {
    rule_ids: ['R-12'],
    pattern_ids: ['P-1'],
    case_ids: ['C-883'],
  },
  uncertainty_notes: 'Only 2 similar cases retrieved.',
};

interface MockLlm {
  client: LlmClient;
  calls: any[];
  setExtractResult: (r: any) => void;
  setExtractError: (e: any) => void;
}

function makeMockLlm(): MockLlm {
  const calls: any[] = [];
  let queuedResult: any | null = null;
  let queuedError: any | null = null;
  const client: LlmClient = {
    async extract(opts: any): Promise<any> {
      calls.push(opts);
      if (queuedError) throw queuedError;
      if (queuedResult) return queuedResult;
      // default
      return {
        data: VALID_OUTPUT,
        confidence: 1,
        rawResponse: JSON.stringify(VALID_OUTPUT),
        tokensInputUncached: 1800,
        tokensInputCached: 2500,
        tokensOutput: 450,
        latencyMs: 1234,
        provider: 'anthropic',
        model: 'claude-sonnet-4-latest',
        costInr: 0.78,
        tierEscalated: false,
      };
    },
    classify: (async () => {
      throw new Error('classify not used by ReasoningAgent');
    }) as any,
  };
  return {
    client,
    calls,
    setExtractResult: (r) => {
      queuedResult = r;
    },
    setExtractError: (e) => {
      queuedError = e;
    },
  };
}

function makeMockCost(): { recordCall: (...args: any[]) => Promise<void>; calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    async recordCall(input: any) {
      calls.push(input);
    },
  };
}

function makeInput(overrides: any = {}) {
  return {
    claim_id: CLAIM_ID,
    hospital_id: HOSPITAL_ID,
    dossier: makeDossier(),
    target_stage: 'pre_auth',
    rule_evaluation: {
      ready: false,
      readiness_score: 0.65,
      blocking_gaps: [],
      warnings: [
        { rule_id: 'R-12', rule_key: 'icp_required', message: 'ICP attachment missing' },
        { rule_id: 'R-19', rule_key: 'consent_signed', message: 'Consent signature unclear' },
      ],
      info: [],
      scope_resolution: {
        global_rules_applied: 3,
        panel_rules_applied: 1,
        insurer_rules_applied: 0,
        procedure_rules_applied: 1,
        diagnosis_rules_applied: 0,
      },
    },
    kb_matches: [
      {
        id: 'P-1',
        pattern_type: 'tpa_query_propensity',
        title: 'TPA-X queries ICP on appendectomy',
        confidence: 0.82,
        evidence_count: 24,
        prediction: { outcome: 'queried', expected_deduction_pct: 0.1 },
      },
    ],
    episodic_cases: [
      {
        claim_id: 'C-883',
        similarity: 0.91,
        summary: 'Same procedure, same panel, queried for ICP, finally approved after re-file.',
        outcome: { approved_amount_inr: 70000, deducted_inr: 5000, query_raised: true },
      },
    ],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

test('REASONING_AGENT_VERSION is exported as v1', () => {
  assert.equal(REASONING_AGENT_VERSION, 'v1');
});

test('reason(): happy path returns validated output + records cost', async () => {
  // Force the local fallback summariser to avoid Wave 4B import attempts.
  __setEpisodicSummariserForTests(null);

  const llm = makeMockLlm();
  const cost = makeMockCost();
  const agent = new ReasoningAgent({ llm: llm.client, cost: cost as any });

  const res = await agent.reason(makeInput());

  // Output is the parsed VALID_OUTPUT.
  assert.equal(res.output.readiness_verdict, 'almost_ready');
  assert.equal(res.output.predicted_outcome.approval_probability, 0.78);
  assert.equal(res.output.recommended_action, 'review');
  assert.deepEqual(res.output.citations.rule_ids, ['R-12']);
  assert.equal(res.costInr, 0.78);
  assert.equal(res.tierEscalated, false);

  // LLM call shape.
  assert.equal(llm.calls.length, 1);
  const call = llm.calls[0];
  assert.equal(call.tier, 'premium');
  assert.equal(call.promptVersion, 'v1');
  assert.equal(call.taskName, 'reasoning_agent');
  assert.equal(call.claimId, CLAIM_ID);
  assert.equal(call.hospitalId, HOSPITAL_ID);
  assert.equal(typeof call.cacheKey, 'string');
  assert.ok(call.cacheKey.length > 0);
  // Prompt content sanity: the user prompt mentions the target_stage.
  assert.match(call.userPrompt, /TARGET_STAGE: pre_auth/);
  assert.match(call.userPrompt, /=== RULES_ENGINE_RESULT ===/);
  assert.match(call.userPrompt, /=== KB_PATTERN_MATCHES/);
  assert.match(call.userPrompt, /=== EPISODIC_SIMILAR_CASES/);

  // Cost was recorded once.
  assert.equal(cost.calls.length, 1);
  assert.equal(cost.calls[0].claimId, CLAIM_ID);
  assert.equal(cost.calls[0].hospitalId, HOSPITAL_ID);
  assert.equal(cost.calls[0].task, 'reasoning_agent');
  assert.equal(cost.calls[0].promptVersion, 'v1');
  assert.equal(cost.calls[0].succeeded, true);
});

test('reason(): LlmSchemaValidationError propagates from LLM bridge', async () => {
  __setEpisodicSummariserForTests(null);

  const llm = makeMockLlm();
  llm.setExtractError(
    new LlmSchemaValidationError(
      'zod validation failed',
      '{ "broken": true }',
      'reasoning_agent',
      'v1',
    ),
  );
  const cost = makeMockCost();
  const agent = new ReasoningAgent({ llm: llm.client, cost: cost as any });

  await assert.rejects(
    () => agent.reason(makeInput()),
    (err: any) => {
      assert.ok(err instanceof LlmSchemaValidationError);
      assert.equal(err.taskName, 'reasoning_agent');
      assert.equal(err.promptVersion, 'v1');
      return true;
    },
  );

  // Cost is NOT recorded on a propagated error — the wrapper only
  // records on success. The provider's own audit log already captures
  // the failure if needed.
  assert.equal(cost.calls.length, 0);
});

test('computeReasoningCacheKey: deterministic for same inputs', () => {
  const args = {
    rules_signature: 'rules-sig-1',
    kb_signature: 'kb-sig-1',
    episodic_signature: 'epi-sig-1',
    target_stage: 'pre_auth',
  };
  const k1 = computeReasoningCacheKey(args);
  const k2 = computeReasoningCacheKey(args);
  assert.equal(k1, k2);
  assert.equal(typeof k1, 'string');
  assert.equal(k1.length, 64); // sha256 hex
});

test('computeReasoningCacheKey: differs when any signature changes', () => {
  const base = {
    rules_signature: 'rules-sig-1',
    kb_signature: 'kb-sig-1',
    episodic_signature: 'epi-sig-1',
    target_stage: 'pre_auth',
  };
  const k0 = computeReasoningCacheKey(base);
  assert.notEqual(
    k0,
    computeReasoningCacheKey({ ...base, rules_signature: 'rules-sig-2' }),
  );
  assert.notEqual(
    k0,
    computeReasoningCacheKey({ ...base, kb_signature: 'kb-sig-2' }),
  );
  assert.notEqual(
    k0,
    computeReasoningCacheKey({ ...base, episodic_signature: 'epi-sig-2' }),
  );
  assert.notEqual(
    k0,
    computeReasoningCacheKey({ ...base, target_stage: 'final_filing' }),
  );
});

test('reason(): falls back to local summariser when no Wave 4B export', async () => {
  __setEpisodicSummariserForTests(null);

  const llm = makeMockLlm();
  const cost = makeMockCost();
  const agent = new ReasoningAgent({ llm: llm.client, cost: cost as any });

  await agent.reason(makeInput());
  // Sanity: the local builder put a CLAIM_ID line in the prompt.
  assert.match(llm.calls[0].userPrompt, new RegExp(`CLAIM_ID: ${CLAIM_ID}`));
  assert.match(llm.calls[0].userPrompt, /PATIENT:/);
});

test('reason(): uses summariseDossier override when injected', async () => {
  const llm = makeMockLlm();
  const cost = makeMockCost();
  let calledWith: ClaimDossier | null = null;
  const agent = new ReasoningAgent({
    llm: llm.client,
    cost: cost as any,
    summariseDossier: (d) => {
      calledWith = d;
      return 'CUSTOM_SUMMARY_MARKER';
    },
  });

  await agent.reason(makeInput());
  assert.equal(calledWith!.claim_id, CLAIM_ID);
  assert.match(llm.calls[0].userPrompt, /CUSTOM_SUMMARY_MARKER/);
});
