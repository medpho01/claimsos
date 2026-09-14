/**
 * Run control — the mid-run cost-consent gate (§B.6 / §D.4 / §E.3-E.5).
 *
 * WHY THIS FILE EXISTS.
 *
 * Everything else about consent was proven end to end — the pre-flight 428,
 * the out-of-range refusal, the stale-token 409, pause/resume across three OS
 * processes — and yet the gate did not hold, because of two defects that were
 * invisible to every one of those proofs.
 *
 *   1. `pauseForConsent` ALWAYS THREW. Its UPDATE referenced `$1, $3, $4`
 *      while FOUR values were passed, so `$2` was never referenced and
 *      Postgres could not infer its type: `42P18 could not determine data
 *      type of parameter $2`, on every single call. All three call sites wrap
 *      the call in try/catch and log, so the throw was swallowed; the run
 *      stayed `status=running, pause_reason=NULL`; `isRunHalted` kept
 *      answering `halted:false`; and the run carried on spending past the
 *      budget its user had approved. The mid-run half of consent had never
 *      worked once.
 *
 *      A mock pool cannot catch that — a mock happily accepts a statement no
 *      database would. So the test below asserts the ONE invariant the bug
 *      violated (every bound value is referenced by the text), and, when a
 *      throwaway database is offered, actually executes the statement.
 *
 *   2. Resume DELETED unreadable markers. See the RELEASING UNREADABLE
 *      MARKERS note in claimAiRun.service.ts. The tests here pin the two
 *      halves of the replacement rule: markers on documents this resume is
 *      NOT re-driving are left standing, and the ones it does release are
 *      archived — with their ORIGINAL detected_at — before they go.
 *
 * ── Running the database half ──────────────────────────────────────────────
 * It is OPT-IN and skipped everywhere by default, because it writes rows.
 * Point it at a throwaway database (it refuses to run against one named like
 * production) that has been migrated:
 *
 *   POSTGRES_DB=claimsos_runctl_verify npm run migrate:up
 *   RUN_CONTROL_DB_TESTS=1 POSTGRES_HOST=localhost \
 *     POSTGRES_DB=claimsos_runctl_verify \
 *     npx tsx --test src/Services/__tests__/runControl.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import claimAiRunService, {
  buildPauseForConsentQuery,
  RUN_AUDIT_ENTITY_TYPE,
  UNREADABLE_RELEASED_AUDIT_ACTION,
  type ClaimAiRunRow,
} from '../claimAiRun.service.js';

// ────────────────────────────────────────────────────────────────────────────
// 1. The statement itself — no database required.
// ────────────────────────────────────────────────────────────────────────────

/** Every `$n` the text mentions. */
function referencedParams(text: string): Set<number> {
  return new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
}

test('pauseForConsent: every bound value is referenced by the statement', () => {
  // The EXACT argument shape docExtractor / docClassifier / docBundleClassifier
  // pass. This is the bug: four values, three referenced, and the unreferenced
  // one is an untypeable parameter that fails the whole statement.
  const q = buildPauseForConsentQuery({
    run_id: '00000000-0000-4000-8000-0000000000aa',
    claim_id: '00000000-0000-4000-8000-0000000000bb',
    spend_inr: 42.5,
    projected_remaining_inr: 17.25,
  });

  const refs = referencedParams(q.text);

  for (let i = 1; i <= q.values.length; i++) {
    assert.ok(
      refs.has(i),
      `$${i} is bound but never referenced — Postgres cannot infer its type ` +
        `and the statement fails with 42P18. This is exactly the defect that ` +
        `made every mid-run pause a silent no-op.`,
    );
  }
  for (const n of refs) {
    assert.ok(
      n >= 1 && n <= q.values.length,
      `$${n} is referenced but not bound (only ${q.values.length} values passed)`,
    );
  }
});

test('pauseForConsent: claim_id is not a parameter, and the guard survives', () => {
  const claimId = '00000000-0000-4000-8000-0000000000bb';
  const q = buildPauseForConsentQuery({
    run_id: '00000000-0000-4000-8000-0000000000aa',
    claim_id: claimId,
    spend_inr: 1,
    projected_remaining_inr: 2,
  });

  // claim_id is deliberately absent: making it part of the predicate would
  // turn a stale caller-supplied claim_id into a SILENT failure to pause.
  assert.ok(
    !q.values.includes(claimId),
    'claim_id must not be bound — it is neither set nor matched on',
  );
  assert.deepEqual(q.values, [
    '00000000-0000-4000-8000-0000000000aa',
    1,
    2,
  ]);

  // The guard is what makes a double-pause a no-op rather than a race.
  assert.match(q.text, /status\s+IN\s+\('queued','running'\)/);
  assert.match(q.text, /pause_reason\s+=\s+'cost_consent_required'/);
  assert.match(q.text, /RETURNING \*/);
});

test('pauseForConsent: non-finite money is coerced to 0, never sent as NaN', () => {
  const q = buildPauseForConsentQuery({
    run_id: '00000000-0000-4000-8000-0000000000aa',
    claim_id: '00000000-0000-4000-8000-0000000000bb',
    spend_inr: Number.NaN,
    projected_remaining_inr: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(q.values.slice(1), [0, 0]);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. The pause guard in recomputeFromState.
//
// recomputeFromState is the pipeline's self-healing mechanism: a stall sweep,
// an orphan re-enqueuer and a harmoniser auto-heal, all of which exist to push
// a stuck run forward. During a deliberate pause that is precisely wrong — the
// FE polls /status, /status calls recompute, and within one poll cycle the run
// the user just paused would be re-enqueued and would carry on spending.
// ────────────────────────────────────────────────────────────────────────────

function fakeRun(status: ClaimAiRunRow['status']): ClaimAiRunRow {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    claim_id: '00000000-0000-4000-8000-0000000000bb',
    triggered_by: null,
    triggered_at: new Date().toISOString(),
    status,
    phase: 'extract',
    total_docs: 3,
    docs_completed: 1,
    docs_failed: 0,
    cost_inr: 12,
    finished_at: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pause_reason: status === 'paused' ? 'cost_consent_required' : null,
    paused_at: status === 'paused' ? new Date().toISOString() : null,
    paused_by: null,
    approved_budget_inr: 50,
    budget_approved_by: null,
    budget_approved_at: null,
    spend_at_pause_inr: 50,
    projected_remaining_inr: 30,
    resume_count: 0,
    estimate: null,
    end_reason: null,
    unreadable_acknowledged_at: null,
    unreadable_acknowledged_by: null,
  };
}

test('recomputeFromState returns a paused run UNCHANGED and does nothing else', async () => {
  const svc = claimAiRunService as any;
  const original = svc.getLatestRun;
  const paused = fakeRun('paused');
  svc.getLatestRun = async () => paused;
  try {
    const out = await claimAiRunService.recomputeFromState(paused.claim_id);
    // Reference equality: the guard hands back the very row it read. Anything
    // that fell through would have re-read, recomputed and returned a
    // different object (and touched the database on the way).
    assert.equal(
      out,
      paused,
      'a paused run must be returned untouched — falling through re-enqueues ' +
        'work during a pause and the run carries on spending',
    );
  } finally {
    svc.getLatestRun = original;
  }
});

test('recomputeFromState returns a terminal run UNCHANGED too', async () => {
  const svc = claimAiRunService as any;
  const original = svc.getLatestRun;
  const done = fakeRun('succeeded');
  svc.getLatestRun = async () => done;
  try {
    const out = await claimAiRunService.recomputeFromState(done.claim_id);
    assert.equal(out, done);
  } finally {
    svc.getLatestRun = original;
  }
});

test('recomputeFromState returns null when the claim has no run', async () => {
  const svc = claimAiRunService as any;
  const original = svc.getLatestRun;
  svc.getLatestRun = async () => null;
  try {
    assert.equal(await claimAiRunService.recomputeFromState('nope'), null);
  } finally {
    svc.getLatestRun = original;
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 3. The audit contract for released markers.
// ────────────────────────────────────────────────────────────────────────────

test('the released-marker archive keys are stable', () => {
  // These two strings are how anyone ever finds out what a resume released.
  // Changing them orphans every archive row already written.
  assert.equal(
    UNREADABLE_RELEASED_AUDIT_ACTION,
    'claim_ai_run.resume.unreadable_released',
  );
  assert.equal(RUN_AUDIT_ENTITY_TYPE, 'claim_ai_run');
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Against a real Postgres. OPT-IN — see the header.
// ────────────────────────────────────────────────────────────────────────────

const DB_TESTS = process.env.RUN_CONTROL_DB_TESTS === '1';
const DB_NAME = process.env.POSTGRES_DB ?? '';
const DB_LOOKS_PRODUCTIONISH = /prod|live/i.test(DB_NAME);

async function withDb<T>(fn: (pool: any) => Promise<T>): Promise<T> {
  const { pool } = await import('../../DB/db.js');
  return fn(pool);
}

test('pauseForConsent: the real statement runs on a real Postgres', async (t) => {
  if (!DB_TESTS) return t.skip('set RUN_CONTROL_DB_TESTS=1 to run');
  if (DB_LOOKS_PRODUCTIONISH) {
    return t.skip(`refusing to write to a database named "${DB_NAME}"`);
  }

  await withDb(async (pool) => {
    const claimId = randomUUID();
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO hospital.claim_ai_runs
         (id, claim_id, status, phase, total_docs, docs_completed, docs_failed,
          approved_budget_inr)
       VALUES ($1, $2, 'running', 'extract', 2, 0, 0, 50)`,
      [runId, claimId],
    );

    const paused = await claimAiRunService.pauseForConsent({
      run_id: runId,
      claim_id: claimId,
      spend_inr: 50.25,
      projected_remaining_inr: 31.5,
    });

    assert.ok(paused, 'pauseForConsent returned null — the pause did not take');
    assert.equal(paused!.status, 'paused');
    assert.equal(paused!.pause_reason, 'cost_consent_required');
    assert.equal(Number(paused!.spend_at_pause_inr), 50.25);
    assert.equal(Number(paused!.projected_remaining_inr), 31.5);

    // The whole point: the workers must now SEE the pause.
    claimAiRunService.invalidateHaltMemo(runId);
    const halt = await claimAiRunService.isRunHalted(runId);
    assert.equal(halt.halted, true, 'isRunHalted must see the pause');
    assert.equal(halt.pauseReason, 'cost_consent_required');

    // A second worker hitting the budget in the same moment is a no-op, not
    // an error and not a second pause.
    const again = await claimAiRunService.pauseForConsent({
      run_id: runId,
      claim_id: claimId,
      spend_inr: 51,
      projected_remaining_inr: 30,
    });
    assert.equal(again, null);

    await pool.query('DELETE FROM hospital.claim_ai_runs WHERE id = $1', [runId]);
  });
});

test('resume: releases only what it re-drives, and archives before it does', async (t) => {
  if (!DB_TESTS) return t.skip('set RUN_CONTROL_DB_TESTS=1 to run');
  if (DB_LOOKS_PRODUCTIONISH) {
    return t.skip(`refusing to write to a database named "${DB_NAME}"`);
  }

  await withDb(async (pool) => {
    const claimId = randomUUID();
    const runId = randomUUID();
    const docRedriven = randomUUID();
    const docSettled = randomUUID();
    // Backdated, so we can prove the archive keeps the ORIGINAL timestamp —
    // the fact the old DELETE-then-reINSERT destroyed.
    const firstSeen = '2026-09-01T10:00:00.000Z';

    await pool.query(
      `INSERT INTO hospital.claim_ai_runs
         (id, claim_id, status, phase, total_docs, docs_completed, docs_failed,
          approved_budget_inr, pause_reason, paused_at, spend_at_pause_inr)
       VALUES ($1, $2, 'paused', 'extract', 2, 0, 0, 50,
               'cost_consent_required', NOW(), 50)`,
      [runId, claimId],
    );
    // One document with work the resume re-arms, one entirely settled.
    await pool.query(
      `INSERT INTO hospital.doc_phase_ledger (doc_id, run_id, phase, status)
       VALUES ($1, $3, 'extract', 'blocked'),
              ($2, $3, 'extract', 'done')`,
      [docRedriven, docSettled, runId],
    );
    await pool.query(
      `INSERT INTO hospital.claim_ai_unreadable_pages
         (run_id, doc_id, page_number, reason, detail, phase, detected_at)
       VALUES ($1, $2, 3, 'cost_budget',    'budget hit at page 3', 'extract', $4),
              ($1, $2, 4, 'latency_budget', 'deadline at page 4',   'extract', $4),
              ($1, $2, 9, 'render_failed',  'page would not render','ingest',  $4),
              ($1, $3, 2, 'cost_budget',    'budget hit at page 2', 'classify',$4)`,
      [runId, docRedriven, docSettled, firstSeen],
    );

    const out = await claimAiRunService.resumeRun({
      run_id: runId,
      approved_budget_inr: 120,
      budget_approved_by: null,
    });

    assert.equal(out.ok, true, `resume failed: ${out.error}`);
    assert.equal(out.resumed!.unreadable_markers_released, 2);
    assert.equal(out.resumed!.unreadable_markers_cleared, 2); // deprecated alias

    const live = await pool.query(
      `SELECT doc_id, page_number, reason, detected_at
         FROM hospital.claim_ai_unreadable_pages
        WHERE run_id = $1 ORDER BY doc_id, page_number`,
      [runId],
    );

    // render_failed on the re-driven doc: money does not fix a render.
    // cost_budget on the SETTLED doc: nothing is going to re-read it, so
    // dropping its marker would erase live blocked work from the summary.
    // Both must still be standing. The old blanket DELETE took the second one.
    const standing = live.rows
      .map((r: any) => `${r.doc_id === docRedriven ? 'A' : 'B'}${r.page_number}:${r.reason}`)
      .sort();
    assert.deepEqual(standing, ['A9:render_failed', 'B2:cost_budget']);
    assert.equal(out.resumed!.unreadable_markers_preserved, 2);

    // ...and the two that WERE released are in the archive, intact.
    const audit = await pool.query(
      `SELECT details FROM hospital.audit_logs
        WHERE entity_type = $1 AND entity_id = $2 AND action = $3`,
      [RUN_AUDIT_ENTITY_TYPE, runId, UNREADABLE_RELEASED_AUDIT_ACTION],
    );
    assert.equal(audit.rowCount, 1, 'resume must archive before it releases');
    const details = audit.rows[0].details;
    assert.equal(details.released_count, 2);
    assert.equal(details.resume_count, 1);
    assert.equal(Number(details.approved_budget_inr), 120);

    const archived = [...details.released].sort(
      (a: any, b: any) => a.page_number - b.page_number,
    );
    assert.deepEqual(
      archived.map((m: any) => [m.doc_id, m.page_number, m.reason, m.detail]),
      [
        [docRedriven, 3, 'cost_budget', 'budget hit at page 3'],
        [docRedriven, 4, 'latency_budget', 'deadline at page 4'],
      ],
    );
    for (const m of archived) {
      assert.equal(
        new Date(m.detected_at).toISOString(),
        firstSeen,
        'the archive must keep the ORIGINAL detected_at — "blocked since the ' +
          'first attempt" is the history the DELETE destroyed',
      );
    }

    // And the summary can say what the extra budget was spent releasing.
    const summary = await claimAiRunService.getUnreadableSummary(runId);
    assert.equal(summary!.released_pages_total, 2);
    assert.equal(summary!.unreadable_pages_total, 2);

    await pool.query('DELETE FROM hospital.audit_logs WHERE entity_id = $1', [runId]);
    await pool.query('DELETE FROM hospital.claim_ai_runs WHERE id = $1', [runId]);
  });
});

test('resume: a cost-consent pause cannot be lifted without more money', async (t) => {
  if (!DB_TESTS) return t.skip('set RUN_CONTROL_DB_TESTS=1 to run');
  if (DB_LOOKS_PRODUCTIONISH) {
    return t.skip(`refusing to write to a database named "${DB_NAME}"`);
  }

  await withDb(async (pool) => {
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO hospital.claim_ai_runs
         (id, claim_id, status, phase, total_docs, docs_completed, docs_failed,
          approved_budget_inr, pause_reason, paused_at)
       VALUES ($1, $2, 'paused', 'extract', 1, 0, 0, 50,
               'cost_consent_required', NOW())`,
      [runId, randomUUID()],
    );

    // Same budget: resuming would walk straight back into the same wall,
    // burn the re-read and pause again. Consent as theatre.
    const same = await claimAiRunService.resumeRun({
      run_id: runId,
      approved_budget_inr: 50,
    });
    assert.equal(same.ok, false);
    assert.equal(same.error, 'budget_not_increased');

    const none = await claimAiRunService.resumeRun({ run_id: runId });
    assert.equal(none.ok, false);
    assert.equal(none.error, 'budget_not_increased');

    // The run is still paused and its markers are untouched by a refusal.
    const still = await claimAiRunService.getRunById(runId);
    assert.equal(still!.status, 'paused');
    assert.equal(Number(still!.approved_budget_inr), 50);

    await pool.query('DELETE FROM hospital.claim_ai_runs WHERE id = $1', [runId]);
    await pool.end();
  });
});
