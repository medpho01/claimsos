// =============================================================================
// M3 — rules engine golden tests (pure; host-runnable).
// Run: cd Backend && npx tsx --test src/Services/rules/__tests__/rules.test.ts
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { levenshtein, nameTokens, tokenSetRatio } from '../text.js';
import { evaluateRule, evaluateRules, summarizeReadiness } from '../engine.js';
import { selectRuleSet, scoreRuleSet } from '../selection.js';
import type { Rule, RuleContext } from '../types.js';
import type { RuleSetMeta } from '../selection.js';

const baseCtx = (over: Partial<RuleContext>): RuleContext => ({
  stage: 'discharge_submitted',
  presentCategories: [],
  fieldsByCategory: {},
  names: [],
  datedDocs: [],
  anchors: { admission: null, discharge: null },
  ...over,
});
const rule = (over: Partial<Rule>): Rule => ({
  ruleId: 'r', kind: 'DOCUMENT_PRESENCE', params: {}, severity: 'HIGH', impact: 'QUERY', ...over,
});

describe('text utils', () => {
  it('strips honorifics + punctuation in tokens', () => {
    assert.deepEqual(nameTokens('Dr. Bhuri Ahmad'), ['bhuri', 'ahmad']);
  });
  it('levenshtein basics', () => {
    assert.equal(levenshtein('abc', 'abc'), 0);
    assert.equal(levenshtein('bhuri', 'bhari'), 1);
  });
  it('tokenSetRatio = 1 when one name is a subset of the other (missing surname)', () => {
    assert.equal(tokenSetRatio('Bhuri', 'Bhuri Ahmad'), 1);
  });
});

describe('DOCUMENT_PRESENCE', () => {
  const r = rule({ kind: 'DOCUMENT_PRESENCE', params: { requiredCategories: ['discharge_summary', 'final_bill'] } });
  it('PASS when all required present', () => {
    const res = evaluateRule(r, baseCtx({ presentCategories: ['discharge_summary', 'final_bill', 'ot_notes'] }));
    assert.equal(res.status, 'PASS');
  });
  it('FAIL with the missing list as evidence', () => {
    const res = evaluateRule(r, baseCtx({ presentCategories: ['discharge_summary'] }));
    assert.equal(res.status, 'FAIL');
    assert.deepEqual((res.evidence as any).missing, ['final_bill']);
  });
  it('treats an array entry as an OR-group (any member satisfies it)', () => {
    const og = rule({ kind: 'DOCUMENT_PRESENCE', params: { requiredCategories: [['aadhaar_front', 'aadhaar_card'], 'pmjay_card'] } });
    assert.equal(evaluateRule(og, baseCtx({ presentCategories: ['aadhaar_card', 'pmjay_card'] })).status, 'PASS');
    const res2 = evaluateRule(og, baseCtx({ presentCategories: ['pmjay_card'] }));
    assert.equal(res2.status, 'FAIL');
    assert.deepEqual((res2.evidence as any).missing, ['aadhaar_front|aadhaar_card']);
  });
});

describe('REQUIRED_FIELDS', () => {
  const r = rule({ kind: 'REQUIRED_FIELDS', params: { category: 'preauth_form', fields: ['admission_date', 'treating_doctor'] } });
  it('FAIL when a field is blank', () => {
    const res = evaluateRule(r, baseCtx({ fieldsByCategory: { preauth_form: { admission_date: '', treating_doctor: 'Dr X' } } }));
    assert.equal(res.status, 'FAIL');
    assert.deepEqual((res.evidence as any).missing, ['admission_date']);
  });
  it('PASS when all present', () => {
    const res = evaluateRule(r, baseCtx({ fieldsByCategory: { preauth_form: { admission_date: '2026-02-16', treating_doctor: 'Dr X' } } }));
    assert.equal(res.status, 'PASS');
  });
});

describe('FUZZY_NAME ladder', () => {
  const r = rule({ kind: 'FUZZY_NAME', params: {}, severity: 'CRITICAL', impact: 'CLAIM_REJECTION' });
  it('PASS exact across docs', () => {
    const res = evaluateRule(r, baseCtx({ names: [
      { value: 'Bhuri Ahmad', sourceDocType: 'aadhaar' },
      { value: 'Bhuri Ahmad', sourceDocType: 'prescription' },
    ] }));
    assert.equal(res.status, 'PASS');
    assert.equal(res.confidence, 1);
  });
  it('PASS (subset) when a surname is missing — NOT flagged as different person', () => {
    const res = evaluateRule(r, baseCtx({ names: [
      { value: 'Bhuri', sourceDocType: 'aadhaar' },
      { value: 'Bhuri Ahmad', sourceDocType: 'prescription' },
    ] }));
    assert.equal(res.status, 'PASS');
  });
  it('PASS+warn on a 1–2 char mismatch (degree surfaced)', () => {
    const res = evaluateRule(r, baseCtx({ names: [
      { value: 'Bhuri Ahmad', sourceDocType: 'aadhaar' },
      { value: 'Bhari Ahmad', sourceDocType: 'prescription' },
    ] }));
    assert.equal(res.status, 'PASS');
    assert.equal((res.evidence as any).edit_distance, 1);
    assert.ok(res.confidence < 1);
  });
  it('FAIL (likely different person) on a large low-overlap mismatch', () => {
    const res = evaluateRule(r, baseCtx({ names: [
      { value: 'Bhuri Ahmad', sourceDocType: 'aadhaar' },
      { value: 'Rajesh Kumar', sourceDocType: 'prescription' },
    ] }));
    assert.equal(res.status, 'FAIL');
  });
  it('SKIP with <2 names', () => {
    assert.equal(evaluateRule(r, baseCtx({ names: [{ value: 'Solo', sourceDocType: 'aadhaar' }] })).status, 'SKIP');
  });
});

describe('TEMPORAL_WINDOW (diagnostics 1 day prior to discharge)', () => {
  const r = rule({ kind: 'TEMPORAL_WINDOW', params: { docType: 'investigation', relativeTo: 'discharge', withinDays: 1, direction: 'before' } });
  const anchors = { admission: '2026-02-10T00:00:00Z', discharge: '2026-02-16T00:00:00Z' };
  it('PASS when an investigation is dated the day before discharge', () => {
    const res = evaluateRule(r, baseCtx({ anchors, datedDocs: [{ docType: 'investigation', date: '2026-02-15T09:00:00Z' }] }));
    assert.equal(res.status, 'PASS');
  });
  it('FAIL when the only investigation is a week old', () => {
    const res = evaluateRule(r, baseCtx({ anchors, datedDocs: [{ docType: 'investigation', date: '2026-02-09T09:00:00Z' }] }));
    assert.equal(res.status, 'FAIL');
  });
  it('SKIP when there is no discharge anchor', () => {
    const res = evaluateRule(r, baseCtx({ anchors: { admission: null, discharge: null }, datedDocs: [{ docType: 'investigation', date: '2026-02-15' }] }));
    assert.equal(res.status, 'SKIP');
  });
});

describe('OD4 abstention gate', () => {
  it('forces SKIP when confidence < min_confidence', () => {
    const r = rule({ kind: 'FUZZY_NAME', params: {}, minConfidence: 0.8 });
    const res = evaluateRule(r, baseCtx({ names: [
      { value: 'Bhuri Ahmad', sourceDocType: 'aadhaar' },
      { value: 'Bhari Ahmad', sourceDocType: 'prescription' }, // PASS@0.7 → abstain
    ] }));
    assert.equal(res.status, 'SKIP');
  });
});

describe('readiness summary', () => {
  it('penalizes by severity and buckets blocking vs warnings', () => {
    const results = evaluateRules(
      [
        rule({ ruleId: 'docs', kind: 'DOCUMENT_PRESENCE', params: { requiredCategories: ['final_bill'] }, severity: 'CRITICAL' }),
        rule({ ruleId: 'fields', kind: 'REQUIRED_FIELDS', params: { category: 'x', fields: ['a'] }, severity: 'LOW' }),
      ],
      baseCtx({ presentCategories: [], fieldsByCategory: {} }),
    );
    const s = summarizeReadiness(results);
    assert.equal(s.score, 100 - 25 - 2);
    assert.deepEqual(s.blocking, ['docs']);
    assert.deepEqual(s.warnings, ['fields']);
  });
});

describe('rule-set selection (most-specific-wins)', () => {
  const mk = (over: Partial<RuleSetMeta>): RuleSetMeta => ({
    id: over.ruleSetId ?? 'x', ruleSetId: over.ruleSetId ?? 'x', status: 'live', insurerCode: null,
    schemes: [], routes: [], stages: [], caseTypes: [], treatments: [], specialties: [], ...over,
  });
  const ctx = { scheme: 'PMJAY', route: 'network', insurer: 'PMJAY', stage: 'discharge_submitted', caseType: 'SURGICAL' };
  it('prefers a stage+scheme+case_type pack over a generic one', () => {
    const generic = mk({ ruleSetId: 'generic' });
    const specific = mk({ ruleSetId: 'pmjay_surg_discharge', schemes: ['PMJAY'], stages: ['discharge_submitted'], caseTypes: ['SURGICAL'] });
    assert.equal(selectRuleSet([generic, specific], ctx)?.ruleSetId, 'pmjay_surg_discharge');
    assert.ok(scoreRuleSet(specific, ctx) > scoreRuleSet(generic, ctx));
  });
  it('excludes a rule set whose stage does not match', () => {
    const preauthOnly = mk({ ruleSetId: 'preauth', stages: ['preauth_submitted'] });
    assert.equal(selectRuleSet([preauthOnly], ctx), null);
  });
  it('ignores draft rule sets', () => {
    const draft = mk({ ruleSetId: 'd', status: 'draft', schemes: ['PMJAY'] });
    assert.equal(selectRuleSet([draft], ctx), null);
  });
});
