/**
 * Unit tests for KbPatternMatcher.
 *
 * Runner: node:test (matches the convention in actionEngine.test.ts and
 * claimDossierProjector.test.ts). Run with:
 *
 *   npx tsx --test src/Services/__tests__/kbPatternMatcher.test.ts
 *
 * No DB — we mock the pool to return canned pattern rows and exercise the
 * condition evaluators directly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  KbPatternMatcher,
  evaluateCondition,
} from '../kbPatternMatcher.service.js';
import { blankDossier, type ClaimDossier } from '../claimDossierProjector.service.js';

// ─── Mock pool ────────────────────────────────────────────────────────────

interface MockState {
  calls: Array<{ sql: string; params: unknown[] }>;
  rows: any[];
}

function makeMockPool(state: MockState) {
  return {
    query: async (sql: string, params: unknown[]) => {
      state.calls.push({ sql, params });
      return { rows: state.rows, rowCount: state.rows.length };
    },
  } as any;
}

function freshState(rows: any[] = []): MockState {
  return { calls: [], rows };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const CLAIM_ID = '11111111-1111-4111-8111-111111111111';
const PANEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PANEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function dossierWith(overrides: Partial<ClaimDossier>): ClaimDossier {
  return { ...blankDossier(CLAIM_ID), ...overrides };
}

function makePattern(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    pattern_type: 'insurer_query_pattern',
    title: 'test',
    description: null,
    scope: { global: true },
    condition: { kind: 'doc_missing', params: { required_doc_category: 'consent' } },
    prediction: { kind: 'query_likely', point_estimate: 0.8 },
    confidence: 0.75,
    evidence_count: 12,
    ...overrides,
  };
}

// ─── evaluateCondition (pure) ─────────────────────────────────────────────

describe('evaluateCondition — doc_missing', () => {
  it('returns true when doc category is absent', () => {
    const d = dossierWith({ doc_sections_by_category: { other: ['s1'] } });
    assert.equal(
      evaluateCondition(
        { kind: 'doc_missing', params: { required_doc_category: 'consent' } },
        d,
      ),
      true,
    );
  });
  it('returns false when doc category is present', () => {
    const d = dossierWith({ doc_sections_by_category: { consent: ['s1'] } });
    assert.equal(
      evaluateCondition(
        { kind: 'doc_missing', params: { required_doc_category: 'consent' } },
        d,
      ),
      false,
    );
  });
  it('returns true when doc_sections_by_category is null', () => {
    const d = dossierWith({ doc_sections_by_category: null });
    assert.equal(
      evaluateCondition(
        { kind: 'doc_missing', params: { required_doc_category: 'consent' } },
        d,
      ),
      true,
    );
  });
});

describe('evaluateCondition — doc_present', () => {
  it('returns true when doc category is present', () => {
    const d = dossierWith({ doc_sections_by_category: { consent: ['s1', 's2'] } });
    assert.equal(
      evaluateCondition(
        { kind: 'doc_present', params: { required_doc_category: 'consent' } },
        d,
      ),
      true,
    );
  });
  it('returns false when array is empty', () => {
    const d = dossierWith({ doc_sections_by_category: { consent: [] } });
    assert.equal(
      evaluateCondition(
        { kind: 'doc_present', params: { required_doc_category: 'consent' } },
        d,
      ),
      false,
    );
  });
});

describe('evaluateCondition — amount_in_range', () => {
  it('matches inside range', () => {
    const d = dossierWith({ amounts: { claimed: 50_000 } });
    assert.equal(
      evaluateCondition(
        { kind: 'amount_in_range', params: { field_path: 'claimed', min: 10_000, max: 100_000 } },
        d,
      ),
      true,
    );
  });
  it('rejects outside range', () => {
    const d = dossierWith({ amounts: { claimed: 5_000 } });
    assert.equal(
      evaluateCondition(
        { kind: 'amount_in_range', params: { field_path: 'claimed', min: 10_000, max: 100_000 } },
        d,
      ),
      false,
    );
  });
  it('returns false when amount missing', () => {
    const d = dossierWith({ amounts: null });
    assert.equal(
      evaluateCondition(
        { kind: 'amount_in_range', params: { field_path: 'claimed', min: 0 } },
        d,
      ),
      false,
    );
  });
});

describe('evaluateCondition — past_outcome_seq', () => {
  it('matches sub-sequence', () => {
    const d = dossierWith({
      outbound_submissions: [
        { event_id: 'e1', status: 'drafted', at: '2026-05-01T00:00:00Z' },
        { event_id: 'e2', status: 'queued', at: '2026-05-01T01:00:00Z' },
        { event_id: 'e3', status: 'sent', at: '2026-05-01T02:00:00Z' },
      ] as any,
    });
    assert.equal(
      evaluateCondition(
        { kind: 'past_outcome_seq', params: { seq: ['drafted', 'sent'] } },
        d,
      ),
      true,
    );
  });
  it('does not match wrong order', () => {
    const d = dossierWith({
      outbound_submissions: [
        { event_id: 'e1', status: 'sent', at: '2026-05-01T00:00:00Z' },
        { event_id: 'e2', status: 'drafted', at: '2026-05-01T01:00:00Z' },
      ] as any,
    });
    assert.equal(
      evaluateCondition(
        { kind: 'past_outcome_seq', params: { seq: ['drafted', 'sent'] } },
        d,
      ),
      false,
    );
  });
});

describe('evaluateCondition — stage_dwell', () => {
  it('matches when dwell is in range', () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    const t1 = new Date('2026-05-01T05:00:00Z'); // 5h dwell
    const d = dossierWith({
      events_summary: [
        {
          event_id: 'e1',
          kind: 'stage_transitioned',
          at: t0.toISOString(),
          actor: 'system',
          salient: { before_stage: 'pre_auth', after_stage: 'enhancement' },
        },
        {
          event_id: 'e2',
          kind: 'stage_transitioned',
          at: t1.toISOString(),
          actor: 'system',
          salient: { before_stage: 'enhancement', after_stage: 'discharge' },
        },
      ] as any,
    });
    assert.equal(
      evaluateCondition(
        { kind: 'stage_dwell', params: { stage: 'enhancement', min_hours: 1, max_hours: 10 } },
        d,
      ),
      true,
    );
  });
});

describe('evaluateCondition — unknown kind returns "skip"', () => {
  it('returns the sentinel skip', () => {
    const d = dossierWith({});
    assert.equal(
      evaluateCondition({ kind: 'this_does_not_exist_yet', params: {} }, d),
      'skip',
    );
  });
});

// ─── match() — orchestration ──────────────────────────────────────────────

describe('KbPatternMatcher.match — orchestration', () => {
  it('returns matched patterns ordered by confidence DESC', async () => {
    const state = freshState([
      makePattern({ id: 'p-low', confidence: 0.5 }),
      makePattern({ id: 'p-high', confidence: 0.9 }),
      makePattern({ id: 'p-mid', confidence: 0.7 }),
    ]);
    const matcher = new KbPatternMatcher(makeMockPool(state));
    const out = await matcher.match({
      claim_id: CLAIM_ID,
      dossier: dossierWith({
        // ensure conditions match (doc_missing on 'consent')
        doc_sections_by_category: { other: ['s'] },
      }),
    });
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((p) => p.id),
      ['p-high', 'p-mid', 'p-low'],
    );
  });

  it('skips unknown condition kinds without crashing', async () => {
    const state = freshState([
      makePattern({
        id: 'p-unknown',
        condition: { kind: 'novel_unhandled', params: {} },
        confidence: 0.99,
      }),
      makePattern({ id: 'p-known', confidence: 0.5 }),
    ]);
    const matcher = new KbPatternMatcher(makeMockPool(state));
    const out = await matcher.match({
      claim_id: CLAIM_ID,
      dossier: dossierWith({ doc_sections_by_category: null }),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.id, 'p-known');
  });

  it('rejects patterns whose declared scope does not match', async () => {
    const state = freshState([
      makePattern({
        id: 'p-panel-A',
        scope: { panel_id: PANEL_A },
        confidence: 0.9,
      }),
      makePattern({
        id: 'p-global',
        scope: { global: true },
        confidence: 0.5,
      }),
    ]);
    const matcher = new KbPatternMatcher(makeMockPool(state));
    const out = await matcher.match({
      claim_id: CLAIM_ID,
      dossier: dossierWith({
        current_panel_id: PANEL_B,
        doc_sections_by_category: null,
      }),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.id, 'p-global');
  });

  it('caps results at MAX_MATCHES=10', async () => {
    const rows = Array.from({ length: 15 }).map((_, i) =>
      makePattern({ id: `p-${i}`, confidence: 0.9 - i * 0.01 }),
    );
    const state = freshState(rows);
    const matcher = new KbPatternMatcher(makeMockPool(state));
    const out = await matcher.match({
      claim_id: CLAIM_ID,
      dossier: dossierWith({ doc_sections_by_category: null }),
    });
    assert.equal(out.length, 10);
  });
});

// ─── logMatch ─────────────────────────────────────────────────────────────

describe('KbPatternMatcher.logMatch', () => {
  it('inserts a row into kb_pattern_matches', async () => {
    const state = freshState();
    const matcher = new KbPatternMatcher(makeMockPool(state));
    await matcher.logMatch('p-1', CLAIM_ID, 'rep-1');
    const insertCall = state.calls.find((c) =>
      c.sql.includes('INSERT INTO hospital.kb_pattern_matches'),
    );
    assert.ok(insertCall, 'should have issued an INSERT');
    assert.deepEqual(insertCall!.params, ['p-1', CLAIM_ID, 'rep-1']);
  });

  it('swallows insert errors (does not throw)', async () => {
    const errorPool = {
      query: async () => {
        throw new Error('db down');
      },
    } as any;
    const matcher = new KbPatternMatcher(errorPool);
    // Should not throw.
    await matcher.logMatch('p-1', CLAIM_ID);
  });
});
