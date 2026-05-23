/**
 * Unit tests for the Action Engine.
 *
 * Runner: node:test (matches the convention in eventDispatcher.test.ts and
 * claimDossierProjector.test.ts). Run with:
 *
 *   npx tsx --test src/Services/__tests__/actionEngine.test.ts
 *
 * Everything is mocked: pool, eventDispatcher, dispatcher enqueue. No DB,
 * no Bull, no network.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActionEngine,
  computeIdempotencyKey,
  type AdjudicationReport,
  type DispatcherEnqueue,
} from '../actionEngine.service.js';

// ─── Mock pool ────────────────────────────────────────────────────────────
// Pattern mirrors eventDispatcher.test.ts: a list of pattern matchers that
// the mock cycles through in order. Anything unmatched returns an empty
// rowset (which is the right default for routing lookups that find nothing).

type QueryResponse = { rows: any[]; rowCount?: number };

interface MockState {
  calls: Array<{ sql: string; params: unknown[] }>;
  queueByPattern: Array<{
    match: (sql: string) => boolean;
    respond: () => QueryResponse;
  }>;
}

function makeMockPool(state: MockState) {
  const query = async (sql: string, params: unknown[]): Promise<QueryResponse> => {
    state.calls.push({ sql, params });
    for (const entry of state.queueByPattern) {
      if (entry.match(sql)) return entry.respond();
    }
    return { rows: [] };
  };
  return { query: query as any };
}

function freshState(): MockState {
  return { calls: [], queueByPattern: [] };
}

// Mock event dispatcher — re-uses the singleton via module patching is
// awkward in node:test; instead, we monkey-patch its dispatch method.
import { eventDispatcher } from '../events/eventDispatcher.service.js';

function makeMockDispatcher() {
  const calls: any[] = [];
  const orig = (eventDispatcher as any).dispatch.bind(eventDispatcher);
  (eventDispatcher as any).dispatch = async (input: any) => {
    calls.push(input);
    return { id: 'evt-' + calls.length, deduped: false };
  };
  return {
    calls,
    restore: () => {
      (eventDispatcher as any).dispatch = orig;
    },
  };
}

// Mock dispatcher enqueue (Bull replacement).
function makeMockEnqueue(): DispatcherEnqueue & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    enqueue: async (id: string) => {
      calls.push(id);
    },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const CLAIM_ID = '11111111-1111-4111-8111-111111111111';
const REPORT_ID = '22222222-2222-4222-8222-222222222222';
const HOSPITAL_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_USER_ID = '44444444-4444-4444-8444-444444444444';
const WHATSAPP_GROUP = '120363111111111111@g.us';
const ACTOR_USER_ID = '55555555-5555-4555-8555-555555555555';

function baseReport(
  overrides: Partial<AdjudicationReport> = {},
): AdjudicationReport {
  return {
    id: REPORT_ID,
    claim_id: CLAIM_ID,
    readiness: 0.6,
    recommended_action: 'review',
    blocking_gaps: [],
    warnings: [],
    generated_at: '2026-05-18T10:00:00.000Z',
    ...overrides,
  };
}

// Default routing: panel group + ops head admin both resolved.
function primeRouting(state: MockState, opts: { withGroup?: boolean; withAdmin?: boolean } = {}) {
  const withGroup = opts.withGroup ?? true;
  const withAdmin = opts.withAdmin ?? true;
  state.queueByPattern.push({
    match: (sql) => sql.includes('FROM hospital.ipds i'),
    respond: () => ({
      rows: [
        {
          whatsapp_group_id: withGroup ? WHATSAPP_GROUP : null,
          panel_name: withGroup ? 'Sadbhawana' : null,
        },
      ],
    }),
  });
  state.queueByPattern.push({
    match: (sql) => sql.includes('FROM hospital.hospital_users'),
    respond: () => ({
      rows: withAdmin ? [{ user_id: ADMIN_USER_ID }] : [],
    }),
  });
}

// Default INSERT that returns the inserted row. Each insert returns the
// params it was called with so we can correlate.
function primeInsertSuccess(state: MockState) {
  state.queueByPattern.push({
    match: (sql) => sql.startsWith('\n         INSERT INTO hospital.claim_actions') || sql.includes('INSERT INTO hospital.claim_actions'),
    respond: () => ({
      rows: [
        { id: 'new-action-' + Math.random().toString(36).slice(2, 8), kind: 'unknown', status: 'pending' },
      ],
    }),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('ActionEngine.planActions (pure)', () => {
  it("maps 'request_doc' + blocking_gaps → one whatsapp_group action per gap", () => {
    const state = freshState();
    const engine = new ActionEngine(makeMockPool(state), makeMockEnqueue());
    const specs = engine.planActions(
      baseReport({
        recommended_action: 'request_doc',
        blocking_gaps: [
          { id: 'gap-1', severity: 'blocker', message: 'missing discharge summary', doc_category: 'discharge_summary' },
          { id: 'gap-2', severity: 'blocker', message: 'missing pre-auth letter', doc_category: 'preauth_letter' },
        ],
      }),
      {
        hospital_id: HOSPITAL_ID,
        whatsapp_group_id: WHATSAPP_GROUP,
        panel_name: 'Sadbhawana',
        ops_head_user_id: ADMIN_USER_ID,
        approver_user_id: ADMIN_USER_ID,
      } as any,
    );
    assert.equal(specs.length, 2);
    for (const s of specs) {
      assert.equal(s.kind, 'request_doc');
      assert.equal(s.target_kind, 'whatsapp_group');
      assert.equal(s.target_value, WHATSAPP_GROUP);
    }
    assert.equal(specs[0]!.gap_or_warning_id, 'gap-1');
    assert.equal(specs[1]!.gap_or_warning_id, 'gap-2');
  });

  it("maps 'request_doc' with no panel group → in-app to ops head", () => {
    const state = freshState();
    const engine = new ActionEngine(makeMockPool(state), makeMockEnqueue());
    const specs = engine.planActions(
      baseReport({
        recommended_action: 'request_doc',
        blocking_gaps: [
          { id: 'gap-1', severity: 'blocker', message: 'missing summary' },
        ],
      }),
      {
        hospital_id: HOSPITAL_ID,
        whatsapp_group_id: null,
        panel_name: null,
        ops_head_user_id: ADMIN_USER_ID,
        approver_user_id: ADMIN_USER_ID,
      } as any,
    );
    assert.equal(specs.length, 1);
    assert.equal(specs[0]!.target_kind, 'in_app_user');
    assert.equal(specs[0]!.target_user_id, ADMIN_USER_ID);
  });

  it("maps 'review' → single notify_ops in-app to ops head", () => {
    const state = freshState();
    const engine = new ActionEngine(makeMockPool(state), makeMockEnqueue());
    const specs = engine.planActions(
      baseReport({ recommended_action: 'review' }),
      {
        hospital_id: HOSPITAL_ID,
        whatsapp_group_id: WHATSAPP_GROUP,
        panel_name: 'Sadbhawana',
        ops_head_user_id: ADMIN_USER_ID,
        approver_user_id: ADMIN_USER_ID,
      } as any,
    );
    assert.equal(specs.length, 1);
    assert.equal(specs[0]!.kind, 'notify_ops');
    assert.equal(specs[0]!.target_kind, 'in_app_user');
  });

  it("maps 'file_now' → single notify_ops with 'Ready to file' title", () => {
    const state = freshState();
    const engine = new ActionEngine(makeMockPool(state), makeMockEnqueue());
    const specs = engine.planActions(
      baseReport({ recommended_action: 'file_now', readiness: 0.92 }),
      {
        hospital_id: HOSPITAL_ID,
        whatsapp_group_id: null,
        panel_name: null,
        ops_head_user_id: ADMIN_USER_ID,
        approver_user_id: ADMIN_USER_ID,
      } as any,
    );
    assert.equal(specs.length, 1);
    assert.equal((specs[0]!.payload as any).title, 'Ready to file');
  });

  it("maps 'approval_request' → in-app + whatsapp pair", () => {
    const state = freshState();
    const engine = new ActionEngine(makeMockPool(state), makeMockEnqueue());
    const specs = engine.planActions(
      baseReport({ recommended_action: 'approval_request', readiness: 0.95 }),
      {
        hospital_id: HOSPITAL_ID,
        whatsapp_group_id: WHATSAPP_GROUP,
        panel_name: 'Sadbhawana',
        ops_head_user_id: ADMIN_USER_ID,
        approver_user_id: ADMIN_USER_ID,
      } as any,
    );
    assert.equal(specs.length, 2);
    assert.equal(specs[0]!.target_kind, 'in_app_user');
    assert.equal(specs[1]!.target_kind, 'whatsapp_group');
    for (const s of specs) assert.equal(s.kind, 'approval_request');
  });

  it("maps 'escalate_to_human' → single high-priority in-app to ops head", () => {
    const state = freshState();
    const engine = new ActionEngine(makeMockPool(state), makeMockEnqueue());
    const specs = engine.planActions(
      baseReport({ recommended_action: 'escalate_to_human' }),
      {
        hospital_id: HOSPITAL_ID,
        whatsapp_group_id: WHATSAPP_GROUP,
        panel_name: 'Sadbhawana',
        ops_head_user_id: ADMIN_USER_ID,
        approver_user_id: ADMIN_USER_ID,
      } as any,
    );
    assert.equal(specs.length, 1);
    assert.equal(specs[0]!.kind, 'notify_ops');
    assert.equal((specs[0]!.payload as any).priority, 'high');
  });
});

describe('ActionEngine.planAndDispatch — DB + side effects', () => {
  it('inserts one row per spec and enqueues a dispatch job per row', async () => {
    const state = freshState();
    primeRouting(state);
    primeInsertSuccess(state);
    const enqueue = makeMockEnqueue();
    const dispatcherMock = makeMockDispatcher();
    try {
      const engine = new ActionEngine(makeMockPool(state), enqueue);
      const out = await engine.planAndDispatch({
        report: baseReport({
          recommended_action: 'request_doc',
          blocking_gaps: [
            { id: 'gap-1', severity: 'blocker', message: 'm1' },
            { id: 'gap-2', severity: 'blocker', message: 'm2' },
          ],
        }),
        hospital_id: HOSPITAL_ID,
      });
      assert.equal(out.length, 2);
      assert.equal(enqueue.calls.length, 2);
      assert.equal(dispatcherMock.calls.length, 2);
      for (const call of dispatcherMock.calls) {
        assert.equal(call.kind, 'claim_action_dispatched');
      }
    } finally {
      dispatcherMock.restore();
    }
  });

  it('idempotency: a second run with same conflicts inserts 0 new rows', async () => {
    const state = freshState();
    primeRouting(state);
    // First insert returns a row; subsequent inserts return empty (ON
    // CONFLICT DO NOTHING).
    let insertCount = 0;
    state.queueByPattern.push({
      match: (sql) => sql.includes('INSERT INTO hospital.claim_actions'),
      respond: () => {
        insertCount += 1;
        if (insertCount === 1) {
          return { rows: [{ id: 'first-action', kind: 'request_doc', status: 'pending' }] };
        }
        return { rows: [] };
      },
    });
    const enqueue = makeMockEnqueue();
    const dispatcherMock = makeMockDispatcher();
    try {
      const engine = new ActionEngine(makeMockPool(state), enqueue);
      const report = baseReport({
        recommended_action: 'request_doc',
        blocking_gaps: [{ id: 'gap-1', severity: 'blocker', message: 'm1' }],
      });
      const first = await engine.planAndDispatch({ report, hospital_id: HOSPITAL_ID });
      const second = await engine.planAndDispatch({ report, hospital_id: HOSPITAL_ID });
      assert.equal(first.length, 1);
      assert.equal(second.length, 0, 'second run should not insert duplicates');
      assert.equal(enqueue.calls.length, 1, 'enqueue happens only for new rows');
    } finally {
      dispatcherMock.restore();
    }
  });
});

describe('ActionEngine.ackAction / declineAction', () => {
  it('ackAction updates to acked + emits claim_action_acked', async () => {
    const state = freshState();
    state.queueByPattern.push({
      match: (sql) => sql.includes('UPDATE hospital.claim_actions') && sql.includes("status = 'acked'"),
      respond: () => ({ rows: [{ claim_id: CLAIM_ID, kind: 'approval_request' }] }),
    });
    const dispatcherMock = makeMockDispatcher();
    try {
      const engine = new ActionEngine(makeMockPool(state), makeMockEnqueue());
      await engine.ackAction('action-1', ACTOR_USER_ID, { decision: 'approved' });
      assert.equal(dispatcherMock.calls.length, 1);
      assert.equal(dispatcherMock.calls[0].kind, 'claim_action_acked');
      assert.equal((dispatcherMock.calls[0].payload as any).action_id, 'action-1');
    } finally {
      dispatcherMock.restore();
    }
  });

  it('ackAction throws when row not in ackable state', async () => {
    const state = freshState();
    state.queueByPattern.push({
      match: (sql) => sql.includes('UPDATE hospital.claim_actions'),
      respond: () => ({ rows: [] }),
    });
    const dispatcherMock = makeMockDispatcher();
    try {
      const engine = new ActionEngine(makeMockPool(state), makeMockEnqueue());
      await assert.rejects(
        () => engine.ackAction('missing', ACTOR_USER_ID),
        /not in an ackable state/,
      );
      assert.equal(dispatcherMock.calls.length, 0);
    } finally {
      dispatcherMock.restore();
    }
  });

  it('declineAction requires a reason', async () => {
    const state = freshState();
    const engine = new ActionEngine(makeMockPool(state), makeMockEnqueue());
    await assert.rejects(
      () => engine.declineAction('action-1', ACTOR_USER_ID, ''),
      /reason is required/,
    );
  });

  it('declineAction updates to declined + emits claim_action_declined', async () => {
    const state = freshState();
    state.queueByPattern.push({
      match: (sql) => sql.includes('UPDATE hospital.claim_actions') && sql.includes("status = 'declined'"),
      respond: () => ({ rows: [{ claim_id: CLAIM_ID, kind: 'request_doc' }] }),
    });
    const dispatcherMock = makeMockDispatcher();
    try {
      const engine = new ActionEngine(makeMockPool(state), makeMockEnqueue());
      await engine.declineAction('action-1', ACTOR_USER_ID, 'not applicable for this claim');
      assert.equal(dispatcherMock.calls.length, 1);
      assert.equal(dispatcherMock.calls[0].kind, 'claim_action_declined');
      assert.equal((dispatcherMock.calls[0].payload as any).reason, 'not applicable for this claim');
    } finally {
      dispatcherMock.restore();
    }
  });
});

describe('computeIdempotencyKey', () => {
  it('is deterministic on identical inputs', () => {
    const a = computeIdempotencyKey(CLAIM_ID, 'request_doc', WHATSAPP_GROUP, 'gap-1');
    const b = computeIdempotencyKey(CLAIM_ID, 'request_doc', WHATSAPP_GROUP, 'gap-1');
    assert.equal(a, b);
  });
  it('differs when any input differs', () => {
    const a = computeIdempotencyKey(CLAIM_ID, 'request_doc', WHATSAPP_GROUP, 'gap-1');
    const b = computeIdempotencyKey(CLAIM_ID, 'request_doc', WHATSAPP_GROUP, 'gap-2');
    const c = computeIdempotencyKey(CLAIM_ID, 'notify_ops', WHATSAPP_GROUP, 'gap-1');
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });
});
