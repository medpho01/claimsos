import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  ClaudeClient,
  __MODELS__,
  __COSTS__,
  __resetLruCacheForTests,
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
  model: string;
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
          model: __MODELS__.HAIKU,
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
          model: __MODELS__.HAIKU,
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
          model: __MODELS__.HAIKU,
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
    assert.equal(result.model, __MODELS__.HAIKU);
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
          model: __MODELS__.SONNET,
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
    assert.equal(result.model, __MODELS__.SONNET);
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
          model: __MODELS__.HAIKU,
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
          model: __MODELS__.HAIKU,
        },
        // Second call: Sonnet, high confidence.
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"Y","amount":2,"confidence":0.95}\n```' },
          ],
          // 100k in, 50k out -> $0.30 + $0.75 = $1.05 -> ₹87.15
          usage: { input_tokens: 100_000, output_tokens: 50_000 },
          model: __MODELS__.SONNET,
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
    assert.equal(result.model, __MODELS__.SONNET);
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
          model: __MODELS__.HAIKU,
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
    assert.equal(result.model, __MODELS__.HAIKU);
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
          model: __MODELS__.HAIKU,
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
          model: __MODELS__.HAIKU,
        },
        {
          content: [
            { type: 'text', text: '```json\n{"policy_number":"B","amount":2,"confidence":0.9}\n```' },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: __MODELS__.HAIKU,
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
          model: __MODELS__.HAIKU,
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
