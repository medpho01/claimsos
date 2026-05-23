/**
 * Unit tests for the pure claim-dossier projector.
 *
 * Uses Node's built-in `node:test` runner — matches the convention set by
 * src/Services/__tests__/ocr.service.test.ts. Run with:
 *
 *     npx tsx --test src/Services/__tests__/claimDossierProjector.test.ts
 *
 * The projector is pure (no I/O, no module mocks needed), so tests just feed
 * synthetic events through `applyEvent` / `blankDossier` and assert on the
 * resulting ClaimDossier shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvent,
  blankDossier,
  ClaimDossier,
  SubmissionEventRow,
} from '../claimDossierProjector.service.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const CLAIM_ID = '11111111-1111-1111-1111-111111111111';

let evtCounter = 0;
function evt(
  kind: string,
  payload: Record<string, unknown> = {},
  opts: { id?: string; at?: Date; actor?: string | null } = {}
): SubmissionEventRow {
  evtCounter += 1;
  return {
    id: opts.id ?? `event-${evtCounter.toString().padStart(4, '0')}`,
    kind,
    payload,
    actor: opts.actor ?? 'system',
    created_at: opts.at ?? new Date(2026, 4, 18, 9, 0, evtCounter), // monotonic
  };
}

function freshDossier(): ClaimDossier {
  evtCounter = 0;
  return blankDossier(CLAIM_ID);
}

// ────────────────────────────────────────────────────────────────────────────
// Per-event tests
// ────────────────────────────────────────────────────────────────────────────

test('claim_created sets stage, panel, insurer, patient_summary, amounts', () => {
  const d = freshDossier();
  const next = applyEvent(
    d,
    evt('claim_created', {
      initial_stage: 'pre_auth_drafted',
      panel_id: 'panel-1',
      insurer_id: 'insurer-1',
      patient_summary: { name: 'Asha', uhid: 'U-1' },
      claimed: 50000,
    })
  );
  assert.equal(next.current_stage, 'pre_auth_drafted');
  assert.equal(next.current_panel_id, 'panel-1');
  assert.equal(next.current_insurer_id, 'insurer-1');
  assert.deepEqual(next.patient_summary, { name: 'Asha', uhid: 'U-1' });
  assert.deepEqual(next.amounts, { claimed: 50000 });
  assert.equal(next.version, 1);
  assert.equal(next.events_summary.length, 1);
});

test('stage_transitioned updates current_stage and records salient from/to', () => {
  const d = freshDossier();
  const a = applyEvent(d, evt('claim_created', { initial_stage: 'pre_auth_drafted' }));
  const b = applyEvent(
    a,
    evt('stage_transitioned', { from: 'pre_auth_drafted', to: 'pre_auth_sent' })
  );
  assert.equal(b.current_stage, 'pre_auth_sent');
  assert.equal(b.events_summary.length, 2);
  assert.deepEqual(b.events_summary[1]!.salient, {
    from: 'pre_auth_drafted',
    to: 'pre_auth_sent',
  });
});

test('claim_closed sets closed_at, closure_outcome and retrospective_summary', () => {
  const d = freshDossier();
  const e = evt('claim_closed', { outcome: 'settled', summary: { net: 45000 } });
  const next = applyEvent(d, e);
  assert.equal(next.closure_outcome, 'settled');
  assert.deepEqual(next.retrospective_summary, { net: 45000 });
  assert.equal(next.closed_at, e.created_at);
});

test('doc_uploaded and doc_segmented append to events_summary but no sections', () => {
  const d = freshDossier();
  const a = applyEvent(d, evt('doc_uploaded', { doc_id: 'doc-1', file_name: 'a.pdf' }));
  const b = applyEvent(a, evt('doc_segmented', { doc_id: 'doc-1', section_count: 3 }));
  assert.equal(b.events_summary.length, 2);
  assert.equal(b.doc_sections_by_category, null);
});

test('section_classified accumulates section_ids per category, no duplicates', () => {
  const d = freshDossier();
  const a = applyEvent(
    d,
    evt('section_classified', { category: 'discharge_summary', section_id: 's1' })
  );
  const b = applyEvent(
    a,
    evt('section_classified', { category: 'discharge_summary', section_id: 's2' })
  );
  const c = applyEvent(
    b,
    evt('section_classified', { category: 'investigations', section_id: 's3' })
  );
  // Same section_id again should not duplicate.
  const dup = applyEvent(
    c,
    evt('section_classified', { category: 'discharge_summary', section_id: 's1' })
  );
  assert.deepEqual(dup.doc_sections_by_category, {
    discharge_summary: ['s1', 's2'],
    investigations: ['s3'],
  });
});

test('inbound_email_received and _matched both push to inbound_emails with matched flag', () => {
  const d = freshDossier();
  const a = applyEvent(
    d,
    evt('inbound_email_received', { inbound_id: 'in-1', subject: 'Query' })
  );
  const b = applyEvent(
    a,
    evt('inbound_email_matched', { inbound_id: 'in-1', confidence: 0.92 })
  );
  assert.equal(b.inbound_emails.length, 2);
  assert.equal(b.inbound_emails[0]!.matched, false);
  assert.equal(b.inbound_emails[1]!.matched, true);
  assert.equal(b.inbound_emails[1]!.match_confidence, 0.92);
});

test('ai_draft_created pushes draft; ai_draft_applied removes it', () => {
  const d = freshDossier();
  const a = applyEvent(
    d,
    evt('ai_draft_created', { draft_id: 'dr-1', kind: 'reply_to_query', preview: 'Hi…' })
  );
  assert.equal(a.ai_drafts_pending.length, 1);
  const b = applyEvent(a, evt('ai_draft_applied', { draft_id: 'dr-1' }));
  assert.equal(b.ai_drafts_pending.length, 0);
});

test('ai_draft_rejected removes the matching draft and leaves others alone', () => {
  const d = freshDossier();
  const a = applyEvent(d, evt('ai_draft_created', { draft_id: 'dr-1', kind: 'k' }));
  const b = applyEvent(a, evt('ai_draft_created', { draft_id: 'dr-2', kind: 'k' }));
  const c = applyEvent(b, evt('ai_draft_rejected', { draft_id: 'dr-1' }));
  assert.equal(c.ai_drafts_pending.length, 1);
  assert.equal(c.ai_drafts_pending[0]!.draft_id, 'dr-2');
});

test('submission_drafted / queued / sent / failed all log to outbound_submissions', () => {
  const d = freshDossier();
  let cur: ClaimDossier = d;
  for (const kind of [
    'submission_drafted',
    'submission_queued',
    'submission_sent',
    'submission_failed',
  ]) {
    cur = applyEvent(cur, evt(kind, { email_outbound_id: 'em-1' }));
  }
  assert.equal(cur.outbound_submissions.length, 4);
  assert.equal(cur.outbound_submissions[0]!.status, 'drafted');
  assert.equal(cur.outbound_submissions[3]!.status, 'failed');
});

test('query_raised pushes; query_resolved removes by query_id', () => {
  const d = freshDossier();
  const a = applyEvent(
    d,
    evt('query_raised', {
      query_id: 'q-1',
      question: 'Send discharge summary',
      deficiency_type: 'missing_discharge_summary',
    })
  );
  assert.equal(a.active_queries.length, 1);
  assert.equal(a.active_queries[0]!.deficiency_type, 'missing_discharge_summary');
  const b = applyEvent(a, evt('query_resolved', { query_id: 'q-1' }));
  assert.equal(b.active_queries.length, 0);
});

test('adjudication_run replaces active_adjudication and merges matched_kb_patterns', () => {
  const d = freshDossier();
  const pattern1 = '22222222-2222-2222-2222-222222222222';
  const pattern2 = '33333333-3333-3333-3333-333333333333';
  const a = applyEvent(
    d,
    evt('adjudication_run', {
      report: { verdict: 'likely_approval', confidence: 0.8 },
      matched_kb_patterns: [pattern1],
      verdict: 'likely_approval',
      confidence: 0.8,
    })
  );
  assert.deepEqual(a.active_adjudication, {
    verdict: 'likely_approval',
    confidence: 0.8,
  });
  assert.deepEqual(a.matched_kb_patterns, [pattern1]);
  const b = applyEvent(
    a,
    evt('adjudication_run', {
      report: { verdict: 'partial_deduction', confidence: 0.6 },
      matched_kb_patterns: [pattern2],
    })
  );
  // Replaced, not appended.
  assert.deepEqual(b.active_adjudication, {
    verdict: 'partial_deduction',
    confidence: 0.6,
  });
  // Patterns unioned.
  assert.deepEqual(b.matched_kb_patterns.sort(), [pattern1, pattern2].sort());
});

test('claim_action_dispatched / acked / declined manage pending_actions list', () => {
  const d = freshDossier();
  const a = applyEvent(
    d,
    evt('claim_action_dispatched', {
      action_id: 'ax-1',
      kind: 'rpa_upload_to_ihx',
      target: 'ihx',
      payload: { doc_count: 5 },
    })
  );
  assert.equal(a.pending_actions.length, 1);
  const b = applyEvent(a, evt('claim_action_acked', { action_id: 'ax-1' }));
  assert.equal(b.pending_actions.length, 0);
  const c = applyEvent(
    b,
    evt('claim_action_dispatched', { action_id: 'ax-2', kind: 'k' })
  );
  const d2 = applyEvent(c, evt('claim_action_declined', { action_id: 'ax-2' }));
  assert.equal(d2.pending_actions.length, 0);
});

test('unknown event kinds no-op but record a warning in events_summary', () => {
  const d = freshDossier();
  const next = applyEvent(d, evt('totally_made_up_event', { foo: 'bar' }));
  assert.equal(next.events_summary.length, 1);
  const entry = next.events_summary[0]!;
  assert.ok(
    entry.salient && typeof entry.salient.warning === 'string',
    'unknown event records warning'
  );
  assert.match(
    entry.salient!.warning as string,
    /unknown_event_kind:totally_made_up_event/
  );
});

// ────────────────────────────────────────────────────────────────────────────
// End-to-end fold sequence
// ────────────────────────────────────────────────────────────────────────────

test('fold: typical pre-auth → query → adjudication → close sequence', () => {
  let d = freshDossier();
  d = applyEvent(
    d,
    evt('claim_created', {
      initial_stage: 'pre_auth_drafted',
      panel_id: 'panel-1',
      claimed: 80000,
      patient_summary: { name: 'Ravi', uhid: 'U-9' },
    })
  );
  d = applyEvent(d, evt('doc_uploaded', { doc_id: 'doc-1' }));
  d = applyEvent(d, evt('doc_segmented', { doc_id: 'doc-1', section_count: 2 }));
  d = applyEvent(
    d,
    evt('section_classified', { category: 'discharge_summary', section_id: 's1' })
  );
  d = applyEvent(d, evt('submission_drafted', { email_outbound_id: 'em-1' }));
  d = applyEvent(d, evt('submission_sent', { email_outbound_id: 'em-1' }));
  d = applyEvent(
    d,
    evt('stage_transitioned', { from: 'pre_auth_drafted', to: 'pre_auth_sent' })
  );
  d = applyEvent(d, evt('inbound_email_received', { inbound_id: 'in-1' }));
  d = applyEvent(
    d,
    evt('query_raised', { query_id: 'q-1', question: 'Resend OT notes' })
  );
  d = applyEvent(d, evt('query_resolved', { query_id: 'q-1' }));
  d = applyEvent(
    d,
    evt('adjudication_run', { report: { verdict: 'likely_approval' } })
  );
  d = applyEvent(d, evt('claim_closed', { outcome: 'settled' }));

  assert.equal(d.current_stage, 'pre_auth_sent');
  assert.equal(d.closure_outcome, 'settled');
  assert.equal(d.active_queries.length, 0);
  assert.equal(d.outbound_submissions.length, 2);
  assert.equal(d.events_summary.length, 12);
  assert.equal(d.version, 12);
});

// ────────────────────────────────────────────────────────────────────────────
// Idempotency
// ────────────────────────────────────────────────────────────────────────────

test('idempotency: re-applying the same event.id is a no-op', () => {
  const d = freshDossier();
  const e = evt('query_raised', { query_id: 'q-1', question: 'Send docs' });
  const once = applyEvent(d, e);
  const twice = applyEvent(once, e);
  assert.strictEqual(once, twice, 'returns same reference (no-op)');
  assert.equal(twice.active_queries.length, 1);
  assert.equal(twice.version, 1);
});

test('idempotency: re-applying section_classified with the same section_id does not duplicate', () => {
  const d = freshDossier();
  const e1 = evt('section_classified', { category: 'oth', section_id: 'sec-1' });
  const e2 = evt('section_classified', { category: 'oth', section_id: 'sec-1' });
  const a = applyEvent(d, e1);
  const b = applyEvent(a, e2);
  assert.deepEqual(b.doc_sections_by_category, { oth: ['sec-1'] });
});

test('out-of-order: event older than last_event_at is dropped', () => {
  const d = freshDossier();
  const newer = evt(
    'doc_uploaded',
    { doc_id: 'doc-1' },
    { at: new Date(2026, 4, 18, 12, 0, 0) }
  );
  const older = evt(
    'doc_uploaded',
    { doc_id: 'doc-0' },
    { at: new Date(2026, 4, 18, 9, 0, 0) }
  );
  const a = applyEvent(d, newer);
  const b = applyEvent(a, older);
  assert.strictEqual(a, b, 'older event is a no-op');
});
