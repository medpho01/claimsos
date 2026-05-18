/**
 * Unit tests for EventDispatcher.
 *
 * Runner: node:test (built-in to Node 20+). The Backend package.json doesn't
 * (yet) have a `test` script; run with:
 *
 *   npx tsx --test src/Services/events/__tests__/eventDispatcher.test.ts
 *
 * We mock the pg pool by passing a stub object with a `query` method to the
 * EventDispatcher constructor (the production code uses the default pool
 * but the constructor accepts an injected one for exactly this purpose).
 * No DB, no network, no env required.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  EventDispatcher,
  InvalidEventPayloadError,
  UnknownEventKindError,
} from '../eventDispatcher.service.js';
import {
  EVENT_KINDS,
  EVENT_PAYLOAD_SCHEMAS,
  type EventKind,
} from '../eventTypes.js';

// ─── Mock pool ────────────────────────────────────────────────────────────

type QueryHandler = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: any[]; rowCount?: number }>;

interface MockState {
  calls: Array<{ sql: string; params: unknown[] }>;
  queueByPattern: Array<{
    match: (sql: string) => boolean;
    response: { rows: any[]; rowCount?: number };
  }>;
  defaultResponse: { rows: any[]; rowCount?: number };
}

function makeMockPool(state: MockState) {
  const query: QueryHandler = async (sql, params) => {
    state.calls.push({ sql, params });
    for (const entry of state.queueByPattern) {
      if (entry.match(sql)) {
        return entry.response;
      }
    }
    return state.defaultResponse;
  };
  return { query: query as any };
}

function freshState(): MockState {
  return {
    calls: [],
    queueByPattern: [],
    defaultResponse: { rows: [] },
  };
}

// ─── Canonical valid payloads per kind ────────────────────────────────────
// One entry per kind. Used in the "every kind parses its canonical payload"
// suite and as a quarry of valid payloads for the other tests.
const ISO = '2026-05-18T12:00:00.000Z';
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';

const CANONICAL_PAYLOADS: { [K in EventKind]: unknown } = {
  claim_created: { initial_stage: 'pre_auth_drafted' },
  claim_closed: { final_stage: 'approved', reason: 'paid' },
  doc_uploaded: {
    document_id: UUID_A,
    doc_count_pages: 4,
    uploaded_by: 'user:42',
  },
  doc_segmented: {
    document_id: UUID_A,
    section_ids: [UUID_B, UUID_C],
    segmenter_version: 'seg-v1.0.0',
  },
  section_classified: {
    section_id: UUID_B,
    category: 'discharge_slip',
    confidence: 0.92,
    classifier_version: 'cls-v1.0.0',
  },
  section_extracted: {
    section_id: UUID_B,
    extraction_id: UUID_C,
    confidence: 0.81,
    extractor_version: 'ext-v1.0.0',
  },
  section_corrected: {
    section_id: UUID_B,
    action: 'reclassify',
    before: { category: 'investigations' },
    after: { category: 'treatment' },
    corrected_by: 'user:42',
  },
  inbound_email_received: {
    email_id: UUID_A,
    sender: 'claims@insurer.com',
    subject: 'Re: pre-auth #123',
    matched: false,
  },
  inbound_email_matched: {
    email_id: UUID_A,
    claim_id: UUID_B,
    match_strategy: 'thread_id',
  },
  inbound_email_unmatched: {
    email_id: UUID_A,
    reason: 'no_subject_match',
  },
  ai_draft_created: {
    draft_id: UUID_A,
    kind: 'pre_auth_response',
    confidence: 0.74,
    llm_provider: 'anthropic',
    llm_model: 'claude-haiku',
    tokens_used: 1234,
    cost_inr: 0.42,
  },
  ai_draft_applied: {
    draft_id: UUID_A,
    applied_by: 'user:42',
    field_overrides: { policy_number: 'P-9' },
  },
  ai_draft_rejected: {
    draft_id: UUID_A,
    rejected_by: 'user:42',
    reason: 'wrong_attachment',
  },
  stage_transitioned: {
    transition_id: UUID_A,
    before_stage: 'pre_auth_drafted',
    after_stage: 'pre_auth_submitted',
    triggered_by: 'submission_sent',
    triggering_event_id: UUID_B,
    was_reversal: false,
  },
  submission_drafted: {
    submission_id: UUID_A,
    draft_kind: 'pre_auth',
    attachments_count: 3,
  },
  submission_queued: {
    submission_id: UUID_A,
    interface_id: UUID_B,
  },
  submission_sent: {
    submission_id: UUID_A,
    interface_id: UUID_B,
    message_id: 'gmail:abc123',
  },
  submission_failed: {
    submission_id: UUID_A,
    error: 'gmail_auth_expired',
  },
  query_raised: {
    query_id: UUID_A,
    deficiency_type: 'missing_discharge_slip',
    raised_at: ISO,
    deadline: ISO,
  },
  query_resolved: {
    query_id: UUID_A,
    resolved_at: ISO,
    resolved_by: 'user:42',
    resolution_doc_section_id: UUID_B,
  },
  adjudication_run: {
    report_id: UUID_A,
    target_stage: 'pre_auth_submitted',
    readiness: 0.88,
    blocking_gaps_count: 0,
    warnings_count: 2,
  },
  claim_action_dispatched: {
    action_id: UUID_A,
    action_kind: 'whatsapp_notification',
    target: 'group:ops-rajiv',
    payload_summary: 'pre-auth #123 approved',
  },
  claim_action_acked: {
    action_id: UUID_A,
    acked_by: 'user:42',
    response: { thumbs_up: true },
  },
  claim_action_declined: {
    action_id: UUID_A,
    declined_by: 'user:42',
    reason: 'wrong_patient',
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────

describe('EventDispatcher.dispatch — payload validation', () => {
  let state: MockState;
  let dispatcher: EventDispatcher;

  beforeEach(() => {
    state = freshState();
    // Insert returns one row by default.
    state.defaultResponse = { rows: [{ id: UUID_D }], rowCount: 1 };
    dispatcher = new EventDispatcher(makeMockPool(state));
  });

  it('inserts when kind + payload are valid', async () => {
    const result = await dispatcher.dispatch({
      kind: 'claim_created',
      claimId: UUID_A,
      hospitalId: UUID_B,
      actorUserId: UUID_C,
      payload: { initial_stage: 'pre_auth_drafted' },
    });

    assert.equal(result.id, UUID_D);
    assert.equal(result.deduped, false);
    assert.equal(state.calls.length, 1, 'expected exactly one DB call');
    assert.match(
      state.calls[0]!.sql,
      /INSERT INTO hospital\.submission_events/,
    );
    // claim_id, hospital_id, kind, event_type, payload, actor, correlation_id,
    // insurance_submission_id (reuses claim_id)
    const params = state.calls[0]!.params;
    assert.equal(params[0], UUID_A);
    assert.equal(params[1], UUID_B);
    assert.equal(params[2], 'claim_created');
    assert.equal(params[3], 'claim_created');
    assert.equal(params[5], UUID_C);
  });

  it('throws InvalidEventPayloadError when payload is bad', async () => {
    await assert.rejects(
      () =>
        dispatcher.dispatch({
          kind: 'doc_uploaded',
          claimId: UUID_A,
          // missing document_id, doc_count_pages, uploaded_by
          payload: {} as any,
        }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidEventPayloadError);
        assert.equal(err.kind, 'doc_uploaded');
        assert.ok(err.issues.length > 0);
        return true;
      },
    );
    assert.equal(
      state.calls.length,
      0,
      'no DB calls should be made when validation fails',
    );
  });

  it('throws InvalidEventPayloadError when a nested field is wrong type', async () => {
    await assert.rejects(
      () =>
        dispatcher.dispatch({
          kind: 'section_classified',
          claimId: UUID_A,
          payload: {
            section_id: UUID_B,
            category: 'discharge_slip',
            confidence: 'high' as any, // should be number
            classifier_version: 'v1',
          } as any,
        }),
      InvalidEventPayloadError,
    );
    assert.equal(state.calls.length, 0);
  });

  it('throws UnknownEventKindError for an unknown kind', async () => {
    await assert.rejects(
      () =>
        dispatcher.dispatch({
          // forced through `any` — at runtime a JS caller could pass anything
          kind: 'totally_made_up_kind' as any,
          claimId: UUID_A,
          payload: {} as any,
        }),
      (err: unknown) => {
        assert.ok(err instanceof UnknownEventKindError);
        assert.equal((err as UnknownEventKindError).kind, 'totally_made_up_kind');
        return true;
      },
    );
    assert.equal(state.calls.length, 0);
  });
});

describe('EventDispatcher.dispatch — idempotency', () => {
  it('returns deduped=true when ON CONFLICT swallows the insert', async () => {
    const state = freshState();
    // First call: INSERT ... ON CONFLICT DO NOTHING — returns zero rows
    // because the partial UNIQUE caught it.
    state.queueByPattern.push({
      match: (sql) => /INSERT INTO hospital\.submission_events/.test(sql),
      response: { rows: [], rowCount: 0 },
    });
    // Follow-up SELECT for the existing id.
    state.queueByPattern.push({
      match: (sql) => /SELECT id\s+FROM hospital\.submission_events/.test(sql),
      response: { rows: [{ id: UUID_D }], rowCount: 1 },
    });

    const dispatcher = new EventDispatcher(makeMockPool(state));
    const result = await dispatcher.dispatch({
      kind: 'ai_draft_created',
      claimId: UUID_A,
      idempotencyKey: 'ai_draft_created:' + UUID_B,
      payload: CANONICAL_PAYLOADS.ai_draft_created as any,
    });

    assert.equal(result.id, UUID_D);
    assert.equal(result.deduped, true);
    assert.equal(state.calls.length, 2, 'expected INSERT then SELECT');
    assert.match(state.calls[0]!.sql, /INSERT/);
    assert.match(state.calls[1]!.sql, /SELECT id/);
  });

  it('returns deduped=false when ON CONFLICT fires the insert normally', async () => {
    const state = freshState();
    state.queueByPattern.push({
      match: (sql) => /INSERT INTO hospital\.submission_events/.test(sql),
      response: { rows: [{ id: UUID_D }], rowCount: 1 },
    });

    const dispatcher = new EventDispatcher(makeMockPool(state));
    const result = await dispatcher.dispatch({
      kind: 'ai_draft_created',
      claimId: UUID_A,
      idempotencyKey: 'ai_draft_created:' + UUID_B,
      payload: CANONICAL_PAYLOADS.ai_draft_created as any,
    });

    assert.equal(result.id, UUID_D);
    assert.equal(result.deduped, false);
    assert.equal(
      state.calls.length,
      1,
      'no follow-up SELECT when the INSERT returned a row',
    );
  });

  it('uses the no-idempotency-key insert path when no key is provided', async () => {
    const state = freshState();
    state.defaultResponse = { rows: [{ id: UUID_D }], rowCount: 1 };

    const dispatcher = new EventDispatcher(makeMockPool(state));
    const result = await dispatcher.dispatch({
      kind: 'inbound_email_received',
      claimId: UUID_A,
      payload: CANONICAL_PAYLOADS.inbound_email_received as any,
    });

    assert.equal(result.deduped, false);
    assert.equal(state.calls.length, 1);
    // No ON CONFLICT on this branch.
    assert.doesNotMatch(state.calls[0]!.sql, /ON CONFLICT/);
  });

  it('surfaces a clear error when conflict-then-missing-row race occurs', async () => {
    const state = freshState();
    // INSERT returns 0 rows (conflict swallowed).
    state.queueByPattern.push({
      match: (sql) => /INSERT INTO hospital\.submission_events/.test(sql),
      response: { rows: [], rowCount: 0 },
    });
    // SELECT also returns 0 rows (the prior row vanished — race).
    state.queueByPattern.push({
      match: (sql) => /SELECT id/.test(sql),
      response: { rows: [], rowCount: 0 },
    });

    const dispatcher = new EventDispatcher(makeMockPool(state));
    await assert.rejects(
      () =>
        dispatcher.dispatch({
          kind: 'claim_created',
          claimId: UUID_A,
          idempotencyKey: 'key-1',
          payload: { initial_stage: 'pre_auth_drafted' },
        }),
      /conflict swallowed but prior row missing/,
    );
  });
});

describe('EventDispatcher — exhaustive kind coverage', () => {
  it('has a canonical payload for every EventKind (test self-check)', () => {
    for (const kind of EVENT_KINDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(CANONICAL_PAYLOADS, kind),
        `missing canonical payload for kind: ${kind}`,
      );
    }
  });

  it('every kind parses its canonical payload via its schema', () => {
    for (const kind of EVENT_KINDS) {
      const schema = EVENT_PAYLOAD_SCHEMAS[kind];
      const result = schema.safeParse(CANONICAL_PAYLOADS[kind]);
      assert.ok(
        result.success,
        `canonical payload for '${kind}' failed validation: ` +
          (result.success
            ? ''
            : result.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')),
      );
    }
  });

  it('dispatches every kind end-to-end through the mock pool', async () => {
    const state = freshState();
    state.defaultResponse = { rows: [{ id: UUID_D }], rowCount: 1 };
    const dispatcher = new EventDispatcher(makeMockPool(state));

    for (const kind of EVENT_KINDS) {
      const result = await dispatcher.dispatch({
        kind,
        claimId: UUID_A,
        payload: CANONICAL_PAYLOADS[kind] as any,
      });
      assert.equal(result.id, UUID_D, `dispatch failed for kind: ${kind}`);
      assert.equal(result.deduped, false);
    }
    assert.equal(state.calls.length, EVENT_KINDS.length);
  });
});

describe('EventDispatcher — correlation + actor passthrough', () => {
  it('passes correlation_id and actor_user_id to the INSERT', async () => {
    const state = freshState();
    state.defaultResponse = { rows: [{ id: UUID_D }], rowCount: 1 };
    const dispatcher = new EventDispatcher(makeMockPool(state));

    await dispatcher.dispatch({
      kind: 'stage_transitioned',
      claimId: UUID_A,
      actorUserId: UUID_B,
      correlationId: UUID_C,
      payload: CANONICAL_PAYLOADS.stage_transitioned as any,
    });

    const params = state.calls[0]!.params;
    // (claim_id, hospital_id, kind, event_type, payload, actor, correlation_id, ...)
    assert.equal(params[0], UUID_A); // claim_id
    assert.equal(params[5], UUID_B); // actor
    assert.equal(params[6], UUID_C); // correlation_id
  });
});
