/**
 * Unit tests for the Wave 11 ActionTemplatingService.
 *
 * Runner: node:test (matches the rest of Backend). Execute with:
 *   npx tsx --test src/Services/__tests__/actionTemplating.test.ts
 *
 * Everything mocked: pool + harmonisation service. No DB, no network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActionTemplatingService,
  type ActionTemplate,
} from '../actionTemplating.service.js';
import { render as renderTemplate } from '../rules/templateRenderer.js';

// ─── Mock pool ────────────────────────────────────────────────────────────

interface QueryResponse {
  rows: any[];
  rowCount?: number;
}
interface MockState {
  calls: Array<{ sql: string; params: unknown[] }>;
  handlers: Array<{ match: (sql: string) => boolean; respond: () => QueryResponse }>;
}
function freshState(): MockState {
  return { calls: [], handlers: [] };
}
function makeMockPool(state: MockState) {
  return {
    query: async (sql: string, params: unknown[]): Promise<QueryResponse> => {
      state.calls.push({ sql, params });
      for (const h of state.handlers) if (h.match(sql)) return h.respond();
      return { rows: [], rowCount: 0 };
    },
  };
}

function makeMockHarmonisation(episode: any | null = null) {
  return {
    getEpisode: async () =>
      episode == null
        ? null
        : ({
            claim_id: 'c',
            episode,
            schema_version: '1',
            prompt_version: '1',
            confidence: 1,
            provenance: null,
            dossier_state_hash: 'h',
            cost_inr: 0,
            tokens_used: 0,
            llm_provider: null,
            llm_model: null,
            generated_at: new Date(),
            last_corrected_at: null,
            status: 'fresh',
            error_message: null,
          } as any),
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const CLAIM_ID = '11111111-1111-4111-8111-111111111111';
const HOSPITAL_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_USER_ID = '44444444-4444-4444-8444-444444444444';
const CLINICAL_USER_ID = '55555555-5555-4555-8555-555555555555';
const WHATSAPP_GROUP = '120363111111111111@g.us';

interface PrimeOpts {
  failedRules?: any[];
  withGroup?: boolean;
  withAdmin?: boolean;
  withClinical?: boolean;
  withDossier?: boolean;
}

function prime(state: MockState, opts: PrimeOpts = {}) {
  const failed = opts.failedRules ?? [];
  state.handlers.push({
    match: (sql) => sql.includes('FROM hospital.claim_rule_evaluations'),
    respond: () => ({ rows: failed, rowCount: failed.length }),
  });
  state.handlers.push({
    match: (sql) => sql.includes('FROM hospital.ipds i') && sql.includes('hospital_panels'),
    respond: () => ({
      rows: [
        {
          hospital_id: HOSPITAL_ID,
          whatsapp_group_id: opts.withGroup === false ? null : WHATSAPP_GROUP,
          panel_name: 'Sadbhawana',
        },
      ],
    }),
  });
  state.handlers.push({
    match: (sql) => sql.includes('FROM hospital.hospital_users'),
    respond: () => {
      const rows: any[] = [];
      if (opts.withAdmin !== false) {
        rows.push({ user_id: ADMIN_USER_ID, role: ['admin'] });
      }
      if (opts.withClinical) {
        rows.push({ user_id: CLINICAL_USER_ID, role: ['clinical'] });
      }
      return { rows };
    },
  });
  if (opts.withDossier !== false) {
    state.handlers.push({
      match: (sql) => sql.includes('FROM hospital.ipds i') && sql.includes('claim_dossiers'),
      respond: () => ({
        rows: [
          {
            hospital_id: HOSPITAL_ID,
            ipd_patient_name: 'Ramesh Kumar',
            ipd_uhid: 'UH-9001',
            patient_summary: { primary_procedure: 'CABG' },
            panel_name: 'Sadbhawana',
          },
        ],
      }),
    });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('templateRenderer', () => {
  it('replaces simple placeholders', () => {
    const out = renderTemplate('Hi {{patient_name}} ({{uhid}})', {
      patient_name: 'Asha',
      uhid: 'UH-12',
    });
    assert.equal(out, 'Hi Asha (UH-12)');
  });
  it('joins array values with comma', () => {
    const out = renderTemplate('Need: {{required_docs}}', {
      required_docs: ['discharge_summary', 'ot_notes'],
    });
    assert.equal(out, 'Need: discharge_summary, ot_notes');
  });
  it('formats deduction_amount as INR currency', () => {
    const out = renderTemplate('Risk: {{deduction_amount}}', {
      deduction_amount: 45000,
    });
    assert.ok(out.includes('₹45,000'), `got: ${out}`);
  });
  it('drops unknown placeholders by default', () => {
    const out = renderTemplate('Hello {{missing}}!', {});
    assert.equal(out, 'Hello !');
  });
  it('keeps unknown placeholders when keepMissing=true', () => {
    const out = renderTemplate('Hello {{missing}}!', {}, { keepMissing: true });
    assert.equal(out, 'Hello {{missing}}!');
  });
  it('supports dot paths', () => {
    const out = renderTemplate('{{patient.name}}', { patient: { name: 'A' } });
    assert.equal(out, 'A');
  });
});

describe('ActionTemplatingService.deriveFromRulesEvaluation — severity/impact branches', () => {
  it('CRITICAL severity → approval_request to in_app approver, priority=critical', async () => {
    const state = freshState();
    prime(state, {
      failedRules: [
        {
          rule_evaluation_id: 're1',
          rule_set_id: 'rs1',
          rule_id: 'R-CR-01',
          rule_name: 'Mandatory pre-auth letter missing',
          severity: 'CRITICAL',
          impact: 'CLAIM_REJECTION',
          message: null,
          evidence: null,
          deduction_estimate: null,
          failure_message: 'Pre-auth letter is mandatory for {{patient_name}}',
          remediation_guidance: 'Upload signed pre-auth letter',
          required_documents: ['preauth_letter'],
          estimated_deduction_amount: null,
          query_template: null,
        },
      ],
    });
    const svc = new ActionTemplatingService({
      pool: makeMockPool(state) as any,
      harmonisation: makeMockHarmonisation() as any,
    });
    const tpls = await svc.deriveFromRulesEvaluation(CLAIM_ID);
    assert.equal(tpls.length, 1);
    const t = tpls[0]!;
    assert.equal(t.kind, 'approval_request');
    assert.equal(t.target_kind, 'in_app_user');
    assert.equal(t.target_value, ADMIN_USER_ID);
    assert.equal(t.priority, 'critical');
    assert.match(t.summary, /Ramesh Kumar/);
    assert.equal(t.metadata.source_rule_id, 'R-CR-01');
  });

  it('QUERY + required_documents → whatsapp_group, priority=high', async () => {
    const state = freshState();
    prime(state, {
      failedRules: [
        {
          rule_evaluation_id: 're2',
          rule_set_id: 'rs1',
          rule_id: 'R-Q-01',
          rule_name: 'Discharge summary missing',
          severity: 'HIGH',
          impact: 'QUERY',
          message: null,
          evidence: null,
          deduction_estimate: null,
          failure_message: 'Missing docs',
          remediation_guidance: null,
          required_documents: ['discharge_summary', 'ot_notes'],
          estimated_deduction_amount: null,
          query_template: 'Please share: {{required_docs}} for {{patient_name}}',
        },
      ],
    });
    const svc = new ActionTemplatingService({
      pool: makeMockPool(state) as any,
      harmonisation: makeMockHarmonisation() as any,
    });
    const tpls = await svc.deriveFromRulesEvaluation(CLAIM_ID);
    assert.equal(tpls.length, 1);
    const t = tpls[0]!;
    assert.equal(t.kind, 'request_doc');
    assert.equal(t.target_kind, 'whatsapp_group');
    assert.equal(t.target_value, WHATSAPP_GROUP);
    assert.equal(t.priority, 'high');
    assert.match(t.summary, /discharge_summary, ot_notes/);
    assert.match(t.summary, /Ramesh Kumar/);
    assert.deepEqual(t.metadata.required_documents, ['discharge_summary', 'ot_notes']);
  });

  it('DEDUCTION + estimated_deduction_amount → approval_request, priority=high', async () => {
    const state = freshState();
    prime(state, {
      failedRules: [
        {
          rule_evaluation_id: 're3',
          rule_set_id: 'rs1',
          rule_id: 'R-D-01',
          rule_name: 'Length of stay exceeds benchmark',
          severity: 'HIGH',
          impact: 'DEDUCTION',
          message: null,
          evidence: null,
          deduction_estimate: 30000,
          failure_message: 'LoS exceeds benchmark',
          remediation_guidance: 'Provide clinical justification',
          required_documents: [],
          estimated_deduction_amount: 30000,
          query_template: null,
        },
      ],
    });
    const svc = new ActionTemplatingService({
      pool: makeMockPool(state) as any,
      harmonisation: makeMockHarmonisation() as any,
    });
    const tpls = await svc.deriveFromRulesEvaluation(CLAIM_ID);
    assert.equal(tpls.length, 1);
    const t = tpls[0]!;
    assert.equal(t.kind, 'approval_request');
    assert.equal(t.priority, 'high');
    assert.equal(t.metadata.estimated_deduction_amount, 30000);
  });

  it('WARNING impact → notify_ops in-app, priority=normal', async () => {
    const state = freshState();
    prime(state, {
      failedRules: [
        {
          rule_evaluation_id: 're4',
          rule_set_id: 'rs1',
          rule_id: 'R-W-01',
          rule_name: 'Documentation reminder',
          severity: 'LOW',
          impact: 'WARNING',
          message: null,
          evidence: null,
          deduction_estimate: null,
          failure_message: 'Reminder for {{patient_name}}',
          remediation_guidance: 'Attach OT notes for completeness',
          required_documents: [],
          estimated_deduction_amount: null,
          query_template: null,
        },
      ],
    });
    const svc = new ActionTemplatingService({
      pool: makeMockPool(state) as any,
      harmonisation: makeMockHarmonisation() as any,
    });
    const tpls = await svc.deriveFromRulesEvaluation(CLAIM_ID);
    assert.equal(tpls.length, 1);
    const t = tpls[0]!;
    assert.equal(t.kind, 'notify_ops');
    assert.equal(t.priority, 'normal');
    assert.equal(t.target_kind, 'in_app_user');
  });

  it('returns [] when no failed rule rows exist', async () => {
    const state = freshState();
    prime(state, { failedRules: [] });
    const svc = new ActionTemplatingService({
      pool: makeMockPool(state) as any,
      harmonisation: makeMockHarmonisation() as any,
    });
    const tpls = await svc.deriveFromRulesEvaluation(CLAIM_ID);
    assert.equal(tpls.length, 0);
  });
});

describe('ActionTemplatingService — idempotency_dimensions stability', () => {
  it('idempotency_dimensions are stable across two identical runs', async () => {
    const failedRules = [
      {
        rule_evaluation_id: 're1',
        rule_set_id: 'rs1',
        rule_id: 'R-CR-01',
        rule_name: 'Mandatory check',
        severity: 'CRITICAL',
        impact: 'CLAIM_REJECTION',
        message: null,
        evidence: null,
        deduction_estimate: null,
        failure_message: 'msg',
        remediation_guidance: null,
        required_documents: [],
        estimated_deduction_amount: null,
        query_template: null,
      },
    ];
    const s1 = freshState();
    prime(s1, { failedRules });
    const s2 = freshState();
    prime(s2, { failedRules });
    const svc1 = new ActionTemplatingService({ pool: makeMockPool(s1) as any, harmonisation: makeMockHarmonisation() as any });
    const svc2 = new ActionTemplatingService({ pool: makeMockPool(s2) as any, harmonisation: makeMockHarmonisation() as any });
    const a = (await svc1.deriveFromRulesEvaluation(CLAIM_ID))[0]!;
    const b = (await svc2.deriveFromRulesEvaluation(CLAIM_ID))[0]!;
    assert.deepEqual(a.idempotency_dimensions, b.idempotency_dimensions);
  });
});

describe('ActionTemplatingService.deriveFromAdjudicationReport — fallback path', () => {
  it('produces a notify_ops template when there are no failed rules', async () => {
    const state = freshState();
    prime(state, { failedRules: [] });
    const svc = new ActionTemplatingService({
      pool: makeMockPool(state) as any,
      harmonisation: makeMockHarmonisation() as any,
    });
    const out = await svc.deriveFromAdjudicationReport({
      id: 'r1',
      claim_id: CLAIM_ID,
      readiness: 0.6,
      recommended_action: 'review',
      blocking_gaps: [],
      warnings: [],
      generated_at: '2026-05-18T10:00:00Z',
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, 'notify_ops');
    assert.equal(out[0]!.target_kind, 'in_app_user');
  });

  it('produces a request_doc template per blocking gap', async () => {
    const state = freshState();
    prime(state, { failedRules: [] });
    const svc = new ActionTemplatingService({
      pool: makeMockPool(state) as any,
      harmonisation: makeMockHarmonisation() as any,
    });
    const out = await svc.deriveFromAdjudicationReport({
      id: 'r2',
      claim_id: CLAIM_ID,
      readiness: 0.4,
      recommended_action: 'request_doc',
      blocking_gaps: [
        { id: 'g1', severity: 'blocker', message: 'm1', doc_category: 'discharge' },
        { id: 'g2', severity: 'blocker', message: 'm2', doc_category: 'pre-auth' },
      ],
      warnings: [],
      generated_at: '2026-05-18T10:00:00Z',
    });
    assert.equal(out.length, 2);
    assert.ok(out.every((t: ActionTemplate) => t.kind === 'request_doc'));
    assert.ok(out.every((t: ActionTemplate) => t.target_kind === 'whatsapp_group'));
  });
});
