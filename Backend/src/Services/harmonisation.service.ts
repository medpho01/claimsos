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
import costAccounting, { type BudgetVerdict } from './costAccounting.service.js';
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
  extractCandidateName,
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
import s3Service from './s3.service.js';

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
  // Authority priority for the single `$.financial_summary` provenance
  // slot. Multiple bill sections (final + interim + pharmacy) used to all
  // write this one key, so a last-iterated *interim* bill could clobber the
  // *final* bill as the recorded source — pure document order, not
  // authority (benchmark finding B7, multi-bill collapse). Keep the most
  // authoritative bill as the provenance source instead; the full
  // multi-source lineage is preserved separately in
  // financial_summary.reconciliation.sources by reconcileFinancials().
  const FINANCIAL_PROVENANCE_PRIORITY: Record<string, number> = {
    final_bill: 4,
    consolidated_bill: 4,
    final_breakup_of_bill: 4,
    interim_bill: 2,
    pharmacy_bill: 1,
  };
  const provenancePriority: Record<string, number> = {};
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
      case 'consolidated_bill':
      case 'final_breakup_of_bill':
      case 'interim_bill':
      case 'pharmacy_bill': {
        const prio = FINANCIAL_PROVENANCE_PRIORITY[s.category] ?? 0;
        const existing = provenancePriority['$.financial_summary'] ?? -1;
        // Only (re)claim the slot for a strictly-more-authoritative bill.
        // Ties keep the first-seen section (stable document order).
        if (prio > existing) {
          map['$.financial_summary'] = {
            source_section_id: s.section_id,
            confidence: conf,
            llm_inferred: false,
          };
          provenancePriority['$.financial_summary'] = prio;
        }
        break;
      }
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

// ─── Payer (panel) stamp ──────────────────────────────────────────────────

/**
 * Stamp the authoritative payer onto an episode's insurance_context,
 * fill-if-empty.
 *
 * The panel attached to the IPD (ipds.panel_id → panels) is the single source
 * of truth for WHO is paying — a private insurer, a government scheme (PMJAY
 * et al.), or a TPA. The harmoniser LLM only ever saw panel_id as an opaque
 * UUID, and its system prompt forbids inventing values it can't read in a
 * document, so insurer_name routinely came back blank even though the payer
 * was known deterministically all along. This helper closes that gap and is
 * called from BOTH paths:
 *   - write-time, inside harmonise(), so fresh runs persist the payer; and
 *   - read-time, inside getEpisode(), so episodes already persisted with a
 *     blank insurer get the value projected on read — no re-harmonisation,
 *     no LLM spend, every existing claim fixed instantly.
 *
 * Semantics:
 *   - panel_type === 'tpa'  → fills insurer_tpa (the panel names a TPA, not
 *     the risk-bearing insurer, so insurer_name is deliberately left for the
 *     LLM to source from a PA letter / policy doc).
 *   - any other panel_type  → fills insurer_name (insurance / government /
 *     cashless_everywhere / other all name the payer directly).
 *   - NEVER clobbers a non-empty value the LLM legitimately extracted.
 *
 * Returns true iff it wrote a value (handy for logging and tests).
 */
export function fillInsurerFromPanel(
  episode: unknown,
  panel: { panel_name?: string | null; panel_type?: string | null } | null,
): boolean {
  if (!episode || typeof episode !== 'object') return false;
  const name = panel?.panel_name?.trim();
  if (!name) return false;

  const ep = episode as Record<string, unknown>;
  const ic = (ep.insurance_context ?? {}) as Record<string, unknown>;

  const isTpa = (panel?.panel_type ?? '').trim().toLowerCase() === 'tpa';
  const targetKey = isTpa ? 'insurer_tpa' : 'insurer_name';

  const current = ic[targetKey];
  if (typeof current === 'string' && current.trim() !== '') return false;

  ic[targetKey] = name;
  ep.insurance_context = ic;
  return true;
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
// Exported for tests: the promotion bar below is a correctness-critical
// guard (it is what stops another person's Aadhaar being asserted as the
// patient's) and deserves direct cover rather than an indirect assertion.
export function stitchSupportingDocuments(
  episode: any,
  sections: HarmoniserSectionInput[],
  /**
   * Sections the identity gate found to conflict with the canonical patient
   * on a HARD identifier — i.e. very probably another person's document.
   *
   * They are still stitched into `supporting_documents` (the reviewer must be
   * able to see the offending document, and `collectIdValuesAcrossSections`
   * reads it to build `id_conflicts`), but they are BARRED from slot
   * promotion.
   *
   * Without this bar, claim e54c89c0 flagged the spouse's Aadhaar card as
   * foreign AND simultaneously promoted her Aadhaar number into
   * patient_context.identification.aadhaar_number — because `aadhaar_card` is
   * listed ahead of `aadhaar_front` in CANONICAL_SLOT_PROMOTIONS. Asserting a
   * different person's ID as the patient's, in the very field an insurer
   * reads, is worse than not flagging it at all.
   */
  excludeFromPromotion?: ReadonlySet<string>,
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
      const rawBucket = supporting[c.category];
      if (!rawBucket || rawBucket.length === 0) continue;
      // Drop rows belonging to a section that conflicts with the canonical
      // patient on a hard identifier before choosing a value to promote.
      const bucket =
        excludeFromPromotion && excludeFromPromotion.size > 0
          ? rawBucket.filter(
              (row: any) => !excludeFromPromotion.has(String(row?._section_id ?? '')),
            )
          : rawBucket;
      if (bucket.length === 0) continue;
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
    const row = rowToEpisode(res.rows[0]!);

    // Read-time payer enrichment. Episodes persisted before the write-time
    // panel stamp (or by an LLM that left insurer_name blank because it only
    // saw panel_id as a UUID) show a blank insurer in the UI even though the
    // payer is known deterministically. Project the panel name onto
    // insurance_context here — fill-if-empty, NO DB write, zero LLM spend —
    // so every already-persisted claim is fixed on the next read. Skipped for
    // 'pending' placeholder rows (episode is an empty `{}`). Non-fatal: a
    // panel-lookup failure must never break the harmonised read path.
    if (
      row.status !== 'pending' &&
      row.episode &&
      typeof row.episode === 'object'
    ) {
      try {
        const panel = await this.loadPanelFacts(claim_id);
        fillInsurerFromPanel(row.episode, panel);
      } catch (err) {
        logger.warn(
          { err, claim_id },
          'harmonisation: read-time panel enrichment failed (non-fatal)',
        );
      }
    }
    return row;
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
    //
    //     THE runId ARGUMENT IS LOAD-BEARING, NOT TELEMETRY. `checkBudget`
    //     reads the run's approved budget — and can therefore only ever
    //     return 'pause_for_consent' — when it is given a run id. Without it
    //     harmonisation spent against the static operator caps alone while
    //     the number the user approved bound nothing. Resolved once and
    //     reused for the cost-log stamp at step (k).
    const activeRunId = await this.resolveActiveRunId(claim_id);
    const verdict = await this.cost.checkBudget(
      claim_id,
      hospital_id,
      undefined,
      { runId: activeRunId },
    );

    //     'pause_for_consent' PARKS, it does not spend and it does not
    //     throw. This arm is not optional garnish: `action` is a WIDENING
    //     union and this method previously handled ONLY 'block', so a
    //     'pause_for_consent' verdict fell straight through to the LLM call
    //     below and spent the money the pause exists to withhold. Threading
    //     runId in without this arm would newly PRODUCE the verdict and
    //     still ignore it.
    //
    //     It must not throw either: LlmBudgetExceededError here would burn
    //     Bull's three retries against a run deliberately waiting on a
    //     person, and harmonisation would dead-letter. Instead we roll the
    //     'pending' placeholder written at (d) back to 'stale' with a
    //     human-readable reason and return it. 'stale' is exactly right: the
    //     cache check at (c) only short-circuits on 'fresh'/'corrected', so
    //     resume re-runs harmonisation from the top once the user approves
    //     more budget — and the cockpit does not show a pending spinner on a
    //     run that is parked.
    if (verdict.action === 'pause_for_consent') {
      return this.parkForConsent(claim_id, dossier_state_hash, verdict);
    }

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
        // PRESERVE THE PAID RESPONSE BEFORE DOING ANYTHING ELSE.
        //
        // A validation failure here means we called the model, were BILLED
        // for a complete answer, and are about to reject it over a schema
        // mismatch. Until 2026-09-14 that answer was then dropped on the
        // floor: `rawResponse` lived only on the thrown error, nothing
        // persisted it, and RecordReplayClient never saw it (it records
        // around a SUCCESSFUL inner.extract()). So every schema fix had to
        // be tested by paying for a brand-new run — three runs and ~₹81 of
        // one claim's cap went on exactly that loop.
        //
        // Now the rejected payload goes to S3, and re-validating a fixed
        // schema against it costs ₹0 (see scripts/replayHarmonisation.ts).
        //
        // Deliberately NOT the `episode` column: batchAdjudicate.ts:19 joins
        // on `episode IS NOT NULL` and rulesEngineV2 reads it, so a rejected
        // payload parked there could be picked up as a valid episode.
        const preservedKey = await this.preserveRejectedResponse(
          claim_id,
          dossier_state_hash,
          err,
        );
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
          // The S3 key rides along in error_message so an operator reading
          // the failed row knows the paid response still exists.
          await this.upsertFailed(
            claim_id,
            dossier_state_hash,
            `zod_validation_failed: ${err.message}`
              + (preservedKey ? ` [raw_response=${preservedKey}]` : ''),
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
    stitchSupportingDocuments(
      episode,
      keptSections,
      new Set(identityGate.canonical?.conflicting_section_ids ?? []),
    );

    // ─── Authoritative IDs are never the model's to report ──────────────
    // insurer_id is handed to the LLM as a seed and echoed back in
    // insurance_context. On claim e54c89c0 two consecutive runs returned
    // ...44fa857a7ae6 and ...44fa387a7ae6 — the model transcribing a UUID and
    // getting it wrong. A foreign key that silently mutates run to run cannot
    // be joined on, and a wrong one points at a DIFFERENT insurer.
    //
    // The DB value (ipds.hospital_panel_id) is authoritative, so overwrite
    // rather than trust the echo. Same principle as the hospital-name
    // canonicalisation below. Only clears when we genuinely have no seed.
    if (episode && typeof episode === 'object') {
      const vmIns = ((episode as any).validation_metadata ??= {}) as Record<string, unknown>;
      const ic = ((episode as any).insurance_context ??= {});
      const echoed = ic.insurer_id ?? null;
      if (seed.insurer_id) {
        if (echoed && String(echoed) !== String(seed.insurer_id)) {
          vmIns.insurer_id_corrected = { llm_returned: echoed, authoritative: seed.insurer_id };
          logger.warn(
            { claim_id, llm_returned: echoed, authoritative: seed.insurer_id },
            'harmonisation: LLM returned a non-authoritative insurer_id — overwritten from the DB',
          );
        }
        ic.insurer_id = seed.insurer_id;
      } else if (echoed) {
        // No seed to check against: a model-invented UUID is worse than
        // nothing, because downstream code will try to join on it.
        vmIns.insurer_id_unverified = echoed;
        delete ic.insurer_id;
      }
    }

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

    // (i.6.6) Fix 16 (May 28, 2026, iter7): promote typed date fields
    // from per-section extracted_fields into the canonical episode
    // shape. Lifts admission_date / discharge_date / surgery_date
    // from per-section extractor output into stay_summary and
    // procedures_performed[]. Purely additive — never overwrites a
    // value the LLM did populate.
    this.promoteDatesFromSectionsIntoEpisode(episode, keptSections);

    // (i.6.7) Fix 18 (iter7): pull dates the OTHER direction —
    // sometimes the LLM populates clinical_timeline[ADMISSION].start_datetime
    // but leaves stay_summary.admission_datetime empty (Shabana
    // pattern). Mirror clinical_timeline ADMISSION/DISCHARGE
    // phase dates into stay_summary slots when empty.
    this.promoteTimelineDatesIntoStaySummary(episode);

    // (i.6.8) Fix 17 (iter7): guard against cross-patient
    // contamination. iter7 found Vahadur's 11-page bundled PDF
    // included a consent form belonging to "Mrs. Begum Faiz".
    // Reject sections whose extracted patient_name / beneficiary_name
    // doesn't fuzzy-match the claim's ipds row, stamping diagnostics
    // onto validation_metadata so a human can review.
    this.guardForeignPatientSections(episode, keptSections);

    // (i.6.9) Fix 20 (iter7): downgrade completeness when the
    // episode is internally inconsistent. Two cheap gates:
    //   - empty diagnosis but non-empty procedures_performed
    //   - laterality conflict across the timeline's procedures
    this.applyCompletenessConsistencyGate(episode);

    // (i.6.10) Fix 22 (iter7): episode date coherence. Vahadur's
    // OT-notes section had surgery_date=2026-03-17 but discharge
    // was 2026-03-16 — a section dated AFTER the discharge is
    // cross-episode contamination. Flag sections with dates that
    // sit outside the [admission, discharge] window (with a small
    // grace period for pre-admission investigations and post-
    // discharge follow-up notes).
    this.flagDateIncoherentSections(episode, keptSections);

    // (i.6.11) Fix 19 (iter7): GPS+timestamp+patient clustering
    // for `gps_tagged_patient_photos`. Vahadur had two photos
    // 140 km apart at different hospitals — clearly different
    // episodes. Shabana's two photos had IDENTICAL GPS + same day
    // — true near-duplicates that pHash missed (50% Hamming
    // because angle differences flip every pixel). Group photos
    // by GPS proximity + timestamp window and flag inter-episode
    // outliers + intra-episode near-dups.
    this.clusterGpsPhotoSections(episode, keptSections);

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

    // (i.7.5) Payer (panel) stamp.
    //
    // The IPD's attached panel (ipds.panel_id → panels) is the authoritative
    // payer — insurer, government scheme, or TPA. The LLM only ever saw
    // panel_id as an opaque UUID and the system prompt forbids inventing
    // unreadable values, so insurer_name routinely came back blank. Stamp the
    // resolved panel name onto insurance_context now, fill-if-empty, so a
    // value the LLM legitimately extracted (e.g. an insurer named on a PA
    // letter) is never clobbered. This is the persisted counterpart to the
    // read-time projection in getEpisode: fresh runs write what existing
    // claims receive on read. Deterministic, no LLM call, no extra cost.
    try {
      const wrote = fillInsurerFromPanel(episode, {
        panel_name: seed.panel_name,
        panel_type: seed.panel_type,
      });
      if (wrote) {
        logger.debug(
          { claim_id, panel_name: seed.panel_name, panel_type: seed.panel_type },
          'harmonisation: stamped payer from panel',
        );
      }
    } catch (err) {
      logger.warn(
        { err, claim_id },
        'harmonisation: panel payer stamp failed (non-fatal)',
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
        // Stamped so getRunSpendInr attributes this row to THIS run rather
        // than to "all claim spend since the run was triggered" — the
        // fallback that otherwise charges a superseded run's tail, or an
        // inbound-email draft on the same claim, against the budget the user
        // approved for the current run.
        runId: activeRunId,
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
   * Fix 16 (May 28, 2026, iter7): promote per-section typed date fields
   * into the canonical episode shape.
   *
   * The per-section extractor reliably populates date keys —
   * `admission_date`, `discharge_date`, `surgery_date`,
   * `consultation_date`, `consent_date`, `document_date` — inside
   * `extracted_fields`. But the harmoniser LLM was leaving the
   * canonical date slots empty (`stay_summary.admission_datetime`,
   * `stay_summary.discharge_datetime`, `clinical_timeline[].start_date`,
   * `procedures_performed[].performed_at`) on all 5 iter7 patients
   * despite the typed dates being present in section extractions.
   *
   * Strategy: deterministic lift, only into EMPTY slots (never
   * overwrite an LLM-emitted value), with category-aware preference
   * so admission_date is preferred from admission/treatment/OPD
   * sections and discharge_date from discharge_* sections.
   *
   * Surfaces filled:
   *   - stay_summary.admission_datetime
   *   - stay_summary.discharge_datetime
   *   - clinical_timeline[phase=ADMISSION].start_datetime (best-effort)
   *   - clinical_timeline[phase=DISCHARGE].start_datetime (best-effort)
   *   - clinical_timeline[*].procedures_performed[].performed_at (when null)
   */
  private promoteDatesFromSectionsIntoEpisode(
    episode: any,
    sections: HarmoniserSectionInput[],
  ): void {
    if (!episode || typeof episode !== 'object') return;

    // Look in extracted_fields for typed date keys. We accept multiple
    // synonyms because the per-template extractor uses different names
    // depending on document category (`admission_date` on the
    // admission form, `date_of_admission` on a discharge slip, `doa`
    // shorthand on OPD notes). Returns ISO-ish strings (YYYY-MM-DD or
    // YYYY-MM-DDTHH:mm:ss±zz:zz); we don't reformat here — schema is
    // .passthrough() and downstream consumers parse leniently.
    const ADMIT_KEYS = [
      'admission_date',
      'date_of_admission',
      'doa',
      'admit_date',
      'admitted_on',
      'consultation_date', // OPD notes commonly carry it; falls through to admit if nothing better
    ];
    const DISCHARGE_KEYS = [
      'discharge_date',
      'date_of_discharge',
      'dod',
      'discharged_on',
    ];
    const SURGERY_KEYS = [
      'surgery_date',
      'operation_date',
      'procedure_date',
      'date_of_surgery',
      'dos',
      'performed_at',
      'performed_on',
    ];

    // Category preference per slot. Higher score = stronger preference.
    // Categories not in the map score 1 (still considered, just last).
    const CATEGORY_SCORE: Record<string, Record<string, number>> = {
      admission: {
        admission_form: 5,
        opd_notes: 4,
        treatment_sheet: 4,
        icp: 3,
        discharge_slip: 2, // discharge docs often quote admission too
        discharge_summary: 2,
      },
      discharge: {
        discharge_slip: 5,
        discharge_summary: 5,
        surgical_discharge_slip: 5,
        treatment_sheet: 2,
      },
      surgery: {
        ot_notes: 5,
        ot_notes_and_photos: 5,
        surgical_checklist: 4,
        anaesthesia_fitness_reports: 3,
        surgical_discharge_slip: 3,
        discharge_summary: 2,
      },
    };

    interface DateCandidate {
      iso: string;
      raw: string;
      section_id: string;
      category: string | null;
      key: string;
      score: number;
    }

    const collect = (
      slot: 'admission' | 'discharge' | 'surgery',
      keys: string[],
    ): DateCandidate | null => {
      const cands: DateCandidate[] = [];
      const catScores = CATEGORY_SCORE[slot] ?? {};
      for (const s of sections) {
        const ef = s.extracted_fields;
        if (!ef || typeof ef !== 'object') continue;
        for (const k of keys) {
          const raw = (ef as Record<string, unknown>)[k];
          if (typeof raw !== 'string') continue;
          const iso = normaliseToIsoDate(raw);
          if (!iso) continue;
          const score = catScores[s.category ?? ''] ?? 1;
          cands.push({
            iso,
            raw,
            section_id: s.section_id,
            category: s.category,
            key: k,
            score,
          });
        }
      }
      if (cands.length === 0) return null;
      // Sort by score DESC, then prefer the earliest ISO for admission
      // (handles same-day OPD + admission_form pairs), latest for
      // discharge, latest for surgery (handles re-do dates).
      cands.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (slot === 'admission') return a.iso.localeCompare(b.iso);
        return b.iso.localeCompare(a.iso);
      });
      return cands[0]!;
    };

    const filled: string[] = [];

    // ─── stay_summary.admission_datetime / discharge_datetime ───
    if (!episode.stay_summary || typeof episode.stay_summary !== 'object') {
      episode.stay_summary = {};
    }
    const stay = episode.stay_summary as Record<string, unknown>;

    if (!stay.admission_datetime) {
      const adm = collect('admission', ADMIT_KEYS);
      if (adm) {
        stay.admission_datetime = adm.iso;
        filled.push(
          `stay_summary.admission_datetime=${adm.iso} (from ${adm.category}/${adm.key})`,
        );
      }
    }

    if (!stay.discharge_datetime) {
      const dis = collect('discharge', DISCHARGE_KEYS);
      if (dis) {
        stay.discharge_datetime = dis.iso;
        filled.push(
          `stay_summary.discharge_datetime=${dis.iso} (from ${dis.category}/${dis.key})`,
        );
      }
    }

    // ─── clinical_timeline phase dates (best-effort) ───
    // The schema's Phase has start_datetime; we fill ADMISSION + DISCHARGE
    // phases when their slot is empty and we have a candidate date.
    if (Array.isArray(episode.clinical_timeline)) {
      for (const phase of episode.clinical_timeline) {
        if (!phase || typeof phase !== 'object') continue;
        const code = String(phase.phase_code ?? '').toUpperCase();
        if (code === 'ADMISSION' && !phase.start_datetime && stay.admission_datetime) {
          phase.start_datetime = stay.admission_datetime;
          filled.push(`clinical_timeline[ADMISSION].start_datetime=${stay.admission_datetime}`);
        }
        if (code === 'DISCHARGE' && !phase.start_datetime && stay.discharge_datetime) {
          phase.start_datetime = stay.discharge_datetime;
          filled.push(`clinical_timeline[DISCHARGE].start_datetime=${stay.discharge_datetime}`);
        }
      }
    }

    // ─── procedures_performed[].performed_at ───
    const surg = collect('surgery', SURGERY_KEYS);
    if (surg && Array.isArray(episode.clinical_timeline)) {
      for (const phase of episode.clinical_timeline) {
        if (!phase || typeof phase !== 'object') continue;
        const procs = phase.procedures_performed;
        if (!Array.isArray(procs)) continue;
        for (const p of procs) {
          if (!p || typeof p !== 'object') continue;
          if (!p.performed_at) {
            p.performed_at = surg.iso;
            filled.push(
              `procedures_performed.performed_at=${surg.iso} (from ${surg.category}/${surg.key})`,
            );
          }
        }
      }
    }

    if (filled.length > 0) {
      const vm = (episode.validation_metadata ?? {}) as Record<string, unknown>;
      const existing = vm.dates_promoted_from_sections;
      vm.dates_promoted_from_sections = Array.isArray(existing)
        ? [...existing, ...filled]
        : filled;
      episode.validation_metadata = vm;
    }
  }

  /**
   * Fix 18 (May 28, 2026, iter7): mirror dates the other direction.
   * The LLM sometimes populates clinical_timeline[ADMISSION].start_datetime
   * but leaves stay_summary.admission_datetime empty (Shabana case in iter7).
   * Fill empty stay_summary slots from matching timeline phases.
   * Only fills empty slots — never overwrites.
   */
  private promoteTimelineDatesIntoStaySummary(episode: any): void {
    if (!episode || typeof episode !== 'object') return;
    if (!Array.isArray(episode.clinical_timeline)) return;
    if (!episode.stay_summary || typeof episode.stay_summary !== 'object') {
      episode.stay_summary = {};
    }
    const stay = episode.stay_summary as Record<string, unknown>;
    const filled: string[] = [];
    for (const phase of episode.clinical_timeline) {
      if (!phase || typeof phase !== 'object') continue;
      const code = String(phase.phase_code ?? '').toUpperCase();
      if (code === 'ADMISSION' && !stay.admission_datetime && phase.start_datetime) {
        stay.admission_datetime = phase.start_datetime;
        filled.push(`stay_summary.admission_datetime <= timeline[ADMISSION].start_datetime (${phase.start_datetime})`);
      }
      if (code === 'DISCHARGE' && !stay.discharge_datetime && phase.start_datetime) {
        stay.discharge_datetime = phase.start_datetime;
        filled.push(`stay_summary.discharge_datetime <= timeline[DISCHARGE].start_datetime (${phase.start_datetime})`);
      }
    }
    if (filled.length > 0) {
      const vm = (episode.validation_metadata ?? {}) as Record<string, unknown>;
      const existing = vm.dates_promoted_from_timeline;
      vm.dates_promoted_from_timeline = Array.isArray(existing)
        ? [...existing, ...filled]
        : filled;
      episode.validation_metadata = vm;
    }
  }

  /**
   * Fix 17 (May 28, 2026, iter7): cross-patient contamination guard.
   *
   * iter7 surfaced a catastrophic case where Vahadur's 11-page bundled
   * PDF contained a consent form belonging to "Mrs. Begum Faiz" on
   * pages 6-7. The harmoniser happily mixed that section into the
   * episode despite the name mismatch. Worse, the OT-notes section
   * said "NAL Removal from Lt Radius" — fed by the wrong-patient
   * history — and the final episode_subtype came out as
   * ORTHOPEDIC_NAIL_REMOVAL when the actual procedure was right-side
   * patella ORIF.
   *
   * This guard walks each section's extracted patient_name /
   * beneficiary_name / head_of_family etc. and compares to the
   * claim's ipds.first_name + last_name. Any section with a
   * non-matching name is flagged in validation_metadata so a human
   * reviewer can disposition it. We DON'T strip the section from
   * the episode yet — the LLM may have already used it for legitimate
   * fields (the family ration card's head_of_family is often a wife
   * or father, not the patient themselves, and that's a true positive
   * for "different name" but a legitimate doc). Phase 2 work can
   * tighten this to active filtering once we've validated the
   * flag-rate in production.
   */
  private guardForeignPatientSections(
    episode: any,
    sections: HarmoniserSectionInput[],
  ): void {
    if (!episode || typeof episode !== 'object') return;
    const first = String(episode?.patient_context?.first_name ?? '').trim();
    const last  = String(episode?.patient_context?.last_name ?? '').trim();
    if (!first && !last) return;
    const canonicalTokens = normalisePatientName(`${first} ${last}`);
    if (canonicalTokens.length === 0) return;

    // Categories where the doc-bound name is EXPECTED to be a family
    // member, not the patient. Skip these from the foreign-name flag.
    const FAMILY_DOC_CATS = new Set<string>([
      'ration_card',
      'pmjay_bis_family_tree',
      'family_id_card',
      'aadhaar_back', // sometimes shows guardian
      'address_proof',
    ]);
    // Keys in extracted_fields that hold a candidate name.
    const NAME_KEYS = [
      'patient_name',
      'name',
      'full_name',
      // `holder_name` is what the `aadhaar_card` field schema uses (seed 059).
      // Its absence here meant an aadhaar_card section was never evaluated by
      // this guard at all — which is how a spouse's Aadhaar passed unflagged
      // on claim e54c89c0 (2026-09-14). This guard feeds
      // `foreign_patient_sections`, the ONLY key reviewQueue.service.ts reads.
      'holder_name',
      'beneficiary_name',
    ];

    const foreign: Array<{
      section_id: string;
      category: string | null;
      observed_name: string;
      matched_key: string;
    }> = [];

    for (const s of sections) {
      if (FAMILY_DOC_CATS.has(s.category ?? '')) continue;
      const ef = s.extracted_fields;
      if (!ef || typeof ef !== 'object') continue;
      for (const k of NAME_KEYS) {
        const raw = (ef as Record<string, unknown>)[k];
        if (typeof raw !== 'string') continue;
        const obsTokens = normalisePatientName(raw);
        if (obsTokens.length === 0) continue;
        if (!tokensOverlap(canonicalTokens, obsTokens)) {
          foreign.push({
            section_id: s.section_id,
            category: s.category,
            observed_name: raw,
            matched_key: k,
          });
        }
        break; // one name per section is enough to evaluate
      }
    }

    if (foreign.length > 0) {
      const vm = (episode.validation_metadata ?? {}) as Record<string, unknown>;
      vm.foreign_patient_sections = foreign;
      // Each foreign section also nudges completeness down. The
      // Vahadur case proved the LLM can produce a 0.68 score on
      // contaminated data; we need the completeness signal to
      // reflect "data hygiene", not just "schema coverage".
      const meta = episode.meta ?? {};
      const cur = typeof meta.data_completeness_score === 'number'
        ? meta.data_completeness_score : null;
      if (cur != null) {
        const penalty = Math.min(0.30, 0.10 * foreign.length);
        meta.data_completeness_score = Math.max(0, cur - penalty);
        if (!Array.isArray(vm.completeness_penalties)) vm.completeness_penalties = [];
        (vm.completeness_penalties as unknown[]).push(
          `foreign_patient_sections: -${penalty.toFixed(2)} (${foreign.length} section${foreign.length === 1 ? '' : 's'})`,
        );
      }
      episode.validation_metadata = vm;
      episode.meta = meta;
    }
  }

  /**
   * Fix 20 (May 28, 2026, iter7): internal-consistency check on
   * completeness score.
   *
   * iter7 found two opposite failure modes:
   *   (a) Anuj — completeness 0.07 despite the AI having a clean
   *       procedure + doctor + subtype. Under-scored.
   *   (b) Vahadur — completeness 0.68 on demonstrably wrong data
   *       (foreign-patient consent + inverted laterality + wrong
   *       procedure name). Over-scored.
   *
   * Two cheap gates push completeness toward honest:
   *   1. If diagnosis{} is empty BUT procedures_performed[] is
   *      non-empty, the episode is incoherent — cap completeness
   *      at 0.40. (Anuj-style — we have a surgery but no diagnosis.)
   *   2. If laterality appears in any procedure AND a conflicting
   *      laterality appears in any extracted_fields source we know
   *      about (logged in validation_metadata), penalise by 0.10.
   */
  private applyCompletenessConsistencyGate(episode: any): void {
    if (!episode || typeof episode !== 'object') return;
    const meta = episode.meta ?? {};
    if (typeof meta.data_completeness_score !== 'number') return;
    const cur: number = meta.data_completeness_score;
    const vm = (episode.validation_metadata ?? {}) as Record<string, unknown>;
    const penalties: string[] = Array.isArray(vm.completeness_penalties)
      ? (vm.completeness_penalties as string[]).slice()
      : [];
    let next = cur;

    // Gate (a): non-empty procedures but empty diagnosis
    const dx = episode.diagnosis ?? {};
    const dxIsEmpty =
      typeof dx === 'object' && Object.keys(dx).length === 0;
    const procs: any[] = Array.isArray(episode.clinical_timeline)
      ? episode.clinical_timeline.flatMap((p: any) => p?.procedures_performed ?? [])
      : [];
    if (dxIsEmpty && procs.length > 0) {
      const cap = 0.40;
      if (next > cap) {
        penalties.push(
          `incoherent_dx_vs_procedure: capped completeness at ${cap.toFixed(2)} (was ${next.toFixed(2)})`,
        );
        next = cap;
      }
    }

    // Gate (b): laterality conflict across procedures
    const laterals = procs
      .map((p) => (typeof p?.laterality === 'string' ? p.laterality.toUpperCase() : null))
      .filter((x): x is string => !!x);
    const distinctLR = new Set(laterals.filter((l) => l === 'LEFT' || l === 'RIGHT'));
    if (distinctLR.size > 1) {
      const penalty = 0.10;
      next = Math.max(0, next - penalty);
      penalties.push(
        `laterality_conflict: -${penalty.toFixed(2)} (saw ${[...distinctLR].join(' + ')})`,
      );
    }

    if (next !== cur) {
      meta.data_completeness_score = Math.max(0, Math.min(1, next));
      vm.completeness_penalties = penalties;
      episode.validation_metadata = vm;
      episode.meta = meta;
    }
  }

  /**
   * Fix 22 (May 28, 2026, iter7): flag sections with dates that fall
   * outside the episode's [admission_datetime, discharge_datetime]
   * window. iter7 Vahadur case: OT-notes section had
   * surgery_date=2026-03-17 but the discharge was 2026-03-16 → that
   * OT note is from a DIFFERENT episode and shouldn't have informed
   * this episode's procedure.
   *
   * We don't strip the sections — we stamp them onto
   * validation_metadata.date_incoherent_sections so reviewers can
   * see what slipped in, and apply a small completeness penalty per
   * outlier. Grace period: 7 days before admission (pre-op
   * investigations) and 14 days after discharge (follow-up notes).
   */
  private flagDateIncoherentSections(
    episode: any,
    sections: HarmoniserSectionInput[],
  ): void {
    if (!episode || typeof episode !== 'object') return;
    const stay = episode.stay_summary;
    if (!stay || typeof stay !== 'object') return;

    const admitIso = normaliseToIsoDate(String(stay.admission_datetime ?? ''));
    const dischIso = normaliseToIsoDate(String(stay.discharge_datetime ?? ''));
    if (!admitIso && !dischIso) return; // can't bound the window

    const GRACE_BEFORE_DAYS = 7;
    const GRACE_AFTER_DAYS = 14;

    // Compute window in JS Date for date arithmetic.
    const admitDate = admitIso ? new Date(admitIso) : null;
    const dischDate = dischIso ? new Date(dischIso) : null;
    const lo = admitDate ? new Date(admitDate.getTime() - GRACE_BEFORE_DAYS * 86400_000) : null;
    const hi = dischDate ? new Date(dischDate.getTime() + GRACE_AFTER_DAYS * 86400_000) : null;

    const DATE_KEYS = [
      'admission_date', 'discharge_date', 'surgery_date',
      'operation_date', 'procedure_date', 'consultation_date',
      'capture_timestamp', 'document_date', 'visit_date',
      'consent_date', // sometimes the only marker of when a doc applies
    ];

    interface Incoherent {
      section_id: string;
      category: string | null;
      key: string;
      observed_date: string;
      iso: string;
      delta_days: number;
      direction: 'before_admission' | 'after_discharge';
    }
    const incoherent: Incoherent[] = [];

    for (const s of sections) {
      const ef = s.extracted_fields;
      if (!ef || typeof ef !== 'object') continue;
      for (const k of DATE_KEYS) {
        const raw = (ef as Record<string, unknown>)[k];
        if (typeof raw !== 'string') continue;
        const iso = normaliseToIsoDate(raw);
        if (!iso) continue;
        const dt = new Date(iso);
        if (Number.isNaN(dt.getTime())) continue;
        let direction: 'before_admission' | 'after_discharge' | null = null;
        let deltaDays = 0;
        if (lo && dt.getTime() < lo.getTime() && admitDate) {
          direction = 'before_admission';
          deltaDays = Math.ceil((admitDate.getTime() - dt.getTime()) / 86400_000);
        } else if (hi && dt.getTime() > hi.getTime() && dischDate) {
          direction = 'after_discharge';
          deltaDays = Math.ceil((dt.getTime() - dischDate.getTime()) / 86400_000);
        }
        if (direction) {
          incoherent.push({
            section_id: s.section_id,
            category: s.category,
            key: k,
            observed_date: raw,
            iso,
            delta_days: deltaDays,
            direction,
          });
        }
      }
    }

    if (incoherent.length > 0) {
      const vm = (episode.validation_metadata ?? {}) as Record<string, unknown>;
      vm.date_incoherent_sections = incoherent;
      const meta = episode.meta ?? {};
      const cur = typeof meta.data_completeness_score === 'number'
        ? meta.data_completeness_score : null;
      if (cur != null) {
        // 0.05 per outlier section, capped at 0.20 total
        const penalty = Math.min(0.20, 0.05 * incoherent.length);
        meta.data_completeness_score = Math.max(0, cur - penalty);
        if (!Array.isArray(vm.completeness_penalties)) vm.completeness_penalties = [];
        (vm.completeness_penalties as unknown[]).push(
          `date_incoherent_sections: -${penalty.toFixed(2)} (${incoherent.length})`,
        );
      }
      episode.validation_metadata = vm;
      episode.meta = meta;
    }
  }

  /**
   * Fix 19 (May 28, 2026, iter7): cluster `gps_tagged_patient_photos`
   * sections by GPS proximity + timestamp window. iter7 showed:
   *
   *   Shabana: 2 photos with IDENTICAL GPS, same date, same subject
   *            — true near-duplicates pHash missed (50% Hamming
   *            because angle differences flip every pixel)
   *   Vahadur: 1 photo at Sadbhawana NH (Moradabad, 28.877, 78.743)
   *            on 2026-03-13 (legit surgery date)
   *            + 1 photo at Siddh Super Multispecialty (Delhi area,
   *            28.842, 77.607) on 2026-03-28 (15 days later) —
   *            CROSS-HOSPITAL contamination
   *
   * Cluster bucket key: round GPS to ~110m grid + same date.
   *   - Clusters with >1 section → near-duplicate group; flag
   *     extras as duplicates.
   *   - Singleton clusters far from the others → cross-episode
   *     outlier; flag for review.
   */
  private clusterGpsPhotoSections(
    episode: any,
    sections: HarmoniserSectionInput[],
  ): void {
    if (!episode || typeof episode !== 'object') return;

    interface Photo {
      section_id: string;
      lat: number;
      lng: number;
      iso: string | null;
      hospital_name: string | null;
    }
    const photos: Photo[] = [];
    for (const s of sections) {
      if (s.category !== 'gps_tagged_patient_photos') continue;
      const ef = s.extracted_fields;
      if (!ef || typeof ef !== 'object') continue;
      const lat = parseFloat(String((ef as any).gps_latitude ?? ''));
      const lng = parseFloat(String((ef as any).gps_longitude ?? ''));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const tsRaw = (ef as any).capture_timestamp;
      const iso = typeof tsRaw === 'string' ? normaliseToIsoDate(tsRaw) : null;
      const hospital_name = typeof (ef as any).hospital_name_in_photo === 'string'
        ? (ef as any).hospital_name_in_photo : null;
      photos.push({ section_id: s.section_id, lat, lng, iso, hospital_name });
    }
    if (photos.length < 2) return;

    // Cluster key: round to 0.001 deg (~110m at equator) + ISO date.
    const keyOf = (p: Photo) =>
      `${p.lat.toFixed(3)}_${p.lng.toFixed(3)}_${p.iso ?? 'nodate'}`;
    const buckets = new Map<string, Photo[]>();
    for (const p of photos) {
      const k = keyOf(p);
      const arr = buckets.get(k) ?? [];
      arr.push(p);
      buckets.set(k, arr);
    }

    // Near-duplicates: any cluster with > 1 photo. Keep the first
    // (lowest section_id alphabetically for determinism) as primary,
    // mark the rest as suspected_duplicates.
    const nearDuplicates: Array<{ primary: string; duplicate: string }> = [];
    for (const [, arr] of buckets) {
      if (arr.length < 2) continue;
      const sorted = arr.slice().sort((a, b) => a.section_id.localeCompare(b.section_id));
      for (let i = 1; i < sorted.length; i++) {
        nearDuplicates.push({ primary: sorted[0]!.section_id, duplicate: sorted[i]!.section_id });
      }
    }

    // Cross-cluster outliers: if there are ≥2 clusters and one is
    // "lonely" (single photo, > 5 km from the cluster centroid of
    // the largest group AND on a different date), flag it.
    const sortedBuckets = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
    const outliers: string[] = [];
    if (sortedBuckets.length >= 2 && sortedBuckets[0]![1].length >= 1) {
      const primary = sortedBuckets[0]![1];
      const cLat = primary.reduce((s, p) => s + p.lat, 0) / primary.length;
      const cLng = primary.reduce((s, p) => s + p.lng, 0) / primary.length;
      const cDate = primary[0]!.iso;
      for (let i = 1; i < sortedBuckets.length; i++) {
        for (const p of sortedBuckets[i]![1]) {
          const dKm = haversineKm(cLat, cLng, p.lat, p.lng);
          const dateMismatch = !!(cDate && p.iso && cDate !== p.iso);
          if (dKm > 5 && dateMismatch) {
            outliers.push(p.section_id);
          }
        }
      }
    }

    if (nearDuplicates.length > 0 || outliers.length > 0) {
      const vm = (episode.validation_metadata ?? {}) as Record<string, unknown>;
      const report: Record<string, unknown> = {};
      if (nearDuplicates.length > 0) report.near_duplicate_pairs = nearDuplicates;
      if (outliers.length > 0) report.cross_episode_outliers = outliers;
      vm.gps_photo_clustering = report;
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

        // A `no_clinical_keywords` verdict means only "this string is not in
        // our finite vocabulary". It is NOT positive evidence of a
        // hallucination — unlike the blocklist, person-name and pure-symptom
        // verdicts, which detect something actually WRONG with the string and
        // stay hard rejections below.
        //
        // The distinction matters because the vocabulary has an unbounded
        // tail. The hard-evidence override above requires lab / imaging / ECG,
        // which ophthalmology, dermatology and ENT essentially never produce —
        // they diagnose by examination, recorded in OPD notes as
        // `clinical_observation`. So an entire specialty was ineligible for
        // the rescue that exists for exactly this case, and claim e54c89c0
        // lost a 0.88-confidence, four-source cataract diagnosis to a missing
        // word (2026-09-14).
        //
        // A vocabulary miss may therefore be rescued by SOFT evidence, gated
        // on an independently-shaped corroborating signal: a well-formed
        // ICD-10 hint. Recorded in validation_metadata so every rescued claim
        // stays queryable and the precision of this rule can be audited.
        const softRescue =
          !patternCheck.ok &&
          patternCheck.reason === 'no_clinical_keywords' &&
          evidencePrimary != null &&
          Number(evidencePrimary.confidence) >= 0.8 &&
          Array.isArray(evidencePrimary.supporting_evidence) &&
          evidencePrimary.supporting_evidence.length >= 2 &&
          typeof evidencePrimary.icd10_hint === 'string' &&
          /^[A-Z]\d{2}(\.\d{1,2})?$/.test(evidencePrimary.icd10_hint.trim());

        if (softRescue) {
          vm.diagnosis_vocabulary_rescue = {
            observed: name,
            icd10_hint: String(evidencePrimary.icd10_hint).trim(),
            confidence: evidencePrimary.confidence,
          };
          if (!primary.icd_code) {
            primary.icd_code = String(evidencePrimary.icd10_hint).trim();
            if (!primary.icd_version) primary.icd_version = 'ICD10';
          }
        } else if (!patternCheck.ok) {
          vm.diagnosis_rejected = {
            observed: name,
            reason: patternCheck.reason ?? 'unknown',
          };
          // Schema contract: PrimaryDiagnosis.diagnosis_name is a REQUIRED
          // string, and the episode is validated after stripNullsDeep — so
          // writing null here produced a stored episode that could not
          // round-trip through its own schema (verified 2026-09-14). The
          // schema comment at harmonisedEpisode.ts:399 prescribes the correct
          // shape: OMIT primary_diagnosis entirely when there is no usable
          // diagnosis. `diagnosis_rejected` above preserves what was seen.
          delete (dx as any).primary_diagnosis;
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
            // Same schema contract as the rejection branch above: omit the
            // block rather than null a REQUIRED string field, which would
            // leave a stored episode that cannot re-validate.
            delete (dx as any).primary_diagnosis;
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

      // ─── Hard-identifier conflicts → the LOUD channel ────────────────
      // A section that clustered on name but disagrees on Aadhaar number or
      // gender is very probably a DIFFERENT PERSON's document sitting in this
      // claim bundle — for an insurer, a fraud signal, not a footnote.
      //
      // It is routed to `foreign_patient_sections` deliberately.
      // `foreign_documents` (written just above) has NO consumer anywhere in
      // the backend or webapp; reviewQueue.service.ts keys exclusively on
      // `foreign_patient_sections`, so that is the only key that actually
      // reaches a human. Writing solely to the richer key below would repeat
      // the original mistake of recording the finding where nobody looks.
      if (gate.canonical.hard_conflicts?.length) {
        const rows = gate.canonical.hard_conflicts.map((hc) => {
          const sec = keptSections.find((s) => s.section_id === hc.section_id);
          return {
            section_id: hc.section_id,
            category: sec?.category ?? null,
            observed_name: extractCandidateName(sec as any) ?? '',
            matched_key: 'hard_identifier',
            conflict: hc.conflict,
            severity: 'high' as const,
          };
        });
        vm.foreign_patient_sections = [
          ...((vm.foreign_patient_sections as unknown[]) ?? []),
          ...rows,
        ];
        // Richer detail for the reviewer UI, alongside the queue-visible key.
        vm.foreign_identity_documents = rows;
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

    // ─── Fix 18 (Jun 2, 2026): deterministic financial reconciliation ────
    // B7: financial_summary was 100% LLM-produced and never cross-checked.
    // Compute a deterministic total from the kept bill sections, flag
    // stated-vs-itemised mismatches, and — crucially for the PMJAY corpus
    // where bills carry no extracted amount — flag the all-empty case so a
    // reviewer SEES that the episode has no financial grounding instead of
    // trusting a hollow {currency:"INR"} block. Additive + observational;
    // never clobbers an LLM amount, never re-scores completeness.
    try {
      const fin = reconcileFinancials(episode, keptSections);
      // Mirror the headline + the discrepancy/empty signal into vm so a
      // reviewer sweep can SELECT on a single key.
      vm.financial_reconciliation = {
        status: fin.status,
        reconciled_total_inr: fin.reconciled_total_inr,
        hospital_total_inr: fin.hospital_total_inr,
        pharmacy_total_inr: fin.pharmacy_total_inr,
        implant_total_inr: fin.implant_total_inr,
        subbill_total_inr: fin.subbill_total_inr,
        components_sum_inr: fin.components_sum_inr,
        discrepancies: fin.discrepancies,
        source_count: fin.sources.length,
      };
      // Write the full reconciliation (incl. per-source lineage) into the
      // episode's financial_summary, creating the block if the LLM omitted
      // it. This is deterministic provenance, namespaced so it can't be
      // confused with an LLM-extracted figure.
      const fs =
        episode.financial_summary && typeof episode.financial_summary === 'object'
          ? (episode.financial_summary as Record<string, unknown>)
          : {};
      fs.reconciliation = fin;
      if (!fs.currency) fs.currency = fin.currency;
      // Fill-if-empty: surface a deterministic total to downstream readers
      // (e.g. validate_pmjay_package_match reads total_billed) ONLY when we
      // derived one AND the LLM left every known total field blank. Never
      // overwrite an LLM-extracted amount.
      if (fin.reconciled_total_inr != null) {
        fs.reconciled_total_inr = fin.reconciled_total_inr;
        const hasLlmTotal = [
          'actual_total_cost',
          'estimated_total_cost',
          'total_billed',
          'total_amount',
          'gross_amount',
          'net_amount',
        ].some((k) => typeof fs[k] === 'number' && (fs[k] as number) > 0);
        if (!hasLlmTotal) {
          fs.total_billed = fin.reconciled_total_inr;
        }
      }
      episode.financial_summary = fs;
    } catch (e) {
      // non-fatal — reconciliation is observational only
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
    // Resolve the human-readable payer (panel) so the prompt can name it and
    // the deterministic post-merge can stamp it. The bare panel_id UUID was
    // useless to the LLM — this is why insurer_name came back blank.
    const panel = await this.loadPanelFacts(claim_id);
    return {
      claim_id,
      hospital_id,
      hospital_name: row?.hospital_name ?? null,
      patient_first_name: row?.first_name ?? null,
      patient_last_name: row?.last_name ?? null,
      admission_type: row?.admission_type ?? null,
      panel_id: row?.panel_id ?? null,
      insurer_id: row?.hospital_panel_id ?? null,
      panel_name: panel?.panel_name ?? null,
      panel_type: panel?.panel_type ?? null,
    };
  }

  /**
   * Resolve the authoritative payer for a claim from the IPD's attached panel
   * (ipds.panel_id → panels). Returns null when the claim has no panel or the
   * panel row is missing. A cheap PK-indexed lookup — safe to call on the read
   * path (getEpisode) as well as the write path (loadSeedFacts).
   */
  private async loadPanelFacts(
    claim_id: string,
  ): Promise<{ panel_name: string | null; panel_type: string | null } | null> {
    const res = await this.pool.query<{
      panel_name: string | null;
      panel_type: string | null;
    }>(
      `SELECT p.name AS panel_name, p.panel_type
         FROM hospital.ipds i
         JOIN hospital.panels p ON p.id = i.panel_id
        WHERE i.id = $1`,
      [claim_id],
    );
    return res.rows[0] ?? null;
  }

  /**
   * UPSERT a status='pending' row. Used before the LLM call so a
   * concurrent reader sees that work is in flight. episode column is
   * NOT NULL on the table, so we write an empty object placeholder.
   */
  /**
   * The id of the claim's run, when one is genuinely in flight.
   *
   * Returns null for a terminal, superseded or paused run: attributing spend
   * to a run that is not running would charge it against a budget nobody is
   * watching, and would let `checkBudget` pause a run that is already parked.
   * A null degrades the budget check to the static operator caps, which is
   * correct for a harmonisation with no run behind it (a manual re-harmonise,
   * or the projector rebuilding an old claim).
   */
  private async resolveActiveRunId(claim_id: string): Promise<string | null> {
    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claim_id);
      if (!run) return null;
      return run.status === 'queued' || run.status === 'running' ? run.id : null;
    } catch {
      return null;
    }
  }

  /**
   * The run's approved budget is spent before harmonisation could run.
   *
   * Pause the run, roll the 'pending' placeholder back to 'stale' with a
   * reason a human can read, and RETURN that row. Never throws: the caller is
   * a Bull job and a throw would spend its three retries against a run that
   * is deliberately waiting for a person to approve more money.
   *
   * There is no ledger `blockPhase` call here on purpose — harmonisation is a
   * claim-level phase with no doc_id to block, and the run's own paused status
   * is what resume reads to re-drive it.
   */
  private async parkForConsent(
    claim_id: string,
    dossier_state_hash: string,
    verdict: BudgetVerdict,
  ): Promise<HarmonisedEpisodeRow> {
    const message =
      `run budget exhausted — paused for consent: ${verdict.reason ?? 'over approved budget'}`;

    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claim_id);
      if (run && (run.status === 'queued' || run.status === 'running')) {
        const spend = await claimAiRunService
          .getRunSpend(run)
          .catch(() => ({ totalInr: 0 }) as any);
        const remaining = await claimAiRunService
          .computeProjectedRemainingInr(run)
          .catch(() => 0);
        await claimAiRunService.pauseForConsent({
          run_id: run.id,
          claim_id,
          spend_inr: spend.totalInr ?? 0,
          projected_remaining_inr: remaining,
        });
        logger.warn(
          {
            claim_id,
            run_id: run.id,
            run_spend_inr: verdict.runSpendInr,
            approved_budget_inr: verdict.runApprovedBudgetInr,
          },
          'harmonisation: run budget exhausted — run paused for consent, no LLM call made',
        );
      }
    } catch (err) {
      logger.error(
        { err, claim_id },
        'harmonisation: pauseForConsent failed — the run may keep spending; investigate',
      );
    }

    // Roll the (d) placeholder back. Best-effort: if this write fails the row
    // stays 'pending', which is cosmetically wrong but costs nothing — the
    // run is already paused and no tokens were spent.
    try {
      await this.pool.query(
        `UPDATE hospital.claim_harmonised_episodes
            SET status = 'stale',
                error_message = $2,
                dossier_state_hash = $3
          WHERE claim_id = $1
            AND status = 'pending'`,
        [claim_id, message.slice(0, 4000), dossier_state_hash],
      );
    } catch (err) {
      logger.warn(
        { err, claim_id },
        'harmonisation: could not roll the pending placeholder back to stale (non-fatal)',
      );
    }

    const existing = await this.getEpisode(claim_id).catch(() => null);
    if (existing) return existing;

    // No row at all (the placeholder write itself failed). Return a shaped,
    // honest object rather than throwing — the caller must see "not done, and
    // here is why", not a Bull retry.
    return {
      claim_id,
      episode: null,
      schema_version: SCHEMA_VERSION,
      prompt_version: PROMPT_VERSION,
      confidence: null,
      provenance: null,
      dossier_state_hash,
      cost_inr: 0,
      tokens_used: 0,
      llm_provider: null,
      llm_model: null,
      generated_at: new Date(),
      last_corrected_at: null,
      status: 'stale',
      error_message: message,
    };
  }

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
  /**
   * Park a model response we PAID for but rejected, so a schema fix can be
   * validated against it for free.
   *
   * Best-effort by construction: every failure path returns null rather than
   * throwing. This runs inside a catch block that is already handling the
   * real error, and an S3 hiccup must never replace a precise
   * "zod validation failed at <path>" with "S3 upload failed".
   *
   * The object is the model's untouched text plus just enough context to
   * replay it (task, prompt version, the Zod message). It contains patient
   * clinical data, so it goes to the same SSE-AES256 bucket as the source
   * documents — never to stdout logs.
   */
  private async preserveRejectedResponse(
    claim_id: string,
    dossier_state_hash: string,
    err: LlmSchemaValidationError,
  ): Promise<string | null> {
    try {
      const raw = err.rawResponse;
      if (!raw) return null;

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const key =
        `llm-rejected/harmonisation/${claim_id}/`
        + `${PROMPT_VERSION}_${dossier_state_hash.slice(0, 12)}_${stamp}.json`;

      const body = JSON.stringify(
        {
          claim_id,
          dossier_state_hash,
          task_name: TASK_NAME,
          prompt_version: PROMPT_VERSION,
          schema_version: SCHEMA_VERSION,
          rejected_at: new Date().toISOString(),
          validation_error: err.message,
          raw_response: raw,
        },
        null,
        2,
      );

      await s3Service.upload(key, Buffer.from(body, 'utf8'), 'application/json');
      logger.warn(
        { claim_id, s3_key: key, bytes: body.length },
        'harmonisation: model response rejected by schema — raw payload preserved '
          + 'for free re-validation (npm run replay:harmonisation -- <key>)',
      );
      return key;
    } catch (preserveErr) {
      logger.warn(
        { err: preserveErr, claim_id },
        'harmonisation: could not preserve the rejected response (non-fatal)',
      );
      return null;
    }
  }

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

// ─── Fix 18 helper — deterministic financial reconciliation ──────────────
//
// Benchmark finding B7: financial_summary is 100% LLM-produced and never
// cross-checked. On the 15-patient PMJAY corpus EVERY episode shipped a
// financial_summary of just {currency:"INR", package_details:{…}} with NO
// monetary amount at all — and nothing flagged the gap, so a reviewer (or
// the validate_pmjay_package_match rule reading financial_summary.
// total_billed) silently got `undefined`. And when an itemised bill DOES
// exist (other hospitals' non-package claims), the harmoniser had no
// deterministic check that line items sum to the stated total, so an OCR /
// transcription error in the headline figure sailed straight through.
//
// This helper reads the FULL extracted_fields of every kept bill-like
// section (untruncated — unlike the prompt) and:
//   1. harvests each section's stated total + summed line items, defensively
//      across the many field-name variants the generic extractor emits;
//   2. picks an authoritative hospital total (final-bill-wins; interim only
//      as fallback; PMJAY discharge-slip total as last resort) and tallies
//      pharmacy / implant / sub-bills SEPARATELY — they are billed outside
//      the package, so we never silently fold them into one number;
//   3. flags stated-vs-itemised mismatches, conflicting duplicate finals,
//      and the all-empty "no financial data" case.
//
// OBSERVATIONAL + ADDITIVE, exactly like Fix 5 / Fix 7: it writes a
// namespaced financial_summary.reconciliation block, a fill-if-empty
// reconciled total, and a validation_metadata.financial_reconciliation
// signal. It NEVER fabricates a number and NEVER clobbers an LLM-extracted
// amount. It deliberately does NOT touch data_completeness_score — a
// missing total is surfaced as a reviewer flag, not silently re-scored.

// category → economic role. final/interim are mutually-exclusive tiers for
// the hospital anchor; pharmacy/implant/subbill are additive side-spends.
const FINANCIAL_BILL_ROLE: Record<
  string,
  'final' | 'interim' | 'pharmacy' | 'implant' | 'subbill'
> = {
  final_bill: 'final',
  consolidated_bill: 'final',
  final_breakup_of_bill: 'final',
  interim_bill: 'interim',
  pharmacy_bill: 'pharmacy',
  implant_bill: 'implant',
  implant_invoice: 'implant',
  diagnostics_bill: 'subbill',
  consumables_bill: 'subbill',
};

// Non-bill categories that can still carry an authoritative hospital total
// in a known money field (PMJAY discharge slips print the package amount as
// `total_amount`). Used only when no actual bill section exists.
const FINANCIAL_FALLBACK_CATEGORIES = new Set([
  'discharge_slip',
  'surgical_discharge_slip',
]);

// Stated-total field-name candidates, most authoritative first.
const STATED_TOTAL_KEYS = [
  'net_amount',
  'net_payable',
  'amount_payable',
  'net_bill_amount',
  'grand_total',
  'total_amount',
  'total_bill_amount',
  'total_billed',
  'final_amount',
  'bill_amount',
  'bill_total',
  'total_payable',
  'gross_amount',
  'total',
  'package_amount',
  'approved_amount',
  'sanctioned_amount',
  'total_cost',
];

// Array-of-line-items field-name candidates.
const LINE_ITEMS_KEYS = [
  'line_items',
  'items',
  'charges',
  'particulars',
  'bill_items',
  'services',
  'breakup',
  'line_item_details',
];

// Per-line-item amount field-name candidates, most specific first.
const LINE_ITEM_AMOUNT_KEYS = [
  'net_amount',
  'amount',
  'line_total',
  'total_amount',
  'total',
  'charge',
  'cost',
  'value',
];

/**
 * Parse an extracted money value into a non-negative number, or null.
 * Handles the shapes the extractor emits in the wild: a JS number, or an
 * Indian-formatted string ("Rs. 1,23,456/-", "₹1,23,456.00", "1,23,456").
 * Returns null for anything we can't read confidently — we never invent.
 */
function parseInrAmount(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v >= 0 ? v : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  // Strip currency words/symbols and trailing "/-"; drop grouping commas.
  const cleaned = s
    .replace(/(?:rs\.?|inr|₹)/gi, '')
    .replace(/\/-\s*$/, '')
    .replace(/[,\s]/g, '');
  // Reject any non-numeric residue ("approx5000", "5000onwards") so an
  // unreliable figure becomes null rather than a confident-looking wrong
  // number.
  const m = cleaned.match(/^(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Best monetary read for a single line-item object: an explicit amount
 * field, else quantity × unit-rate when both are parseable. */
function lineItemAmount(item: unknown): number | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  for (const k of LINE_ITEM_AMOUNT_KEYS) {
    if (k in rec) {
      const a = parseInrAmount(rec[k]);
      if (a != null) return a;
    }
  }
  const qty = parseInrAmount(rec.quantity ?? rec.qty ?? rec.units);
  const rate = parseInrAmount(rec.rate ?? rec.unit_price ?? rec.unit_rate ?? rec.price);
  if (qty != null && rate != null) return qty * rate;
  return null;
}

interface BillObservation {
  section_id: string;
  category: string;
  role: 'final' | 'interim' | 'pharmacy' | 'implant' | 'subbill' | 'fallback';
  stated_total: number | null;
  stated_total_key: string | null;
  line_items_sum: number | null;
  line_items_count: number;
  /** stated_total and line_items_sum both present and disagree > tolerance. */
  internal_discrepancy: boolean;
}

interface FinancialReconciliation {
  status: 'reconciled' | 'single_source' | 'discrepancy' | 'no_financial_data';
  currency: string;
  /** The authoritative figure we'd stand behind, when derivable. */
  reconciled_total_inr: number | null;
  hospital_total_inr: number | null;
  pharmacy_total_inr: number | null;
  implant_total_inr: number | null;
  subbill_total_inr: number | null;
  /** hospital + pharmacy + implant + subbills, when ≥1 present. */
  components_sum_inr: number | null;
  discrepancies: string[];
  sources: BillObservation[];
}

/** Two rupee figures agree if within max(₹1, 1% of the larger). */
function amountsAgree(a: number, b: number): boolean {
  const tol = Math.max(1, Math.max(a, b) * 0.01);
  return Math.abs(a - b) <= tol;
}

function reconcileFinancials(
  episode: any,
  sections: HarmoniserSectionInput[],
): FinancialReconciliation {
  const currency =
    (typeof episode?.financial_summary?.currency === 'string' &&
      episode.financial_summary.currency) ||
    'INR';

  const sources: BillObservation[] = [];
  for (const s of sections) {
    if (!s.category) continue;
    const role = FINANCIAL_BILL_ROLE[s.category];
    const isFallback = !role && FINANCIAL_FALLBACK_CATEGORIES.has(s.category);
    if (!role && !isFallback) continue;
    const fields = (s.extracted_fields ?? {}) as Record<string, unknown>;
    if (!fields || typeof fields !== 'object') continue;

    // Stated total: first present + parseable key, in authority order.
    let stated: number | null = null;
    let statedKey: string | null = null;
    for (const k of STATED_TOTAL_KEYS) {
      if (k in fields) {
        const a = parseInrAmount(fields[k]);
        if (a != null) {
          stated = a;
          statedKey = k;
          break;
        }
      }
    }

    // Line items: sum across any recognised array field.
    let liSum: number | null = null;
    let liCount = 0;
    for (const lk of LINE_ITEMS_KEYS) {
      const arr = fields[lk];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        const a = lineItemAmount(item);
        if (a != null) {
          liSum = (liSum ?? 0) + a;
          liCount++;
        }
      }
    }

    // A fallback (discharge slip) only counts as a financial source if it
    // actually carried a stated amount — an amount-less slip is not signal.
    if (isFallback && stated == null) continue;
    if (stated == null && liSum == null) continue;

    const internal_discrepancy =
      stated != null && liSum != null && !amountsAgree(stated, liSum);

    sources.push({
      section_id: s.section_id,
      category: s.category,
      role: role ?? 'fallback',
      stated_total: stated,
      stated_total_key: statedKey,
      line_items_sum: liSum,
      line_items_count: liCount,
      internal_discrepancy,
    });
  }

  const discrepancies: string[] = [];
  for (const o of sources) {
    if (o.internal_discrepancy) {
      discrepancies.push(
        `section ${o.section_id} (${o.category}): stated ₹${o.stated_total} ≠ line-item sum ₹${o.line_items_sum}`,
      );
    }
  }

  // best() = the figure we trust for one section: stated, else line-sum.
  const best = (o: BillObservation): number | null =>
    o.stated_total ?? o.line_items_sum;

  // Hospital anchor: final tier wins; else interim; else discharge-slip
  // fallback. Within the chosen tier, conflicting distinct values are a
  // discrepancy — we take the max (most conservative for a spend cap) and
  // flag it.
  const pickHospital = (
    role: BillObservation['role'],
  ): number | null => {
    const tier = sources.filter((o) => o.role === role && best(o) != null);
    if (!tier.length) return null;
    const vals = tier.map((o) => best(o) as number);
    const max = Math.max(...vals);
    if (tier.length > 1 && vals.some((v) => !amountsAgree(v, max))) {
      discrepancies.push(
        `${tier.length} ${role} bills disagree: [${vals.join(', ')}] — using max ₹${max}`,
      );
    }
    return max;
  };

  let hospital_total_inr = pickHospital('final');
  if (hospital_total_inr == null) hospital_total_inr = pickHospital('interim');
  if (hospital_total_inr == null) hospital_total_inr = pickHospital('fallback');

  // Additive side-spends: every pharmacy/implant/sub-bill section adds up.
  const sumRole = (role: BillObservation['role']): number | null => {
    const tier = sources.filter((o) => o.role === role && best(o) != null);
    if (!tier.length) return null;
    return tier.reduce((acc, o) => acc + (best(o) as number), 0);
  };
  const pharmacy_total_inr = sumRole('pharmacy');
  const implant_total_inr = sumRole('implant');
  const subbill_total_inr = sumRole('subbill');

  const componentParts = [
    hospital_total_inr,
    pharmacy_total_inr,
    implant_total_inr,
    subbill_total_inr,
  ].filter((v): v is number => v != null);
  const components_sum_inr = componentParts.length
    ? componentParts.reduce((a, b) => a + b, 0)
    : null;

  // The headline we stand behind: the hospital anchor if we have one
  // (pharmacy/implant are reported alongside but NOT auto-added — combining
  // them is a policy call, not a deterministic fact). If there's no hospital
  // anchor at all, fall back to the side-spend components sum.
  const reconciled_total_inr =
    hospital_total_inr != null ? hospital_total_inr : components_sum_inr;

  let status: FinancialReconciliation['status'];
  if (!sources.length) {
    status = 'no_financial_data';
  } else if (discrepancies.length > 0) {
    status = 'discrepancy';
  } else if (sources.length === 1) {
    status = 'single_source';
  } else {
    status = 'reconciled';
  }

  return {
    status,
    currency,
    reconciled_total_inr,
    hospital_total_inr,
    pharmacy_total_inr,
    implant_total_inr,
    subbill_total_inr,
    components_sum_inr,
    discrepancies,
    sources,
  };
}

/**
 * Fix 16 helper — coerce an extracted date string into ISO-8601 date
 * (YYYY-MM-DD). Returns null if we can't confidently parse.
 *
 * Inputs we see in the wild (across all 5 iter7 patients):
 *   - "2026-02-20"            ISO already, pass through
 *   - "20/02/2026", "20-02-26" DD/MM/YYYY (Indian convention dominates)
 *   - "12 Mar 2026"           DD Mon YYYY
 *   - "2026-03-13T17:30:00+05:30" ISO datetime, take date portion
 *
 * Deliberately strict — we'd rather reject ambiguous strings than
 * silently misclassify an admission date as a discharge date.
 */
export function normaliseToIsoDate(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  // ISO date or datetime → take first 10 chars if it parses cleanly.
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    if (isValidCalendarDate(y, m, d)) return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
  }

  // Numeric DD/MM/YYYY or DD-MM-YYYY (or 2-digit year).
  const numMatch = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (numMatch) {
    let d = Number(numMatch[1]);
    let m = Number(numMatch[2]);
    let y = Number(numMatch[3]);
    if (numMatch[3]!.length === 2) y = y < 80 ? 2000 + y : 1900 + y;
    // Default to DD/MM/YYYY (Indian convention dominates ClaimOS docs).
    // If first part > 12 it MUST be day; if second > 12 it MUST be
    // month and we swap; otherwise we trust the default.
    if (d > 12 && m <= 12) {
      // d is day, m is month — DD/MM/YYYY confirmed.
    } else if (m > 12 && d <= 12) {
      // Swap — must be MM/DD/YYYY (rare in our corpus but real).
      [d, m] = [m, d];
    }
    if (isValidCalendarDate(y, m, d)) return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
  }

  // DD Mon YYYY (Mon = 3-letter month name, case-insensitive).
  const monthNames: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };
  const monMatch = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,4})[\s-]+(\d{2,4})/);
  if (monMatch) {
    const d = Number(monMatch[1]);
    const m = monthNames[monMatch[2]!.toLowerCase().slice(0, 4)] ??
             monthNames[monMatch[2]!.toLowerCase().slice(0, 3)];
    let y = Number(monMatch[3]);
    if (monMatch[3]!.length === 2) y = y < 80 ? 2000 + y : 1900 + y;
    if (m && isValidCalendarDate(y, m, d)) return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
  }

  return null;
}

function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}
function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}`; }
function pad4(n: number): string { return n.toString().padStart(4, '0'); }

/** Great-circle distance between two GPS points, in km (≈ R*acos). */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Fix 17 helper — normalise a name string to a token array suitable
 * for fuzzy comparison. Strips honorifics ("Mr"/"Mrs"/"Dr"/etc.),
 * lowercases, splits on whitespace, drops single-letter tokens.
 *
 * Examples:
 *   "Mrs. Begum Faiz"    -> ["begum", "faiz"]
 *   "Vahadur "           -> ["vahadur"]
 *   "ANUJ PAL"           -> ["anuj", "pal"]
 *   "BAHADUR"            -> ["bahadur"]   (matches Vahadur fuzzy below)
 */
export function normalisePatientName(raw: string): string[] {
  if (typeof raw !== 'string') return [];
  const HONORIFICS = new Set([
    'mr', 'mrs', 'ms', 'miss', 'master', 'dr', 'shri', 'smt',
    'mister', 'mister.', 'baby', 'child', 'mst',
  ]);
  const tokens = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation incl. periods
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !HONORIFICS.has(t))
    // ≥3 chars filters OCR fragments ("Mrs. KA" → drop) while keeping
    // short real names like "Anu" or "Raj". 2-char tokens carry almost
    // no identity signal and bloat the foreign-section false-positive
    // rate (iter7 verifier confirmed this on Kalksum).
    .filter((t) => t.length >= 3);
  return tokens;
}

/**
 * Fix 17 helper — do two token arrays share at least one fuzzy-equal
 * token? Tuned for OCR-mangled name matching observed in iter7:
 *
 *   "Vahadur"  ≈ "Bahadur"   — 1-edit Levenshtein
 *   "Kalksum"  ≈ "KALAKSU"   — common 4+ char prefix (OCR truncation)
 *   "Anuj"     ⊂ "Anuj Pal"  — token-in-token (substring containment)
 *   "Begum"    vs "Vahadur"  — none of the above, foreign
 *
 * Three matching paths (any one wins):
 *   1. exact equality after normalisation
 *   2. Levenshtein-1 (insertion/deletion/substitution of one char)
 *   3. common 4+ char prefix (catches OCR-truncated tails)
 *   4. substring containment in either direction (≥3 chars)
 */
export function tokensOverlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (Math.abs(x.length - y.length) <= 1 && levenshtein1(x, y)) return true;
      // Levenshtein-≤2 for tokens of length ≥ 5 catches OCR-mangling
      // like "Kalksum" ≈ "Kalaksu" (distance 2). 5-char minimum keeps
      // short-name false positives (e.g. "Anuj" vs "Asha") in check.
      if (x.length >= 5 && y.length >= 5 && Math.abs(x.length - y.length) <= 2
          && levenshteinAtMost(x, y, 2)) return true;
      if (commonPrefixLen(x, y) >= 4) return true;
      if (x.length >= 3 && y.includes(x)) return true;
      if (y.length >= 3 && x.includes(y)) return true;
    }
  }
  return false;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Bounded-Levenshtein: returns true iff edit distance(a, b) ≤ k. Uses
// O((k+1)^2) DP band — much cheaper than full Levenshtein when k is
// small. We only call this with k=2 so the band is tiny.
function levenshteinAtMost(a: string, b: string, k: number): boolean {
  if (Math.abs(a.length - b.length) > k) return false;
  const la = a.length, lb = b.length;
  // prev/curr rows, full O((la+1)*(lb+1)) but la/lb both small in our use.
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,        // deletion
        curr[j - 1]! + 1,    // insertion
        prev[j - 1]! + cost, // substitution
      );
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > k) return false;
    [prev, curr] = [curr, prev];
  }
  return (prev[lb] ?? Infinity) <= k;
}

// Cheap Levenshtein-<=1 check. Returns true iff a and b differ by at
// most one edit (insertion, deletion, or substitution). Much faster
// than computing full distance.
function levenshtein1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, diffs = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    diffs++;
    if (diffs > 1) return false;
    if (la === lb) { i++; j++; }      // substitution
    else if (la < lb) j++;            // insertion in b
    else i++;                         // deletion from a
  }
  // remaining tail counts as one edit if non-empty
  if (i < la || j < lb) diffs++;
  return diffs <= 1;
}

// ─── Default singleton ────────────────────────────────────────────────────
export const harmonisationService = new HarmonisationService();
export default harmonisationService;
