/**
 * HarmonisationService — Wave 7
 *
 * Produces and maintains a per-claim canonical medical_episode.v2
 * artifact in hospital.claim_harmonised_episodes. The harmoniser is
 * the LAST LLM stage in the intelligence pipeline — it consumes the
 * dossier (Wave 1), the document sections (Wave 2A), and the
 * per-section extractions (Wave 2B), and emits ONE canonical JSON
 * the rest of the system reads.
 *
 * Lifecycle:
 *   1. harmonise() loads the dossier, hashes the inputs that matter
 *      (dossier_state_hash), and short-circuits when the cache row
 *      is fresh against the same hash + same prompt_version.
 *   2. On a cache miss it loads the document_sections (joined to
 *      ipd_doc for filename + s3_key), runs the budget pre-flight,
 *      then calls the LLM with the harmoniser.v1 prompt at premium
 *      tier (Sonnet — this is the deep reasoning call).
 *   3. The LLM bridge parses + Zod-validates the response. On
 *      validation failure we try HarmonisedEpisodePartial as a
 *      fallback so we get *something* rather than nothing.
 *   4. UPSERT the row, build a sparse provenance map, record the
 *      cost (cost_inr column on the row + a row in llm_cost_log
 *      via costAccounting.recordCall), and dispatch a typed
 *      'claim_harmonised' event.
 *
 *   applyCorrection(): patches the episode JSONB at a JSONPath,
 *     inserts a harmonisation_corrections row, dispatches a typed
 *     'harmonisation_corrected' event. Does NOT trigger a fresh
 *     LLM call.
 *
 *   regenerate(): convenience wrapper for harmonise({force:true}).
 *
 * Cost expectations (Sonnet, prompt-cached system block):
 *   - First call:        ~₹1.00-1.50
 *   - Cache-hit re-runs: ~₹0
 *   - Per-claim hard cap (CLAIM_HARD_LIMIT_INR = ₹15) is enforced
 *     pre-flight by costAccounting.checkBudget; over budget runs
 *     persist with status='failed' and never hit the provider.
 *
 * Concurrency:
 *   - Two simultaneous harmonise() calls for the same claim_id will
 *     both pass the cache check, both hit the LLM, both attempt the
 *     UPSERT — the second one wins. This is acceptable because the
 *     Bull worker (concurrency 2) is the primary call path and
 *     coalesces via jobId. Manual API triggers can race, but the
 *     resulting episodes will be near-identical (same dossier_state_hash).
 *
 * v1 JSONPath limitations (applyCorrection):
 *   - Supports dotted form: $.a.b.c
 *   - Supports array indexing: $.a[0].b, $.a.b[2]
 *   - Does NOT support: predicates ($..[?(@.k==1)]), wildcards (*),
 *     recursive descent (..). The validator rejects these forms; the
 *     caller must split into multiple corrections.
 */

import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import claimDossierService, {
  type ClaimDossier,
} from './claimDossier.service.js';
import costAccounting from './costAccounting.service.js';
import { eventDispatcher } from './events/eventDispatcher.service.js';
import { recordCorrectionBestEffort } from './aiCorrections.service.js';
import { getLlmClient } from './llm/factory.js';
import {
  LlmBudgetExceededError,
  LlmSchemaValidationError,
  type LlmClient,
} from './llm/LlmClient.js';
import {
  HarmonisedEpisodeSchema,
  HarmonisedEpisodePartial,
  type HarmonisedEpisodeT,
} from './llm/schemas/harmonisedEpisode.js';
import {
  PROMPT_VERSION,
  TASK_NAME,
  SYSTEM_PROMPT,
  buildUserPrompt,
  type HarmoniserSectionInput,
  type HarmoniserSeedFacts,
} from './llm/prompts/harmoniser.v1.js';

// ─── Versioning ───────────────────────────────────────────────────────────
export const HARMONISER_VERSION = 'v1';
const SCHEMA_VERSION = 'claimsos.canonical.medical_episode.v2';

// ─── Public types ─────────────────────────────────────────────────────────

export type HarmonisationStatus =
  | 'fresh'
  | 'stale'
  | 'pending'
  | 'failed'
  | 'partial'
  | 'corrected';

export interface HarmonisedEpisodeRow {
  claim_id: string;
  episode: HarmonisedEpisodeT | Record<string, unknown> | null;
  schema_version: string;
  prompt_version: string;
  confidence: number | null;
  provenance: Record<string, unknown> | null;
  dossier_state_hash: string;
  cost_inr: number | null;
  tokens_used: number | null;
  llm_provider: string | null;
  llm_model: string | null;
  generated_at: Date;
  last_corrected_at: Date | null;
  status: HarmonisationStatus;
  error_message: string | null;
}

export interface HarmoniseInput {
  claim_id: string;
  hospital_id: string;
  /** Bypass dossier_state_hash cache and re-run the LLM. */
  force?: boolean;
}

export interface HarmonisationServiceDeps {
  pool?: Pick<Pool, 'query' | 'connect'>;
  llm?: LlmClient;
  cost?: typeof costAccounting;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Stable JSON stringify — keys are sorted at every level. Used to make
 * the dossier_state_hash deterministic regardless of property insertion
 * order on the underlying JSONB columns.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') +
    '}'
  );
}

/**
 * Compute the cache key over the dossier inputs that materially affect
 * the harmonisation output. Bumping this set changes the cache key on
 * every existing claim — done deliberately when a prompt change starts
 * paying attention to a new dossier slice.
 *
 * Exported for the worker test parity and so callers can pre-compute
 * the hash when deciding whether to enqueue a regen.
 */
export function computeDossierStateHash(
  dossier: ClaimDossier,
  sectionIds: string[],
): string {
  const subset = {
    current_stage: dossier.current_stage,
    doc_sections_by_category: dossier.doc_sections_by_category,
    amounts: dossier.amounts,
    // Drop volatile metadata from active_queries — we only care about
    // structural change.
    active_queries: (dossier.active_queries ?? []).map((q: any) => ({
      query_id: q.query_id,
      deficiency_type: q.deficiency_type ?? null,
    })),
    section_ids: [...sectionIds].sort(),
  };
  return createHash('sha256').update(stableStringify(subset)).digest('hex');
}

// ─── DB row mapping ───────────────────────────────────────────────────────

interface DbRow {
  claim_id: string;
  episode: any;
  schema_version: string;
  prompt_version: string;
  confidence: string | number | null;
  provenance: any;
  dossier_state_hash: string;
  cost_inr: string | number | null;
  tokens_used: number | null;
  llm_provider: string | null;
  llm_model: string | null;
  generated_at: Date;
  last_corrected_at: Date | null;
  status: HarmonisationStatus;
  error_message: string | null;
}

function rowToEpisode(row: DbRow): HarmonisedEpisodeRow {
  return {
    claim_id: row.claim_id,
    episode: row.episode ?? null,
    schema_version: row.schema_version,
    prompt_version: row.prompt_version,
    confidence: row.confidence == null ? null : Number(row.confidence),
    provenance: row.provenance ?? null,
    dossier_state_hash: row.dossier_state_hash,
    cost_inr: row.cost_inr == null ? null : Number(row.cost_inr),
    tokens_used: row.tokens_used ?? null,
    llm_provider: row.llm_provider,
    llm_model: row.llm_model,
    generated_at: row.generated_at,
    last_corrected_at: row.last_corrected_at,
    status: row.status,
    error_message: row.error_message,
  };
}

const SELECT_ALL_COLS = `
  claim_id, episode, schema_version, prompt_version, confidence,
  provenance, dossier_state_hash,
  cost_inr, tokens_used, llm_provider, llm_model,
  generated_at, last_corrected_at, status, error_message
`;

// ─── JSONPath helpers (v1 — dotted form only) ─────────────────────────────

/**
 * Parse a JSONPath like '$.diagnosis.primary_diagnosis.icd_code' or
 * '$.clinical_timeline[0].procedures_performed[1].procedure_name' into a
 * list of string-or-number segments. Rejects predicates / wildcards /
 * recursive descent — those forms throw.
 *
 * Exported only for testing.
 */
export function parseJsonPath(path: string): Array<string | number> {
  if (!path || !path.startsWith('$')) {
    throw new Error(`invalid json_path: must start with '$' (got '${path}')`);
  }
  // Reject the forms we don't support — catch them before we attempt to
  // walk and mis-set fields.
  if (path.includes('..') || path.includes('*') || path.includes('?')) {
    throw new Error(
      `invalid json_path: recursive descent / wildcards / predicates are not supported in v1 (got '${path}')`,
    );
  }
  const rest = path.slice(1); // strip leading '$'
  if (rest === '') return [];
  const segments: Array<string | number> = [];
  // We accept either '.name' or '[index]' as the next chunk.
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === '.') {
      i++;
      let buf = '';
      while (i < rest.length && rest[i] !== '.' && rest[i] !== '[') {
        buf += rest[i++];
      }
      if (!buf) throw new Error(`invalid json_path: empty segment in '${path}'`);
      segments.push(buf);
    } else if (rest[i] === '[') {
      const close = rest.indexOf(']', i);
      if (close < 0) throw new Error(`invalid json_path: unclosed bracket in '${path}'`);
      const idx = rest.slice(i + 1, close);
      const n = Number(idx);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`invalid json_path: non-integer index '${idx}' in '${path}'`);
      }
      segments.push(n);
      i = close + 1;
    } else {
      throw new Error(`invalid json_path: unexpected char '${rest[i]}' at ${i} in '${path}'`);
    }
  }
  return segments;
}

/**
 * Set `value` at `path` inside `obj` (mutating). Creates intermediate
 * objects/arrays as needed (number-key segments coerce intermediate to
 * array, string-key to object). Returns the (mutated) root for chaining.
 */
export function setAtJsonPath(
  obj: any,
  path: string,
  value: unknown,
): any {
  const segments = parseJsonPath(path);
  if (segments.length === 0) {
    // '$' — replace the root. Caller is expected to pass an object.
    return value;
  }
  let cursor: any = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const nextSeg = segments[i + 1]!;
    const need = typeof nextSeg === 'number' ? [] : {};
    if (cursor[seg as any] == null || typeof cursor[seg as any] !== 'object') {
      cursor[seg as any] = need;
    }
    cursor = cursor[seg as any];
  }
  cursor[segments[segments.length - 1]!] = value;
  return obj;
}

/**
 * Read the value at `path` inside `obj`. Returns undefined if any
 * intermediate segment is missing. Used to capture the ai_value when
 * recording a correction.
 */
export function getAtJsonPath(obj: any, path: string): unknown {
  const segments = parseJsonPath(path);
  let cursor: any = obj;
  for (const seg of segments) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = cursor[seg as any];
  }
  return cursor;
}

// ─── Provenance builder ───────────────────────────────────────────────────

/**
 * Build a sparse provenance map for the harmonised episode. v1 logic:
 *   - For each section we received: if its extracted_fields contain
 *     keys that look like top-level canonical leaves (patient name,
 *     diagnosis, etc.), tag those leaves with {source_section_id,
 *     confidence}.
 *   - Everything else is implicitly "llm_inferred". We don't enumerate
 *     every JSONPath in the episode — that would be unwieldy. The map
 *     is sparse: keys not present mean "no direct source claimed".
 *
 * This is intentionally coarse for v1 — a future wave can ask the LLM
 * to produce a strict provenance map field-by-field. For now we ground
 * the provenance to the section grain.
 */
function buildProvenanceMap(
  sections: HarmoniserSectionInput[],
): Record<string, { source_section_id: string; confidence: number | null; llm_inferred: boolean }> {
  const map: Record<
    string,
    { source_section_id: string; confidence: number | null; llm_inferred: boolean }
  > = {};
  for (const s of sections) {
    if (!s.category) continue;
    const conf =
      s.extraction_confidence && typeof s.extraction_confidence === 'object'
        ? // crude: max value in the per-field confidence map
          Math.max(
            0,
            ...Object.values(s.extraction_confidence as Record<string, unknown>)
              .map((v) => (typeof v === 'number' ? v : 0))
              .concat(0),
          )
        : null;
    // Map a few common categories to top-level JSONPath roots. Sparse
    // by design — only categories we recognise contribute.
    switch (s.category) {
      case 'discharge_summary':
        map['$.discharge_summary'] = {
          source_section_id: s.section_id,
          confidence: conf,
          llm_inferred: false,
        };
        break;
      case 'final_bill':
      case 'interim_bill':
      case 'pharmacy_bill':
        map['$.financial_summary'] = {
          source_section_id: s.section_id,
          confidence: conf,
          llm_inferred: false,
        };
        break;
      case 'admission_note':
      case 'admission_form':
        map['$.clinical_timeline'] = {
          source_section_id: s.section_id,
          confidence: conf,
          llm_inferred: false,
        };
        break;
      case 'investigation_report':
      case 'lab_report':
      case 'radiology_report':
        map['$.clinical_timeline[*].diagnostics_performed'] = {
          source_section_id: s.section_id,
          confidence: conf,
          llm_inferred: false,
        };
        break;
      case 'preauth_form':
      case 'pa_approval':
        map['$.insurance_context'] = {
          source_section_id: s.section_id,
          confidence: conf,
          llm_inferred: false,
        };
        break;
      default:
        // skip — falls into "llm_inferred" implicitly
        break;
    }
  }
  return map;
}

/**
 * Aggregate per-section confidence into a single 0..1 headline. Returns
 * null if no per-section signal is available.
 */
function aggregateConfidence(sections: HarmoniserSectionInput[]): number | null {
  const vals: number[] = [];
  for (const s of sections) {
    const ec: any = s.extraction_confidence;
    if (ec && typeof ec === 'object') {
      for (const v of Object.values(ec)) {
        if (typeof v === 'number') vals.push(v);
      }
    } else if (typeof s.classification_confidence === 'number') {
      vals.push(s.classification_confidence);
    }
  }
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.round(avg * 1000) / 1000;
}

// ─── Service ──────────────────────────────────────────────────────────────

export class HarmonisationService {
  private readonly pool: Pick<Pool, 'query' | 'connect'>;
  private readonly llm: LlmClient | null;
  private readonly cost: typeof costAccounting;

  constructor(deps: HarmonisationServiceDeps = {}) {
    this.pool = deps.pool ?? defaultPool;
    this.llm = deps.llm ?? null;
    this.cost = deps.cost ?? costAccounting;
  }

  private getLlm(): LlmClient {
    return this.llm ?? getLlmClient();
  }

  /**
   * Read the latest harmonised-episode row for a claim. Returns null
   * when no harmonisation has ever been run. Status='pending' rows are
   * returned as-is — the caller can decide whether to wait.
   */
  async getEpisode(claim_id: string): Promise<HarmonisedEpisodeRow | null> {
    const res = await this.pool.query<DbRow>(
      `SELECT ${SELECT_ALL_COLS}
         FROM hospital.claim_harmonised_episodes
        WHERE claim_id = $1`,
      [claim_id],
    );
    if ((res.rowCount ?? 0) === 0) return null;
    return rowToEpisode(res.rows[0]!);
  }

  /**
   * Idempotent harmonise. Cache key: dossier_state_hash + prompt_version.
   * Cache hit (and status='fresh' / 'corrected') returns the existing row
   * without an LLM call. force=true bypasses the cache.
   */
  async harmonise(input: HarmoniseInput): Promise<HarmonisedEpisodeRow> {
    const { claim_id, hospital_id, force = false } = input;

    // (a) Load dossier — throws if the IPD doesn't exist.
    const dossier = await claimDossierService.getDossier(claim_id);
    if (!dossier) {
      throw new Error(
        `harmonisation: no dossier projection for claim ${claim_id} — run intelligenceOrchestrator.analyzeClaim first`,
      );
    }

    // (b) Load document sections (joined to ipd_doc) for both the
    //     cache hash input and the user prompt.
    const sections = await this.loadSections(claim_id);
    const sectionIds = sections.map((s) => s.section_id);
    const dossier_state_hash = computeDossierStateHash(dossier, sectionIds);

    // (c) Cache check.
    if (!force) {
      const existing = await this.getEpisode(claim_id);
      if (
        existing &&
        existing.dossier_state_hash === dossier_state_hash &&
        existing.prompt_version === PROMPT_VERSION &&
        (existing.status === 'fresh' || existing.status === 'corrected')
      ) {
        logger.debug(
          { claim_id, dossier_state_hash, status: existing.status },
          'harmonisation: cache hit, returning existing',
        );
        return existing;
      }
    }

    // (d) Mark pending. We write a row with status='pending' BEFORE
    //     the LLM call so a concurrent reader sees that work is in
    //     progress (instead of an empty slot).
    await this.upsertPending(claim_id, dossier_state_hash);

    // (e) Budget pre-flight — block if hospital over cap or claim
    //     over its hard limit. checkBudget logs the verdict; we
    //     translate 'block' into a failed row + thrown error so the
    //     worker retries don't burn tokens.
    const verdict = await this.cost.checkBudget(claim_id, hospital_id);
    if (verdict.action === 'block') {
      const msg = `budget block: ${verdict.reason ?? 'over cap'}`;
      await this.upsertFailed(claim_id, dossier_state_hash, msg);
      throw new LlmBudgetExceededError(
        verdict.claimUnderLimit ? 'hospital_daily' : 'claim',
        verdict.claimSpendInr ?? 0,
        verdict.hospitalDailyCapInr ?? 0,
        { claimId: claim_id, hospitalId: hospital_id },
      );
    }

    // (f) Seed facts from hospital.ipds — augment the dossier summary
    //     with the row-level fields the dossier doesn't carry.
    const seed = await this.loadSeedFacts(claim_id, hospital_id);

    // (g) Build the user prompt.
    const userPrompt = buildUserPrompt({ dossier, sections, seed });

    // (h) Call the LLM. We pass schema=HarmonisedEpisodeSchema for the
    //     happy path; on Zod validation failure we retry the parse
    //     against HarmonisedEpisodePartial below.
    let llmResult: Awaited<ReturnType<LlmClient['extract']>> | null = null;
    let validationFallback: HarmonisedEpisodeT | null = null;
    let usedPartialSchema = false;

    try {
      llmResult = await this.getLlm().extract({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        schema: HarmonisedEpisodeSchema,
        tier: 'premium',
        promptVersion: PROMPT_VERSION,
        taskName: TASK_NAME,
        claimId: claim_id,
        hospitalId: hospital_id,
        cacheKey: `harmonise:${dossier_state_hash}`,
      });
    } catch (err) {
      // Try the partial fallback if validation failed.
      if (err instanceof LlmSchemaValidationError) {
        try {
          const partial = HarmonisedEpisodePartial.parse(JSON.parse(extractJsonBlock(err.rawResponse)));
          validationFallback = partial as any;
          usedPartialSchema = true;
          // We don't have token/cost numbers from a failed call's
          // raw response; we still want to capture *something* —
          // the bridge has already best-effort recorded the failed
          // call to llm_cost_log on its own.
        } catch {
          // partial parse also failed — give up and persist failure.
          await this.upsertFailed(
            claim_id,
            dossier_state_hash,
            `zod_validation_failed: ${err.message}`,
          );
          throw err;
        }
      } else {
        await this.upsertFailed(
          claim_id,
          dossier_state_hash,
          err instanceof Error ? err.message : String(err),
        );
        throw err;
      }
    }

    // (i) Build provenance + aggregate confidence.
    const provenance = buildProvenanceMap(sections);
    const confidence = aggregateConfidence(sections);
    const status: HarmonisationStatus = usedPartialSchema ? 'partial' : 'fresh';
    const episode: HarmonisedEpisodeT = (llmResult?.data ??
      (validationFallback as HarmonisedEpisodeT)) as HarmonisedEpisodeT;

    // Stamp episode_id / schema_version defensively — the LLM should
    // already have done so per the system prompt, but we hard-set in
    // case it didn't.
    if (episode && typeof episode === 'object') {
      const m = (episode as any).meta ?? {};
      m.schema_version = SCHEMA_VERSION;
      m.episode_id = m.episode_id ?? claim_id;
      (episode as any).meta = m;
    }

    // (j) UPSERT the row.
    const row = await this.upsertSuccess({
      claim_id,
      episode,
      provenance,
      dossier_state_hash,
      confidence,
      cost_inr: llmResult?.costInr ?? 0,
      tokens_used:
        (llmResult?.tokensInputUncached ?? 0) +
        (llmResult?.tokensInputCached ?? 0) +
        (llmResult?.tokensOutput ?? 0),
      llm_provider: llmResult?.provider ?? 'unknown',
      llm_model: llmResult?.model ?? 'unknown',
      status,
    });

    // (k) Record cost. Bridge does NOT auto-record (matches the
    //     reasoningAgent pattern); we explicitly write to llm_cost_log.
    if (llmResult) {
      await this.cost.recordCall({
        claimId: claim_id,
        hospitalId: hospital_id,
        task: TASK_NAME,
        provider: llmResult.provider,
        model: llmResult.model,
        promptVersion: PROMPT_VERSION,
        tokensInputUncached: llmResult.tokensInputUncached,
        tokensInputCached: llmResult.tokensInputCached,
        tokensOutput: llmResult.tokensOutput,
        latencyMs: llmResult.latencyMs,
        costInr: llmResult.costInr,
        succeeded: true,
      });
    }

    // (l) Dispatch typed event. Best-effort — failure here must not
    //     undo the UPSERT. Wrap in try/catch.
    try {
      await eventDispatcher.dispatch({
        kind: 'claim_harmonised',
        claimId: claim_id,
        hospitalId: hospital_id,
        payload: {
          dossier_state_hash,
          cost_inr: row.cost_inr ?? 0,
          tokens_used: row.tokens_used ?? 0,
          confidence: row.confidence,
        },
      });
    } catch (err) {
      logger.warn(
        { err, claim_id },
        'harmonisation: claim_harmonised event dispatch failed (row persisted)',
      );
    }

    logger.info(
      {
        claim_id,
        hospital_id,
        status: row.status,
        cost_inr: row.cost_inr,
        tokens_used: row.tokens_used,
        section_count: sections.length,
        dossier_state_hash,
      },
      'harmonisation: complete',
    );

    return row;
  }

  /**
   * Apply a human correction at a JSONPath. Mutates the episode JSONB,
   * records the correction row, flips status to 'corrected', and emits
   * the harmonisation_corrected event. Does NOT trigger a fresh LLM
   * call — corrections are layered on top of the existing harmonised
   * episode without invalidating the cache hash.
   */
  async applyCorrection(
    claim_id: string,
    json_path: string,
    human_value: unknown,
    corrected_by: string,
    reason?: string,
  ): Promise<void> {
    // Pre-flight: reject unparseable paths before opening a transaction.
    parseJsonPath(json_path);

    const client = await (this.pool as any).connect();
    try {
      await client.query('BEGIN');

      const cur = await client.query<DbRow>(
        `SELECT ${SELECT_ALL_COLS}
           FROM hospital.claim_harmonised_episodes
          WHERE claim_id = $1
          FOR UPDATE`,
        [claim_id],
      );
      if ((cur.rowCount ?? 0) === 0) {
        throw new Error(
          `harmonisation: no episode for claim ${claim_id} — cannot apply correction`,
        );
      }
      const row = cur.rows[0]!;

      const episode = (row.episode ?? {}) as any;
      const ai_value = getAtJsonPath(episode, json_path);
      setAtJsonPath(episode, json_path, human_value);

      // Insert audit row.
      await client.query(
        `INSERT INTO hospital.harmonisation_corrections
           (claim_id, json_path, ai_value, human_value, corrected_by,
            reason, applied_to_episode)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, true)`,
        [
          claim_id,
          json_path,
          ai_value === undefined ? null : JSON.stringify(ai_value),
          JSON.stringify(human_value),
          corrected_by,
          reason ?? null,
        ],
      );

      // Update the episode JSONB.
      await client.query(
        `UPDATE hospital.claim_harmonised_episodes
            SET episode = $2::jsonb,
                status = 'corrected',
                last_corrected_at = NOW()
          WHERE claim_id = $1`,
        [claim_id, JSON.stringify(episode)],
      );

      await client.query('COMMIT');

      // Wave 10 — mirror into the unified ai_corrections stream so the
      // kb miner can mine harmonisation_drift signatures. Best-effort.
      await recordCorrectionBestEffort({
        surface: 'harmonised_field',
        claim_id,
        target_id: json_path,
        target_kind: json_path,
        ai_value: ai_value === undefined ? null : ai_value,
        human_value,
        reason: reason ?? null,
        corrected_by,
      });

      // Dispatch event AFTER commit so a downstream listener can read
      // the corrected row.
      try {
        await eventDispatcher.dispatch({
          kind: 'harmonisation_corrected',
          claimId: claim_id,
          payload: {
            json_path,
            ai_value: ai_value === undefined ? null : ai_value,
            human_value,
            corrected_by,
          },
        });
      } catch (err) {
        logger.warn(
          { err, claim_id, json_path },
          'harmonisation: harmonisation_corrected event dispatch failed (correction persisted)',
        );
      }
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Convenience — harmonise with force=true. */
  async regenerate(
    claim_id: string,
    hospital_id: string,
  ): Promise<HarmonisedEpisodeRow> {
    return this.harmonise({ claim_id, hospital_id, force: true });
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  /**
   * Load document_sections + ipd_doc filename/s3_key, ordered by
   * (document_id, page_start) so the LLM sees sections in a stable
   * physical order.
   */
  private async loadSections(claim_id: string): Promise<HarmoniserSectionInput[]> {
    const res = await this.pool.query<{
      section_id: string;
      document_id: string;
      file_name: string | null;
      s3_key: string | null;
      category: string | null;
      classification_confidence: string | number | null;
      page_start: number | null;
      page_end: number | null;
      status: string | null;
      extracted_fields: any;
      extraction_confidence: any;
    }>(
      `SELECT ds.id AS section_id,
              ds.document_id,
              d.file_name,
              d.s3_key,
              ds.category,
              ds.classification_confidence,
              ds.page_start,
              ds.page_end,
              ds.status,
              ds.extracted_fields,
              ds.extraction_confidence
         FROM hospital.document_sections ds
         JOIN hospital.ipd_doc d ON d.id = ds.document_id
        WHERE ds.claim_id = $1
        ORDER BY ds.document_id, ds.page_start NULLS LAST, ds.id`,
      [claim_id],
    );
    return res.rows.map((r) => ({
      section_id: r.section_id,
      document_id: r.document_id,
      document_filename: r.file_name,
      document_s3_key: r.s3_key,
      category: r.category,
      classification_confidence:
        r.classification_confidence == null ? null : Number(r.classification_confidence),
      page_start: r.page_start,
      page_end: r.page_end,
      title: null,
      status: r.status,
      extracted_fields: r.extracted_fields,
      extraction_confidence: r.extraction_confidence,
    }));
  }

  /**
   * Pull the IPD seed-row facts (patient name, admission type, panel,
   * insurer, hospital name). The dossier carries some of this but not
   * all — and we want to be defensive.
   */
  private async loadSeedFacts(
    claim_id: string,
    hospital_id: string,
  ): Promise<HarmoniserSeedFacts> {
    const res = await this.pool.query<{
      first_name: string | null;
      last_name: string | null;
      admission_type: string | null;
      panel_id: string | null;
      hospital_panel_id: string | null;
      hospital_name: string | null;
    }>(
      `SELECT i.first_name, i.last_name, i.admission_type,
              i.panel_id, i.hospital_panel_id,
              h.name AS hospital_name
         FROM hospital.ipds i
         LEFT JOIN hospital.hospitals h ON h.id = i.hospital_id
        WHERE i.id = $1`,
      [claim_id],
    );
    const row = res.rows[0] ?? null;
    return {
      claim_id,
      hospital_id,
      hospital_name: row?.hospital_name ?? null,
      patient_first_name: row?.first_name ?? null,
      patient_last_name: row?.last_name ?? null,
      admission_type: row?.admission_type ?? null,
      panel_id: row?.panel_id ?? null,
      insurer_id: row?.hospital_panel_id ?? null,
    };
  }

  /**
   * UPSERT a status='pending' row. Used before the LLM call so a
   * concurrent reader sees that work is in flight. episode column is
   * NOT NULL on the table, so we write an empty object placeholder.
   */
  private async upsertPending(
    claim_id: string,
    dossier_state_hash: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO hospital.claim_harmonised_episodes
         (claim_id, episode, schema_version, prompt_version,
          dossier_state_hash, status)
       VALUES ($1, '{}'::jsonb, $2, $3, $4, 'pending')
       ON CONFLICT (claim_id) DO UPDATE
         SET status = 'pending',
             dossier_state_hash = EXCLUDED.dossier_state_hash,
             prompt_version = EXCLUDED.prompt_version,
             error_message = NULL`,
      [claim_id, SCHEMA_VERSION, PROMPT_VERSION, dossier_state_hash],
    );
  }

  /**
   * Persist a failure. Sets status='failed' + error_message; keeps the
   * existing episode JSONB in place so a stale-but-readable harmonisation
   * remains visible to the cockpit during outages.
   */
  private async upsertFailed(
    claim_id: string,
    dossier_state_hash: string,
    error_message: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO hospital.claim_harmonised_episodes
         (claim_id, episode, schema_version, prompt_version,
          dossier_state_hash, status, error_message)
       VALUES ($1, '{}'::jsonb, $2, $3, $4, 'failed', $5)
       ON CONFLICT (claim_id) DO UPDATE
         SET status = 'failed',
             error_message = EXCLUDED.error_message,
             dossier_state_hash = EXCLUDED.dossier_state_hash,
             prompt_version = EXCLUDED.prompt_version`,
      [
        claim_id,
        SCHEMA_VERSION,
        PROMPT_VERSION,
        dossier_state_hash,
        error_message.slice(0, 4000),
      ],
    );
  }

  /**
   * UPSERT a successful harmonisation row.
   */
  private async upsertSuccess(args: {
    claim_id: string;
    episode: HarmonisedEpisodeT;
    provenance: Record<string, unknown>;
    dossier_state_hash: string;
    confidence: number | null;
    cost_inr: number;
    tokens_used: number;
    llm_provider: string;
    llm_model: string;
    status: HarmonisationStatus;
  }): Promise<HarmonisedEpisodeRow> {
    const res = await this.pool.query<DbRow>(
      `INSERT INTO hospital.claim_harmonised_episodes
         (claim_id, episode, schema_version, prompt_version, confidence,
          provenance, dossier_state_hash,
          cost_inr, tokens_used, llm_provider, llm_model,
          status, error_message, generated_at)
       VALUES (
          $1, $2::jsonb, $3, $4, $5,
          $6::jsonb, $7,
          $8, $9, $10, $11,
          $12, NULL, NOW()
       )
       ON CONFLICT (claim_id) DO UPDATE
         SET episode = EXCLUDED.episode,
             schema_version = EXCLUDED.schema_version,
             prompt_version = EXCLUDED.prompt_version,
             confidence = EXCLUDED.confidence,
             provenance = EXCLUDED.provenance,
             dossier_state_hash = EXCLUDED.dossier_state_hash,
             cost_inr = EXCLUDED.cost_inr,
             tokens_used = EXCLUDED.tokens_used,
             llm_provider = EXCLUDED.llm_provider,
             llm_model = EXCLUDED.llm_model,
             status = EXCLUDED.status,
             error_message = NULL,
             generated_at = NOW()
       RETURNING ${SELECT_ALL_COLS}`,
      [
        args.claim_id,
        JSON.stringify(args.episode),
        SCHEMA_VERSION,
        PROMPT_VERSION,
        args.confidence,
        JSON.stringify(args.provenance),
        args.dossier_state_hash,
        args.cost_inr,
        args.tokens_used,
        args.llm_provider,
        args.llm_model,
        args.status,
      ],
    );
    return rowToEpisode(res.rows[0]!);
  }
}

/**
 * Extract the JSON body from a fenced ```json block, or fall back to
 * the first {...} balanced span. Used in the partial-schema fallback
 * path where we re-parse the raw LLM response with a looser schema.
 */
function extractJsonBlock(raw: string): string {
  if (!raw) return '{}';
  const fence = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

// ─── Default singleton ────────────────────────────────────────────────────
export const harmonisationService = new HarmonisationService();
export default harmonisationService;
