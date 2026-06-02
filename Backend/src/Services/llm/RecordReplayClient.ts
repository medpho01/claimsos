import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../../Utils/logger.js';
import {
  LlmClient,
  LlmExtractOpts,
  LlmExtractResult,
  LlmClassifyOpts,
  LlmClassifyResult,
  LlmAttachment,
} from './LlmClient.js';

/**
 * RecordReplayClient — a disk-backed record/replay decorator over any LlmClient.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The pipeline-v2 redesign is vision-native: every document page is read by
 * a vision model. Re-running the full pipeline over our benchmark corpus
 * (the 13-patient cross-validation set, ~194 docs / ~200 pages) on every code
 * change would re-bill that vision spend each time. But the EXPENSIVE part of
 * the pipeline — the per-page vision read — is *deterministic input*: the same
 * page image + same prompt version yields a response we can safely reuse while
 * we iterate on the cheap, deterministic downstream stages (identity gate,
 * dedup wiring, authority-ranked fusion, value-level validators).
 *
 * So: record the vision/LLM responses ONCE (real spend), then replay them for
 * free on every subsequent run. We pay for the model only when a page is new
 * or its prompt version changed.
 *
 * This is NOT the in-process LRU in claudeClient (that has a 5-min TTL and is
 * for retry-storm dedupe). This is a *persistent*, content-addressed cache on
 * disk, intended for the offline eval harness and local development.
 *
 * MODES (env LLM_REPLAY_MODE)
 * ───────────────────────────
 *   'live'    — passthrough; no disk I/O. Production default (unset == live).
 *   'record'  — call the inner client, persist the result to disk, return it.
 *               A cache hit is still served from disk (so 'record' is also
 *               "fill the cache, don't re-pay for what's already there").
 *   'replay'  — serve from disk only. On a miss: throw (LLM_REPLAY_STRICT=1,
 *               the harness default — a miss means the corpus/prompt changed
 *               and you should re-record deliberately) or fall through to the
 *               inner client and record (LLM_REPLAY_STRICT=0).
 *
 * CACHE KEY
 * ─────────
 * Content-addressed sha256 over everything that affects the model output:
 * taskName, promptVersion, tier, system+user prompts, and the bytes of every
 * attachment (image/pdf/text). Changing the prompt version or the page image
 * changes the key, so stale responses never leak into a changed pipeline.
 *
 * COST ACCOUNTING
 * ───────────────
 * A replayed result carries the ORIGINAL recorded costInr (so downstream cost
 * math is unchanged), but `replayedFromCache: true` is attached so the harness
 * can report "real spend this run = sum of non-replayed calls" — i.e. ₹0 on a
 * fully-cached re-run.
 */

export type ReplayMode = 'live' | 'record' | 'replay';

interface StoredRecord {
  version: 1;
  taskName: string;
  promptVersion: string;
  kind: 'extract' | 'classify';
  recordedAt: string;
  // For extract: the validated `data` is stored as plain JSON and re-parsed
  // through the caller's schema on replay (guards against schema drift).
  payload: unknown;
  meta: {
    confidence: number;
    rawResponse: string;
    tokensInputUncached: number;
    tokensInputCached: number;
    tokensOutput: number;
    latencyMs: number;
    provider: string;
    model: string;
    costInr: number;
    tierEscalated: boolean;
  };
}

function hashAttachment(a: LlmAttachment): string {
  const h = createHash('sha256');
  h.update(a.kind);
  h.update('\0');
  h.update(a.mime);
  h.update('\0');
  h.update(typeof a.data === 'string' ? Buffer.from(a.data, 'utf8') : a.data);
  return h.digest('hex');
}

function computeKey(parts: {
  kind: 'extract' | 'classify';
  taskName: string;
  promptVersion: string;
  tier: string;
  systemPrompt: string;
  userPrompt: string;
  documents?: LlmAttachment[];
  categories?: readonly string[];
}): string {
  const h = createHash('sha256');
  h.update(parts.kind);
  h.update('\0');
  h.update(parts.taskName);
  h.update('\0');
  h.update(parts.promptVersion);
  h.update('\0');
  h.update(parts.tier);
  h.update('\0');
  h.update(parts.systemPrompt);
  h.update('\0');
  h.update(parts.userPrompt);
  h.update('\0');
  for (const a of parts.documents ?? []) {
    h.update(hashAttachment(a));
    h.update(',');
  }
  h.update('\0');
  for (const c of parts.categories ?? []) {
    h.update(c);
    h.update(',');
  }
  return h.digest('hex');
}

export class LlmReplayMissError extends Error {
  readonly key: string;
  readonly taskName: string;
  constructor(key: string, taskName: string) {
    super(
      `LLM replay miss (task=${taskName}, key=${key.slice(0, 12)}…). ` +
        `The corpus or prompt version changed since the cache was recorded. ` +
        `Re-record with LLM_REPLAY_MODE=record, or set LLM_REPLAY_STRICT=0 to fall through.`
    );
    this.name = 'LlmReplayMissError';
    this.key = key;
    this.taskName = taskName;
  }
}

export class RecordReplayClient implements LlmClient {
  private readonly inner: LlmClient;
  private readonly mode: ReplayMode;
  private readonly dir: string;
  private readonly strict: boolean;

  // In-run counters so the harness can print real-vs-replayed spend.
  public stats = {
    hits: 0,
    misses: 0,
    recorded: 0,
    realCostInr: 0, // sum of costInr for calls that actually hit the provider
    replayedCostInr: 0, // sum of costInr served from cache (would-have-been spend)
  };

  constructor(inner: LlmClient, opts?: { mode?: ReplayMode; dir?: string; strict?: boolean }) {
    this.inner = inner;
    this.mode = opts?.mode ?? (process.env.LLM_REPLAY_MODE as ReplayMode) ?? 'live';
    this.dir = opts?.dir ?? process.env.LLM_REPLAY_DIR ?? path.resolve(process.cwd(), '.llm-cache');
    // Strict replay (miss → throw) is the harness default; opt out with =0.
    this.strict = opts?.strict ?? process.env.LLM_REPLAY_STRICT !== '0';
    if (this.mode !== 'live') {
      fs.mkdirSync(this.dir, { recursive: true });
      logger.info({ mode: this.mode, dir: this.dir, strict: this.strict }, 'RecordReplayClient active');
    }
  }

  private pathFor(key: string): string {
    // Shard by first 2 hex chars to avoid one giant directory.
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  private read(key: string): StoredRecord | null {
    try {
      const raw = fs.readFileSync(this.pathFor(key), 'utf8');
      return JSON.parse(raw) as StoredRecord;
    } catch {
      return null;
    }
  }

  private write(key: string, rec: StoredRecord): void {
    const p = this.pathFor(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(rec, null, 2), 'utf8');
  }

  async extract<T>(opts: LlmExtractOpts<T>): Promise<LlmExtractResult<T>> {
    if (this.mode === 'live') return this.inner.extract(opts);

    const key = computeKey({
      kind: 'extract',
      taskName: opts.taskName,
      promptVersion: opts.promptVersion,
      tier: opts.tier ?? 'standard',
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      documents: opts.documents,
    });

    const existing = this.read(key);
    if (existing && existing.kind === 'extract') {
      this.stats.hits++;
      this.stats.replayedCostInr += existing.meta.costInr;
      // Re-validate stored payload through the caller's schema so type T is real.
      const data = opts.schema.parse(existing.payload);
      return { data, ...existing.meta, replayedFromCache: true } as LlmExtractResult<T> & {
        replayedFromCache: boolean;
      };
    }

    if (this.mode === 'replay' && this.strict) {
      this.stats.misses++;
      throw new LlmReplayMissError(key, opts.taskName);
    }

    // record (or replay+non-strict): hit the provider, persist, return.
    this.stats.misses++;
    const result = await this.inner.extract(opts);
    this.stats.recorded++;
    this.stats.realCostInr += result.costInr;
    this.write(key, {
      version: 1,
      taskName: opts.taskName,
      promptVersion: opts.promptVersion,
      kind: 'extract',
      recordedAt: new Date().toISOString(),
      payload: result.data,
      meta: {
        confidence: result.confidence,
        rawResponse: result.rawResponse,
        tokensInputUncached: result.tokensInputUncached,
        tokensInputCached: result.tokensInputCached,
        tokensOutput: result.tokensOutput,
        latencyMs: result.latencyMs,
        provider: result.provider,
        model: result.model,
        costInr: result.costInr,
        tierEscalated: result.tierEscalated,
      },
    });
    return result;
  }

  async classify(opts: LlmClassifyOpts): Promise<LlmClassifyResult> {
    if (this.mode === 'live') return this.inner.classify(opts);

    const key = computeKey({
      kind: 'classify',
      taskName: opts.taskName,
      promptVersion: opts.promptVersion,
      tier: opts.tier ?? 'standard',
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      documents: opts.documents,
      categories: opts.categories,
    });

    const existing = this.read(key);
    if (existing && existing.kind === 'classify') {
      this.stats.hits++;
      this.stats.replayedCostInr += existing.meta.costInr;
      return existing.payload as LlmClassifyResult;
    }

    if (this.mode === 'replay' && this.strict) {
      this.stats.misses++;
      throw new LlmReplayMissError(key, opts.taskName);
    }

    this.stats.misses++;
    const result = await this.inner.classify(opts);
    this.stats.recorded++;
    this.stats.realCostInr += result.costInr;
    this.write(key, {
      version: 1,
      taskName: opts.taskName,
      promptVersion: opts.promptVersion,
      kind: 'classify',
      recordedAt: new Date().toISOString(),
      payload: result,
      meta: {
        confidence: result.confidence,
        rawResponse: '',
        tokensInputUncached: 0,
        tokensInputCached: 0,
        tokensOutput: 0,
        latencyMs: 0,
        provider: 'anthropic',
        model: '',
        costInr: result.costInr,
        tierEscalated: false,
      },
    });
    return result;
  }

  resetStats(): void {
    this.stats = { hits: 0, misses: 0, recorded: 0, realCostInr: 0, replayedCostInr: 0 };
  }
}
