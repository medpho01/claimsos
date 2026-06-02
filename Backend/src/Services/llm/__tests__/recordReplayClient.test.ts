import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import { RecordReplayClient, LlmReplayMissError } from '../RecordReplayClient.js';
import {
  LlmClient,
  LlmExtractOpts,
  LlmExtractResult,
  LlmClassifyOpts,
  LlmClassifyResult,
} from '../LlmClient.js';

/**
 * Tests for RecordReplayClient — the disk-backed record/replay decorator that
 * makes offline pipeline iteration free.
 *
 * Run: npx tsx --test src/Services/llm/__tests__/recordReplayClient.test.ts
 *
 * Strategy: a counting fake LlmClient as `inner`. We assert that record mode
 * calls the inner once and persists; replay mode serves from disk WITHOUT
 * touching inner; a changed prompt version misses; strict replay miss throws.
 */

class CountingInner implements LlmClient {
  extractCalls = 0;
  classifyCalls = 0;

  async extract<T>(opts: LlmExtractOpts<T>): Promise<LlmExtractResult<T>> {
    this.extractCalls++;
    const data = opts.schema.parse({ value: `resp-${this.extractCalls}`, confidence: 0.9 });
    return {
      data,
      confidence: 0.9,
      rawResponse: '{"value":"x"}',
      tokensInputUncached: 1000,
      tokensInputCached: 0,
      tokensOutput: 200,
      latencyMs: 42,
      provider: 'fake',
      model: 'fake-model',
      costInr: 1.23,
      tierEscalated: false,
    };
  }

  async classify(_opts: LlmClassifyOpts): Promise<LlmClassifyResult> {
    this.classifyCalls++;
    return { category: 'discharge_summary', confidence: 0.8, reasoning: 'r', costInr: 0.5 };
  }
}

const SCHEMA = z.object({ value: z.string(), confidence: z.number() });

function extractOpts(promptVersion = 'v1'): LlmExtractOpts<{ value: string; confidence: number }> {
  return {
    systemPrompt: 'sys',
    userPrompt: 'user',
    schema: SCHEMA,
    promptVersion,
    taskName: 'unit.extract',
    documents: [{ kind: 'image', data: Buffer.from([1, 2, 3, 4]), mime: 'image/jpeg' }],
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cache-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('RecordReplayClient', () => {
  it('record mode calls inner once, then serves the recorded result on repeat', async () => {
    const inner = new CountingInner();
    const rr = new RecordReplayClient(inner, { mode: 'record', dir: tmpDir });

    const r1 = await rr.extract(extractOpts());
    assert.equal(inner.extractCalls, 1);
    assert.equal(r1.data.value, 'resp-1');
    assert.equal(rr.stats.recorded, 1);

    // Same inputs again → served from disk, inner NOT called again.
    const r2 = await rr.extract(extractOpts());
    assert.equal(inner.extractCalls, 1, 'inner should not be called on cache hit');
    assert.equal(r2.data.value, 'resp-1');
    assert.equal(r2.replayedFromCache, true);
    assert.equal(rr.stats.hits, 1);
  });

  it('replay mode serves a previously recorded result without calling inner', async () => {
    // Phase 1: record with one client instance.
    const recorder = new RecordReplayClient(new CountingInner(), { mode: 'record', dir: tmpDir });
    await recorder.extract(extractOpts());

    // Phase 2: replay with a fresh inner — must never be called.
    const replayInner = new CountingInner();
    const replayer = new RecordReplayClient(replayInner, { mode: 'replay', dir: tmpDir, strict: true });
    const r = await replayer.extract(extractOpts());
    assert.equal(replayInner.extractCalls, 0, 'replay must not hit the provider');
    assert.equal(r.data.value, 'resp-1');
    assert.equal(r.replayedFromCache, true);
    assert.equal(replayer.stats.realCostInr, 0, 'replayed run has zero real spend');
    assert.equal(replayer.stats.replayedCostInr, 1.23);
  });

  it('strict replay miss throws LlmReplayMissError', async () => {
    const replayer = new RecordReplayClient(new CountingInner(), { mode: 'replay', dir: tmpDir, strict: true });
    await assert.rejects(() => replayer.extract(extractOpts()), LlmReplayMissError);
  });

  it('changing promptVersion is a cache miss (no stale leak)', async () => {
    const inner = new CountingInner();
    const rr = new RecordReplayClient(inner, { mode: 'record', dir: tmpDir });
    await rr.extract(extractOpts('v1'));
    await rr.extract(extractOpts('v2'));
    assert.equal(inner.extractCalls, 2, 'different prompt versions must not share a cache entry');
  });

  it('live mode is a pure passthrough (no disk writes)', async () => {
    const inner = new CountingInner();
    const rr = new RecordReplayClient(inner, { mode: 'live', dir: tmpDir });
    await rr.extract(extractOpts());
    await rr.extract(extractOpts());
    assert.equal(inner.extractCalls, 2);
    // Nothing should have been written.
    const entries = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    assert.equal(entries.length, 0);
  });
});
