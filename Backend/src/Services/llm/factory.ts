import { logger } from '../../Utils/logger.js';
import { LlmClient } from './LlmClient.js';
import { ClaudeClient } from './providers/claudeClient.js';

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
  switch (provider) {
    case 'claude':
    case 'anthropic': {
      cached = new ClaudeClient();
      logger.info({ provider: 'claude' }, 'llm factory: initialised Claude client');
      return cached;
    }
    default:
      throw new Error(
        `LLM_PROVIDER='${provider}' is not supported. Valid values: 'claude'.`
      );
  }
}

/**
 * Test-only: swap the cached singleton (e.g. inject a mock). Not exported
 * from any index file — call sites must reach in deliberately.
 */
export function __setLlmClientForTests(client: LlmClient | null): void {
  cached = client;
}
