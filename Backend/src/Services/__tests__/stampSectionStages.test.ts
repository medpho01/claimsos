/**
 * stampSectionStages — the one production caller of resolveSectionStage.
 *
 * What these guard is mostly SHAPE rather than precedence (documentStageAffinity
 * already owns the precedence tests): that the helper groups by category
 * including the null bucket, that it writes stage_source alongside stage, and
 * above all that it never throws — it runs after the section INSERT has
 * committed, so an exception here would surface as a failed document whose
 * sections are actually fine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stampSectionStages, type StampDeps } from '../harmoniser/stampSectionStages.js';
import { DocumentStageAffinityService } from '../documentStageAffinity.service.js';

type Row = Record<string, unknown>;

const STAGE_ORDER = new Map([
  ['ELIGIBILITY_CHECK', 10],
  ['PREAUTH', 20],
  ['FINAL_AUTH', 40],
]);

/**
 * The REAL resolveSectionStage, over a pool that answers only the affinity
 * lookup. Stubbing the resolver itself would leave the precedence untested at
 * this layer and let a wiring mistake through — the exact failure this whole
 * commit exists to fix.
 */
function realDeps(affinity: Record<string, Row> = {}): StampDeps {
  const pool = {
    async query(_sql: string, params: unknown[] = []) {
      const hit = affinity[String(params[0] ?? '')];
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
    },
  };
  const svc = new DocumentStageAffinityService(pool as never);
  return {
    resolveSectionStage: (input) => svc.resolveSectionStage(input),
    stageOrder: async () => STAGE_ORDER,
  };
}

/** Records every UPDATE so a test can assert what was written. */
function fakeDb(opts: {
  sections: Array<{ id: string; category: string | null }>;
  ctx?: Row;
  failOn?: RegExp;
}) {
  const updates: Array<{ stage: unknown; source: unknown; category: unknown }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (opts.failOn?.test(sql)) throw new Error('boom');

      if (/^UPDATE hospital\.document_sections/i.test(sql.trim())) {
        updates.push({ stage: params[0], source: params[1], category: params[3] });
        const n = opts.sections.filter((s) => (s.category ?? null) === (params[3] ?? null)).length;
        return { rows: [], rowCount: n };
      }
      if (/FROM hospital\.document_sections/i.test(sql)) {
        return { rows: opts.sections, rowCount: opts.sections.length };
      }
      if (/FROM hospital\.ipd_doc/i.test(sql)) {
        return { rows: [opts.ctx ?? {}], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { db: db as never, updates };
}

/** No affinity rows — the common case: ~215 of 246 categories are unmapped. */
const deps = realDeps();

describe('stampSectionStages', () => {
  it('stamps the declared stage when the uploader chose one', async () => {
    const { db, updates } = fakeDb({
      sections: [{ id: 's1', category: 'final_bill' }],
      ctx: { claim_stage: 'PREAUTH', declared_stage: 'FINAL_AUTH' },
    });
    const r = await stampSectionStages(db, 'doc1', 'claim1', deps);
    assert.equal(r.stamped, 1);
    assert.equal(updates[0].stage, 'FINAL_AUTH');
    assert.equal(updates[0].source, 'declared');
  });

  it('falls back to the claim stage when nothing was declared', async () => {
    const { db, updates } = fakeDb({
      sections: [{ id: 's1', category: 'opd_notes' }],
      ctx: { claim_stage: 'PREAUTH', declared_stage: null },
    });
    await stampSectionStages(db, 'doc1', 'claim1', deps);
    assert.equal(updates[0].stage, 'PREAUTH');
    assert.equal(updates[0].source, 'claim_stage');
  });

  it('groups by category and resolves each one once', async () => {
    const { db, updates } = fakeDb({
      sections: [
        { id: 's1', category: 'final_bill' },
        { id: 's2', category: 'final_bill' },
        { id: 's3', category: 'opd_notes' },
      ],
      ctx: { claim_stage: 'PREAUTH', declared_stage: null },
    });
    const r = await stampSectionStages(db, 'doc1', 'claim1', deps);
    assert.equal(r.categories, 2, 'two distinct categories, not three sections');
    assert.equal(updates.length, 2);
  });

  it('treats a null category as its own bucket, not a row to skip', async () => {
    // The segmenter path: sections exist before classification, so every one
    // is category-less. An uploader who declared a stage has still said
    // something true about them.
    const { db, updates } = fakeDb({
      sections: [{ id: 's1', category: null }, { id: 's2', category: null }],
      ctx: { claim_stage: null, declared_stage: 'PREAUTH' },
    });
    const r = await stampSectionStages(db, 'doc1', 'claim1', deps);
    assert.equal(r.categories, 1);
    assert.equal(r.stamped, 2);
    assert.equal(updates[0].stage, 'PREAUTH');
    assert.equal(updates[0].category, null);
  });

  it('records stage_source even when an evergreen category resolves to NULL', async () => {
    // NULL-because-evergreen must be distinguishable from never-looked-at.
    const { db, updates } = fakeDb({
      sections: [{ id: 's1', category: 'aadhaar_front' }],
      ctx: { claim_stage: 'PREAUTH', declared_stage: 'PREAUTH' },
    });
    const deps = realDeps({ aadhaar_front: { doc_category: 'aadhaar_front', is_evergreen: true } });
    await stampSectionStages(db, 'doc1', 'claim1', deps);
    assert.equal(updates[0].stage, null);
    assert.equal(updates[0].source, 'none');
  });

  it('never throws — it runs after the section insert has committed', async () => {
    const { db } = fakeDb({
      sections: [{ id: 's1', category: 'final_bill' }],
      failOn: /FROM hospital\.ipd_doc/i,
    });
    const r = await stampSectionStages(db, 'doc1', 'claim1', deps);
    assert.deepEqual(r, { stamped: 0, categories: 0 });
  });

  it('does nothing when the document has no auto sections', async () => {
    const { db, updates } = fakeDb({ sections: [] });
    const r = await stampSectionStages(db, 'doc1', 'claim1', deps);
    assert.deepEqual(r, { stamped: 0, categories: 0 });
    assert.equal(updates.length, 0);
  });
});
