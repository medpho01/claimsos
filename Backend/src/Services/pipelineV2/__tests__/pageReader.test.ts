import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PageReaderService,
  LEGIBILITY_ESCALATION_THRESHOLD,
} from '../pageReader.service.js';
import {
  LlmClient,
  LlmExtractOpts,
  LlmExtractResult,
  LlmClassifyOpts,
  LlmClassifyResult,
  LlmBudgetExceededError,
} from '../../llm/LlmClient.js';

/**
 * Tests for the Stage 1 vision-native page reader.
 *
 * Run: docker exec hospital_worker_dev npx tsx --test \
 *        src/Services/pipelineV2/__tests__/pageReader.test.ts
 *
 * Strategy: a fake LlmClient whose `extract` is driven by a per-tier
 * `responder`. The fake STILL runs the returned payload through the caller's
 * real schema (opts.schema.parse) — exactly as the real provider does — so the
 * tests exercise PageReadSchema (incl. its null-stripping preprocessor) too.
 * We assert: clean page → one cheap call, no escalation; low-legibility or
 * is_legible=false → escalate cheap→premium and return the premium read with
 * summed cost; premium-first never escalates; a budget block on escalation
 * keeps the cheap read and flags it.
 */

type ReadOverrides = Record<string, unknown>;

function makeRead(over: ReadOverrides = {}): Record<string, unknown> {
  return {
    legibility: 0.95,
    is_legible: true,
    doc_type: 'discharge_slip',
    doc_type_confidence: 0.9,
    is_blank_or_noise: false,
    transcription: 'DISCHARGE SUMMARY ...',
    identity: {},
    facts: [],
    ...over,
  };
}

interface CapturedCall {
  tier?: string;
  taskName: string;
  promptVersion: string;
  hasImage: boolean;
  cacheKey?: string;
}

/** A response for a given tier, or an error to throw for that tier. */
type Responder = (tier: string) => { read: ReadOverrides; costInr?: number } | { throw: Error };

class FakeLlm implements LlmClient {
  calls: CapturedCall[] = [];
  constructor(private readonly responder: Responder) {}

  async extract<T>(opts: LlmExtractOpts<T>): Promise<LlmExtractResult<T>> {
    const tier = opts.tier ?? 'standard';
    this.calls.push({
      tier: opts.tier,
      taskName: opts.taskName,
      promptVersion: opts.promptVersion,
      hasImage: (opts.documents ?? []).some((d) => d.kind === 'image'),
      cacheKey: opts.cacheKey,
    });
    const r = this.responder(tier);
    if ('throw' in r) throw r.throw;
    // Exercise the REAL schema, just like the provider/RecordReplayClient do.
    const data = opts.schema.parse(makeRead(r.read)) as T;
    return {
      data,
      confidence: 0.9,
      rawResponse: JSON.stringify(r.read),
      tokensInputUncached: 100,
      tokensInputCached: 0,
      tokensOutput: 50,
      latencyMs: 10,
      provider: 'fake',
      model: tier === 'premium' ? 'fake-sonnet' : 'fake-haiku',
      costInr: r.costInr ?? (tier === 'premium' ? 5 : 1),
      tierEscalated: false,
    };
  }

  async classify(_opts: LlmClassifyOpts): Promise<LlmClassifyResult> {
    throw new Error('classify not used in page reader');
  }
}

const IMG = { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mime: 'image/jpeg' };
const CATS = ['discharge_slip', 'ot_notes_and_photos', 'others'] as const;

describe('PageReaderService', () => {
  it('clean page: one cheap read, no escalation', async () => {
    const llm = new FakeLlm(() => ({ read: { legibility: 0.95, is_legible: true } }));
    const svc = new PageReaderService({ llm });

    const r = await svc.readPage({ image: IMG, candidateCategories: CATS });

    assert.equal(llm.calls.length, 1, 'a clean page must not escalate');
    assert.equal(llm.calls[0].tier, 'cheap');
    assert.equal(llm.calls[0].hasImage, true, 'the page image must be attached');
    assert.equal(llm.calls[0].taskName, 'pipelinev2.page_read');
    assert.equal(r.tier, 'cheap');
    assert.equal(r.escalated, false);
    assert.equal(r.escalationBlocked, false);
    assert.equal(r.model, 'fake-haiku');
    assert.equal(r.costInr, 1);
  });

  it('low legibility: escalates cheap→premium and returns the premium read', async () => {
    const llm = new FakeLlm((tier) =>
      tier === 'premium'
        ? { read: { legibility: 0.88, is_legible: true, transcription: 'SONNET READ' } }
        : { read: { legibility: 0.3, is_legible: true, transcription: 'haiku blur' } },
    );
    const svc = new PageReaderService({ llm });

    const r = await svc.readPage({ image: IMG, candidateCategories: CATS, pageKey: 'doc1:2' });

    assert.equal(llm.calls.length, 2);
    assert.equal(llm.calls[0].tier, 'cheap');
    assert.equal(llm.calls[1].tier, 'premium');
    assert.equal(llm.calls[0].cacheKey, 'doc1:2:cheap', 'cacheKey carries the tier');
    assert.equal(llm.calls[1].cacheKey, 'doc1:2:premium');
    assert.equal(r.tier, 'premium');
    assert.equal(r.escalated, true);
    assert.equal(r.read.transcription, 'SONNET READ', 'returns the premium read');
    assert.equal(r.read.legibility, 0.88);
    assert.equal(r.costInr, 6, 'cost is the sum of both legs (1 + 5)');
    assert.equal(r.model, 'fake-sonnet');
  });

  it('is_legible=false escalates even when the score is above threshold', async () => {
    assert.ok(0.8 > LEGIBILITY_ESCALATION_THRESHOLD, 'guard: 0.8 is above the threshold');
    const llm = new FakeLlm((tier) =>
      tier === 'premium'
        ? { read: { legibility: 0.9, is_legible: true } }
        : { read: { legibility: 0.8, is_legible: false } },
    );
    const svc = new PageReaderService({ llm });

    const r = await svc.readPage({ image: IMG, candidateCategories: CATS });

    assert.equal(llm.calls.length, 2, 'is_legible=false must force escalation');
    assert.equal(r.tier, 'premium');
    assert.equal(r.escalated, true);
  });

  it('premium-first never escalates (even on low legibility)', async () => {
    const llm = new FakeLlm(() => ({ read: { legibility: 0.2, is_legible: false } }));
    const svc = new PageReaderService({ llm });

    const r = await svc.readPage({
      image: IMG,
      candidateCategories: CATS,
      firstTier: 'premium',
    });

    assert.equal(llm.calls.length, 1, 'a premium first read is already the best available');
    assert.equal(r.tier, 'premium');
    assert.equal(r.escalated, false);
  });

  it('budget block on escalation keeps the cheap read and flags it', async () => {
    const llm = new FakeLlm((tier) =>
      tier === 'premium'
        ? { throw: new LlmBudgetExceededError('claim', 16, 15, { claimId: 'c1' }) }
        : { read: { legibility: 0.25, is_legible: true, transcription: 'degraded haiku' } },
    );
    const svc = new PageReaderService({ llm });

    const r = await svc.readPage({ image: IMG, candidateCategories: CATS, claimId: 'c1' });

    assert.equal(llm.calls.length, 2, 'escalation was attempted');
    assert.equal(r.tier, 'cheap', 'falls back to the cheap read');
    assert.equal(r.escalated, false);
    assert.equal(r.escalationBlocked, true, 'block is surfaced for downstream trust-lowering');
    assert.equal(r.read.transcription, 'degraded haiku');
    assert.equal(r.costInr, 1, 'only the cheap leg was billed');
  });

  it('schema is enforced: null identity fields are stripped, values pass through', async () => {
    const llm = new FakeLlm(() => ({
      read: {
        identity: { patient_name: 'Shakil Khan', uhid: null, ipd_number: '250650' },
        facts: [{ field: 'laterality', value: 'Right', quote: 'Rt.', confidence: 0.9 }],
      },
    }));
    const svc = new PageReaderService({ llm });

    const r = await svc.readPage({ image: IMG, candidateCategories: CATS });

    assert.equal(r.read.identity.patient_name, 'Shakil Khan');
    assert.equal(r.read.identity.uhid, undefined, 'null optional is stripped, not "null"');
    assert.equal(r.read.identity.ipd_number, '250650');
    assert.equal(r.read.facts[0].value, 'Right');
  });
});
