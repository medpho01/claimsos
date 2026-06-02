// =============================================================================
// M6 — LLM_COHERENCE semantic evaluator tests (mock LLM client; host-runnable).
// Run: cd Backend && npx tsx --test src/Services/rules/__tests__/semantic.test.ts
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSemanticRule, type SemanticContext } from '../semantic.js';
import type { LlmClient } from '../../llm/LlmClient.js';
import type { Rule } from '../types.js';

function mockLlm(coheres: boolean, confidence: number, reasoning = 'mock'): LlmClient {
  return {
    async extract(_opts: any) {
      return {
        data: { coheres, confidence, reasoning },
        confidence,
        rawResponse: '',
        tokensInputUncached: 10,
        tokensInputCached: 0,
        tokensOutput: 5,
        latencyMs: 1,
        provider: 'mock',
        model: 'mock',
        costInr: 0.01,
        tierEscalated: false,
      } as any;
    },
    async classify() {
      throw new Error('classify not used');
    },
  };
}

function visionLlm(present: boolean, confidence: number, reasoning = 'mock'): LlmClient {
  return {
    async extract(_opts: any) {
      return {
        data: { present, confidence, reasoning },
        confidence,
        rawResponse: '',
        tokensInputUncached: 10,
        tokensInputCached: 0,
        tokensOutput: 5,
        latencyMs: 1,
        provider: 'mock',
        model: 'mock',
        costInr: 0.02,
        tierEscalated: false,
      } as any;
    },
    async classify() {
      throw new Error('classify not used');
    },
  };
}
const fetchImage = async (_key: string) => Buffer.from('fake-image-bytes');

const recordCall = async () => {};
const sctx: SemanticContext = { fieldsByCategory: { opd_notes: { notes: 'fever; prescribed paracetamol' } }, episode: { diagnosis: { primary_diagnosis: { diagnosis_name: 'viral fever' } } } };
const rule = (over: Partial<Rule> = {}): Rule => ({
  ruleId: 'COH',
  kind: 'LLM_COHERENCE',
  params: { question: 'consistent?', sources: [{ label: 'rx', fromCategory: 'opd_notes' }, { label: 'dx', fromEpisodePath: 'diagnosis.primary_diagnosis.diagnosis_name' }] },
  severity: 'MEDIUM',
  impact: 'QUERY',
  ...over,
});

describe('LLM_COHERENCE evaluator (mocked)', () => {
  it('PASS when the model says it coheres', async () => {
    const r = await evaluateSemanticRule(rule(), sctx, { llm: mockLlm(true, 0.9), recordCall });
    assert.equal(r.status, 'PASS');
    assert.equal((r.evidence as any).coheres, true);
  });
  it('FAIL when the model finds an inconsistency', async () => {
    const r = await evaluateSemanticRule(rule(), sctx, { llm: mockLlm(false, 0.9), recordCall });
    assert.equal(r.status, 'FAIL');
  });
  it('SKIP (abstain) when confidence < min_confidence (OD4)', async () => {
    const r = await evaluateSemanticRule(rule({ minConfidence: 0.8 }), sctx, { llm: mockLlm(true, 0.5), recordCall });
    assert.equal(r.status, 'SKIP');
  });
  it('SKIP when no source content is available', async () => {
    const r = await evaluateSemanticRule(
      rule({ params: { question: 'q', sources: [{ label: 'x', fromCategory: 'missing_cat' }] } }),
      { fieldsByCategory: {}, episode: {} },
      { llm: mockLlm(true, 0.9), recordCall },
    );
    assert.equal(r.status, 'SKIP');
  });
  it('EVIDENCE_CHECK → SKIP when no image of that category is present', async () => {
    const r = await evaluateSemanticRule(
      rule({ kind: 'EVIDENCE_CHECK', params: { category: 'gps_tagged_patient_photos', assertion: 'doctor and patient visible' } }),
      sctx,
      { llm: visionLlm(true, 0.9), fetchImage, recordCall },
    );
    assert.equal(r.status, 'SKIP');
  });
  it('EVIDENCE_CHECK → PASS when vision says the evidence is present', async () => {
    const r = await evaluateSemanticRule(
      rule({ kind: 'EVIDENCE_CHECK', params: { category: 'gps_tagged_patient_photos', assertion: 'doctor and patient visible' } }),
      { ...sctx, imagesByCategory: { gps_tagged_patient_photos: [{ s3Key: 'k1', mime: 'image/jpeg' }] } },
      { llm: visionLlm(true, 0.9), fetchImage, recordCall },
    );
    assert.equal(r.status, 'PASS');
    assert.equal((r.evidence as any).present, true);
  });
  it('EVIDENCE_CHECK → FAIL when vision says not visible', async () => {
    const r = await evaluateSemanticRule(
      rule({ kind: 'EVIDENCE_CHECK', params: { category: 'gps_tagged_patient_photos', assertion: 'scar visible at surgery site' } }),
      { ...sctx, imagesByCategory: { gps_tagged_patient_photos: [{ s3Key: 'k1', mime: 'image/jpeg' }] } },
      { llm: visionLlm(false, 0.9), fetchImage, recordCall },
    );
    assert.equal(r.status, 'FAIL');
  });
});
