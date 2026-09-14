/**
 * phaseRecorder — the single way a worker writes a doc_phase_ledger row.
 *
 * The two behaviours worth pinning are the ones that decide whether a bug here
 * damages a pipeline run:
 *
 *   1. No active run  -> every call is a silent no-op. A system-triggered or
 *      legacy call must still do its work and simply leave no trail. Writing
 *      rows against a finished run would resurrect it in every progress view
 *      that counts unfinished phases.
 *
 *   2. A ledger failure never propagates. The ledger is an audit trail OF the
 *      work, not the work. A claim whose documents were classified but whose
 *      ledger write failed is recoverable; one whose classification was rolled
 *      back because an audit write failed is not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from '../ledger/phaseRecorder.js';

function makeDeps(opts: {
  run: { id: string; status: string } | null;
  ledgerThrows?: boolean;
  runLookupThrows?: boolean;
}) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record = (fn: string) => async (...args: unknown[]) => {
    calls.push({ fn, args });
    if (opts.ledgerThrows) throw new Error('ledger boom');
  };
  const deps = {
    getLatestRun: async () => {
      if (opts.runLookupThrows) throw new Error('lookup boom');
      return opts.run;
    },
    ledger: {
      startPhase: record('startPhase'),
      finishPhase: record('finishPhase'),
      skipPhase: record('skipPhase'),
      failPhase: record('failPhase'),
    },
  };
  return { deps, calls };
}

async function loadRecorder(opts: Parameters<typeof makeDeps>[0]) {
  const { deps, calls } = makeDeps(opts);
  return { mod, calls, deps };
}

describe('phaseRecorder', () => {
  it('writes through to the ledger when a run is active', async () => {
    const { calls, deps } = await loadRecorder({ run: { id: 'run-1', status: 'running' } });
    const rec = await mod.forClaim('claim-1', deps as any);
    assert.equal(rec.active, true);

    await rec.start('doc-1', 'dedup');
    await rec.finish('doc-1', 'dedup', { groups_found: 2 });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].fn, 'startPhase');
    assert.deepEqual(calls[0].args.slice(0, 3), ['doc-1', 'run-1', 'dedup']);
    assert.equal(calls[1].fn, 'finishPhase');
    assert.deepEqual(calls[1].args[3], { groups_found: 2 });
  });

  it('no-ops entirely when there is no run', async () => {
    const { calls, deps } = await loadRecorder({ run: null });
    const rec = await mod.forClaim('claim-1', deps as any);
    assert.equal(rec.active, false);
    await rec.start('doc-1', 'extract');
    await rec.finish('doc-1', 'extract');
    assert.equal(calls.length, 0);
  });

  it('no-ops when the run is already terminal', async () => {
    // Writing phase rows against a finished run would resurrect it.
    const { calls, deps } = await loadRecorder({ run: { id: 'run-1', status: 'completed' } });
    const rec = await mod.forClaim('claim-1', deps as any);
    assert.equal(rec.active, false);
    await rec.finish('doc-1', 'harmonise');
    assert.equal(calls.length, 0);
  });

  it('swallows a ledger write failure', async () => {
    const { deps } = await loadRecorder({
      run: { id: 'run-1', status: 'running' },
      ledgerThrows: true,
    });
    const rec = await mod.forClaim('claim-1', deps as any);
    // Must not reject — the caller's real work has already happened.
    await rec.finish('doc-1', 'extract');
    await rec.fail('doc-1', 'extract', 'boom');
  });

  it('degrades to a no-op when the run lookup itself throws', async () => {
    const { calls, deps } = await loadRecorder({ run: null, runLookupThrows: true });
    const rec = await mod.forClaim('claim-1', deps as any);
    assert.equal(rec.active, false);
    await rec.start('doc-1', 'dedup');
    assert.equal(calls.length, 0);
  });

  it('exposes the synthetic claim-level doc id for harmonise', async () => {
    const { deps } = await loadRecorder({ run: null });
    assert.equal(mod.CLAIM_LEVEL_DOC_ID, '00000000-0000-0000-0000-000000000000');
  });
});
