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
import {
  findCanonicalPatient,
  classifySectionIdentity,
  crossValidateIdentity,
  type CanonicalPatient,
  type IdentityMismatch,
  type WrongPmjayCard,
} from './harmoniser/patientIdentity.js';
// Wire-up note (May 21, 2026): validateDiagnosisName now sourced from
// the new permissive validator in postValidators.ts. The legacy narrow
// validator in ./harmoniser/diagnosisValidator wrongly rejected
// "Suspected Typhoid Fever", "AWMI", "# Both bone forearm" etc. The
// new one has comprehensive Indian-hospital diagnosis vocabulary plus
// a pure-symptom blocklist (so "chest pain" still gets rejected when
// used as a fake diagnosis). The legacy module still owns the
// source-category gating helpers.
import { validateDiagnosisName } from './extractor/postValidators.js';
import {
  isAllowedSourceCategory,
  inferDiagnosisSourceCategory,
  ALLOWED_DIAGNOSIS_SOURCE_CATEGORIES,
} from './harmoniser/diagnosisValidator.js';
import { canonicalizeHospitalName } from './harmoniser/hospitalCanonicalizer.js';

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
  /**
   * Optional per-section extraction fingerprints. When supplied, the hash
   * becomes sensitive to changes in extracted_fields — fixing the race
   * where harmonise() runs before all extractions complete, caches an
   * empty-supporting_documents result, and then refuses to re-run when
   * extractions land later (because the section_ids set hasn't changed).
   *
   * Each entry is `{ id: section_id, h: sha256(extracted_fields) }`.
   * Callers should pass the FULL list for the claim; the hash sorts by
   * id so order doesn't matter.
   *
   * Backwards-compatible: omitting this argument reproduces the pre-fix
   * hash exactly (existing tests + cached rows aren't invalidated).
   */
  extractionFingerprints?: Array<{ id: string; h: string }>,
): string {
  const subset: Record<string, unknown> = {
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
  if (extractionFingerprints && extractionFingerprints.length > 0) {
    subset.section_extractions = [...extractionFingerprints]
      .sort((a, b) => a.id.localeCompare(b.id));
  }
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

// ─── Supporting-documents stitcher ────────────────────────────────────────

/**
 * Slot-promotion map: which doc_category fields populate which canonical
 * episode slots. Used when a single, unambiguous source-of-truth exists
 * for a canonical field (e.g. the aadhaar_card section's aadhaar_number
 * IS patient_context.identification.aadhaar_number).
 *
 * Keys are JSON Pointer-style paths into the canonical episode; values
 * are an ordered list of (category, field_key) candidates. The first
 * candidate that produces a non-empty value wins. Ordering matters when
 * multiple categories carry the same field — list the most reliable
 * source first.
 *
 * To add a new slot: append to this map. No service changes required.
 */
const CANONICAL_SLOT_PROMOTIONS: Record<
  string,
  ReadonlyArray<{ category: string; field_key: string }>
> = {
  '/patient_context/identification/aadhaar_number': [
    { category: 'aadhaar_card', field_key: 'aadhaar_number' },
    { category: 'aadhaar_front', field_key: 'aadhaar_number' },
  ],
  '/patient_context/identification/pan_number': [
    { category: 'pan_card', field_key: 'pan_number' },
  ],
  '/patient_context/identification/ration_card_number': [
    { category: 'ration_card', field_key: 'ration_card_number' },
  ],
  '/patient_context/identification/pmjay_beneficiary_id': [
    { category: 'pmjay_bis_family_tree', field_key: 'pmjay_beneficiary_id' },
  ],
  '/patient_context/date_of_birth': [
    { category: 'aadhaar_front', field_key: 'date_of_birth' },
  ],
  '/patient_context/address/pincode': [
    { category: 'aadhaar_card', field_key: 'pin_code' },
  ],
};

/**
 * Mutates `episode` in place to add:
 *   1. `supporting_documents.{category}` — an array of every section's
 *      extracted_fields for that category, each tagged with section_id
 *      and document_id so the rules engine can trace lineage.
 *   2. Slot promotions per CANONICAL_SLOT_PROMOTIONS above. Only writes
 *      slots that are currently empty/null — never overwrites whatever
 *      the LLM produced.
 *
 * No-ops if the sections array is empty.
 */
function stitchSupportingDocuments(
  episode: any,
  sections: HarmoniserSectionInput[],
): void {
  if (!episode || typeof episode !== 'object') return;
  if (!Array.isArray(sections) || sections.length === 0) return;

  // ─── Pass 1: aggregate verbatim payloads by category ─────────────────
  const supporting: Record<string, Array<Record<string, any>>> = {};
  for (const s of sections) {
    const fields = s.extracted_fields;
    if (!fields || typeof fields !== 'object') continue;
    if (Object.keys(fields).length === 0) continue;
    if (!s.category) continue;
    const bucket = supporting[s.category] ?? [];
    bucket.push({
      _section_id: s.section_id,
      _document_id: s.document_id,
      _document_filename: s.document_filename,
      _pages: { start: s.page_start, end: s.page_end },
      ...fields,
    });
    supporting[s.category] = bucket;
  }
  if (Object.keys(supporting).length > 0) {
    episode.supporting_documents = supporting;
  }

  // ─── Pass 2: slot promotion into canonical paths ─────────────────────
  for (const [pointer, candidates] of Object.entries(
    CANONICAL_SLOT_PROMOTIONS,
  )) {
    // Skip if the LLM already populated the slot.
    if (jsonPointerHasValue(episode, pointer)) continue;
    // Walk candidates in order; first non-empty wins.
    for (const c of candidates) {
      const bucket = supporting[c.category];
      if (!bucket || bucket.length === 0) continue;
      // Pick the row with the highest per-field confidence (or the first
      // one if confidence isn't tracked per-bucket-entry).
      const value = pickBestFieldValue(bucket, c.field_key);
      if (value !== undefined && value !== null && value !== '') {
        jsonPointerSet(episode, pointer, value);
        break;
      }
    }
  }
}

/** Pick the field value with the highest confidence across multiple sections of the same category. */
function pickBestFieldValue(
  bucket: Array<Record<string, any>>,
  fieldKey: string,
): unknown {
  let best: { value: unknown; conf: number } | null = null;
  for (const row of bucket) {
    const v = row[fieldKey];
    if (v === undefined || v === null || v === '') continue;
    // We don't have confidence in the bucket row directly (we strip it
    // when building supporting_documents). For now, take the first
    // present value — sections were already sorted by document_id then
    // page in loadSections. A future refinement could thread the
    // confidence map through here.
    if (!best) best = { value: v, conf: 1 };
  }
  return best?.value;
}

/** Is the value at `pointer` truthy? */
function jsonPointerHasValue(obj: any, pointer: string): boolean {
  const segments = pointer.split('/').filter(Boolean);
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return false;
    cur = cur[seg];
  }
  return cur !== undefined && cur !== null && cur !== '';
}

/** Set the value at `pointer`, creating intermediate objects as needed. */
function jsonPointerSet(obj: any, pointer: string, value: unknown): void {
  const segments = pointer.split('/').filter(Boolean);
  let cur = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (cur[seg] === undefined || cur[seg] === null) cur[seg] = {};
    cur = cur[seg];
  }
  cur[segments[segments.length - 1]!] = value;
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
    // Per-section extraction fingerprints — makes the cache key sensitive
    // to extracted_fields changes. Without this, a harmoniser call that
    // races ahead of in-flight extractions caches an empty
    // supporting_documents result and refuses to re-run when the
    // extractions land later (same section_ids → same hash).
    const extractionFingerprints = sections.map((s) => ({
      id: s.section_id,
      h: createHash('sha256')
        .update(stableStringify(s.extracted_fields ?? {}))
        .digest('hex')
        .slice(0, 16),
    }));
    const dossier_state_hash = computeDossierStateHash(
      dossier,
      sectionIds,
      extractionFingerprints,
    );

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

    // (f.5) Patient-identity anchor (Task H4) + ID cross-validation (Task H10).
    //
    // Compute the canonical patient identity from high-trust ID docs and
    // filter the section list to drop foreign documents (smoke-test
    // findings: Babbu's bundle contained an X-ray for "MR PAPPU";
    // Aman Faiz's had a "Mrs. Begum Faiz" consent; Vahadur's had a
    // traffic-violation affidavit for "Smt. ANUPMA VERMA"). The dropped
    // sections are recorded as validation_metadata.foreign_documents so
    // the operator can audit the gate.
    //
    // We also pre-compute identity-mismatch + wrong_pmjay_card
    // signals here; both are stamped onto the harmonised episode after
    // the LLM call (so we have one consistent place writing
    // validation_metadata). Wrong pmjay cards are ALSO filtered from
    // the section list — they're a different person entirely and
    // shouldn't seed downstream rules.
    const identityGate = this.applyIdentityGate(sections, seed);

    // (g) Build the user prompt. Pass the canonical patient name + the
    //     diagnosis-source constraint via the buildUserPrompt 'hints'
    //     channel (concatenated as a TASK_ADDENDUM block) so the LLM
    //     biases towards picking clinical sources for diagnosis_name
    //     and towards the canonical patient when fields disagree.
    const promptHints = this.buildPromptHints(identityGate.canonical) +
      this.buildDeterministicFactsBlock(identityGate.keptSections);
    const userPrompt = buildUserPrompt({
      dossier,
      sections: identityGate.keptSections,
      seed,
    }) + promptHints;

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

    // (i) Build provenance + aggregate confidence. Use the
    //     identity-gated section list so dropped foreign documents
    //     don't appear as supporting evidence anywhere downstream.
    const keptSections = identityGate.keptSections;
    const provenance = buildProvenanceMap(keptSections);
    const confidence = aggregateConfidence(keptSections);
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

    // (i.5) Stitch per-section extracted_fields into the episode.
    //
    // The LLM produces the clinical narrative (timeline, diagnosis,
    // financial summary) but doesn't have direct access to every
    // structured KYC/supporting-doc payload we've extracted. We post-
    // process by walking every section and aggregating its
    // extracted_fields under two complementary surfaces:
    //
    //   1. Verbatim payloads, keyed by category, under
    //      `supporting_documents.{category}.{section_id}` — preserves
    //      everything the extractor pulled, so rules can ask things
    //      like `$.supporting_documents.aadhaar_front[*].full_name ==
    //      $.supporting_documents.pmjay_bis_family_tree[*].head_of_family`.
    //
    //   2. Slot promotion: canonical fields the schema already has
    //      (e.g. patient_context.identification.aadhaar_number) are
    //      populated from the most-confident matching section. Keeps
    //      the harmonised episode useful to consumers that don't know
    //      about supporting_documents (legacy code, dashboards).
    //
    // This is deterministic post-processing — no LLM call, no extra
    // cost. Re-runs always reproduce the same stitched output for a
    // given set of extracted_fields.
    stitchSupportingDocuments(episode, keptSections);

    // (i.6) Post-LLM validation (Tasks H2 + H4 + H10).
    //
    // Constrains primary_diagnosis to clinical sources, enforces the
    // pattern blocklist, stamps foreign-document / identity-mismatch /
    // wrong-pmjay-card findings onto validation_metadata, and degrades
    // data_completeness_score for each identity mismatch found (each
    // mismatch = -0.1, floored at 0).
    this.applyPostLlmValidation(episode, keptSections, identityGate);

    // (i.6.5) Fix 14 (May 21, 2026): merge deterministic facts into the
    // episode as a post-LLM safety net. Even when the prompt block lists
    // verified IDs, the LLM sometimes ignores them. This walks
    // treating_team doctors + patient_context identification and fills
    // null/missing fields from deterministic facts where applicable.
    this.mergeDeterministicFactsIntoEpisode(episode, keptSections);

    // (i.7) Hospital-name canonicalisation.
    //
    // The LLM extracts hospital_context.name from whatever letterhead
    // the OCR picked up first. iter5 bench showed this routinely
    // diverges from the authoritative hospital.hospitals row (e.g.
    // "Akshay Heart Hospital" vs the DB canonical, "Jigyasa Hospital"
    // vs "Jigyasa Super Speciality Hospital"). Wrong-spelling variants
    // break downstream deduplication — episodes from the same hospital
    // fail to group together.
    //
    // Replace the LLM value with the DB canonical and stash diagnostic
    // info in validation_metadata. When the LLM string is FAR from the
    // DB one ('low' confidence) we also flag hospital_name_suspicious
    // — that typically means a foreign referral letterhead slipped
    // past H4.
    //
    // The harmonisedEpisode schema's field is hospital_context.name;
    // we also keep hospital_name in sync when the LLM emitted that
    // alias, so downstream consumers reading either key see the
    // canonical value.
    try {
      const hc = (episode.hospital_context ?? {}) as Record<string, unknown>;
      const fromName =
        typeof hc.name === 'string' && (hc.name as string).trim() !== ''
          ? (hc.name as string)
          : null;
      const fromHospitalName =
        typeof hc.hospital_name === 'string' &&
        (hc.hospital_name as string).trim() !== ''
          ? (hc.hospital_name as string)
          : null;
      const llmName: string | null = fromName ?? fromHospitalName;
      const canon = await canonicalizeHospitalName(hospital_id, llmName, this.pool);
      const replacement = canon.canonical_name || llmName || null;
      hc.name = replacement;
      if (fromHospitalName !== null) hc.hospital_name = replacement;
      episode.hospital_context = hc;

      const vm = (episode.validation_metadata ?? {}) as Record<string, unknown>;
      vm.hospital_name_canonicalization = {
        llm_extracted: canon.llm_extracted,
        match_distance: canon.match_distance,
        match_confidence: canon.match_confidence,
      };
      if (canon.match_confidence === 'low') {
        vm.hospital_name_suspicious = true;
      }
      episode.validation_metadata = vm;
    } catch (err) {
      logger.warn(
        { err, claim_id, hospital_id },
        'harmonisation: hospital-name canonicalisation failed (non-fatal)',
      );
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
        section_count_kept: identityGate.keptSections.length,
        foreign_documents: identityGate.foreignDocuments.length,
        identity_mismatches: identityGate.identityMismatches.length,
        wrong_pmjay_cards: identityGate.wrongPmjayCards.length,
        canonical_patient: identityGate.canonical?.name ?? null,
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

  // ─── Identity-gate + post-LLM validation helpers ─────────────────────

  /**
   * Run the patient-identity anchor over the section list. Returns:
   *
   *   - canonical:           the elected patient identity (null if no
   *                          high-trust ID doc carried a name)
   *   - keptSections:        the input sections minus foreign documents
   *                          and wrong pmjay cards
   *   - weakMatches:         sections with a borderline name match
   *                          (0.3 < d ≤ 0.5) — kept but flagged
   *   - foreignDocuments:    sections dropped for diverging patient
   *                          name (>0.5)
   *   - identityMismatches:  pairwise name disagreements among the
   *                          high-trust ID docs (>0.4)
   *   - wrongPmjayCards:     pmjay_card sections whose holder name is
   *                          a different person (>0.6 from canonical)
   *
   * All values are tagged onto the harmonised episode in
   * applyPostLlmValidation. The wrong_pmjay_card sections are dropped
   * from keptSections so downstream rules (slot promotion,
   * supporting_documents) don't see them.
   *
   * NOTE: when the canonical can't be computed we PASS THROUGH every
   * section unchanged — we don't want to silently drop documents on a
   * claim with weak KYC coverage. The downstream LLM still gets the
   * full set, and validation_metadata records canonical_patient=null.
   */
  private applyIdentityGate(
    sections: HarmoniserSectionInput[],
    seed: HarmoniserSeedFacts,
  ): {
    canonical: CanonicalPatient | null;
    keptSections: HarmoniserSectionInput[];
    weakMatches: Array<{ section_id: string; observed_name: string; distance: number }>;
    foreignDocuments: Array<{
      section_id: string;
      category: string | null;
      observed_name: string;
      canonical_name: string;
      distance: number;
    }>;
    identityMismatches: IdentityMismatch[];
    wrongPmjayCards: WrongPmjayCard[];
  } {
    const seedName =
      [seed.patient_first_name, seed.patient_last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || null;
    const canonical = findCanonicalPatient(sections, seedName);

    const keptSections: HarmoniserSectionInput[] = [];
    const weakMatches: Array<{ section_id: string; observed_name: string; distance: number }> = [];
    const foreignDocuments: Array<{
      section_id: string;
      category: string | null;
      observed_name: string;
      canonical_name: string;
      distance: number;
    }> = [];

    let identityMismatches: IdentityMismatch[] = [];
    let wrongPmjayCards: WrongPmjayCard[] = [];

    if (!canonical) {
      // No anchor — pass through. Cross-validation is meaningless
      // without a canonical reference.
      return {
        canonical: null,
        keptSections: [...sections],
        weakMatches: [],
        foreignDocuments: [],
        identityMismatches: [],
        wrongPmjayCards: [],
      };
    }

    const xv = crossValidateIdentity(sections, canonical);
    identityMismatches = xv.mismatches;
    wrongPmjayCards = xv.wrong_pmjay_cards;
    const wrongPmjaySectionIds = new Set(
      wrongPmjayCards.map((w) => w.section_id),
    );

    for (const s of sections) {
      // H10: drop pmjay_card sections that belong to a different person.
      if (wrongPmjaySectionIds.has(s.section_id)) {
        foreignDocuments.push({
          section_id: s.section_id,
          category: s.category,
          observed_name:
            wrongPmjayCards.find((w) => w.section_id === s.section_id)
              ?.observed_holder ?? '',
          canonical_name: canonical.name,
          distance:
            wrongPmjayCards.find((w) => w.section_id === s.section_id)
              ?.distance ?? 1,
        });
        continue;
      }

      // H4: per-section identity classification.
      const verdict = classifySectionIdentity(s, canonical);
      if (verdict.decision === 'drop' && verdict.observed_name) {
        foreignDocuments.push({
          section_id: s.section_id,
          category: s.category,
          observed_name: verdict.observed_name,
          canonical_name: canonical.name,
          distance: verdict.distance,
        });
        continue;
      }
      if (verdict.decision === 'weak' && verdict.observed_name) {
        weakMatches.push({
          section_id: s.section_id,
          observed_name: verdict.observed_name,
          distance: verdict.distance,
        });
      }
      keptSections.push(s);
    }

    return {
      canonical,
      keptSections,
      weakMatches,
      foreignDocuments,
      identityMismatches,
      wrongPmjayCards,
    };
  }

  /**
   * Construct an addendum block appended to the user prompt. Tells the
   * LLM the canonical patient name + constrains where it may draw the
   * primary_diagnosis from.
   *
   * Idempotent: when canonical is null we only emit the diagnosis-
   * source constraint.
   */
  private buildPromptHints(canonical: CanonicalPatient | null): string {
    const allowed = Array.from(ALLOWED_DIAGNOSIS_SOURCE_CATEGORIES).join(', ');
    const lines: string[] = [
      '',
      '=== HARMONISER_ADDENDUM (validation hints) ===',
    ];
    if (canonical) {
      lines.push(
        `CANONICAL_PATIENT_NAME="${canonical.name}" (confidence=${canonical.confidence.toFixed(2)}). When extracted fields disagree, prefer values consistent with this patient. Foreign-document sections have already been filtered out.`,
      );
    }
    lines.push(
      `DIAGNOSIS_SOURCE_CONSTRAINT: When assigning diagnosis.primary_diagnosis.diagnosis_name, you MUST draw the value from sections whose category is one of {${allowed}}. Do NOT use values from aadhaar, ration_card, pmjay_card, photos, or consent-form free-text fields. If no clinical section provides a diagnosis, OMIT primary_diagnosis.diagnosis_name (set diagnosis to {} or set the value to null) rather than inventing one or copying a generic placeholder like "Orthopaedics case - trauma/injury related".`,
    );
    return '\n' + lines.join('\n');
  }

  /**
   * Fix 14 post-merge (May 21, 2026): walk the harmonised episode and
   * fill MISSING fields from deterministic facts. Never overwrites a
   * non-empty LLM-emitted value — if the LLM disagrees with regex, the
   * LLM wins (it has more context). We only fill the gaps.
   *
   * Surfaces filled:
   *   - hospital_context.treating_team.primary_consultant.registration_number
   *     (from the highest-confidence doctor_nmc_id)
   *   - patient_context.identification.aadhaar_number / pmjay_id / abha
   *   - patient_context.contact.mobile (preferred over secondary)
   */
  private mergeDeterministicFactsIntoEpisode(episode: any, sections: HarmoniserSectionInput[]): void {
    if (!episode || typeof episode !== 'object') return;

    interface Fact { kind: string; value: string; confidence?: number }
    // Same confidence threshold as the prompt block — keep them in sync.
    const MIN_CONFIDENCE = 0.7;
    const seen = new Set<string>();
    const facts: Fact[] = [];
    for (const s of sections) {
      const ec = s.extraction_confidence as Record<string, unknown> | null | undefined;
      const det = ec?._deterministic_facts as { facts?: Fact[] } | undefined;
      if (!det || !Array.isArray(det.facts)) continue;
      for (const f of det.facts) {
        if ((f.confidence ?? 1) < MIN_CONFIDENCE) continue;
        const k = `${f.kind}::${f.value}`;
        if (seen.has(k)) continue;
        seen.add(k);
        facts.push(f);
      }
    }
    if (facts.length === 0) return;

    const byKind = new Map<string, Fact[]>();
    for (const f of facts) {
      if (!byKind.has(f.kind)) byKind.set(f.kind, []);
      byKind.get(f.kind)!.push(f);
    }
    const best = (kind: string): Fact | null => {
      const list = byKind.get(kind);
      if (!list || list.length === 0) return null;
      return list.slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]!;
    };

    const filled: string[] = [];

    // ─── Doctor NMC ───
    const nmc = best('doctor_nmc_id');
    if (nmc) {
      // Try multiple paths — different LLMs emit it in different places.
      const team = episode?.hospital_context?.treating_team;
      const targets: any[] = [];
      if (team?.primary_consultant && typeof team.primary_consultant === 'object') targets.push(team.primary_consultant);
      if (Array.isArray(team?.surgeons)) for (const s of team.surgeons) if (s && typeof s === 'object') targets.push(s);
      if (Array.isArray(team?.secondary_consultants)) for (const s of team.secondary_consultants) if (s && typeof s === 'object') targets.push(s);
      for (const t of targets) {
        const cur = typeof t.registration_number === 'string' ? t.registration_number.trim() : '';
        if (!cur) {
          t.registration_number = nmc.value;
          filled.push(`treating_team.${t.name ?? 'doctor'}.registration_number = ${nmc.value}`);
          break; // fill only the first empty doctor
        }
      }
    }

    // ─── Patient identification ───
    if (!episode.patient_context) episode.patient_context = {};
    if (!episode.patient_context.identification || typeof episode.patient_context.identification !== 'object') {
      episode.patient_context.identification = {};
    }
    const ident = episode.patient_context.identification;
    const aad = best('aadhaar_number');
    if (aad && !ident.aadhaar_number) { ident.aadhaar_number = aad.value; filled.push(`patient.aadhaar = ${aad.value.slice(0,4)}****${aad.value.slice(-4)}`); }
    const pmj = best('pmjay_id');
    if (pmj && !ident.pmjay_id) { ident.pmjay_id = pmj.value; filled.push(`patient.pmjay_id = ${pmj.value}`); }
    const abha = best('abha_number');
    if (abha && !ident.abha_number) { ident.abha_number = abha.value; filled.push(`patient.abha = ${abha.value}`); }

    // ─── Patient mobile ───
    const mobiles = byKind.get('mobile_number') ?? [];
    if (mobiles.length > 0) {
      if (!episode.patient_context.contact || typeof episode.patient_context.contact !== 'object') {
        episode.patient_context.contact = {};
      }
      const contact = episode.patient_context.contact;
      // Don't overwrite existing mobile; only fill if empty.
      if (!contact.mobile) {
        contact.mobile = mobiles[0]!.value;
        filled.push(`patient.contact.mobile = ${mobiles[0]!.value}`);
      }
    }

    if (filled.length > 0) {
      const vm = (episode.validation_metadata ?? {}) as Record<string, unknown>;
      vm.deterministic_facts_merged = filled;
      episode.validation_metadata = vm;
    }
  }

  /**
   * Fix 14 (May 21, 2026): surface DETERMINISTIC_FACTS to the harmoniser.
   *
   * P1a writes regex-extracted IDs/dates/amounts into each section's
   * extraction_confidence._deterministic_facts. Until now those facts
   * sat in the DB unused — the harmoniser LLM never saw them, so doctor
   * registration_numbers and other regex-recoverable fields stayed
   * empty in the harmonised episode.
   *
   * This block aggregates the deterministic facts across all kept
   * sections and appends them as an authoritative "use these exact
   * values" block to the prompt. The LLM is told to PREFER these over
   * its own re-extraction and to populate registration_number,
   * aadhaar_number, etc. directly from this list.
   *
   * Dedup by (kind, value) — a doctor's NMC ID appearing on every page
   * shouldn't repeat in the prompt.
   */
  private buildDeterministicFactsBlock(sections: HarmoniserSectionInput[]): string {
    interface Fact { kind: string; value: string; confidence?: number }
    // Fix 14.1 (May 21, 2026): threshold low-confidence facts. Anuj's
    // MPMC Reg "21274" got OCR'd as "212" with confidence 0.55 — the
    // regex still matched but the value is garbage. Filtering at >=0.7
    // suppresses these false positives while still injecting genuine
    // signals like Kalksum's reg 66610 (conf=0.8).
    const MIN_CONFIDENCE = 0.7;
    const seen = new Set<string>();
    const facts: Fact[] = [];
    for (const s of sections) {
      const ec = s.extraction_confidence as Record<string, unknown> | null | undefined;
      const det = ec?._deterministic_facts as { facts?: Fact[] } | undefined;
      if (!det || !Array.isArray(det.facts)) continue;
      for (const f of det.facts) {
        if ((f.confidence ?? 1) < MIN_CONFIDENCE) continue;
        const k = `${f.kind}::${f.value}`;
        if (seen.has(k)) continue;
        seen.add(k);
        facts.push(f);
      }
    }
    if (facts.length === 0) return '';

    // Group by kind for prompt readability.
    const byKind = new Map<string, Fact[]>();
    for (const f of facts) {
      if (!byKind.has(f.kind)) byKind.set(f.kind, []);
      byKind.get(f.kind)!.push(f);
    }

    const lines: string[] = [
      '',
      '=== DETERMINISTIC_FACTS (regex/checksum-validated; prefer these over re-extraction) ===',
      'These values were extracted directly from OCR text by deterministic patterns',
      '(NMC/MPMC reg-number regex, Aadhaar Verhoeff checksum, etc.). When populating',
      'fields like treating_team.primary_consultant.registration_number,',
      'patient_context.identification.aadhaar_number, pmjay_id, mobile, or dates,',
      'PREFER the value listed here over any value you re-extract from the section text.',
    ];
    for (const [kind, list] of byKind.entries()) {
      const values = list
        .map((f) => f.confidence != null ? `${f.value} (conf=${f.confidence.toFixed(2)})` : f.value)
        .join(', ');
      lines.push(`  ${kind}: ${values}`);
    }
    return '\n' + lines.join('\n');
  }

  /**
   * Stamp validation_metadata + apply hard guards on the LLM's output.
   *
   * 1.  primary_diagnosis sanitisation (Task H2):
   *     - reject blocklist phrases ("Orthopaedics case - trauma/...",
   *       "Surgical condition requiring intervention", "WITH A/E POP SLAB")
   *     - reject person-name shapes
   *     - reject strings with no clinical keywords
   *     - if rejected, null the diagnosis_name and record
   *       validation_metadata.diagnosis_rejected
   *     - also enforce the source-category allowlist: if we can infer
   *       the source category and it's not clinical, null + record
   *       validation_metadata.diagnosis_source_invalid
   *
   * 2.  Foreign documents (Task H4): record the dropped sections.
   *
   * 3.  Identity mismatches + wrong pmjay cards (Task H10): record
   *     them and degrade data_completeness_score by 0.1 each.
   *
   * 4.  Weak matches: surfaced on each affected section's lineage
   *     entry under validation_metadata.identity_match_weak[].
   */
  private applyPostLlmValidation(
    episode: any,
    keptSections: HarmoniserSectionInput[],
    gate: ReturnType<HarmonisationService['applyIdentityGate']>,
  ): void {
    if (!episode || typeof episode !== 'object') return;

    const vm = (episode.validation_metadata ?? {}) as Record<string, unknown>;

    // ─── H2: primary_diagnosis sanitisation ────────────────────────────
    //
    // Evidence-based override (added May 2026 — iter5 P0 fix):
    //   When the LLM provides a confident `diagnosis.evidence_based.primary`
    //   candidate backed by ≥2 supporting evidence lines AND at least one
    //   piece of HARD evidence (lab_positive, lab_value, imaging_finding,
    //   or ecg_finding — i.e. NOT just clinical_observation /
    //   documented_history / treatment_consistency), we trust it. The
    //   keyword-based regex on diagnosis_name is too brittle to catch
    //   things like "Suspected Typhoid Fever" (was rejected as
    //   no_clinical_keywords even though Widal POSITIVE confirmed it) or
    //   "Acute MI with Triple Vessel Disease" (currently displaced by
    //   the chief complaint "chest pain").
    //
    //   When the override fires:
    //     - DO NOT null primary_diagnosis.diagnosis_name
    //     - Mirror evidence_based.primary.candidate_name into
    //       primary_diagnosis.diagnosis_name when the legacy field is
    //       empty or disagrees, so downstream consumers (FE, KB, etc.)
    //       see the same value.
    //     - Stash validation_metadata.diagnosis_evidence_override=true
    //       for observability.
    const dx = episode.diagnosis;
    if (dx && typeof dx === 'object') {
      const evidenceBased = (dx as any).evidence_based;
      const evidencePrimary =
        evidenceBased && typeof evidenceBased === 'object'
          ? evidenceBased.primary
          : null;
      const evidenceOverride = (() => {
        if (!evidencePrimary || typeof evidencePrimary !== 'object') return false;
        const conf = Number(evidencePrimary.confidence);
        if (!Number.isFinite(conf) || conf < 0.7) return false;
        const supporting = Array.isArray(evidencePrimary.supporting_evidence)
          ? evidencePrimary.supporting_evidence
          : [];
        if (supporting.length < 2) return false;
        // Hard evidence = labs / imaging / ECG. We accept the canonical
        // enum values AND common LLM aliases ('lab_finding', 'lab_result',
        // 'angiogram_finding', 'xray_finding', 'ct_finding', etc.) via
        // prefix matching, so we don't lose override coverage when the
        // model drifts on terminology. Soft evidence (clinical_observation,
        // documented_history, treatment_consistency) is NOT counted.
        const isHardKind = (kind: unknown): boolean => {
          if (typeof kind !== 'string') return false;
          const k = kind.toLowerCase();
          if (
            k === 'clinical_observation' ||
            k === 'documented_history' ||
            k === 'treatment_consistency'
          ) {
            return false;
          }
          if (k === 'lab_positive' || k === 'lab_value') return true;
          if (k === 'imaging_finding' || k === 'ecg_finding') return true;
          if (k.startsWith('lab_') || k === 'lab') return true;
          if (k.startsWith('imaging') || k.endsWith('_imaging')) return true;
          if (k.startsWith('ecg') || k.endsWith('_ecg')) return true;
          const IMAGING_PREFIXES = [
            'xray',
            'x_ray',
            'ct_',
            'mri_',
            'usg_',
            'ultrasound',
            'angiogram',
            'angio_',
            'echo_',
            'echo',
            'radiology',
          ];
          if (IMAGING_PREFIXES.some((p) => k.startsWith(p))) return true;
          return false;
        };
        const hasHardEvidence = supporting.some(
          (e: any) =>
            e && typeof e === 'object' && isHardKind(e.evidence_kind),
        );
        if (!hasHardEvidence) return false;
        const candidateName =
          typeof evidencePrimary.candidate_name === 'string'
            ? evidencePrimary.candidate_name.trim()
            : '';
        return candidateName.length > 0;
      })();

      const primary = (dx as any).primary_diagnosis;
      if (evidenceOverride) {
        vm.diagnosis_evidence_override = true;
        const candidateName: string = String(
          evidencePrimary.candidate_name,
        ).trim();
        // Mirror the evidence-based candidate into the legacy field so
        // downstream consumers that haven't migrated still see the
        // correct diagnosis (instead of e.g. "chest pain" or null).
        if (primary && typeof primary === 'object') {
          const legacyName =
            typeof primary.diagnosis_name === 'string'
              ? primary.diagnosis_name.trim()
              : '';
          if (
            !legacyName ||
            legacyName.toLowerCase() !== candidateName.toLowerCase()
          ) {
            if (legacyName) {
              vm.diagnosis_legacy_overwritten = {
                previous: primary.diagnosis_name,
                replaced_with: candidateName,
                reason: 'evidence_based_primary_supersedes_legacy',
              };
            }
            primary.diagnosis_name = candidateName;
          }
          if (
            !primary.icd_code &&
            typeof evidencePrimary.icd10_hint === 'string' &&
            evidencePrimary.icd10_hint.length > 0
          ) {
            primary.icd_code = evidencePrimary.icd10_hint;
            if (!primary.icd_version) primary.icd_version = 'ICD10';
          }
        } else {
          // Legacy block missing entirely — synthesise a minimal one so
          // downstream readers find a diagnosis_name to display.
          (dx as any).primary_diagnosis = {
            diagnosis_name: candidateName,
            ...(typeof evidencePrimary.icd10_hint === 'string' &&
            evidencePrimary.icd10_hint.length > 0
              ? { icd_code: evidencePrimary.icd10_hint, icd_version: 'ICD10' }
              : {}),
          };
        }
        // Skip the keyword-regex rejection path entirely. The
        // source-category allowlist isn't meaningful here either —
        // the candidate is synthesised from multiple sections.
      } else if (primary && typeof primary === 'object') {
        const name: string | null = primary.diagnosis_name ?? null;
        const patternCheck = validateDiagnosisName(name);
        if (!patternCheck.ok) {
          vm.diagnosis_rejected = {
            observed: name,
            reason: patternCheck.reason ?? 'unknown',
          };
          primary.diagnosis_name = null;
        } else if (name) {
          // Source-category allowlist check. We don't have explicit
          // provenance from the LLM here, so we infer the most likely
          // source by scanning for the diagnosis text inside the kept
          // sections' extracted_fields. When found AND the section's
          // category isn't clinical, we drop the diagnosis.
          const observedCategory = inferDiagnosisSourceCategory(
            name,
            keptSections,
          );
          if (
            observedCategory !== null &&
            !isAllowedSourceCategory(observedCategory)
          ) {
            vm.diagnosis_source_invalid = observedCategory;
            primary.diagnosis_name = null;
          }
        }
      }
    }

    // ─── H4: foreign documents ─────────────────────────────────────────
    if (gate.foreignDocuments.length > 0) {
      vm.foreign_documents = gate.foreignDocuments;
    }
    if (gate.weakMatches.length > 0) {
      vm.identity_match_weak = gate.weakMatches;
    }

    // ─── H10: identity cross-check ─────────────────────────────────────
    if (gate.identityMismatches.length > 0) {
      vm.identity_mismatch = gate.identityMismatches;
    }
    if (gate.wrongPmjayCards.length > 0) {
      vm.wrong_pmjay_card = gate.wrongPmjayCards;
    }
    if (gate.canonical) {
      vm.canonical_patient = {
        name: gate.canonical.name,
        confidence: gate.canonical.confidence,
        supporting_section_ids: gate.canonical.supporting_section_ids,
        uncertain: gate.canonical.uncertain ?? false,
        ...(gate.canonical.uncertain_reason
          ? { uncertain_reason: gate.canonical.uncertain_reason }
          : {}),
        ...(gate.canonical.seed_name
          ? { seed_name: gate.canonical.seed_name }
          : {}),
      };
      // Top-level convenience flag — the bug spec asked us to set
      // validation_metadata.canonical_uncertain so a reviewer sweep
      // can SELECT on a single key without unpacking canonical_patient.
      if (gate.canonical.uncertain) {
        vm.canonical_uncertain = true;
      }
    } else {
      vm.canonical_patient = null;
      vm.canonical_uncertain = true;
    }

    // ─── Fix 5 (May 21, 2026): laterality reconciliation ─────────────────
    // Hina Parveen's harmoniser propagated diagnosis "DISTAL RADIUS
    // FRACTURE RIGHT SIDE" from the discharge slip, but the OPD notes,
    // OT notes, and x-ray report all said LEFT. The harmoniser had no
    // cross-section anchor — discharge slip won, three other sources
    // disagreed silently.
    //
    // Fix: count laterality signals across all kept sections. If the
    // diagnosis says RIGHT but ≥2 other sections say LEFT (or vice
    // versa), flag `laterality_dispute` in validation_metadata. We
    // DON'T auto-correct the diagnosis — that's risky without a
    // schema constraint — but reviewers see the conflict.
    try {
      const latReport = checkLateralityConsensus(
        episode,
        keptSections,
      );
      if (latReport.disputed) {
        vm.laterality_dispute = {
          diagnosis_says: latReport.diagnosisSide,
          sections_say: latReport.majoritySide,
          left_votes: latReport.leftCount,
          right_votes: latReport.rightCount,
          dissenting_sections: latReport.dissentingSections,
        };
      } else if (latReport.observedWithoutDiagnosis) {
        // Diagnosis is null (often because H2-harm rejected a disputed
        // diagnosis upstream) but the clinical sections show a clear
        // majority. Preserve the signal for the reviewer rather than
        // silently dropping it.
        vm.laterality_observed = {
          diagnosis_says: null,
          sections_say: latReport.majoritySide,
          left_votes: latReport.leftCount,
          right_votes: latReport.rightCount,
          agreeing_sections: latReport.agreeingSections,
          reason:
            'diagnosis_rejected_or_missing — preserved clinical-section consensus',
        };
      }
    } catch (e) {
      // non-fatal — reconciliation is observational only
    }

    // ─── Fix 7 (May 21, 2026): cross-doc ID reconciliation ───────────────
    // Hina's pmjay_id reads "MCETESFVS" on the card but "MCETBPFVS" on
    // the feedback form (E↔B OCR drift); aadhaar_number can similarly
    // differ across aadhaar_front vs aadhaar_back vs pmjay_bis_family_tree.
    // Pre-existing harmoniser picks the first/loudest source without
    // surfacing the conflict.
    //
    // Fix: collect each ID type across all sections, group by Levenshtein
    // distance, and flag the canonical_patient block when ≥2 distinct
    // values appear. Reviewers see all observed values + which sections
    // they came from.
    try {
      const idReport = collectIdValuesAcrossSections(keptSections);
      const idConflicts: Record<string, unknown> = {};
      for (const [idKey, observations] of Object.entries(idReport)) {
        const uniqVals = Array.from(new Set(observations.map((o) => o.value).filter(Boolean)));
        if (uniqVals.length > 1) {
          idConflicts[idKey] = {
            observed_values: uniqVals,
            sources: observations,
          };
        }
      }
      if (Object.keys(idConflicts).length > 0) {
        vm.id_conflicts = idConflicts;
      }
    } catch (e) {
      // non-fatal
    }

    // Degrade data_completeness_score by:
    //   • 0.1 per identity mismatch
    //   • 0.1 per wrong pmjay card found
    //   • 0.25 when primary_diagnosis.diagnosis_name is null (rejected,
    //     missing, or never populated). A claim without a diagnosis is
    //     fundamentally incomplete — the LLM was previously reporting
    //     harm=0.73 for Hina even after H2-harm nulled her diagnosis,
    //     which masked the severity of the gap from the reviewer.
    //     Floor at 0.
    let penalty = 0.1 * (gate.identityMismatches.length + gate.wrongPmjayCards.length);
    const dxNameAfter: string | null =
      (episode?.diagnosis?.primary_diagnosis?.diagnosis_name as string | null) ?? null;
    if (!dxNameAfter || (typeof dxNameAfter === 'string' && dxNameAfter.trim() === '')) {
      penalty += 0.25;
      vm.diagnosis_missing = true;
    }
    if (penalty > 0) {
      const m = (episode.meta ?? {}) as Record<string, unknown>;
      const cur =
        typeof m.data_completeness_score === 'number'
          ? (m.data_completeness_score as number)
          : null;
      if (cur != null) {
        m.data_completeness_score = Math.max(0, cur - penalty);
        episode.meta = m;
      }
    }

    episode.validation_metadata = vm;
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  /**
   * Load document_sections + ipd_doc filename/s3_key, ordered by
   * (document_id, page_start) so the LLM sees sections in a stable
   * physical order.
   */
  private async loadSections(claim_id: string): Promise<HarmoniserSectionInput[]> {
    // Wave 12 content dedup: ONLY canonicals (dedup_of IS NULL) feed the
    // harmoniser. Sections marked as duplicates have their extracted
    // fields already projected from the canonical (docExtractor.queue
    // post-extract hook), and showing them again here would just teach
    // the LLM that the same Aadhar appears 3x in the dossier — wasted
    // tokens and confused output.
    //
    // For each canonical we attach a `source_documents` array
    // enumerating every file the canonical's content appears in (the
    // canonical's own file + all duplicates' files + page ranges).
    // The harmoniser prompt's supporting_documents construction
    // surfaces this lineage so the operator can see "Implant Invoice
    // (canonical: PDF1 p6; also in: PDF2 p8, PDF3 p8)".
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
      source_documents: any;
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
              ds.extraction_confidence,
              -- Build the lineage for this canonical. Includes the
              -- canonical's own (file_name, page_start, page_end) plus
              -- one entry per dedup_of=ds.id row. NULL when the section
              -- has no duplicates (i.e. truly standalone).
              (
                SELECT json_agg(json_build_object(
                  'document_id', sub.document_id,
                  'file_name', sub_d.file_name,
                  'page_start', sub.page_start,
                  'page_end', sub.page_end,
                  'is_canonical', sub.id = ds.id
                ) ORDER BY sub.id = ds.id DESC, sub.document_id)
                FROM hospital.document_sections sub
                JOIN hospital.ipd_doc sub_d ON sub_d.id = sub.document_id
                WHERE sub.id = ds.id OR sub.dedup_of = ds.id
              ) AS source_documents
         FROM hospital.document_sections ds
         JOIN hospital.ipd_doc d ON d.id = ds.document_id
        WHERE ds.claim_id = $1
          AND ds.dedup_of IS NULL
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
      // Surface the lineage via an open field on the section input
      // (HarmoniserSectionInput is structurally typed in the prompts
      // builder; extra fields pass through to the supporting_documents
      // construction in buildUserPrompt).
      source_documents: Array.isArray(r.source_documents) ? r.source_documents : null,
    } as any));
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

// ─── Fix 5 helper — laterality reconciliation ────────────────────────────
//
// Cross-hospital smoke test (May 21, 2026) found Hina Parveen's diagnosis
// "DISTAL RADIUS FRACTURE RIGHT SIDE" propagated from the discharge slip
// while three other sections (OPD notes, OT notes, x-ray) said LEFT.
// This helper counts laterality signals across sections and flags
// disputes in validation_metadata. Observational only — no auto-correct.

const LEFT_TOKENS = /\b(left|lt|l[\s-]?side|lt\.|left[\s-]?side)\b/gi;
const RIGHT_TOKENS = /\b(right|rt|r[\s-]?side|rt\.|right[\s-]?side)\b/gi;

interface LateralityReport {
  disputed: boolean;
  /** True when diagnosis is null but clinical sections show a clear majority side. */
  observedWithoutDiagnosis: boolean;
  diagnosisSide: 'left' | 'right' | null;
  majoritySide: 'left' | 'right' | null;
  leftCount: number;
  rightCount: number;
  dissentingSections: Array<{ section_id: string; category: string; side: 'left' | 'right' }>;
  /** All sections that voted for the majority side (only populated when observedWithoutDiagnosis). */
  agreeingSections: Array<{ section_id: string; category: string; side: 'left' | 'right' }>;
}

function checkLateralityConsensus(
  episode: any,
  sections: HarmoniserSectionInput[],
): LateralityReport {
  const dxName = (
    episode?.diagnosis?.primary_diagnosis?.diagnosis_name ?? ''
  ).toString();
  const dxLeft = (dxName.match(LEFT_TOKENS) ?? []).length;
  const dxRight = (dxName.match(RIGHT_TOKENS) ?? []).length;
  const diagnosisSide: 'left' | 'right' | null =
    dxLeft > dxRight ? 'left' : dxRight > dxLeft ? 'right' : null;
  // Note (May 21, 2026): we used to early-return when diagnosisSide was
  // null. That meant H2-harm rejecting a disputed diagnosis (e.g. Hina:
  // discharge slip RIGHT, OPD/OT/X-ray LEFT → diagnosis nulled) wiped out
  // the laterality signal entirely. The reviewer never saw that the
  // clinical majority was LEFT. Now we continue to scan sections and
  // emit `observedWithoutDiagnosis` so the consensus survives diagnosis
  // rejection.

  // Inspect each section's clinical-text fields. We focus on the
  // categories most likely to mention laterality clinically — skip
  // identity docs (aadhaar, pmjay, ration) since they shouldn't say
  // left/right about the patient's body part.
  const CLINICAL_CATEGORIES = new Set([
    'opd_notes',
    'ot_notes',
    'surgical_discharge_slip',
    'discharge_summary',
    'xray_reports',
    'mri_reports',
    'ct_scan_reports',
    'surgery_consent_form',
    'progress_notes',
    'post_op_reports',
  ]);

  const dissents: LateralityReport['dissentingSections'] = [];
  const agreeing: LateralityReport['agreeingSections'] = [];
  let leftCount = 0;
  let rightCount = 0;
  const perSection: Array<{ section_id: string; category: string; side: 'left' | 'right' }> = [];
  for (const s of sections) {
    if (!s.category || !CLINICAL_CATEGORIES.has(s.category)) continue;
    const fields = (s.extracted_fields ?? {}) as Record<string, unknown>;
    // Only consider clinical free-text fields, NOT patient_name / signed_by etc.
    const blob = [
      fields.chief_complaints,
      fields.history,
      fields.provisional_diagnosis,
      fields.primary_diagnosis,
      fields.diagnosis,
      fields.procedure_performed,
      fields.procedure_planned,
      fields.findings,
      fields.impression,
      fields.body_part,
      fields.laterality,
    ]
      .filter((v) => typeof v === 'string')
      .join(' ');
    const sLeft = (blob.match(LEFT_TOKENS) ?? []).length;
    const sRight = (blob.match(RIGHT_TOKENS) ?? []).length;
    if (sLeft === 0 && sRight === 0) continue;
    const side: 'left' | 'right' = sLeft > sRight ? 'left' : 'right';
    if (side === 'left') leftCount++; else rightCount++;
    perSection.push({ section_id: s.section_id, category: s.category, side });
    if (diagnosisSide && side !== diagnosisSide) {
      dissents.push({ section_id: s.section_id, category: s.category, side });
    }
  }

  const majoritySide: 'left' | 'right' | null =
    leftCount > rightCount ? 'left' : rightCount > leftCount ? 'right' : null;

  // Dispute if ≥2 dissenting clinical sections AND the majority of
  // clinical sections disagrees with the diagnosis.
  const disputed =
    diagnosisSide !== null &&
    dissents.length >= 2 &&
    majoritySide !== null &&
    majoritySide !== diagnosisSide;

  // Observed-without-diagnosis: diagnosis is null (often because H2-harm
  // rejected a disputed one) but the clinical sections still have ≥2
  // votes on one side. Surface this so the reviewer knows what the
  // sections actually said.
  const observedWithoutDiagnosis =
    diagnosisSide === null &&
    majoritySide !== null &&
    (majoritySide === 'left' ? leftCount : rightCount) >= 2;

  if (observedWithoutDiagnosis && majoritySide) {
    for (const ps of perSection) {
      if (ps.side === majoritySide) agreeing.push(ps);
    }
  }

  return {
    disputed,
    observedWithoutDiagnosis,
    diagnosisSide,
    majoritySide,
    leftCount,
    rightCount,
    dissentingSections: dissents,
    agreeingSections: agreeing,
  };
}

// ─── Fix 7 helper — cross-doc identifier reconciliation ──────────────────
//
// Looks at aadhaar_number, pmjay_id, ration_card_number, pmjay_beneficiary_id
// across all kept sections. When ≥2 distinct values appear for the same
// ID type, flags `id_conflicts` in validation_metadata.

interface IdObservation {
  section_id: string;
  category: string;
  value: string;
}

function collectIdValuesAcrossSections(
  sections: HarmoniserSectionInput[],
): Record<string, IdObservation[]> {
  // (field_name_in_section → canonical_id_type_key)
  const ID_FIELD_MAP: Record<string, string> = {
    aadhaar_number: 'aadhaar_number',
    pmjay_id: 'pmjay_id',
    pmjay_beneficiary_id: 'pmjay_id',
    ayushman_bharat_id: 'pmjay_id',
    ration_card_number: 'ration_card_number',
    abha_number: 'abha_number',
  };
  const observations: Record<string, IdObservation[]> = {};

  for (const s of sections) {
    if (!s.category) continue;
    const fields = (s.extracted_fields ?? {}) as Record<string, unknown>;
    for (const [fieldKey, canonicalKey] of Object.entries(ID_FIELD_MAP)) {
      const v = fields[fieldKey];
      if (typeof v !== 'string' || v.trim() === '') continue;
      // Normalise whitespace + dashes for comparison
      const normalised = v.replace(/[\s-]/g, '');
      if (normalised.length < 4) continue; // ignore stub values
      const arr = observations[canonicalKey] ?? [];
      arr.push({ section_id: s.section_id, category: s.category, value: normalised });
      observations[canonicalKey] = arr;
    }
  }
  return observations;
}

// ─── Default singleton ────────────────────────────────────────────────────
export const harmonisationService = new HarmonisationService();
export default harmonisationService;
