/**
 * documentStageAffinity — the stage-resolution policy.
 *
 * This is the function that decides which rule pack a document is judged by.
 * Get it wrong and a document routes to the wrong checklist with no error:
 * one stage reports a document missing that is in the bundle, another counts
 * evidence it should not. So the precedence is pinned explicitly, in both
 * directions — what must override, and what must NOT.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DocumentStageAffinityService } from '../documentStageAffinity.service.js';

const STAGE_ORDER = new Map([
  ['ELIGIBILITY_CHECK', 10],
  ['PREAUTH', 20],
  ['ENHANCEMENT', 30],
  ['FINAL_AUTH', 40],
  ['CLAIM_FILE', 50],
  ['SETTLEMENT', 60],
]);

/** Pool that answers only the affinity lookup resolveSectionStage makes. */
function poolWith(affinity: Record<string, any>) {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (/FROM hospital\.document_stage_affinity WHERE doc_category/.test(sql)) {
        const row = affinity[params[0] as string];
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

const AFFINITY = {
  final_bill: { doc_category: 'final_bill', is_evergreen: false, stage_floor: 'FINAL_AUTH', affinity_stage: 'CLAIM_FILE' },
  pre_authorization_form: { doc_category: 'pre_authorization_form', is_evergreen: false, stage_floor: 'PREAUTH', affinity_stage: 'PREAUTH' },
  aadhaar_front: { doc_category: 'aadhaar_front', is_evergreen: true, stage_floor: null, affinity_stage: null },
  opd_notes: { doc_category: 'opd_notes', is_evergreen: false, stage_floor: null, affinity_stage: null },
};

const svc = () => new DocumentStageAffinityService(poolWith(AFFINITY));

describe('resolveSectionStage — precedence', () => {
  it("a reviewer's correction wins, and is not floor-checked", async () => {
    // A human looking at the document outranks our model of what is possible.
    const r = await svc().resolveSectionStage({
      docCategory: 'final_bill',
      reviewerStage: 'PREAUTH',
      declaredStage: 'CLAIM_FILE',
      stageOrder: STAGE_ORDER,
    });
    assert.equal(r.stage, 'PREAUTH');
    assert.equal(r.stage_source, 'reviewer');
    assert.equal(r.floor_violation, undefined);
  });

  it("the uploader's declared stage beats category affinity", async () => {
    // ADJUDICATION_ARCHITECTURE §5.3 rule 1: explicit human assignment always
    // wins. affinity_stage for final_bill is CLAIM_FILE; the human said
    // SETTLEMENT, and a final bill legitimately travels with an appeal.
    const r = await svc().resolveSectionStage({
      docCategory: 'final_bill',
      declaredStage: 'SETTLEMENT',
      claimStage: 'CLAIM_FILE',
      stageOrder: STAGE_ORDER,
    });
    assert.equal(r.stage, 'SETTLEMENT');
    assert.equal(r.stage_source, 'declared');
  });

  it('affinity is used when nobody declared a stage (inbound documents)', async () => {
    const r = await svc().resolveSectionStage({
      docCategory: 'final_bill',
      claimStage: 'SETTLEMENT',
      stageOrder: STAGE_ORDER,
    });
    assert.equal(r.stage, 'CLAIM_FILE');
    assert.equal(r.stage_source, 'affinity');
  });

  it('falls back to the claim stage only when there is no affinity', async () => {
    const r = await svc().resolveSectionStage({
      docCategory: 'opd_notes',
      claimStage: 'ENHANCEMENT',
      stageOrder: STAGE_ORDER,
    });
    assert.equal(r.stage, 'ENHANCEMENT');
    assert.equal(r.stage_source, 'claim_stage');
  });
});

describe('resolveSectionStage — the floor', () => {
  it('rejects a physically impossible human choice and says so', async () => {
    // A final bill cannot exist before discharge authorisation.
    const r = await svc().resolveSectionStage({
      docCategory: 'final_bill',
      declaredStage: 'PREAUTH',
      stageOrder: STAGE_ORDER,
    });
    assert.equal(r.stage, 'FINAL_AUTH');
    assert.deepEqual(r.floor_violation, { declared: 'PREAUTH', floor: 'FINAL_AUTH' });
  });

  it('accepts a human choice ABOVE the floor — that is merely unlikely, not impossible', async () => {
    const r = await svc().resolveSectionStage({
      docCategory: 'final_bill',
      declaredStage: 'SETTLEMENT',
      stageOrder: STAGE_ORDER,
    });
    assert.equal(r.stage, 'SETTLEMENT');
    assert.equal(r.floor_violation, undefined);
  });

  it('does not let a stale claim stage sink below the floor', async () => {
    const r = await svc().resolveSectionStage({
      docCategory: 'pre_authorization_form',
      claimStage: 'ELIGIBILITY_CHECK',
      stageOrder: STAGE_ORDER,
    });
    assert.notEqual(r.stage, 'ELIGIBILITY_CHECK');
  });
});

describe('resolveSectionStage — evergreen', () => {
  it('returns no stage at all, because it is evidence everywhere', async () => {
    // Stamping a stage on an Aadhaar would imply a scope it does not have, and
    // is how a KYC document filed at pre-auth gets reported missing at final
    // claim while sitting in the bundle.
    const r = await svc().resolveSectionStage({
      docCategory: 'aadhaar_front',
      declaredStage: 'PREAUTH',
      claimStage: 'CLAIM_FILE',
      stageOrder: STAGE_ORDER,
    });
    assert.equal(r.evergreen, true);
    assert.equal(r.stage, null);
    assert.equal(r.stage_source, 'none');
  });
});

describe('resolveSectionStage — dates flag, never override', () => {
  it('flags a post-discharge document tagged pre-auth without re-tagging it', async () => {
    // The extractor has shipped a misread of 9993 as 9593; a date it misreads
    // must not silently move a document into a different rule pack.
    const r = await svc().resolveSectionStage({
      docCategory: 'opd_notes',
      declaredStage: 'PREAUTH',
      documentDate: '2026-09-20',
      dischargeDate: '2026-09-12',
      stageOrder: STAGE_ORDER,
    });
    assert.equal(r.stage, 'PREAUTH', 'must NOT re-tag');
    assert.match(r.disputed ?? '', /after discharge/);
  });

  it('stays quiet when the dates agree', async () => {
    const r = await svc().resolveSectionStage({
      docCategory: 'opd_notes',
      declaredStage: 'PREAUTH',
      documentDate: '2026-09-10',
      dischargeDate: '2026-09-12',
      stageOrder: STAGE_ORDER,
    });
    assert.equal(r.disputed, undefined);
  });
});
