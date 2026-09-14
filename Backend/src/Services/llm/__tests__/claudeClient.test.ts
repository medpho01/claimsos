import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  ClaudeClient,
  LlmResponseTruncatedError,
  __MODELS__,
  __COSTS__,
  __TOKEN_LIMITS__,
  __resetLruCacheForTests,
  resolveMaxOutputTokens,
} from '../providers/claudeClient.js';
import { LlmSchemaValidationError } from '../LlmClient.js';

/**
 * Tests for ClaudeClient.
 *
 * Test runner: node:test (built-in to Node 20+). The Backend package.json
 * doesn't (yet) have a `test` script; run with:
 *   npx tsx --test src/Services/llm/__tests__/claudeClient.test.ts
 * or, once the project adds a runner script, plug into that.
 *
 * We mock @anthropic-ai/sdk by constructing the client with a stub object
 * matching the surface ClaudeClient touches: `messages.create(...)`. This
 * avoids the need for a module mocker (jest.mock / vi.mock) and keeps the
 * test self-contained.
 */

interface StubResponse {
  content: Array<{ type: string; text: string }>;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /**
   * The model id the PROVIDER reports back. Every stub in this file sets it to
   * the DATED snapshot id ('claude-sonnet-4-5-20250929'), because that is what
   * the Anthropic API actually returns when you send the alias.
   *
   * This is not a cosmetic detail. Until 2026-09-14 every stub here set the
   * ALIAS, and the alias was the one spelling that hit COST_TABLE — so the
   * suite priced Sonnet correctly while production, receiving the dated id,
   * missed the table and recorded every Sonnet call at HAIKU rates (3.75x
   * under). A mock that is more convenient than reality is a mock that hides
   * the bug it exists to catch. Do not "simplify" these back to the alias.
   */
  model: string;
  /** 'end_turn' | 'max_tokens' | 'stop_sequence'. Absent behaves like end_turn. */
  stop_reason?: string;
}

interface MockState {
  calls: Array<{ model: string; system: any; messages: any[]; max_tokens: number }>;
  responses: StubResponse[];
}

function makeMockAnthropic(state: MockState): any {
  return {
    messages: {
      create: async (params: any) => {
        state.calls.push({
          model: params.model,
          system: params.system,
          messages: params.messages,
          max_tokens: params.max_tokens,
        });
        const next = state.responses.shift();
        if (!next) throw new Error('mock: no more queued responses');
        return next;
      },
    },
  };
}

const ExtractSchema = z.object({
  policy_number: z.string(),
  amount: z.number(),
  confidence: z.number().optional(),
});

describe('ClaudeClient.extract', () => {
  beforeEach(() => {
    __resetLruCacheForTests();
  });

  it('throws LlmSchemaValidationError when response has no JSON', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [{ type: 'text', text: 'sorry, I could not extract anything useful here.' }],
          usage: { input_tokens: 50, output_tokens: 10 },
          model: __MODELS__.HAIKU_DATED,
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    await assert.rejects(
      () =>
        client.extract({
          systemPrompt: 'extract policy',
          userPrompt: 'do it',
          schema: ExtractSchema,
          promptVersion: 'v1',
          taskName: 'test.no_json',
          tier: 'cheap',
        }),
      (err: unknown) => {
        assert.ok(err instanceof LlmSchemaValidationError, 'expected LlmSchemaValidationError');
        const e = err as LlmSchemaValidationError;
        assert.equal(e.taskName, 'test.no_json');
        assert.equal(e.promptVersion, 'v1');
        assert.match(e.rawResponse, /sorry/);
        return true;
      }
    );
  });

  it('throws LlmSchemaValidationError when JSON is present but fails Zod', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            {
              type: 'text',
              // amount missing — schema requires it.
              text: '```json\n{"policy_number": "ABC123"}\n```',
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10 },
          model: __MODELS__.HAIKU_DATED,
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    await assert.rejects(
      () =>
        client.extract({
          systemPrompt: 'sys',
          userPrompt: 'usr',
          schema: ExtractSchema,
          promptVersion: 'v1',
          taskName: 'test.bad_shape',
          tier: 'cheap',
        }),
      (err: unknown) => err instanceof LlmSchemaValidationError
    );
  });

  it('computes Haiku cost correctly: $0.80/M input + $4/M output -> INR', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"P1","amount":100,"confidence":0.95}\n```' },
          ],
          // 1,000,000 input + 500,000 output -> $0.80 + $2.00 = $2.80 -> ₹232.4
          usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
          model: __MODELS__.HAIKU_DATED,
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    const result = await client.extract({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 'test.cost_haiku',
      tier: 'cheap',
    });
    // 2.80 USD * 83 = 232.40 INR
    assert.equal(result.costInr, 232.4);
    assert.equal(result.model, __MODELS__.HAIKU_DATED);
    assert.equal(result.tierEscalated, false);
  });

  it('computes Sonnet cost correctly: $3/M input + $15/M output -> INR', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"P2","amount":200,"confidence":0.99}\n```' },
          ],
          // 1,000,000 input + 100,000 output -> $3 + $1.5 = $4.50 -> ₹373.5
          usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
          model: __MODELS__.SONNET_DATED,
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    const result = await client.extract({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 'test.cost_sonnet',
      tier: 'premium',
    });
    assert.equal(result.costInr, 373.5);
    assert.equal(result.model, __MODELS__.SONNET_DATED);
  });

  it('counts cached tokens at the cached rate (0.08/M for Haiku)', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"P","amount":1,"confidence":1}\n```' },
          ],
          // 0 uncached, 1M cached, 0 output -> $0.08 -> ₹6.64
          usage: { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 },
          model: __MODELS__.HAIKU_DATED,
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    const result = await client.extract({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 'test.cached',
      tier: 'cheap',
    });
    assert.equal(result.tokensInputCached, 1_000_000);
    assert.equal(result.costInr, 6.64);
  });

  it('escalates standard-tier Haiku -> Sonnet on low confidence and reports cumulative cost', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        // First call: Haiku, low confidence (0.4 < 0.7).
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"X","amount":1,"confidence":0.4}\n```' },
          ],
          // 100k in, 50k out -> $0.08 + $0.20 = $0.28 -> ₹23.24
          usage: { input_tokens: 100_000, output_tokens: 50_000 },
          model: __MODELS__.HAIKU_DATED,
        },
        // Second call: Sonnet, high confidence.
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"Y","amount":2,"confidence":0.95}\n```' },
          ],
          // 100k in, 50k out -> $0.30 + $0.75 = $1.05 -> ₹87.15
          usage: { input_tokens: 100_000, output_tokens: 50_000 },
          model: __MODELS__.SONNET_DATED,
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    const result = await client.extract({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 'test.escalation',
      tier: 'standard',
    });
    assert.equal(state.calls.length, 2, 'expected escalation to fire a second call');
    assert.equal(state.calls[0]!.model, __MODELS__.HAIKU);
    assert.equal(state.calls[1]!.model, __MODELS__.SONNET);
    assert.equal(result.model, __MODELS__.SONNET_DATED);
    assert.equal(result.tierEscalated, true);
    assert.equal(result.data.policy_number, 'Y');
    // Cumulative: 23.24 + 87.15 = 110.39
    assert.equal(result.costInr, 110.39);
  });

  it('does NOT escalate when standard-tier confidence meets threshold', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"Z","amount":3,"confidence":0.95}\n```' },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
          model: __MODELS__.HAIKU_DATED,
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    const result = await client.extract({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 'test.no_escalation',
      tier: 'standard',
    });
    assert.equal(state.calls.length, 1);
    assert.equal(result.tierEscalated, false);
    assert.equal(result.model, __MODELS__.HAIKU_DATED);
  });

  it('uses the LRU cache: identical (cacheKey,promptVersion) skips the provider on the 2nd call', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"CACHED","amount":7,"confidence":0.9}\n```' },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
          model: __MODELS__.HAIKU_DATED,
        },
        // No second response queued — if the LRU misses, the mock will throw.
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    const first = await client.extract({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 'test.lru',
      tier: 'cheap',
      cacheKey: 'doc-abc-123',
    });
    const second = await client.extract({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 'test.lru',
      tier: 'cheap',
      cacheKey: 'doc-abc-123',
    });
    assert.equal(state.calls.length, 1, 'expected only one provider call (LRU hit on 2nd)');
    assert.equal(first.data.policy_number, 'CACHED');
    assert.equal(second.data.policy_number, 'CACHED');
  });

  it('bumping promptVersion busts the LRU cache', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"A","amount":1,"confidence":0.9}\n```' },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: __MODELS__.HAIKU_DATED,
        },
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"B","amount":2,"confidence":0.9}\n```' },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: __MODELS__.HAIKU_DATED,
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    await client.extract({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 't',
      tier: 'cheap',
      cacheKey: 'k',
    });
    await client.extract({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: ExtractSchema,
      promptVersion: 'v2', // different
      taskName: 't',
      tier: 'cheap',
      cacheKey: 'k',
    });
    assert.equal(state.calls.length, 2);
  });

  it('puts cache_control on the system block (Anthropic prompt-caching pattern)', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"S","amount":1,"confidence":0.9}\n```' },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: __MODELS__.HAIKU_DATED,
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    await client.extract({
      systemPrompt: 'long stable system prompt here',
      userPrompt: 'short user prompt',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 't',
      tier: 'cheap',
    });
    const call = state.calls[0]!;
    assert.ok(Array.isArray(call.system), 'system should be an array of blocks');
    const block = call.system[0];
    assert.equal(block.type, 'text');
    assert.equal(block.text, 'long stable system prompt here');
    assert.deepEqual(block.cache_control, { type: 'ephemeral' });
  });
});

// ── output budget + truncation (finding #10) ─────────────────────────────

describe('ClaudeClient output-token budget', () => {
  beforeEach(() => {
    __resetLruCacheForTests();
  });

  it('gives doc_extract 16384 on the premium model — the budget its own prompt demands', () => {
    // lineItems.buildLineItemsPromptBlock instructs the model to emit every row
    // of a 120+ row table. Under an 8192 ceiling that instruction guarantees a
    // cut-off response and a Zod rejection.
    assert.equal(
      resolveMaxOutputTokens('doc_extract.final_bill', __MODELS__.SONNET),
      __TOKEN_LIMITS__.MAX_TOKENS_LONG_OUTPUT
    );
    assert.equal(
      resolveMaxOutputTokens('doc_extract.pharmacy_bill', __MODELS__.SONNET),
      __TOKEN_LIMITS__.MAX_TOKENS_LONG_OUTPUT
    );
  });

  it('keeps Haiku at 8192 — its hard API ceiling', () => {
    assert.equal(
      resolveMaxOutputTokens('doc_extract.final_bill', __MODELS__.HAIKU),
      __TOKEN_LIMITS__.MAX_TOKENS_DEFAULT
    );
    assert.equal(
      resolveMaxOutputTokens('pipelinev2.page_read', __MODELS__.HAIKU),
      __TOKEN_LIMITS__.MAX_TOKENS_DEFAULT
    );
  });

  it('leaves the existing ceilings where they were', () => {
    assert.equal(
      resolveMaxOutputTokens('claim_harmonisation', __MODELS__.SONNET),
      __TOKEN_LIMITS__.MAX_TOKENS_LONG_OUTPUT
    );
    assert.equal(
      resolveMaxOutputTokens('pipelinev2.page_read', __MODELS__.SONNET),
      __TOKEN_LIMITS__.MAX_TOKENS_LONG_OUTPUT
    );
    assert.equal(
      resolveMaxOutputTokens('attr_extract.policy_number', __MODELS__.SONNET),
      __TOKEN_LIMITS__.MAX_TOKENS_DEFAULT,
      'a short-payload task does not get the long ceiling just for being premium'
    );
  });

  it('sends that ceiling on the wire for a premium doc_extract call', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"P1","amount":10}\n```' },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
          model: __MODELS__.SONNET_DATED,
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    await client.extract({
      systemPrompt: 'extract a bill',
      userPrompt: 'read the table',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 'doc_extract.final_bill',
      tier: 'premium',
    });
    assert.equal(state.calls[0]!.max_tokens, __TOKEN_LIMITS__.MAX_TOKENS_LONG_OUTPUT);
  });
});

describe('ClaudeClient truncation (stop_reason=max_tokens)', () => {
  beforeEach(() => {
    __resetLruCacheForTests();
  });

  it('rejects a truncated extraction EVEN WHEN the JSON parses and validates', async () => {
    // The dangerous case is not the unparseable one. It is this: the payload
    // is well-formed and schema-valid, and the rows the model had not written
    // yet are simply gone. Accepting it stores a bill with a missing tail as a
    // clean extraction.
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"P1","amount":10}\n```' },
          ],
          usage: { input_tokens: 100, output_tokens: 16384 },
          model: __MODELS__.SONNET_DATED,
          stop_reason: 'max_tokens',
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    await assert.rejects(
      () =>
        client.extract({
          systemPrompt: 'extract a bill',
          userPrompt: 'read the table',
          schema: ExtractSchema,
          promptVersion: 'v7',
          taskName: 'doc_extract.final_bill',
          tier: 'premium',
        }),
      (err: unknown) => {
        assert.ok(err instanceof LlmResponseTruncatedError, 'expected LlmResponseTruncatedError');
        // Every existing caller catches LlmSchemaValidationError; the subclass
        // must keep being caught by them.
        assert.ok(err instanceof LlmSchemaValidationError, 'must stay catchable as a schema error');
        const e = err as LlmResponseTruncatedError;
        assert.equal(e.truncated, true);
        assert.equal(e.taskName, 'doc_extract.final_bill');
        assert.equal(e.promptVersion, 'v7');
        assert.equal(e.maxTokens, __TOKEN_LIMITS__.MAX_TOKENS_LONG_OUTPUT);
        assert.equal(e.tokensOutput, 16384);
        assert.match(e.rawResponse, /policy_number/, 'carries the partial output for forensics');
        return true;
      }
    );
  });

  it('does not fire on a normal completion', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"P1","amount":10}\n```' },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
          model: __MODELS__.HAIKU_DATED,
          stop_reason: 'end_turn',
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    const res = await client.extract({
      systemPrompt: 'extract policy',
      userPrompt: 'do it',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 'test.ok',
      tier: 'cheap',
    });
    assert.equal(res.data.policy_number, 'P1');
  });

  it('rejects a truncated classification instead of calling it an invalid category', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [{ type: 'text', text: '```json\n{"category":"final_bi' }],
          usage: { input_tokens: 100, output_tokens: 512 },
          model: __MODELS__.HAIKU_DATED,
          stop_reason: 'max_tokens',
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    await assert.rejects(
      () =>
        client.classify({
          systemPrompt: 'classify',
          userPrompt: 'which is it',
          categories: ['final_bill', 'discharge_summary'],
          promptVersion: 'v1',
          taskName: 'test.classify_truncated',
        }),
      (err: unknown) => {
        assert.ok(err instanceof LlmResponseTruncatedError);
        assert.match((err as Error).message, /truncated/);
        return true;
      }
    );
  });
});

describe('ClaudeClient cost-table constants', () => {
  it('uses the documented USD->INR rate of 83', () => {
    assert.equal(__COSTS__.USD_TO_INR_RATE, 83);
  });

  it('uses 0.7 as the standard-tier escalation threshold', () => {
    assert.equal(__COSTS__.ESCALATION_CONFIDENCE_THRESHOLD, 0.7);
  });

  it('has Haiku rates 0.80 / 4 / 0.08 per million', () => {
    const haiku = __COSTS__.COST_TABLE[__MODELS__.HAIKU];
    assert.deepEqual(haiku, { input: 0.8, output: 4, cachedInput: 0.08 });
  });

  it('has Sonnet rates 3 / 15 / 0.30 per million', () => {
    const sonnet = __COSTS__.COST_TABLE[__MODELS__.SONNET];
    assert.deepEqual(sonnet, { input: 3, output: 15, cachedInput: 0.3 });
  });
});

// ── THE SONNET MISPRICING (2026-09-14) ───────────────────────────────────────
//
// We SEND 'claude-sonnet-4-5'. Anthropic ANSWERS 'claude-sonnet-4-5-20250929',
// and computeCostInr prices on the answer. COST_TABLE was keyed only on the
// alias, so the exact-key lookup missed on every real call and took the
// unknown-model branch, which charges Haiku rates — 1/3.75 of the truth.
// Measured: ₹2.21 recorded vs ₹8.30 true on one tiled itemised extraction.
//
// That figure is what llm_cost_log stores, what getClaimSpendInr sums, and
// what checkBudget enforces every cap against. The cap re-tune in
// costAccounting (₹40 → ₹150) only makes sense once these tests pass.
// ─────────────────────────────────────────────────────────────────────────────

describe('ClaudeClient model-id normalisation (the Sonnet mispricing)', () => {
  const { normalizeModelId, computeCostInr, COST_TABLE, USD_TO_INR_RATE } = __COSTS__;

  it('strips a trailing -YYYYMMDD snapshot stamp and lowercases', () => {
    assert.equal(normalizeModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
    assert.equal(normalizeModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.equal(normalizeModelId('  Claude-Sonnet-4-5-20250929  '), 'claude-sonnet-4-5');
    // An id with no date stamp is returned unchanged (bar case/trim).
    assert.equal(normalizeModelId('claude-sonnet-4-5'), 'claude-sonnet-4-5');
    // Only a TRAILING 8-digit group is a date stamp; nothing else is touched.
    assert.equal(normalizeModelId('claude-4-5-sonnet'), 'claude-4-5-sonnet');
    assert.equal(normalizeModelId(''), '');
  });

  it('prices the DATED Sonnet id at Sonnet rates, not Haiku rates', () => {
    // 1M uncached input + 100k output. Sonnet: $3 + $1.50 = $4.50 -> ₹373.50.
    const sonnet = computeCostInr(__MODELS__.SONNET_DATED, 1_000_000, 0, 100_000);
    assert.equal(sonnet, 4.5 * USD_TO_INR_RATE);
    // The alias must price identically — both spellings, one number.
    assert.equal(computeCostInr(__MODELS__.SONNET, 1_000_000, 0, 100_000), sonnet);
  });

  it('records Sonnet at exactly 3.75x Haiku for identical token counts', () => {
    // 3/0.8 = 3.75 on input, 15/4 = 3.75 on output, 0.30/0.08 = 3.75 cached.
    // The ratio is uniform, which is precisely why the bug produced one clean
    // factor rather than a token-mix-dependent smear: every recorded Sonnet
    // rupee was 1/3.75 of the true one.
    const args = [1_000_000, 250_000, 400_000] as const;
    const haiku = computeCostInr(__MODELS__.HAIKU_DATED, ...args);
    const sonnet = computeCostInr(__MODELS__.SONNET_DATED, ...args);
    assert.ok(haiku > 0, 'sanity: Haiku must cost something');
    assert.equal(
      Math.round((sonnet / haiku) * 1e6) / 1e6,
      3.75,
      `Sonnet ₹${sonnet} vs Haiku ₹${haiku} — the dated id must not fall through ` +
        'to the Haiku fallback branch',
    );
  });

  it('carries both spellings in COST_TABLE so a bypassed normaliser still prices right', () => {
    assert.deepEqual(
      COST_TABLE[__MODELS__.SONNET_DATED],
      COST_TABLE[__MODELS__.SONNET],
    );
    assert.deepEqual(
      COST_TABLE[__MODELS__.HAIKU_DATED],
      COST_TABLE[__MODELS__.HAIKU],
    );
  });

  it('still falls back to Haiku rates for a genuinely unknown model', () => {
    // The fallback itself is correct behaviour (never throw while pricing a
    // call that already happened) — it just must not be reachable by an id we
    // DO know. It now logs at error level, not warn.
    const unknown = computeCostInr('some-future-model-we-have-not-shipped', 1_000_000, 0, 0);
    assert.equal(unknown, computeCostInr(__MODELS__.HAIKU, 1_000_000, 0, 0));
  });

  it('an end-to-end premium call priced from the dated id charges Sonnet rates', async () => {
    const state: MockState = {
      calls: [],
      responses: [
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"P2","amount":200,"confidence":0.99}\n```' },
          ],
          // 1,000,000 input + 100,000 output -> $3 + $1.5 = $4.50 -> ₹373.5.
          // Under the bug this recorded ₹99.60 (Haiku rates) — 3.75x under.
          usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
          model: __MODELS__.SONNET_DATED,
        },
      ],
    };
    const client = new ClaudeClient(makeMockAnthropic(state));
    const result = await client.extract({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: ExtractSchema,
      promptVersion: 'v1',
      taskName: 'test.cost_sonnet_dated',
      tier: 'premium',
    });
    assert.equal(state.calls[0]!.model, __MODELS__.SONNET, 'we send the alias');
    assert.equal(result.model, __MODELS__.SONNET_DATED, 'the API answers with the dated id');
    assert.equal(result.costInr, 373.5);
    assert.notEqual(result.costInr, 99.6, 'the Haiku-rate figure the bug produced');
  });
});
