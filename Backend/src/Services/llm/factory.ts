import { logger } from '../../Utils/logger.js';
import { LlmClient } from './LlmClient.js';
import { ClaudeClient } from './providers/claudeClient.js';
import { RecordReplayClient } from './RecordReplayClient.js';

/**
 * LLM client factory.
 *
 * Selects a provider implementation based on `LLM_PROVIDER` env var.
 * Returned as a singleton so the underlying SDK client (which holds a
 * keep-alive HTTP agent) is shared across the process.
 *
 * Supported values:
 *   'claude' (default) — Anthropic Claude via @anthropic-ai/sdk
 *
 * Future expansion (left as comments so the shape is obvious):
 *   - 'bedrock-claude' — Anthropic Claude via AWS Bedrock (PHI sensitivity)
 *   - 'gemini'         — Google Gemini (fallback / cost arbitrage)
 *
 * Throws on unknown providers — failing fast at boot is better than
 * silently routing every call through a default that may not be what
 * the operator configured.
 */

let cached: LlmClient | null = null;

export function getLlmClient(): LlmClient {
  if (cached) return cached;
  const provider = (process.env.LLM_PROVIDER ?? 'claude').toLowerCase();
  let base: LlmClient;
  switch (provider) {
    case 'claude':
    case 'anthropic': {
      base = new ClaudeClient();
      logger.info({ provider: 'claude' }, 'llm factory: initialised Claude client');
      break;
    }
    default:
      throw new Error(
        `LLM_PROVIDER='${provider}' is not supported. Valid values: 'claude'.`
      );
  }

  // Optional persistent record/replay layer for the offline eval harness and
  // local dev. Activated only when LLM_REPLAY_MODE is set to 'record' or
  // 'replay'; unset (or 'live') leaves the base client untouched, so the
  // production path is unchanged. See RecordReplayClient for the rationale —
  // it lets us pay for each page's vision read once and re-run the pipeline
  // over the benchmark corpus for free while iterating on deterministic logic.
  const replayMode = (process.env.LLM_REPLAY_MODE ?? 'live').toLowerCase();
  if (replayMode === 'record' || replayMode === 'replay') {
    cached = new RecordReplayClient(base, { mode: replayMode });
    return cached;
  }

  cached = base;
  return cached;
}

/**
 * Test-only: swap the cached singleton (e.g. inject a mock). Not exported
 * from any index file — call sites must reach in deliberately.
 */
export function __setLlmClientForTests(client: LlmClient | null): void {
  cached = client;
}
