// =============================================================================
// M1 — Auto-Context Resolver golden tests (Pillar A: pure-function harness).
// Run:  cd Backend && npx tsx --test src/Services/context/__tests__/resolver.test.ts
// No heavy imports -> runs on host despite incomplete node_modules.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveContext, docMixStageClass, stageClass, isIpdStage } from '../resolver.js';
import type { ResolveContextInput } from '../types.js';

const base = (over: Partial<ResolveContextInput>): ResolveContextInput => ({
  claimId: 'claim-1',
  ipd: {},
  ...over,
});

describe('helpers', () => {
  it('classifies stages by prefix', () => {
    assert.equal(stageClass('preauth_submitted'), 'preauth');
    assert.equal(stageClass('enhancements_queried'), 'enhancement');
    assert.equal(stageClass('discharge_submitted'), 'discharge');
    assert.equal(stageClass('discharged'), 'discharge');
    assert.equal(stageClass('claim_filed'), 'claim');
    assert.equal(stageClass('admitted'), 'other');
    assert.equal(stageClass(null), 'other');
  });

  it('maps doc categories to a coarse stage class (discharge wins)', () => {
    assert.equal(docMixStageClass(['doctor_prescription', 'preauth_form']), 'preauth');
    assert.equal(docMixStageClass(['discharge_summary', 'doctor_prescription']), 'discharge');
    assert.equal(docMixStageClass(['random']), null);
  });

  it('validates stage codes against the frozen vocabulary', () => {
    assert.ok(isIpdStage('discharge_submitted'));
    assert.ok(!isIpdStage('made_up_stage'));
    assert.ok(!isIpdStage(null));
  });
});

describe('PMJAY surgical discharge', () => {
  const ctx = resolveContext(base({
    claimId: 'pmjay-surg',
    ipd: { stage: 'discharge_submitted', claim_filing_route: 'network', panel_id: 'panel-pmjay' },
    panel: { id: 'panel-pmjay', code: 'PMJAY' },
    isEmpanelled: true,
    dossier: { doc_sections_by_category: { discharge_summary: ['s1'], ot_notes: ['s2'], final_bill: ['s3'] } },
    episode: { meta: { episode_type: 'SURGICAL' }, clinical_timeline: [{ procedures_performed: [{}] }] },
  }));

  it('resolves scheme=PMJAY from record (high confidence)', () => {
    assert.equal(ctx.scheme.value, 'PMJAY');
    assert.equal(ctx.scheme.source, 'record');
    assert.ok(ctx.scheme.confidence >= 0.9);
  });
  it('resolves route from the record', () => {
    assert.equal(ctx.route.value, 'network');
    assert.equal(ctx.route.source, 'record');
  });
  it('populates insurer from ipds.panel_id (was always null before M1)', () => {
    assert.equal(ctx.insurerPanelId.value, 'panel-pmjay');
    assert.equal(ctx.insurerPanelId.source, 'record');
  });
  it('uses the record stage and the doc mix agrees', () => {
    assert.equal(ctx.stage.value, 'discharge_submitted');
    assert.equal(ctx.stage.source, 'record');
    assert.equal(ctx.stage.crosscheck?.agrees, true);
    assert.ok(!ctx.flags.includes('stage_docmix_mismatch'));
  });
  it('derives case_type SURGICAL', () => {
    assert.equal(ctx.caseType.value, 'SURGICAL');
  });
});

describe('PMJAY conservative discharge', () => {
  const ctx = resolveContext(base({
    claimId: 'pmjay-cons',
    ipd: { stage: 'discharge_submitted', claim_filing_route: 'network', panel_id: 'panel-pmjay' },
    panel: { id: 'panel-pmjay', name: 'Ayushman Bharat PMJAY' },
    episode: { meta: { episode_type: 'MEDICAL_MANAGEMENT' }, clinical_timeline: [{ procedures_performed: [] }] },
  }));

  it('detects PMJAY from panel name', () => {
    assert.equal(ctx.scheme.value, 'PMJAY');
  });
  it('derives case_type MEDICAL_MANAGEMENT', () => {
    assert.equal(ctx.caseType.value, 'MEDICAL_MANAGEMENT');
  });
});

describe('Cashless Everywhere pre-auth', () => {
  const ctx = resolveContext(base({
    claimId: 'ce-preauth',
    ipd: { stage: 'preauth_submitted', claim_filing_route: 'cashless_everywhere', panel_id: 'panel-icici' },
    panel: { id: 'panel-icici', code: 'ICICI_LOMBARD' },
    isEmpanelled: false,
    dossier: { doc_sections_by_category: { preauth_form: ['s1'], doctor_prescription: ['s2'] } },
    episode: { meta: { episode_type: 'surgical' } },
  }));

  it('resolves scheme=CASHLESS_EVERYWHERE from route', () => {
    assert.equal(ctx.scheme.value, 'CASHLESS_EVERYWHERE');
  });
  it('stage=preauth_submitted, doc mix agrees', () => {
    assert.equal(ctx.stage.value, 'preauth_submitted');
    assert.equal(ctx.stage.crosscheck?.agrees, true);
  });
});

describe('Network private pre-auth', () => {
  const ctx = resolveContext(base({
    claimId: 'np-preauth',
    ipd: { stage: 'preauth_submitted', claim_filing_route: 'network', panel_id: 'panel-star' },
    panel: { id: 'panel-star', code: 'STAR_HEALTH' },
    isEmpanelled: true,
  }));
  it('resolves scheme=NETWORK_PRIVATE from route', () => {
    assert.equal(ctx.scheme.value, 'NETWORK_PRIVATE');
  });
});

describe('REGRESSION: no explicit stage no longer defaults to preauth', () => {
  // Before M1, inferTargetStage(null, ...) fell back to 'preauth_submitted'.
  const ctx = resolveContext(base({
    claimId: 'no-stage',
    ipd: { stage: null, claim_filing_route: 'network', panel_id: 'panel-x' },
    dossier: { current_stage: null, doc_sections_by_category: { discharge_summary: ['s1'], final_bill: ['s2'] } },
  }));

  it('derives discharge_submitted from the doc mix, not preauth', () => {
    assert.equal(ctx.stage.value, 'discharge_submitted');
    assert.equal(ctx.stage.source, 'derived');
    assert.ok(ctx.flags.includes('stage_derived_from_doc_mix'));
    assert.notEqual(ctx.stage.value, 'preauth_submitted');
  });
});

describe('OD5: record wins over a disagreeing doc-mix cross-check', () => {
  const ctx = resolveContext(base({
    claimId: 'mismatch',
    ipd: { stage: 'preauth_submitted', claim_filing_route: 'network', panel_id: 'panel-x' },
    dossier: { doc_sections_by_category: { discharge_summary: ['s1'] } }, // implies discharge
  }));

  it('keeps the record stage but raises a mismatch flag', () => {
    assert.equal(ctx.stage.value, 'preauth_submitted'); // record wins
    assert.equal(ctx.stage.source, 'record');
    assert.equal(ctx.stage.crosscheck?.agrees, false);
    assert.ok(ctx.flags.includes('stage_docmix_mismatch'));
  });
});

describe('unresolved inputs flag rather than guess', () => {
  const ctx = resolveContext(base({ claimId: 'empty', ipd: {} }));
  it('flags every unresolved dimension', () => {
    assert.equal(ctx.route.value, null);
    assert.equal(ctx.insurerPanelId.value, null);
    assert.equal(ctx.stage.value, null);
    assert.ok(ctx.flags.includes('route_unresolved'));
    assert.ok(ctx.flags.includes('insurer_unresolved'));
    assert.ok(ctx.flags.includes('stage_unresolved'));
    assert.ok(ctx.flags.includes('case_type_no_explicit_record'));
  });
});
