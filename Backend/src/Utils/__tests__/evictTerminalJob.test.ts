/**
 * Regression cover for the silent resume no-op.
 *
 * Bull's `add()` does nothing when a job with the same jobId already exists —
 * including one that has already COMPLETED. Our queues keep completed jobs
 * (`removeOnComplete: <n>`) for the life of a claim run, and both
 * `claimAiRunService.resumeRun()` and `claimRunReconciler` re-drive a stranded
 * document under its original deterministic jobId.
 *
 * The result was measured end to end: a run paused for cost consent, the user
 * approved more budget, resume reported `docs_reenqueued: 1` — and nothing ran.
 * ₹0 spent, the blocked pages never read, and the user could keep approving
 * for ever. No error was raised anywhere.
 *
 * `evictTerminalJob` removes a job only when it is in a terminal state, so the
 * re-drive lands while genuine in-flight de-duplication still works.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evictTerminalJob } from '../queueRedis.js';

function fakeJob(state: 'completed' | 'failed' | 'waiting' | 'active') {
  let removed = false;
  return {
    isCompleted: async () => state === 'completed',
    isFailed: async () => state === 'failed',
    remove: async () => {
      removed = true;
    },
    get removed() {
      return removed;
    },
  };
}

const queueWith = (job: any) => ({ getJob: async () => job });

describe('evictTerminalJob', () => {
  test('removes a COMPLETED job so a re-drive can be enqueued', async () => {
    const job = fakeJob('completed');
    const evicted = await evictTerminalJob(queueWith(job), 'bundle-classify:doc-1');
    assert.equal(evicted, true, 'should report that it evicted');
    assert.equal(job.removed, true, 'the stale completed job must be removed');
  });

  test('removes a FAILED job — a permanently failed job must not block retry', async () => {
    const job = fakeJob('failed');
    const evicted = await evictTerminalJob(queueWith(job), 'extract:sec-1');
    assert.equal(evicted, true);
    assert.equal(job.removed, true);
  });

  test('leaves an ACTIVE job alone — collapsing against in-flight work is intended', async () => {
    const job = fakeJob('active');
    const evicted = await evictTerminalJob(queueWith(job), 'bundle-classify:doc-2');
    assert.equal(evicted, false);
    assert.equal(job.removed, false, 'must never remove work that is running');
  });

  test('leaves a WAITING job alone — the queued copy is the de-dup we want', async () => {
    const job = fakeJob('waiting');
    const evicted = await evictTerminalJob(queueWith(job), 'extract:sec-2');
    assert.equal(evicted, false);
    assert.equal(job.removed, false);
  });

  test('no job under that id is a no-op, not an error', async () => {
    const evicted = await evictTerminalJob({ getJob: async () => null }, 'nope');
    assert.equal(evicted, false);
  });

  test('a throwing queue never breaks the enqueue path', async () => {
    const evicted = await evictTerminalJob(
      {
        getJob: async () => {
          throw new Error('redis down');
        },
      },
      'bundle-classify:doc-3',
    );
    assert.equal(evicted, false, 'swallows and degrades to the old collapse behaviour');
  });
});
