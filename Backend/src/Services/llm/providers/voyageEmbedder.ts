/**
 * Voyage AI Embedder — Sprint 4, Wave 4B
 *
 * Anthropic doesn't offer a first-party embeddings API. They recommend
 * Voyage AI (https://docs.voyageai.com). For v0 we use the REST endpoint
 * directly via axios — no `voyageai` npm package required. If we later
 * outgrow REST (batch API, async jobs), revisit.
 *
 * Model: voyage-3 (1024 dimensions, retrieval-tuned, $0.06 per 1M input
 * tokens — basically free at our claim volume).
 *
 * The embedder is intentionally provider-agnostic at the interface level
 * (`Embedder.embed(texts) -> embeddings`) so a Bedrock or Cohere swap is
 * a constructor change, not a service rewrite.
 *
 * Cost shape (USD → INR at ~₹83):
 *   - $0.06 / 1M input tokens
 *   - A 1500-char summary ≈ ~400 tokens
 *   - Per embed call: ~$0.000024 ≈ ₹0.002
 *   - Per claim across its lifetime (assume 5 re-embeds): ₹0.01
 *   - Negligible vs the ₹15/claim hard cap enforced by costAccounting.
 *
 * Required env var: VOYAGE_API_KEY (caller's responsibility to set in
 * the Backend container env — NOT added to .env.example by this wave).
 */

import axios, { AxiosInstance } from 'axios';

import { logger } from '../../../Utils/logger.js';

export interface EmbedResult {
  embeddings: number[][];
  tokensUsed: number;
  costInr: number;
}

export interface Embedder {
  embed(texts: string[]): Promise<EmbedResult>;
}

// Voyage default. Override via VOYAGE_MODEL if we ever A/B against
// voyage-3-large (2048 dim — would require a migration changing the
// vector column dimension).
const DEFAULT_MODEL = 'voyage-3';

// voyage-3 pricing as of 2026-05. Update if Voyage's pricing page moves
// — this number feeds the cost log so accuracy matters.
const COST_USD_PER_MILLION_TOKENS = 0.06;
const USD_TO_INR = 83;

// Voyage's documented per-request batch ceiling. Each batch is one
// HTTP round-trip; we chunk in the service if a caller passes more.
const MAX_BATCH_SIZE = 128;

// Embedding is on the cockpit's critical path (the model agent waits
// for retrieval), but we don't want a stuck Voyage call to block a
// worker forever. 20s is generous — voyage-3 typically returns in 200-
// 800ms for a single text, ~2s for a 128-item batch.
const REQUEST_TIMEOUT_MS = 20_000;

export class VoyageEmbedder implements Embedder {
  private readonly client: AxiosInstance;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(opts?: { apiKey?: string; model?: string; baseURL?: string }) {
    const apiKey = opts?.apiKey ?? process.env.VOYAGE_API_KEY ?? '';
    if (!apiKey) {
      // Don't throw at construction — embed() will throw on the actual
      // call. Lets tests construct a stub-style instance without env
      // wiring, and lets the worker boot when the queue is disabled.
      logger.warn('VoyageEmbedder constructed without VOYAGE_API_KEY; embed() will throw at call time.');
    }
    this.apiKey = apiKey;
    this.model = opts?.model ?? process.env.VOYAGE_MODEL ?? DEFAULT_MODEL;
    this.client = axios.create({
      baseURL: opts?.baseURL ?? 'https://api.voyageai.com',
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    if (!Array.isArray(texts) || texts.length === 0) {
      return { embeddings: [], tokensUsed: 0, costInr: 0 };
    }
    if (!this.apiKey) {
      throw new Error('VoyageEmbedder.embed: VOYAGE_API_KEY not set');
    }

    // Chunk if the caller exceeds the per-request batch ceiling. We
    // accumulate results across chunks so the caller sees a single
    // EmbedResult.
    const allEmbeddings: number[][] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const slice = texts.slice(i, i + MAX_BATCH_SIZE);
      try {
        const res = await this.client.post('/v1/embeddings', {
          input: slice,
          model: this.model,
          // 'document' tells Voyage to use the retrieval-document
          // encoding side. We call this for the embed_claim path; for
          // ad-hoc retrieve(query) paths where we embed a query inline,
          // we'd pass 'query' instead. For v0 every call site is
          // document-style (we embed claim summaries; retrieval looks
          // up the precomputed vector for the current claim).
          input_type: 'document',
        });
        const body = res.data as {
          data: Array<{ embedding: number[]; index: number }>;
          usage?: { total_tokens?: number };
          model?: string;
        };
        // Voyage returns `data` indexed; sort defensively even though
        // the API documents stable ordering.
        const sorted = [...body.data].sort((a, b) => a.index - b.index);
        for (const item of sorted) allEmbeddings.push(item.embedding);
        totalTokens += body.usage?.total_tokens ?? 0;
      } catch (err: any) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        logger.error(
          { err: err?.message ?? String(err), status, data, sliceSize: slice.length },
          'VoyageEmbedder.embed: request failed',
        );
        throw new Error(
          `VoyageEmbedder.embed failed (status=${status ?? 'n/a'}): ${err?.message ?? String(err)}`,
        );
      }
    }

    const costUsd = (totalTokens / 1_000_000) * COST_USD_PER_MILLION_TOKENS;
    const costInr = costUsd * USD_TO_INR;

    return {
      embeddings: allEmbeddings,
      tokensUsed: totalTokens,
      costInr,
    };
  }
}

// Singleton accessor. Mirrors the getLlmClient() pattern in llm/factory.ts —
// the underlying axios instance pools a keep-alive HTTP agent and we want
// one per process.
let cached: Embedder | null = null;

export function getEmbedder(): Embedder {
  if (cached) return cached;
  cached = new VoyageEmbedder();
  return cached;
}

/** Test-only: inject a stub embedder. Not re-exported from any index file. */
export function __setEmbedderForTests(client: Embedder | null): void {
  cached = client;
}
