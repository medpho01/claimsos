/**
 * Sprint 5 / Wave 2B — Document Section Extractor
 *
 * Runs AFTER docClassifier has assigned a category to the section. Reads
 * the per-category field schema from hospital.document_field_schemas
 * (seeded in migration 028), builds a Zod schema from the rows at
 * runtime, asks the LLM bridge to extract those fields, and persists the
 * structured payload (+ per-field confidence map) back to the section row.
 *
 * The interesting/scary bit: the Zod schema is generated from DB rows at
 * call time. Concerns and how this addresses them:
 *
 *   - "What if a field_type is wrong/unknown?" — the typeToZod() switch
 *     has an explicit default that throws. A bad type column in the DB
 *     fails fast at extraction time with the offending key, NOT silently
 *     accepts garbage.
 *
 *   - "What if enum_values is malformed JSONB?" — the row reader pulls
 *     enum_values out via pg's JSONB parsing, then runs an `Array.isArray`
 *     guard. Malformed -> we drop to z.string() and log a warning. We do
 *     NOT throw, because a flaky enum row shouldn't block extraction of
 *     the other (correctly-typed) fields.
 *
 *   - "What if required vs optional drifts between the DB and the prompt?"
 *     — required-ness comes from the SAME row that drives the prompt
 *     instructions. There's one source of truth (the DB row), used in two
 *     places. A bump in schema_version (DB) requires a code rebuild for
 *     the prompt header text, but not for the field list itself.
 *
 *   - "Zod errors are unfriendly for ops." — we wrap any
 *     LlmSchemaValidationError thrown by the bridge with a top-level
 *     error message that includes the section_id and category so the
 *     worker logs are immediately actionable.
 *
 * Tier — standard. Generic prompt + Haiku covers the easy 70%; bridge
 * auto-escalates to Sonnet on confidence < 0.7. The discharge_slip and
 * ICP categories are the hard ones — they're long, multi-section, and
 * have free-text fields. Expect ~30% escalation rate on those; ~5% on
 * structured categories like investigations.
 */

import { createHash } from 'crypto';
import { z, type ZodTypeAny } from 'zod';
import type { Pool } from 'pg';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import defaultS3Service from './s3.service.js';
import defaultOcrService, { OcrPausedError } from './ocr.service.js';
import type { OcrExtractOpts, OcrPage, OcrResult } from './ocr.service.js';
import {
  isUnreadable,
  readablePages,
  unreadablePagesOf,
  persistUnreadablePages,
  clearUnreadablePages,
} from './ocrUnreadable.js';
import costAccountingService, { claimHardLimitInr } from './costAccounting.service.js';
import { eventDispatcher as defaultEventDispatcher } from './events/eventDispatcher.service.js';
import { validateExtractedFields } from './extractedFieldValidators.js';
import {
  runPostValidators,
  containsDevanagari,
} from './extractor/postValidators.js';
import { getLlmClient } from './llm/factory.js';
import { LlmBudgetExceededError, LlmSchemaValidationError } from './llm/LlmClient.js';
import {
  buildDocExtractorSystemPrompt,
  buildDocExtractorUserPrompt,
  docExtractorPromptVersion,
  type ExtractorFieldDescriptor,
} from './llm/prompts/docExtractor.generic.v1.js';
import {
  extractDeterministicFacts,
  formatDeterministicFactsForPrompt,
  type DeterministicFacts,
} from './extractor/deterministicExtractors.js';
import {
  prepareVisionInput,
  isLineItemCategory,
  dedupeLineItems,
  checkLineItemTotals,
  LINE_ITEMS_SCHEMA_FRAGMENT,
  type LineItem,
  type LineItemTotalsCheck,
  type TiledPage,
  type VisionTileAxis,
} from './extractor/index.js';
import { hospitalFormatProfileService } from './hospitalFormatProfile.service.js';

/**
 * Bumped whenever the prompt OR the dynamic-Zod-generation logic changes
 * in a way that would change extraction output for the same input.
 *
 * v2 (2026-05-20): introduced post-extraction validators — Aadhaar
 *   Verhoeff checksum, episode-date plausibility windows, Hindi/English
 *   form-heading boilerplate blocklist, title-case diagnosis normaliser,
 *   forced-vision route for Hindi-script-likely categories. Bumping the
 *   version invalidates the idempotency short-circuit so previously-
 *   extracted sections re-run through the new validators on next
 *   analyzeClaim — necessary because validator failures need to be
 *   written into the `_validation_errors` channel even on rows whose
 *   model output didn't change.
 *
 * v3 (2026-09-13): vision-first document engine. Three behaviour changes
 *   that all alter output for the same input, hence the bump:
 *     1. extraction_mode now defaults to 'vision' (DOC_EXTRACT_DEFAULT_MODE
 *        reverts it) instead of 'ocr', so a category with no master_options
 *        row reads from the image rather than from Tesseract text.
 *     2. Vision attachments are now aspect-aware: a wide page is sent as a
 *        downscaled overview PLUS full-resolution OVERLAPPING horizontal
 *        tiles instead of one image that Anthropic silently downsized to
 *        ~1.15MP (the cause of amounts landing on the wrong line item —
 *        see docs/proposals/EXTRACTION_LANDSCAPE_FIX.md).
 *     3. Categories with an itemised table now emit a first-class
 *        `line_items` array persisted to extracted_fields.line_items.
 *   Bumping invalidates the idempotency short-circuit below so every
 *   section re-extracts through the vision path. Human corrections are
 *   STILL preserved — that guard lives in persistExtraction's
 *   _corrected_fields merge and is independent of this version.
 */
export const EXTRACTOR_VERSION = 'v3';

/**
 * Vision-first flip (Sep 2026). A doc_category with no explicit
 * `master_options.extraction_mode` row used to fall back to 'ocr'; it now
 * falls back to 'vision'. The user's directive is correctness first —
 * prove the accurate path, optimise cost later.
 *
 * Set DOC_EXTRACT_DEFAULT_MODE=ocr to restore the old default with no
 * deploy. An explicit master_options.extraction_mode value still wins over
 * this in both directions.
 *
 * THE FLAG REVERTS COST, NOT JUST BEHAVIOUR (corrected 2026-09-13). As first
 * written it reverted only this module's default mode, while ocr.service kept
 * OCR_ENGINE defaulting to 'vision' — so `extractTextFromPdf` on the reverted
 * "ocr" path still made one Anthropic call per page. Reverting the flip
 * therefore required knowing about a SECOND flag, which is exactly the sort of
 * thing nobody discovers at 2am. Two changes fixed it:
 *
 *   1. `ocr.service.resolveOcrEngine()` now returns 'tesseract' when
 *      DOC_EXTRACT_DEFAULT_MODE=ocr and OCR_ENGINE is unset, so the one flag
 *      reverts both layers. An explicit OCR_ENGINE still wins.
 *   2. `ocrCallOpts()` below passes `allowVisionFallback: false` on every OCR
 *      read this service makes while the revert is engaged — belt and braces,
 *      and it holds even if someone sets OCR_ENGINE=vision globally.
 *
 * Read at call time (not module load) so an ops toggle takes effect on the
 * next extraction rather than the next process restart.
 */
function defaultExtractionMode(): 'ocr' | 'vision' | 'auto' {
  const v = process.env.DOC_EXTRACT_DEFAULT_MODE;
  if (v === 'ocr' || v === 'vision' || v === 'auto') return v;
  return 'vision';
}

/** True when an operator has flipped the documented revert switch. */
function visionRevertEngaged(): boolean {
  return process.env.DOC_EXTRACT_DEFAULT_MODE === 'ocr';
}

/**
 * Options for every OCR read this service makes.
 *
 * The claim context is not decoration: ocr.service gives a call WITHOUT a
 * claimId/hospitalId a much tighter vision page budget, because that is the
 * signature of an unattended ingestion path (inbound email attachments) where
 * the sender picks the page count. This service always runs inside a bound
 * claim, so it identifies itself and keeps the full budget — and the pages it
 * reads land in hospital.llm_cost_log attributed to the right claim instead of
 * as an orphan row.
 */
function ocrCallOpts(
  claimId: string,
  hospitalId: string,
  runId?: string | null,
  shouldStop?: (() => Promise<boolean>) | undefined,
): OcrExtractOpts {
  const opts: OcrExtractOpts = { claimId, hospitalId };
  if (visionRevertEngaged()) opts.allowVisionFallback = false;
  // 076 — run attribution. Without it the run's approved budget is not one of
  // the dimensions getOcrReadAllowanceInr intersects, and the per-section
  // reads (where most OCR rupees are actually spent) would run against the
  // static caps only — i.e. the consent number would bound nothing.
  if (runId) {
    opts.runId = runId;
    opts.shouldStop = shouldStop;
  }
  return opts;
}

/**
 * Document categories where Hindi (Devanagari) content is the norm at
 * Indian hospitals. For these, Tesseract OCR is unreliable — we want to
 * skip the text path entirely and route straight to Sonnet vision with a
 * Hindi-aware prompt suffix. This is the H6 fix from the May 2026 smoke
 * test: 14/30 patients had gibberish Hindi-script fields.
 */
const HINDI_LIKELY_CATEGORIES: ReadonlySet<string> = new Set([
  'aadhaar_back',
  'ration_card',
  'pmjay_letter',
]);

/**
 * Pages-context suffix injected when we know (or strongly suspect) the
 * source is Devanagari. Lives in the user prompt's pagesContext slot so
 * we don't have to edit the shared system prompt module.
 */
const HINDI_VISION_INSTRUCTIONS =
  ' This section is expected to contain Hindi (Devanagari) script. ' +
  'Read directly from the image. ' +
  'Guidance: ' +
  '(1) For Indian addresses, always include the 6-digit PIN code at the end of the address string. ' +
  '(2) For names that appear in Devanagari, write them in Roman transliteration in the canonical field; ' +
  'if a `name_devanagari` field is not in the schema, do NOT invent one. ' +
  '(3) Preserve Devanagari numerals as their ASCII-digit equivalents (०१२३४५६७८९ → 0123456789). ' +
  '(4) The Aadhaar number is always 12 ASCII digits — if you see a 16-digit run, that is the VID, not the Aadhaar.';

/**
 * Truncation ceiling for the TEXT-ONLY path (≈ 6k tokens — the extractor
 * needs the body, not just the heading).
 *
 * v3 note: a wide itemised bill OCRs to far more than 24k characters and this
 * ceiling was cutting the tail of the table off before the model ever saw it.
 * On the vision path the IMAGES are the source of truth and the OCR text is at
 * most a hint, so the vision path gets a much higher ceiling — see
 * VISION_SECTION_TEXT_MAX_CHARS.
 */
const SECTION_TEXT_MAX_CHARS = 24_000;

/**
 * Truncation ceiling for the VISION path (≈ 25k tokens).
 *
 * v3 first shipped with the bound REMOVED here rather than raised, which is a
 * different thing. The Devanagari auto-escalation below has no length gate —
 * one Devanagari character anywhere in the OCR dump escalates the section — so
 * a 50-page Hindi bundle sent ~500k characters (~125k tokens) of Tesseract
 * text on top of up to 8 pages of tiled images, in ONE call. That is an
 * unbounded input the caller does not choose and cannot see.
 *
 * 100k characters is ~4× the text-path ceiling, comfortably past the longest
 * real itemised bill we have measured, and still a bound. The images remain
 * the source of truth, so a document that needs more text than this is a
 * document the text was never going to decide anyway.
 */
const VISION_SECTION_TEXT_MAX_CHARS = 100_000;

// Auto-vision escalation thresholds. When extraction_mode='auto', we run
// Tesseract first; if its confidence is BELOW this AND the OCR'd text has
// FEWER than this many alphanumeric characters, we re-attempt the section
// by sending the raw image bytes to Claude vision. Tuned to match the
// OCR rotation thresholds in ocr.service.ts so the auto-vision branch
// fires only when rotation salvage has already failed.
const AUTO_VISION_CONFIDENCE_THRESHOLD = 0.35;
const AUTO_VISION_ALNUM_FLOOR = 50;
// Hard cap on rendered pages attached to a single vision call. Each PNG
// at viewportScale=2 is ~100KB → 8 pages = ~800KB upload, well within
// Anthropic's request size limits but enough to cover almost every
// real-world section we segment. Sections larger than this rare; we
// truncate rather than fail.
const MAX_VISION_PAGES = 8;

export interface ExtractSectionInput {
  sectionId: string;
  claimId: string;
  hospitalId: string;
  /**
   * When true, bypass the version-based idempotency short-circuit and
   * re-run the LLM extraction. Per-field human corrections (tracked
   * via `_corrected_fields` in extraction_confidence) are STILL
   * preserved across the re-run — that guard lives inside
   * persistExtraction and is independent of `force`.
   */
  force?: boolean;
}

export interface ExtractSectionResult {
  fields: Record<string, unknown>;
  perFieldConfidence: Record<string, number>;
  costInr: number;
  tierEscalated: boolean;
  /**
   * Present only for LINE_ITEM_CATEGORIES (final_bill, pharmacy_bill,
   * …) — the de-duplicated itemised table. Also written to
   * extracted_fields.line_items, which is what the per-line
   * adjudication phase reads.
   */
  lineItems?: LineItem[];
  /** Row-count / sum-vs-declared-total cross-check for those rows. */
  lineItemTotals?: LineItemTotalsCheck;
  /** True when the page was wide enough to be sent as overlapping tiles. */
  usedTiling?: boolean;
}

interface SectionRow {
  id: string;
  document_id: string;
  page_start: number;
  page_end: number;
  category: string | null;
  extractor_version: string | null;
  extracted_fields: Record<string, unknown> | null;
  extraction_confidence: Record<string, number> | null;
  s3_key: string;
}

/**
 * Shape of one row from hospital.document_field_schemas. Kept narrow —
 * only what the extractor and prompt builder touch.
 */
interface FieldSchemaRow {
  field_key: string;
  field_label: string;
  field_type: string;
  is_required: boolean;
  enum_values: unknown; // pg returns JSONB as already-parsed JS
  reference_category: string | null;
  extraction_priority: number;
  schema_version: number;
}

/**
 * Field types we know how to map to Zod. Exported for ops/observability
 * scripts that want to detect new-in-DB types before they cause a
 * production extraction to throw. The fieldRowToZod switch is the
 * authoritative mapping; this set should stay in sync with its cases.
 */
export const KNOWN_FIELD_TYPES: ReadonlySet<string> = new Set([
  'text',
  'date',
  'number',
  'money',
  'boolean',
  'enum',
  'reference',
  'array',
]);

/**
 * Build a Zod schema for a single field. Exposed for the test suite —
 * the tests cover every field_type branch and the required-vs-optional
 * wrapping in isolation, since this is the highest-risk piece of code in
 * Wave 2B.
 */
export function fieldRowToZod(row: FieldSchemaRow): ZodTypeAny {
  let base: ZodTypeAny;
  switch (row.field_type) {
    case 'text':
      base = z.string();
      break;
    case 'date':
      // Target storage format: ISO YYYY-MM-DD. We accept the most common
      // alternatives the model emits ("12/05/2026", "12-05-2026", "5 Feb
      // 2026", "Feb 5 2026") and normalise. If parsing fails we still
      // throw — silent fall-through to a bad value would poison the
      // dossier downstream.
      base = z.preprocess((v) => {
        if (typeof v !== 'string') return v;
        const s = v.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        // dd/mm/yyyy or dd-mm-yyyy
        const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
        if (dmy) {
          const [, dd, mm, yyRaw] = dmy;
          const yy = (yyRaw!.length === 2 ? '20' + yyRaw : yyRaw)!;
          return `${yy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
        }
        // Fallback: Date.parse handles "Feb 5 2026", "5 Feb 2026", ISO with
        // time, etc. Anything we can't parse falls through unchanged so
        // Zod's regex check fails loudly.
        const t = Date.parse(s);
        if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
        return s;
      }, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'));
      break;
    case 'number':
      // Coerce numeric strings ("4500", "4,500.00", "Rs 4,500") to number.
      base = z.preprocess((v) => {
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          const cleaned = v.replace(/[,₹\sRs\.]/gi, '').replace(/[^\d\.-]/g, '');
          if (cleaned === '' || cleaned === '-' || cleaned === '.') return v;
          const n = Number(cleaned);
          if (!Number.isNaN(n)) return n;
        }
        return v;
      }, z.number());
      break;
    case 'money':
      // Same coercion as number, plus non-negative constraint.
      base = z.preprocess((v) => {
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          const cleaned = v.replace(/[,₹\sRs\.]/gi, '').replace(/[^\d\.-]/g, '');
          if (cleaned === '' || cleaned === '-' || cleaned === '.') return v;
          const n = Number(cleaned);
          if (!Number.isNaN(n)) return n;
        }
        return v;
      }, z.number().nonnegative());
      break;
    case 'boolean':
      base = z.boolean();
      break;
    case 'enum': {
      const vals = parseEnumValues(row.enum_values);
      if (vals.length === 0) {
        logger.warn(
          { field_key: row.field_key },
          'docExtractor: enum field has no enum_values, falling back to string',
        );
        base = z.string();
      } else {
        // z.enum requires a non-empty tuple. Cast is safe — we checked length.
        base = z.enum(vals as [string, ...string[]]);
      }
      break;
    }
    case 'reference':
      // Reference values are raw strings — resolution to the master_options
      // row happens downstream (Sprint 5+ entity-resolution pass).
      base = z.string();
      break;
    case 'array':
      // Open-ended for v1 — the prompt steers the shape per category.
      // Tightening to z.array(z.string()) tomorrow is an additive change.
      base = z.array(z.unknown());
      break;
    default:
      throw new Error(
        `docExtractor: unknown field_type '${row.field_type}' on field '${row.field_key}' — update KNOWN_FIELD_TYPES + typeToZod`,
      );
  }
  // At the EXTRACTION layer all fields are optional. The LLM may emit
  // empty strings, JSON null, or omit fields entirely for values it
  // couldn't find, and we'd rather record a partial extraction than
  // reject the whole section. The `is_required` signal still matters —
  // but it's enforced at the rules-engine layer, where rule_evaluation
  // produces a typed blocking_gap if the field is missing on a stage
  // that needs it.
  //
  // Coerce ALL three "couldn't find" signals to undefined:
  //   - `""` (empty string)        — the prompt asks for strings; LLM may
  //                                  return "" when uncertain
  //   - `null`                     — newer Anthropic models tend to emit
  //                                  null instead of "" for missing values
  //   - missing key                — covered by base.optional()
  // Without this, a single null from the model crashes the entire
  // extraction with LlmSchemaValidationError and we lose the partial
  // results too (see aadhaar_front case where 5 fields came back null
  // and we got nothing).
  const tolerant = z.preprocess((v) => {
    if (v === null) return undefined;
    if (typeof v === 'string' && v.trim() === '') return undefined;
    return v;
  }, base.optional());
  return tolerant;
}

function parseEnumValues(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string');
  }
  // pg might hand us a JSON-string if the JSONB column was cast to text;
  // try a parse before giving up.
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      // fall through to []
    }
  }
  return [];
}

/**
 * Build the full extraction payload schema for a category from the
 * per-field rows. Exposed for tests.
 */
export function buildPayloadSchema(rows: FieldSchemaRow[]): z.ZodTypeAny {
  const fieldShape: Record<string, ZodTypeAny> = {};
  for (const r of rows) {
    fieldShape[r.field_key] = fieldRowToZod(r);
  }
  // Top-level schema: { fields, per_field_confidence, confidence }.
  // per_field_confidence is a record from any field_key (we don't enforce
  // the same shape as `fields` at Zod level — that's a soft constraint
  // checked in the service for logging). confidence is optional because
  // some prompt variants forget to include it; the bridge will default
  // missing confidence to 1.0 which is fine for extractor (we use the
  // per-field map for the bridge-side escalation decision instead).
  //
  // LINE_ITEMS_SCHEMA_FRAGMENT adds the optional `line_items` /
  // `line_items_confidence` keys. Both are optional, so a category with no
  // itemised table is unaffected and every model response that validated
  // under v2 still validates. The row shape itself lives in
  // extractor/lineItems.ts (LineItemSchema) — deliberately NOT re-declared
  // here, so the persisted contract and the prompt contract cannot drift.
  return z.object({
    fields: z.object(fieldShape),
    per_field_confidence: z.record(z.string(), z.number().min(0).max(1)),
    confidence: z.number().min(0).max(1).optional(),
    ...LINE_ITEMS_SCHEMA_FRAGMENT,
  });
}

export interface DocExtractorDeps {
  pool?: Pick<Pool, 'query'>;
  llm?: ReturnType<typeof getLlmClient>;
  s3?: Pick<typeof defaultS3Service, 'download'>;
  /**
   * OCR reader. Must declare BOTH methods: `extractSection` calls
   * `extractTextFromPdf` on the PDF path and `extractTextFromImage` on the
   * single-image path, and the field it is assigned to (`this.ocr`) requires
   * both. This used to declare only 'extractTextFromPdf' — a live TS2741 on
   * the assignment, and worse than a type error: a test double or DI override
   * that satisfied the DECLARED type type-checked clean and then threw
   * "extractTextFromImage is not a function" on the first image section.
   * Same defect, same fix, as docClassifier.service.ts:171.
   */
  ocr?: Pick<typeof defaultOcrService, 'extractTextFromPdf' | 'extractTextFromImage'>;
  events?: Pick<typeof defaultEventDispatcher, 'dispatch'>;
  costAccounting?: Pick<typeof costAccountingService, 'checkBudget' | 'recordCall'>;
  /**
   * Vision input preparer — render → deskew → tile. Defaults to
   * prepareVisionInput from extractor/index.ts; injectable so the test
   * suite can exercise the vision branch (attachment plumbing, layout
   * context, line-item handling) without rasterising a real PDF through
   * sharp + pdf-to-png-converter on every run.
   */
  visionInput?: typeof prepareVisionInput;
}

export class DocExtractorService {
  private readonly pool: Pick<Pool, 'query'>;
  private readonly llm: ReturnType<typeof getLlmClient>;
  private readonly s3: Pick<typeof defaultS3Service, 'download'>;
  private readonly ocr: Pick<typeof defaultOcrService, 'extractTextFromPdf' | 'extractTextFromImage'>;
  private readonly events: Pick<typeof defaultEventDispatcher, 'dispatch'>;
  private readonly costAccounting: Pick<typeof costAccountingService, 'checkBudget' | 'recordCall'>;
  private readonly visionInput: typeof prepareVisionInput;

  constructor(deps: DocExtractorDeps = {}) {
    this.pool = deps.pool ?? defaultPool;
    this.llm = deps.llm ?? getLlmClient();
    this.s3 = deps.s3 ?? defaultS3Service;
    this.ocr = deps.ocr ?? defaultOcrService;
    this.events = deps.events ?? defaultEventDispatcher;
    this.costAccounting = deps.costAccounting ?? costAccountingService;
    this.visionInput = deps.visionInput ?? prepareVisionInput;
  }

  async extractSection(input: ExtractSectionInput): Promise<ExtractSectionResult> {
    const { sectionId, claimId, hospitalId, force } = input;

    // 1. Load section.
    const section = await this.loadSection(sectionId);
    if (!section) {
      throw new Error(`docExtractor: section ${sectionId} not found`);
    }
    if (!section.category) {
      throw new Error(
        `docExtractor: section ${sectionId} has no category — classifier must run first`,
      );
    }

    // 2. Idempotency. `force` (from /analyze with force=true) bypasses
    //    this so the user's "Re-run AI Analysis" actually re-extracts
    //    even when nothing else changed. The persist step inside
    //    persistExtraction still preserves per-field human corrections
    //    via the _corrected_fields list — force does not override that.
    if (
      !force &&
      section.extractor_version === EXTRACTOR_VERSION &&
      section.extracted_fields !== null
    ) {
      logger.info(
        { sectionId, extractor_version: EXTRACTOR_VERSION },
        'docExtractor: idempotent short-circuit (version matches)',
      );
      return {
        fields: section.extracted_fields,
        perFieldConfidence: section.extraction_confidence ?? {},
        costInr: 0,
        tierEscalated: false,
      };
    }

    // 3. Budget pre-flight.
    //
    // 076 — `action` is a WIDENING union. Anything that is not 'allow' or
    // 'throttle' means DO NOT MAKE THE CALL. The 'pause_for_consent' arm
    // parks the run and returns WITHOUT throwing LlmBudgetExceededError:
    // a throw would burn Bull's three retries against a run that is
    // deliberately waiting for a person to approve more budget, and after
    // three the section dead-letters — the pause would have destroyed work
    // rather than deferred it.
    //
    // THE runId ARGUMENT IS LOAD-BEARING, NOT TELEMETRY. `checkBudget` only
    // reads the run's approved budget — and therefore can only ever return
    // 'pause_for_consent' — when it is given a run id. Without it this whole
    // arm below is dead code and the extractor spends until the STATIC
    // operator cap throws, which is the wrong failure: 17 itemised sections
    // against a ₹60 approval used to run all 17, blow through ₹150 and dead
    // letter, when what was specified is a pause at ₹60 and a re-ask.
    //
    // Resolved ONCE here and reused for the OCR opts further down (step 5),
    // so the pre-flight and the reads it authorises are attributed to the
    // same run. `resolveActiveRunId` returns null for a terminal, superseded
    // or paused run, which correctly degrades this to the static caps.
    const activeRunId = await this.resolveActiveRunId(claimId);
    const verdict = await this.costAccounting.checkBudget(
      claimId,
      hospitalId,
      undefined,
      { runId: activeRunId },
    );
    if (verdict.action === 'pause_for_consent') {
      await this.pauseRunForConsent(claimId, section.document_id, sectionId);
      return {
        fields: {},
        perFieldConfidence: {},
        costInr: 0,
        tierEscalated: false,
        skipped: true,
        skip_reason: 'run_budget_exhausted',
      } as any;
    }
    if (verdict.action !== 'allow' && verdict.action !== 'throttle') {
      throw new LlmBudgetExceededError(
        verdict.claimUnderLimit ? 'hospital_daily' : 'claim',
        verdict.claimUnderLimit
          ? (verdict.hospitalDailySpendInr ?? 0)
          : (verdict.claimSpendInr ?? 0),
        verdict.claimUnderLimit
          ? (verdict.hospitalDailyCapInr ?? 0)
          // The claim dimension's cap, read live rather than hardcoded. This
          // literal used to say 15, which stopped being the cap when
          // CLAIM_HARD_LIMIT_INR moved to ₹150 — the error reported a limit
          // the system was not enforcing.
          : claimHardLimitInr(),
        { claimId, hospitalId },
      );
    }

    // 4. Load the field schema rows for this category at the latest
    //    schema_version. Many categories don't have schemas seeded yet
    //    (we only ship schemas for ~5 of the 200+ taxonomy codes). For
    //    those, the section is still useful to the rules engine via
    //    presence/absence checks — we just can't pull typed fields. So
    //    mark the row as "extraction skipped" rather than failing the
    //    job; the FE banner stops showing it as pending work.
    const fieldRows = await this.loadFieldSchema(section.category);
    // Category-level extraction hint sourced from master_options.description
    // for this doc_category code. Carries layout/label quirks specific to
    // the document type (e.g. "Aadhaar front has no Name: label; the name
    // appears as Devanagari then English transliteration. The 12-digit
    // UID renders as 3 groups of 4 digits."). Optional — when null/empty
    // the extractor falls back to schema-only prompting.
    const categoryHint = await this.loadCategoryHint(section.category);
    // Extraction mode tells us whether to run Tesseract first
    // ('ocr' / null) or send raw image bytes to Claude vision ('vision'),
    // or try OCR with vision fallback ('auto'). Sourced from
    // master_options.extraction_mode for the doc_category code (migration 050).
    let extractionMode = await this.loadExtractionMode(section.category);
    // H6 fix (May 2026): Hindi-script-heavy categories at Indian hospitals
    // (aadhaar_back, ration_card, pmjay_letter) almost always render in
    // Devanagari. Tesseract.js Devanagari recognition is poor → forcing
    // these to the vision tier avoids the gibberish-ASCII problem that
    // was poisoning 14/30 Sadbhawana patients. Overriding here (instead
    // of in the master_options seed) keeps the override visible in code
    // history for future debugging.
    if (HINDI_LIKELY_CATEGORIES.has(section.category) && extractionMode !== 'vision') {
      logger.debug(
        { sectionId, category: section.category, prior: extractionMode },
        'docExtractor: H6 override — forcing vision for Hindi-likely category',
      );
      extractionMode = 'vision';
    }
    if (fieldRows.length === 0) {
      logger.info(
        { sectionId, category: section.category },
        'docExtractor: no field_schema for category — marking section as extraction_skipped',
      );
      try {
        await this.pool.query(
          `UPDATE hospital.document_sections
              SET extractor_version = $2,
                  extractor_provider = 'system',
                  extractor_model = 'no_schema',
                  status = CASE WHEN status = 'auto' THEN 'auto' ELSE status END,
                  extracted_fields = COALESCE(extracted_fields, '{}'::jsonb),
                  extraction_confidence = COALESCE(extraction_confidence, '{"_meta":{"skipped":"no_field_schema"}}'::jsonb),
                  updated_at = NOW()
            WHERE id = $1`,
          [sectionId, EXTRACTOR_VERSION],
        );
      } catch (err) {
        logger.warn({ err, sectionId }, 'docExtractor: failed to stamp skipped row');
      }
      return {
        fields: {},
        perFieldConfidence: {},
        costInr: 0,
        tierEscalated: false,
        skipped: true,
        skip_reason: 'no_field_schema',
      } as any;
    }

    // 5. Build the runtime Zod schema. Wrapped in try/catch so a single
    //    bad row gives a meaningful error rather than a stack trace from
    //    deep inside Zod.
    let payloadSchema: z.ZodTypeAny;
    try {
      payloadSchema = buildPayloadSchema(fieldRows);
    } catch (err) {
      logger.error(
        { err, category: section.category, fieldRows: fieldRows.map((r) => r.field_key) },
        'docExtractor: failed to build payload schema',
      );
      throw err;
    }

    // 6. Decide between OCR-only path and vision path.
    //
    // Vision mode is for categories Tesseract reliably fails on:
    // handwritten doctor's notes, OT notes, X-ray plates with annotations,
    // multi-column lab reports with rotated text. We send the raw image
    // bytes to Claude vision and let the model read what's there.
    //
    // OCR mode (default) runs Tesseract first → plaintext to the LLM.
    //
    // Auto mode tries OCR first; if confidence is bad AND text is sparse
    // (so the bundle context can't save us either), falls through to
    // vision. Lets us keep the cheap path on for ambiguous categories
    // (e.g. pathology_reports — typed at big labs, handwritten at smaller
    // ones) without permanently paying the vision premium.
    const sourceBytes = await this.s3.download(section.s3_key);
    const isImage = this.isImageBuffer(sourceBytes);

    let sectionText = '';
    let pagesContext = '';
    let visionAttachments: import('./llm/LlmClient.js').LlmAttachment[] | undefined =
      undefined;
    let usedVision = false;
    // Set from prepareVisionInput: the prose describing exactly which
    // images were attached (overview + N overlapping slices), whether any
    // page was wide enough to tile, and how many tiles went out. These
    // feed the prompt (so the model knows to merge by row key) and the
    // _line_items_meta audit channel.
    let layoutContext = '';
    let anyWide = false;
    let tileCount = 0;
    // WHICH WAY the tiler cut. imageTiler measures both axes and picks the
    // better one: a wide landscape bill becomes VERTICAL column strips ('x'),
    // a dense A4 portrait page HORIZONTAL row bands ('y'). Those two merge
    // rules are OPPOSITES, so this is what selects the system prompt below —
    // passing the x-only constant on a portrait page made the system prompt
    // assert "every image shows the same rows" while layoutContext, in the
    // very same call's user turn, correctly described consecutive row bands.
    // Empty = untiled (or text-only), which asserts no merge rule at all.
    let tileAxes: VisionTileAxis[] = [];

    // 076 — pages in this section's range that came back unreadable, in the
    // PARENT document's numbering. Populated by whichever read branch runs.
    let unreadableHere: ReturnType<typeof unreadablePagesOf> = [];

    const wantsVision =
      extractionMode === 'vision' ||
      // 'auto' starts in OCR and may escalate after we measure quality.
      extractionMode === 'auto';

    // ─── §C.3.4 rule 1 — pre-check, BEFORE the prompt and BEFORE any
    // render: has an earlier phase already established that every page in
    // this section's range is unreadable?
    //
    // Skipping here is the difference between "this section cost ₹0" and
    // "this section cost a full itemised-bill extraction to discover it had
    // no input". The exception is the vision path: it renders the pages
    // ITSELF, under a different budget and a different code path, so a
    // render_failed verdict from ingest is not binding on it. Rule 4 exists
    // precisely because that re-render sometimes succeeds — and when it does
    // we clear the marker rather than ask the user to re-upload a file that
    // worked.
    const priorUnreadable = await this.loadPriorUnreadable(
      claimId,
      section.document_id,
      section.page_start,
      section.page_end,
    );
    const rangeLength = Math.max(0, section.page_end - section.page_start + 1);
    const wholeRangePreMarked =
      rangeLength > 0 && priorUnreadable.size >= rangeLength;
    const preMarkedFixableByRender = [...priorUnreadable.values()].every(
      (r) => r === 'render_failed',
    );
    if (wholeRangePreMarked && !(wantsVision && preMarkedFixableByRender)) {
      logger.warn(
        {
          sectionId,
          claimId,
          category: section.category,
          pages: [...priorUnreadable.keys()].sort((a, b) => a - b),
        },
        'docExtractor: every page of this section is unreadable — settling it without an LLM call (₹0)',
      );
      await this.stampUnreadableSection(sectionId, [...priorUnreadable.keys()]);
      return {
        fields: {},
        perFieldConfidence: {},
        costInr: 0,
        tierEscalated: false,
        skipped: true,
        skip_reason: 'unreadable_pages',
      } as any;
    }

    // 076 — the run this section belongs to. Resolved ONCE at the budget
    // pre-flight in step 3 and reused here. Threading it into the OCR opts is
    // what makes the run's approved budget one of the dimensions the rupee
    // allowance intersects; without it the per-section reads — where most OCR
    // spend actually happens — would be bounded only by the static caps, and
    // the number the user approved would bound nothing at all.
    const ocrShouldStop = activeRunId
      ? (await import('./claimAiRun.service.js')).default.makeShouldStop(activeRunId)
      : undefined;

    // The read branches raise OcrPausedError ONLY when a pause lands mid-read
    // (opts.shouldStop). It is a control-flow signal, not a failure: catch it,
    // park the phase, and return. Letting it escape would fail the Bull job
    // and burn a retry against a run that is deliberately parked.
    try {
      if (extractionMode === 'vision') {
        // Pure vision path — skip Tesseract entirely. buildVisionAttachments
        // renders at an aspect-aware DPI, deskews, and tiles wide pages, so
        // this branch covers PDFs and images identically now.
        const prepared = await this.buildVisionAttachments(
          sourceBytes,
          isImage,
          section.s3_key,
          section.page_start,
          section.page_end,
        );
        visionAttachments = prepared.attachments;
        layoutContext = prepared.layoutContext;
        anyWide = prepared.anyWide;
        tileAxes = prepared.tileAxes;
        tileCount = this.countTiles(prepared.pages);
        usedVision = true;
        sectionText = '';
        pagesContext = isImage
          ? `Section is a single-page scanned image. Tesseract is unreliable for category=${section.category}; reading directly from image.`
          : `Section spans pages ${section.page_start}-${section.page_end}. Reading from rendered page image directly (extraction_mode=vision).`;
      } else if (isImage) {
        const page = await this.ocr.extractTextFromImage(
          sourceBytes,
          ocrCallOpts(claimId, hospitalId, activeRunId, ocrShouldStop),
        );
        if (isUnreadable(page as OcrPage)) {
          unreadableHere = [
            {
              pageNumber: section.page_start,
              reason: (page as any).unreadableReason ?? 'vision_failed',
              detail: (page as any).unreadableDetail,
            },
          ];
        }
        // Keep the raw pages around: if we escalate to vision below, the 24k
        // ceiling gives way to the (higher) vision ceiling and we re-join.
        // An unreadable page contributes '' — NOT its marker text.
        const rawPages = isUnreadable(page as OcrPage) ? [] : [page.text];
        sectionText = this.joinText(rawPages, true);
        pagesContext = `Section is a single-page scanned image (OCR confidence ${page.confidence.toFixed(2)}).`;
        // H6 escalation: if Tesseract output contains Devanagari, the
        // ASCII transcription is likely garbage. Force vision regardless
        // of OCR confidence number (Tesseract often reports high confidence
        // on its own gibberish output).
        const hasDevanagari = containsDevanagari(sectionText);
        // Auto mode: escalate to vision if OCR was junk.
        if (
          (wantsVision || hasDevanagari) &&
          (hasDevanagari ||
            (page.confidence < AUTO_VISION_CONFIDENCE_THRESHOLD &&
              sectionText.replace(/[^A-Za-z0-9]/g, '').length < AUTO_VISION_ALNUM_FLOOR))
        ) {
          logger.info(
            { sectionId, category: section.category, conf: page.confidence },
            'docExtractor: auto-escalating to vision (OCR text too sparse)',
          );
          const prepared = await this.buildVisionAttachments(
            sourceBytes,
            true,
            section.s3_key,
            section.page_start,
            section.page_end,
          );
          visionAttachments = prepared.attachments;
          layoutContext = prepared.layoutContext;
          anyWide = prepared.anyWide;
          tileAxes = prepared.tileAxes;
          tileCount = this.countTiles(prepared.pages);
          usedVision = true;
          sectionText = this.joinText(rawPages, false);
          pagesContext +=
            ' OCR text was too sparse to extract reliably; supplementing with the source image via vision.';
        }
      } else {
        const slicedPdf = await this.fetchAndSlicePdf(
          section.s3_key,
          section.page_start,
          section.page_end,
        );
        const ocr = await this.ocr.extractTextFromPdf(
          slicedPdf,
          ocrCallOpts(claimId, hospitalId, activeRunId, ocrShouldStop),
        );
        // Kept raw so an escalation to vision below can re-join under the
        // higher vision ceiling rather than the 24k one (which was clipping
        // the tail of wide itemised bills before the model ever saw it).
        // ─── §C.3.4 rule 2 — extract from the READABLE pages ─────────────
        // Not from all pages: an unreadable page contributes no text, and the
        // placeholder markers the bundle classifier uses to preserve numbering
        // are not content and must never enter an extraction prompt.
        unreadableHere = this.mapSliceUnreadables(ocr, section.page_start);
        const rawPages = readablePages(ocr).map((p) => p.text);
        sectionText = this.joinText(rawPages, true);
        pagesContext = `Section spans pages ${section.page_start}-${section.page_end} of the parent document (this slice is ${ocr.totalPages} page${ocr.totalPages === 1 ? '' : 's'}, avg OCR confidence ${ocr.avgConfidence.toFixed(2)}).`;
        if (unreadableHere.length > 0) {
          // Told to the model explicitly. A model that knows it is looking at
          // 3 of 5 pages will not confidently report a total it never saw; a
          // model that thinks it has the whole bill will.
          pagesContext += ` NOTE: page${unreadableHere.length === 1 ? '' : 's'} ${unreadableHere
            .map((u) => u.pageNumber)
            .join(', ')} could not be read and ${unreadableHere.length === 1 ? 'is' : 'are'} NOT included. Any total you compute covers only the pages shown.`;
        }
        const hasDevanagari = containsDevanagari(sectionText);
        if (
          (wantsVision || hasDevanagari) &&
          (hasDevanagari ||
            (ocr.avgConfidence < AUTO_VISION_CONFIDENCE_THRESHOLD &&
              sectionText.replace(/[^A-Za-z0-9]/g, '').length < AUTO_VISION_ALNUM_FLOOR))
        ) {
          logger.info(
            { sectionId, category: section.category, conf: ocr.avgConfidence },
            'docExtractor: auto-escalating PDF section to vision (OCR text too sparse)',
          );
          const prepared = await this.buildVisionAttachments(
            sourceBytes,
            false,
            section.s3_key,
            section.page_start,
            section.page_end,
          );
          if (prepared.attachments.length > 0) {
            visionAttachments = prepared.attachments;
            layoutContext = prepared.layoutContext;
            anyWide = prepared.anyWide;
            tileAxes = prepared.tileAxes;
            tileCount = this.countTiles(prepared.pages);
            usedVision = true;
            sectionText = this.joinText(rawPages, false);
            pagesContext +=
              ' OCR text was too sparse; supplementing with rendered page images via vision.';
          }
        }
      }
    } catch (err) {
      if (err instanceof OcrPausedError) {
        logger.info(
          { sectionId, claimId, run_id: activeRunId, pages_read: err.pagesRead },
          'docExtractor: run paused during the section read — phase blocked, will be re-read on resume',
        );
        if (activeRunId) {
          const { default: ledger } = await import('./docPhaseLedger.service.js');
          await ledger
            .blockPhase(section.document_id, activeRunId, 'extract', 'run_paused')
            .catch(() => {});
        }
        return {
          fields: {},
          perFieldConfidence: {},
          costInr: 0,
          tierEscalated: false,
          skipped: true,
          skip_reason: 'run_paused',
        } as any;
      }
      throw err;
    }

    // ─── §C.3.4 rules 1 + 4 — post-read reconciliation ─────────────────
    //
    // (4) THE ONE PLACE A MARKER CAN BE CLEARED. If we rendered attachments
    //     for pages a previous phase gave up on, those pages ARE readable
    //     after all, and the end-of-run summary must not ask the user to
    //     re-upload a document that worked.
    if (usedVision && visionAttachments.length > 0 && priorUnreadable.size > 0) {
      const renderFixed = [...priorUnreadable.entries()]
        .filter(([, reason]) => reason === 'render_failed')
        .map(([page]) => page);
      if (renderFixed.length > 0) {
        await this.clearRenderedUnreadables(
          claimId,
          section.document_id,
          renderFixed,
        );
        for (const p of renderFixed) priorUnreadable.delete(p);
        unreadableHere = unreadableHere.filter(
          (u) => !renderFixed.includes(u.pageNumber),
        );
      }
    }

    // (1) The read itself may have found the whole range unreadable, and on
    //     the pure-vision path "no attachments and no text" is the same fact
    //     wearing different clothes: there is nothing to send.
    const nothingToSend =
      sectionText.trim().length === 0 && visionAttachments.length === 0;
    if (nothingToSend) {
      const pages =
        unreadableHere.length > 0
          ? unreadableHere.map((u) => u.pageNumber)
          : [...priorUnreadable.keys()];
      if (pages.length > 0) {
        logger.warn(
          { sectionId, claimId, category: section.category, pages },
          'docExtractor: nothing readable in this section — settling it without an LLM call (₹0)',
        );
        await this.recordSectionUnreadables(
          claimId,
          section.document_id,
          sectionId,
          unreadableHere,
        );
        await this.stampUnreadableSection(sectionId, pages);
        return {
          fields: {},
          perFieldConfidence: {},
          costInr: 0,
          tierEscalated: false,
          skipped: true,
          skip_reason: 'unreadable_pages',
        } as any;
      }
    }

    // (2) SOME pages unreadable — extract from the rest, and record which
    //     ones were missing so the UI can say "extracted from 3 of 5 pages"
    //     rather than presenting a partial bill as complete.
    if (unreadableHere.length > 0) {
      await this.recordSectionUnreadables(
        claimId,
        section.document_id,
        sectionId,
        unreadableHere,
      );
    }

    // H6 — append Hindi-aware instructions to the pagesContext when the
    //       section is Hindi-likely (category in HINDI_LIKELY_CATEGORIES
    //       OR Tesseract output revealed Devanagari). Done here (post-mode
    //       decision) so the instructions flow through whichever branch
    //       above produced pagesContext. The prompt module is not modified.
    const isHindiSection =
      HINDI_LIKELY_CATEGORIES.has(section.category) ||
      (sectionText.length > 0 && containsDevanagari(sectionText));
    if (isHindiSection) {
      pagesContext = pagesContext + HINDI_VISION_INSTRUCTIONS;
    }

    // 6b. Deterministic regex-based fact extraction. Runs over the OCR
    //     text (vision-only sections will have sectionText='' and this
    //     produces an empty fact set, which is fine — the LLM still
    //     has the image). Facts get:
    //       - Injected into the user prompt as a DETECTED_FACTS block
    //         so the LLM prefers them over its own re-extraction.
    //       - Persisted into extraction_confidence._deterministic_facts
    //         so downstream consumers (harmoniser, audit) can read them
    //         without re-running OCR.
    //     Patterns covered: doctor NMC/MPMC reg IDs, Aadhaar (Verhoeff-
    //     validated), PMJAY alphanumeric + beneficiary digit IDs, ABHA,
    //     Indian mobile, dates, currency amounts. See
    //     extractor/deterministicExtractors.ts for details.
    const deterministicFacts: DeterministicFacts = extractDeterministicFacts(
      sectionText ?? '',
    );
    const deterministicFactsBlock = formatDeterministicFactsForPrompt(deterministicFacts);
    if (deterministicFactsBlock.length > 0) {
      logger.debug(
        {
          sectionId,
          category: section.category,
          nmc_ids: deterministicFacts.doctor_nmc_ids.length,
          aadhaar: deterministicFacts.aadhaar_numbers.length,
          pmjay: deterministicFacts.pmjay_ids.length,
          abha: deterministicFacts.abha_numbers.length,
          mobile: deterministicFacts.mobile_numbers.length,
          dates: deterministicFacts.dates.length,
          currency: deterministicFacts.currency_amounts.length,
        },
        'docExtractor: deterministic regex facts detected — injecting into prompt',
      );
    }

    // 7. Build the per-field descriptors for the user prompt.
    const fieldDescriptors: ExtractorFieldDescriptor[] = fieldRows.map((r) => ({
      field_key: r.field_key,
      field_label: r.field_label,
      field_type: r.field_type,
      is_required: r.is_required,
      enum_values: parseEnumValues(r.enum_values).length > 0
        ? parseEnumValues(r.enum_values)
        : null,
      reference_category: r.reference_category,
    }));

    // 7b. Hospital format hints (Phase 3 — May 21, 2026).
    //     Pull the few-shot HOSPITAL_FORMAT_HINTS that the reviewer-
    //     corrections aggregator has precipitated for this
    //     (hospital_id, category). When non-empty, append the rendered
    //     block to pagesContext so the LLM sees it before extracting.
    //     Cap at ~1500 tokens (≈6000 chars) by taking profiles in
    //     confidence-DESC order until the budget runs out.
    //     Failures degrade silently — extraction proceeds without hints.
    try {
      const profiles =
        await hospitalFormatProfileService.getProfilesForExtraction(
          hospitalId,
          section.category,
        );
      if (profiles.length > 0) {
        const HINT_CHAR_BUDGET = 6000;
        const lines: string[] = [];
        let used = 0;
        for (const p of profiles) {
          const examplePart =
            p.example_quote && p.example_value
              ? ` Example past quote: "${p.example_quote}" → "${p.example_value}".`
              : '';
          const line = `- ${p.field_name}: ${p.extraction_hint}${examplePart}`;
          if (used + line.length > HINT_CHAR_BUDGET) break;
          lines.push(line);
          used += line.length + 1;
        }
        if (lines.length > 0) {
          const hintsBlock =
            `\n\n=== HOSPITAL_FORMAT_HINTS (learned from past corrections for this hospital) ===\n` +
            lines.join('\n');
          pagesContext = pagesContext + hintsBlock;
          logger.debug(
            {
              sectionId,
              hospitalId,
              category: section.category,
              hint_count: lines.length,
              total_profiles: profiles.length,
            },
            'docExtractor: injected HOSPITAL_FORMAT_HINTS block into prompt',
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err, sectionId, hospitalId },
        'docExtractor: hospital format profile lookup failed (continuing without hints)',
      );
    }

    // 8. Cache key — section text + extractor version + category + vision
    //    image hashes + section_id backstop.
    //
    //    P0 BUG FIX (May 20, 2026): the previous key hashed ONLY
    //    `sectionText + EXTRACTOR_VERSION + category`. That allowed a
    //    cache collision when:
    //      - the bundle classifier extracted near-empty/garbage OCR
    //        text for handwritten Hindi OPD notes (Tesseract on those
    //        often returns the same short noise blob)
    //      - AND auto-vision-escalation kicked in (so the real signal
    //        was the image, not the text)
    //      - the cache key hashed only the empty/garbage text
    //      - so the SECOND patient's vision extraction call HIT the
    //        cache and returned the FIRST patient's JSON.
    //
    //    Observed leak (Sadbhawana smoke test 16:30-16:45Z): Rampyari's
    //    "Rt Hip x 3 days old" OPD notes verbatim across Mahendri,
    //    Mohd Faijan, Sonam, Hina Parveen (7 sections / 5 patients).
    //    Anvi's CRIF Volar Plate OT note leaked into Sushila + Hamshiran.
    //    Hina's xray copied to Anvi + Sushila.
    //
    //    Fix: include (a) hash of vision attachment bytes if any, AND
    //    (b) section_id as a hard backstop. The section_id alone is
    //    enough to guarantee no cross-section leak, but text+category
    //    + image hash also preserves the SAFE cache hit on legitimate
    //    re-runs of the SAME section (which keeps re-runs cheap).
    const visionHashChunks: string[] = [];
    if (usedVision && visionAttachments && visionAttachments.length > 0) {
      for (const a of visionAttachments) {
        if (a?.data) {
          const bytes = Buffer.isBuffer(a.data)
            ? a.data
            : Buffer.from(a.data as any);
          visionHashChunks.push(
            createHash('sha256').update(bytes).digest('hex').slice(0, 16),
          );
        }
      }
    }
    const cacheKey = createHash('sha256')
      .update(sectionText)
      .update('::')
      .update(EXTRACTOR_VERSION)
      .update('::')
      .update(section.category)
      .update('::')
      .update(sectionId) // hard backstop — guarantees no cross-section leak
      .update('::vision::')
      .update(visionHashChunks.join('|'))
      .digest('hex');

    // 9. Call the LLM bridge. extract() validates against the Zod schema
    //    and throws LlmSchemaValidationError on a malformed model
    //    response. Catch that one specifically so we can surface a
    //    structured error with the section context.
    //
    //    Line items: categories that carry an itemised table
    //    (final_bill, pharmacy_bill, …) additionally ask for the full
    //    `line_items` array. The per-line adjudication phase consumes it,
    //    so a dropped or row-shifted row is a real money error — which is
    //    exactly why those sections go out as overlapping tiles.
    const wantsLineItems = isLineItemCategory(section.category);
    let extractResult;
    try {
      extractResult = await this.llm.extract({
        // AXIS-SELECTED, not the x-only constant. On a tiled portrait page
        // the constant told the model every image showed the same rows while
        // `tilingContext` below described consecutive row bands; the two
        // halves of one prompt contradicted each other.
        systemPrompt: buildDocExtractorSystemPrompt(tileAxes),
        userPrompt: buildDocExtractorUserPrompt({
          category: section.category,
          fields: fieldDescriptors,
          sectionText,
          pagesContext,
          categoryHint,
          deterministicFactsBlock,
          // Passed as its own slot rather than concatenated into
          // pagesContext so there is exactly one copy of the
          // overlapping-slice explanation in the prompt. Empty string on
          // the text-only path renders nothing.
          tilingContext: layoutContext,
          requestLineItems: wantsLineItems,
          // buildLineItemsPromptBlock's rule 3 is itself a merge rule and
          // sits in this same user turn, next to tilingContext. Same axes in,
          // so it cannot contradict its neighbour either.
          tileAxes,
        }),
        schema: payloadSchema,
        cacheKey,
        promptVersion: docExtractorPromptVersion(tileAxes),
        taskName: `doc_extract.${section.category}`,
        // Vision calls jump straight to the premium tier — Haiku doesn't
        // currently support vision well and we want maximum accuracy on
        // the categories Tesseract failed on. Text-only stays standard
        // (Haiku with Sonnet escalation), unchanged behaviour.
        //
        // Line-item categories also go premium even on a text-only path:
        // transcribing an itemised table row-by-row without shifting the
        // money column is exactly the task Haiku is weakest at, and a
        // wrong amount on the wrong line is a money error, not a typo.
        tier: usedVision || wantsLineItems ? 'premium' : 'standard',
        // When vision was decided above, attach image bytes here. The
        // bridge converts these to Anthropic image blocks and feeds them
        // to Sonnet alongside the text prompt.
        documents: visionAttachments,
        claimId,
        hospitalId,
      });
    } catch (err) {
      if (err instanceof LlmSchemaValidationError) {
        logger.error(
          {
            sectionId,
            category: section.category,
            rawResponse: err.rawResponse?.slice(0, 1000),
          },
          'docExtractor: model output failed Zod validation',
        );
      }
      throw err;
    }

    // 9b. Record the call's cost in hospital.llm_cost_log (best-effort;
    //     recordCall swallows its own errors and never aborts the parent
    //     op). Fix for benchmark finding B1: per-doc extract spend was
    //     previously invisible — the bridge computes tokens+costInr but
    //     does NOT write the cost log itself, so each service must record
    //     its own call (same pattern as docSegmenter / harmonisation).
    //     This is what makes the checkBudget() pre-flight above actually
    //     enforceable: without recording here, getClaimSpendInr() always
    //     read ~0 for classify+extract and the per-claim reasoning hard cap
    //     (claimHardLimitInr) could be silently overshot — as could the
    //     run budget the user approved, which is read from the same table.
    //     Recorded unconditionally — an LRU/replay cache
    //     hit re-records its cached cost, but the cacheKey is section+
    //     version scoped so within a run a section is extracted exactly
    //     once; the residual over-count on an accidental retry is small and
    //     the under-count (recording nothing) is the bug we are fixing.
    await this.costAccounting.recordCall({
      claimId,
      hospitalId,
      // Stamped so getRunSpendInr can attribute this row to THIS run rather
      // than falling back to "all claim spend since the run was triggered".
      // Without it a superseded run's tail, or a manual re-extract, counts
      // against the budget the user approved for the current run and the
      // pause card shows a number that is not this run's spend.
      runId: activeRunId,
      task: `doc_extract.${section.category}`,
      provider: extractResult.provider,
      model: extractResult.model,
      promptVersion: docExtractorPromptVersion(tileAxes),
      tokensInputUncached: extractResult.tokensInputUncached,
      tokensInputCached: extractResult.tokensInputCached,
      tokensOutput: extractResult.tokensOutput,
      latencyMs: extractResult.latencyMs,
      costInr: extractResult.costInr,
      succeeded: true,
    });

    const data = extractResult.data as {
      fields: Record<string, unknown>;
      per_field_confidence: Record<string, number>;
      confidence?: number;
      line_items?: LineItem[];
      line_items_confidence?: number;
    };

    // 10. Drop sentinel placeholders. The system prompt instructs the
    //     LLM to emit "" / 0 / false / "1970-01-01" for REQUIRED fields
    //     it couldn't find (with per_field_confidence=0 signalling that),
    //     so the model can keep its output schema consistent. But those
    //     sentinels are meaningless to humans — a reviewer seeing
    //     date_of_birth=1970-01-01 in extracted_fields will mistake it
    //     for a hallucinated value. Persist only fields the LLM was
    //     ACTUALLY confident in (per_field_confidence > 0). The confidence
    //     map keeps its zero entries so downstream rules can still detect
    //     "the model tried but failed" vs "the model never tried".
    const SENTINEL_THRESHOLD = 0; // > 0 = real attempt, 0 = sentinel
    const cleanedFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data.fields)) {
      const conf = data.per_field_confidence[k];
      // Field has no confidence entry → keep (model didn't bother emitting
      // a confidence; treat as best-effort real extraction).
      if (typeof conf !== 'number') {
        cleanedFields[k] = v;
        continue;
      }
      if (conf > SENTINEL_THRESHOLD) {
        cleanedFields[k] = v;
      } else {
        logger.debug(
          { sectionId, field: k, value: v },
          'docExtractor: dropping zero-confidence sentinel field before persist',
        );
      }
    }

    // 11. Post-extraction validation. Some fields have deterministic
    //     invariants the LLM can't reliably enforce — most notably the
    //     Aadhaar Verhoeff checksum, which catches Tesseract digit-OCR
    //     errors (9↔0, 6↔0) that the LLM is happy to pass through.
    //     When a validator fails, we DON'T drop the value (the user may
    //     still want to see the wrong digits to correct them); we just
    //     down-weight per_field_confidence to a low value so the UI's
    //     ConfidenceBadge renders red and the rules engine treats the
    //     field as untrustworthy. The validation reason is stuffed into
    //     extraction_confidence alongside the numeric so the FE can
    //     surface it ("Aadhaar checksum failed — please verify digits").
    const FAILED_VALIDATION_CONFIDENCE = 0.3;

    // 11a. NEW (May 2026, smoke-test follow-up): aggregate validator
    //      runner — Aadhaar 12-digit + Verhoeff with VID split-off,
    //      Hindi/English boilerplate blocklist for clinical fields,
    //      episode-date plausibility windows (uses admission_date as
    //      pivot, falls back to ipds.admitted_at, then to a ±1y window),
    //      diagnosis title-casing, Aadhaar-back PIN backfill.
    //
    //      For these we DO null the offending field (unlike the
    //      existing validators which only down-weight confidence). The
    //      reason: blocklist matches and out-of-window dates are not
    //      something a reviewer wants to "correct from" — the value is
    //      structurally wrong, not just low-confidence.
    const admissionDate = await this.loadAdmissionDate(claimId, sectionId);
    const fieldTypeMap: Record<string, string> = {};
    for (const r of fieldRows) fieldTypeMap[r.field_key] = r.field_type;
    const postRun = runPostValidators({
      category: section.category,
      fields: cleanedFields,
      fieldTypes: fieldTypeMap,
      admissionDate,
    });
    // The post-validator OUTPUT becomes the working set — fields it
    // rejected are now null. The legacy validateExtractedFields() below
    // then runs over this cleaned set so it can still confidence-flag any
    // surviving Aadhaar / PIN values.
    for (const [k, v] of Object.entries(postRun.cleanedFields)) {
      cleanedFields[k] = v;
    }
    // Pre-seed validationReasons with the post-validator errors so they
    // get persisted into extraction_confidence._validation_errors.
    const validationReasons: Record<string, string> = { ...postRun.validationErrors };
    // Widened to `unknown` in v3: alongside the per-field numbers this map
    // also carries the reserved `_`-prefixed annotation channels
    // (_line_items_meta here, _validation_errors / _deterministic_facts
    // added in persistExtraction). It lands in a JSONB column, so mixed
    // value types are free.
    const finalConfidence: Record<string, unknown> = {
      ...data.per_field_confidence,
    };
    // For every post-validator rejection, also down-weight confidence so
    // the FE's ConfidenceBadge renders red without needing the FE to look
    // up _validation_errors.
    for (const k of Object.keys(postRun.validationErrors)) {
      const before = finalConfidence[k];
      finalConfidence[k] = Math.min(
        FAILED_VALIDATION_CONFIDENCE,
        typeof before === 'number' ? before : FAILED_VALIDATION_CONFIDENCE,
      );
    }

    const validationResults = validateExtractedFields(
      section.category,
      cleanedFields,
    );
    for (const [fieldKey, vr] of Object.entries(validationResults)) {
      if (!vr.valid) {
        const before = finalConfidence[fieldKey];
        finalConfidence[fieldKey] = Math.min(
          FAILED_VALIDATION_CONFIDENCE,
          typeof before === 'number' ? before : FAILED_VALIDATION_CONFIDENCE,
        );
        // Don't clobber a more-specific reason already set by the post-validators.
        if (vr.reason && !validationReasons[fieldKey]) {
          validationReasons[fieldKey] = vr.reason;
        }
        logger.warn(
          {
            sectionId,
            category: section.category,
            field: fieldKey,
            reason: vr.reason,
            value: cleanedFields[fieldKey],
            confidence_before: before,
            confidence_after: finalConfidence[fieldKey],
          },
          'docExtractor: post-extraction validation failed; confidence down-weighted',
        );
      } else if (vr.normalisedValue !== undefined) {
        // Persist the canonical form (spaces stripped, etc.) rather than
        // whatever the LLM happened to emit.
        cleanedFields[fieldKey] = vr.normalisedValue;
      }
    }

    // 11b. Line items — first-class output for itemised categories.
    //
    //      ORDERING IS LOAD-BEARING: this runs AFTER the zero-confidence
    //      sentinel-drop loop (step 10) and AFTER runPostValidators /
    //      validateExtractedFields (step 11). Both of those iterate the
    //      per-FIELD maps; line_items lives outside `data.fields`, so
    //      adding it here is the only placement where neither can strip
    //      it. Do not move this block upward.
    //
    //      dedupeLineItems is the safety net for the tile overlap — the
    //      prompt already tells the model to emit an overlapping row
    //      once, this catches the residue. checkLineItemTotals then
    //      compares the row sum against the bill's declared grand total:
    //      a mismatch is the strongest available signal that a row was
    //      dropped or an amount landed on the wrong line, which is the
    //      exact failure the tiling exists to prevent.
    let lineItems: LineItem[] = [];
    let lineItemTotals: LineItemTotalsCheck | undefined;
    if (wantsLineItems) {
      const rawItems = Array.isArray(data.line_items) ? data.line_items : [];
      // declaredTotal must be resolved BEFORE the dedupe: dedupeLineItems is
      // conditional and needs the bill's own arithmetic as its evidence. Called
      // with one argument it can never adopt the deduped set, so the overlap
      // safety net would be dead code.
      const declaredTotal = this.pickDeclaredTotal(cleanedFields);
      const deduped = dedupeLineItems(rawItems, declaredTotal);
      lineItems = deduped.items;
      lineItemTotals = checkLineItemTotals(lineItems, declaredTotal);

      if (lineItems.length > 0) {
        cleanedFields.line_items = lineItems;
      }
      finalConfidence._line_items_meta = {
        row_count: lineItemTotals.rowCount,
        totals_match: lineItemTotals.matchesDeclaredTotal,
        delta_abs: lineItemTotals.deltaAbs,
        deduped_rows: deduped.removed,
        possible_duplicate_rows: deduped.possibleDuplicates,
        tiled: anyWide,
        tile_count: tileCount,
        // WHICH WAY the page was cut, so an auditor reading a totals mismatch
        // can tell a column-strip merge failure from a row-band one. [] means
        // untiled. Same value that selected the system prompt.
        tile_axes: tileAxes,
        warnings: lineItemTotals.warnings,
      };
      if (typeof data.line_items_confidence === 'number') {
        finalConfidence.line_items = data.line_items_confidence;
      }

      logger.info(
        {
          sectionId,
          category: section.category,
          row_count: lineItemTotals.rowCount,
          deduped_rows: deduped.removed,
          possible_duplicate_rows: deduped.possibleDuplicates,
          totals_match: lineItemTotals.matchesDeclaredTotal,
          delta_abs: lineItemTotals.deltaAbs,
          tiled: anyWide,
          tile_count: tileCount,
          tile_axes: tileAxes,
        },
        lineItemTotals.matchesDeclaredTotal === false
          ? 'docExtractor: line_items sum does NOT match the declared total — possible dropped or row-shifted row'
          : 'docExtractor: extracted line_items',
      );
    }

    // 12. Persist + emit.
    await this.persistExtraction(
      sectionId,
      cleanedFields,
      finalConfidence,
      validationReasons,
      usedVision,
      deterministicFacts,
      unreadableHere.map((u) => u.pageNumber),
    );

    try {
      await this.events.dispatch({
        kind: 'section_extracted',
        claimId,
        hospitalId,
        payload: {
          section_id: sectionId,
          // section_extracted carries an extraction_id, but we don't have a
          // separate extractions table — reuse the section_id, which is
          // uniquely-keyed and stable for the lifetime of this version.
          extraction_id: sectionId,
          confidence: extractResult.confidence,
          extractor_version: EXTRACTOR_VERSION,
        },
        idempotencyKey: `section_extracted:${sectionId}:${EXTRACTOR_VERSION}`,
      });
    } catch (err) {
      logger.warn({ err, sectionId }, 'docExtractor: event dispatch failed (non-fatal)');
    }

    return {
      fields: cleanedFields,
      perFieldConfidence: data.per_field_confidence,
      costInr: extractResult.costInr,
      tierEscalated: extractResult.tierEscalated,
      ...(wantsLineItems
        ? { lineItems, lineItemTotals, usedTiling: anyWide }
        : {}),
    };
  }

  // ────────────────────────────────────────────────────────────────────────

  private async loadSection(sectionId: string): Promise<SectionRow | null> {
    // The repo's document table is `hospital.ipd_doc`. We still LEFT-JOIN
    // the legacy `hospital.hospital_documents` and the never-shipped
    // `hospital.documents` so the same query works across environments.
    const sql = `
      SELECT
        ds.id,
        ds.document_id,
        ds.page_start,
        ds.page_end,
        ds.category,
        ds.extractor_version,
        ds.extracted_fields,
        ds.extraction_confidence,
        COALESCE(id_doc.s3_key, d.s3_key, hd.s3_key) AS s3_key
      FROM hospital.document_sections ds
      LEFT JOIN hospital.ipd_doc id_doc ON id_doc.id = ds.document_id
      LEFT JOIN hospital.documents d ON d.id = ds.document_id
      LEFT JOIN hospital.hospital_documents hd ON hd.id = ds.document_id
      WHERE ds.id = $1
      LIMIT 1
    `;
    try {
      const res = await this.pool.query<SectionRow>(sql, [sectionId]);
      const row = res.rows[0];
      if (!row || !row.s3_key) return null;
      return row;
    } catch (err: any) {
      if (String(err?.code) === '42P01') {
        const fallback = await this.pool.query<SectionRow>(
          `SELECT ds.id, ds.document_id, ds.page_start, ds.page_end,
                  ds.category, ds.extractor_version, ds.extracted_fields,
                  ds.extraction_confidence, id_doc.s3_key AS s3_key
             FROM hospital.document_sections ds
             JOIN hospital.ipd_doc id_doc ON id_doc.id = ds.document_id
            WHERE ds.id = $1
            LIMIT 1`,
          [sectionId],
        );
        return fallback.rows[0] ?? null;
      }
      throw err;
    }
  }

  /**
   * Fetch the category-level extraction hint from
   * `master_options(category='doc_category', code=:category).description`.
   *
   * Returns null when no row exists (defensive — every doc_category code
   * SHOULD have a master_options row, but a partial environment might
   * not). Returns null when description is empty so the prompt doesn't
   * render an empty "Category-specific guidance" block.
   */
  private async loadCategoryHint(category: string): Promise<string | null> {
    try {
      const res = await this.pool.query<{ description: string | null }>(
        `SELECT description
           FROM hospital.master_options
          WHERE category = 'doc_category' AND code = $1
          LIMIT 1`,
        [category],
      );
      const desc = res.rows[0]?.description;
      if (!desc || desc.trim().length === 0) return null;
      return desc;
    } catch (err: any) {
      // Defensive — extraction must NOT fail because the hint couldn't
      // be loaded. Treat any error as "no hint" and continue.
      logger.warn(
        { err: err?.message ?? String(err), category },
        'docExtractor: loadCategoryHint failed; proceeding without hint',
      );
      return null;
    }
  }

  /**
   * Look up the canonical admission_date for a claim — used as the pivot
   * for the date-plausibility window validator (H3, May 2026 smoke test).
   *
   * Resolution order, falling through on null/error:
   *   1. Any sibling section's extracted_fields.admission_date (most
   *      reliable when present — comes directly from the discharge slip
   *      or admission form for THIS claim). Excludes the section we're
   *      currently extracting (it may not have run yet, or its
   *      admission_date may be the very value the date-window validator
   *      is trying to vet).
   *   2. ipds.admitted_at via claims.ipd_id (the operational truth — set
   *      by the booking workflow at IPD-admit time).
   *
   * Returns null when nothing is resolvable. The caller's window
   * validator handles null by falling back to a ±1y-from-today window.
   */
  private async loadAdmissionDate(
    claimId: string,
    excludeSectionId: string,
  ): Promise<Date | null> {
    try {
      // 1. Sibling-sections lookup. We want any section that has
      //    admission_date in its extracted_fields JSONB. ORDER BY the
      //    extractor_version desc so a freshly-re-extracted sibling
      //    wins over a stale one.
      const sib = await this.pool.query<{ admission_date: string | null }>(
        `SELECT extracted_fields->>'admission_date' AS admission_date
           FROM hospital.document_sections
          WHERE claim_id = $1
            AND id <> $2
            AND extracted_fields ? 'admission_date'
            AND extracted_fields->>'admission_date' IS NOT NULL
            AND extracted_fields->>'admission_date' <> ''
          ORDER BY updated_at DESC
          LIMIT 1`,
        [claimId, excludeSectionId],
      );
      const raw = sib.rows[0]?.admission_date;
      if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const d = new Date(raw + 'T00:00:00Z');
        if (!Number.isNaN(d.getTime())) return d;
      }
    } catch (err) {
      logger.warn(
        { err: (err as any)?.message ?? String(err), claimId },
        'docExtractor: sibling admission_date lookup failed',
      );
    }
    try {
      // 2. ipds.admitted_at — at this codebase `document_sections.claim_id`
      //    is actually the IPD id (the `claims` table has no `id` column,
      //    only ipd_id as FK). So we look up ipds directly.
      const ipd = await this.pool.query<{ admitted_at: Date | null }>(
        `SELECT i.admitted_at
           FROM hospital.ipds i
          WHERE i.id = $1
          LIMIT 1`,
        [claimId],
      );
      const at = ipd.rows[0]?.admitted_at;
      if (at instanceof Date && !Number.isNaN(at.getTime())) return at;
      if (typeof at === 'string') {
        const d = new Date(at);
        if (!Number.isNaN(d.getTime())) return d;
      }
    } catch (err) {
      logger.warn(
        { err: (err as any)?.message ?? String(err), claimId },
        'docExtractor: ipds.admitted_at lookup failed',
      );
    }
    return null;
  }

  /**
   * Fetch `master_options.extraction_mode` for the doc_category code.
   * Returns one of: 'ocr', 'vision', 'auto'. Migration 050 seeded
   * vision/auto values for categories Tesseract struggles with
   * (handwritten notes, X-rays, OT notes, etc.).
   *
   * v3 VISION-FIRST FLIP: a category with NO seeded value (the vast
   * majority — migration 050 only covered a handful) used to fall back to
   * 'ocr'. It now falls back to defaultExtractionMode(), which is 'vision'
   * unless DOC_EXTRACT_DEFAULT_MODE says otherwise. An explicit
   * master_options value still wins, in both directions: a category
   * deliberately seeded 'ocr' stays on Tesseract.
   *
   * Setting DOC_EXTRACT_DEFAULT_MODE=ocr reverts the flip fleet-wide with
   * no deploy — including the per-page Anthropic calls inside ocr.service,
   * which that flag now also switches off (see defaultExtractionMode above).
   * A category seeded 'ocr' explicitly is NOT affected by the flag and keeps
   * whatever engine ocr.service resolves for it.
   */
  private async loadExtractionMode(
    category: string,
  ): Promise<'ocr' | 'vision' | 'auto'> {
    try {
      const res = await this.pool.query<{ extraction_mode: string | null }>(
        `SELECT extraction_mode
           FROM hospital.master_options
          WHERE category = 'doc_category' AND code = $1
          LIMIT 1`,
        [category],
      );
      const v = res.rows[0]?.extraction_mode;
      if (v === 'vision' || v === 'auto' || v === 'ocr') return v;
      return defaultExtractionMode();
    } catch (err) {
      // Column may not exist in older test schemas — fall back to the
      // configured default so extraction still runs.
      const fallback = defaultExtractionMode();
      logger.warn(
        { err: (err as any)?.message ?? String(err), category, fallback },
        'docExtractor: loadExtractionMode failed; using default extraction mode',
      );
      return fallback;
    }
  }

  /**
   * Total TILES sent across every prepared page (excludes the overview
   * images). 0 means nothing was tiled — every page went as a single
   * fitted image. Recorded into _line_items_meta.tile_count so an auditor
   * can tell a row-shift on a tiled read from one on a single-image read.
   */
  private countTiles(pages: readonly TiledPage[]): number {
    let n = 0;
    for (const p of pages) {
      for (const img of p.images) {
        if (img.role === 'tile') n++;
      }
    }
    return n;
  }

  /**
   * Pull the bill's declared grand total out of the extracted fields so
   * checkLineItemTotals has something to cross-check the row sum against.
   * Field naming varies by category schema, so we try the known keys in
   * priority order and take the first that parses to a finite number.
   * Returns null when the category has no total field (the check then
   * reports matchesDeclaredTotal=null rather than a false mismatch).
   */
  private pickDeclaredTotal(fields: Record<string, unknown>): number | null {
    const CANDIDATES = [
      'total_amount',
      'net_payable',
      'bill_amount',
      'payable_amount',
    ] as const;
    for (const key of CANDIDATES) {
      const raw = fields[key];
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string') {
        // Same coercion the 'money' field type applies — the value may
        // still be a raw string if the category typed it as text.
        const cleaned = raw.replace(/[,₹\sRs\.]/gi, '').replace(/[^\d\.-]/g, '');
        const n = Number(cleaned);
        if (cleaned !== '' && Number.isFinite(n)) return n;
      }
    }
    return null;
  }

  /**
   * Build the images for a vision call.
   *
   * v3: this is now a thin wrapper over prepareVisionInput() in
   * extractor/visionRead.ts, which owns the whole render→deskew→tile
   * pipeline. What changed and why:
   *
   *   - The old code rendered every PDF page at a FIXED viewportScale of
   *     2.0 and emitted exactly ONE image per page. On an A4 portrait
   *     page that is 1190x1684px; on a landscape itemised bill it is
   *     wider still. Anthropic downsizes any image whose long edge
   *     exceeds 1568px to ~1.15MP — so the single most detail-critical
   *     document we handle was arriving at the model already blurred,
   *     which is what row-shifted the money column onto the wrong line
   *     item (docs/proposals/EXTRACTION_LANDSCAPE_FIX.md §3).
   *   - prepareVisionInput picks the render scale from the page's actual
   *     aspect (short edge ~1500px for a wide page), deskews the small
   *     1-2 degree tilt a phone scan introduces, and returns a downscaled
   *     OVERVIEW image followed by FULL-RESOLUTION OVERLAPPING horizontal
   *     tiles — each under the 1568px ceiling, so none is downsized.
   *
   * Never throws: prepareVisionInput returns an empty result plus a
   * warning on failure, and the caller falls back to the text path.
   *
   * maybeDownscaleForVision is still applied to every attachment as a
   * belt-and-braces guard against the 5MB-per-image API limit. Tiles come
   * back well under that, so in practice it is now a no-op — it stays for
   * the single-image path (an untiled 5.7MB source photo, the Jain
   * smoke-test failure from May 2026).
   */
  private async buildVisionAttachments(
    sourceBytes: Buffer,
    isImage: boolean,
    s3Key: string,
    pageStart: number,
    pageEnd: number,
  ): Promise<{
    attachments: import('./llm/LlmClient.js').LlmAttachment[];
    layoutContext: string;
    anyWide: boolean;
    pages: TiledPage[];
    /**
     * Which way the tiler cut each page ('x' = vertical column strips,
     * 'y' = horizontal row bands, empty = untiled). Derived from the SAME
     * measurement that produced layoutContext, so the system prompt and the
     * user prompt cannot disagree about the geometry.
     */
    tileAxes: VisionTileAxis[];
  }> {
    const prepared = await this.visionInput({
      source: sourceBytes,
      kind: isImage ? 'image' : 'pdf',
      // Page range applies to PDFs only; prepareVisionInput ignores it
      // for an image buffer.
      pageStart,
      pageEnd,
      maxPages: MAX_VISION_PAGES,
    });

    if (prepared.warnings.length > 0) {
      logger.warn(
        {
          s3Key,
          pageStart,
          pageEnd,
          warnings: prepared.warnings,
          total_images: prepared.totalImages,
        },
        'docExtractor: prepareVisionInput reported warnings',
      );
    }
    if (prepared.attachments.length === 0) {
      logger.warn(
        { s3Key, pageStart, pageEnd },
        'docExtractor: vision attachment build produced no images; proceeding text-only',
      );
      return {
        attachments: [],
        layoutContext: '',
        anyWide: false,
        pages: [],
        tileAxes: [],
      };
    }

    const attachments: import('./llm/LlmClient.js').LlmAttachment[] = [];
    for (const a of prepared.attachments) {
      const safe = await this.maybeDownscaleForVision(
        Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data as any),
        a.mime,
      );
      attachments.push({ kind: 'image', data: safe.bytes, mime: safe.mime });
    }

    logger.debug(
      {
        s3Key,
        pageStart,
        pageEnd,
        pages: prepared.pages.length,
        images: attachments.length,
        any_wide: prepared.anyWide,
      },
      'docExtractor: built vision attachments (overview + tiles)',
    );

    return {
      attachments,
      layoutContext: prepared.layoutContext,
      anyWide: prepared.anyWide,
      pages: prepared.pages,
      tileAxes: prepared.tileAxes ?? [],
    };
  }

  /**
   * Fix 2 helper — Anthropic vision API rejects any single image over
   * 5MB with HTTP 400. We aim for ≤4MB to leave headroom for the
   * base64 expansion overhead (~33%) the SDK applies when serialising.
   *
   * Strategy:
   *   1. If buffer is already ≤4MB, return unchanged (most common case).
   *   2. Use sharp to resize the longest dimension down to 2048px,
   *      preserving aspect ratio. Re-encodes as JPEG at quality 85
   *      (smallest viable for medical scans without losing OCR-able
   *      detail). This typically brings a 6MB image down to 400-800KB.
   *   3. If sharp isn't available or the resize fails, return original
   *      bytes and log — the LLM call will fail downstream, but we
   *      don't crash the extractor.
   *
   * Mime returned may change from input (e.g. PNG → JPEG after resize).
   * Caller propagates the new mime through to the Anthropic attachment.
   */
  private async maybeDownscaleForVision(
    bytes: Buffer,
    mime: string,
  ): Promise<{ bytes: Buffer; mime: string }> {
    const MAX_SAFE_BYTES = 4 * 1024 * 1024; // 4MB target, well under 5MB API hard limit
    if (bytes.length <= MAX_SAFE_BYTES) {
      return { bytes, mime };
    }
    try {
      const sharpMod: any = await import('sharp');
      const sharp = sharpMod?.default ?? sharpMod;
      // Resize longest dimension to 2048px; JPEG q=85 is the sweet spot
      // for handwritten document OCR (tested against medical scans).
      const resized = await sharp(bytes)
        .rotate() // honour EXIF orientation tag
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85, progressive: true })
        .toBuffer();
      logger.info(
        {
          before_bytes: bytes.length,
          after_bytes: resized.length,
          original_mime: mime,
        },
        'docExtractor: downscaled vision attachment to fit 5MB API limit',
      );
      return { bytes: resized, mime: 'image/jpeg' };
    } catch (err) {
      logger.warn(
        {
          err: (err as any)?.message ?? String(err),
          bytes_length: bytes.length,
        },
        'docExtractor: downscale failed; sending oversized image (Anthropic may reject with 400)',
      );
      return { bytes, mime };
    }
  }

  /** Mirror of isImageBuffer but returns a mime string. */
  private sniffImageMime(buf: Buffer): string | null {
    if (buf.length < 4) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
      return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) return 'image/tiff';
    if (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00) return 'image/tiff';
    // WebP — isImageBuffer above already recognises this; without the
    // matching mime here, Claude vision attachments fell back to
    // 'image/jpeg' which works for some images but isn't honest. Keep
    // the two sniffers in sync.
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) return 'image/webp';
    return null;
  }

  private async loadFieldSchema(category: string): Promise<FieldSchemaRow[]> {
    // Latest schema_version wins. Newer rows can co-exist with older ones
    // at the same (doc_category, field_key) — we pick the MAX version
    // across all field_keys for the category and pull the rows at that
    // version. NB: this assumes schema_version is bumped consistently
    // across all fields when the category schema changes; the seed
    // migrations satisfy that.
    const res = await this.pool.query<FieldSchemaRow>(
      `WITH latest AS (
         SELECT MAX(schema_version) AS v
           FROM hospital.document_field_schemas
          WHERE doc_category = $1
       )
       SELECT field_key, field_label, field_type, is_required,
              enum_values, reference_category, extraction_priority, schema_version
         FROM hospital.document_field_schemas
        WHERE doc_category = $1
          AND schema_version = (SELECT v FROM latest)
        ORDER BY extraction_priority, field_key`,
      [category],
    );
    return res.rows;
  }

  /** Magic-byte sniff. Mirrors the segmenter + classifier image fast-path. */
  private isImageBuffer(buf: Buffer): boolean {
    if (!buf || buf.length < 4) return false;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
    if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
        (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) return true;
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
    if (buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
    return false;
  }

  private async fetchAndSlicePdf(
    s3Key: string,
    pageStart: number,
    pageEnd: number,
  ): Promise<Buffer> {
    const fullPdf = await this.s3.download(s3Key);
    const { PDFDocument } = await import('pdf-lib');
    const src = await PDFDocument.load(fullPdf);
    const total = src.getPageCount();
    const start = Math.max(1, Math.min(pageStart, total));
    const end = Math.max(start, Math.min(pageEnd, total));
    const dst = await PDFDocument.create();
    const indices: number[] = [];
    for (let i = start - 1; i <= end - 1; i++) indices.push(i);
    const copied = await dst.copyPages(src, indices);
    for (const p of copied) dst.addPage(p);
    const bytes = await dst.save();
    return Buffer.from(bytes);
  }

  /**
   * Join the per-page OCR text under the ceiling appropriate to the path.
   *
   * `truncate` is TRUE on the text-only path, where the OCR dump is the
   * model's only view of the document and SECTION_TEXT_MAX_CHARS (24k) caps
   * the token bill.
   *
   * FALSE means the VISION path, where the IMAGES are the source of truth and
   * the text is a secondary hint: clipping at 24k silently removed the tail of
   * every wide itemised bill, so that ceiling is RAISED to
   * VISION_SECTION_TEXT_MAX_CHARS (100k) — not removed. Removing it entirely
   * let an unbounded OCR dump ride along with the images on a path that
   * escalates on a single Devanagari character.
   */
  private joinText(pages: string[], truncate: boolean): string {
    const joined = pages.join('\n\n--- page break ---\n\n').trim();
    const ceiling = truncate
      ? SECTION_TEXT_MAX_CHARS
      : VISION_SECTION_TEXT_MAX_CHARS;
    if (joined.length <= ceiling) return joined;
    return joined.slice(0, ceiling) + '\n... [truncated]';
  }

  // ══════════════════════════════════════════════════════════════════════
  // §C.3.4 — unreadable-page plumbing
  // ══════════════════════════════════════════════════════════════════════

  /**
   * A slice handed to OCR is re-paginated from 1, so its page numbers are
   * local. Map them back to the PARENT document's numbering: that is the
   * numbering every section boundary, every operator's PDF viewer and the
   * end-of-run summary speak.
   */
  private mapSliceUnreadables(
    ocr: OcrResult,
    parentPageStart: number,
  ): ReturnType<typeof unreadablePagesOf> {
    return unreadablePagesOf(ocr).map((u) => ({
      ...u,
      pageNumber: parentPageStart + (u.pageNumber - 1),
    }));
  }

  /**
   * The id of the claim's run, when one is genuinely in flight.
   *
   * Returns null for a terminal, superseded or paused run: attributing a read
   * to a run that is not running would put its spend against a budget nobody
   * is watching, and — for a paused run — hand the OCR pump a stop hook that
   * fires immediately on work that should not have started at all.
   */
  private async resolveActiveRunId(claimId: string): Promise<string | null> {
    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claimId);
      if (!run) return null;
      return run.status === 'queued' || run.status === 'running' ? run.id : null;
    } catch {
      return null;
    }
  }

  /**
   * What earlier phases already established about this section's pages,
   * as page_number -> reason. Empty when there is no run cursor.
   */
  private async loadPriorUnreadable(
    claimId: string,
    documentId: string,
    pageStart: number,
    pageEnd: number,
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claimId);
      if (!run) return out;
      const r = await this.pool.query<{ page_number: number; reason: string }>(
        `SELECT page_number, reason
           FROM hospital.claim_ai_unreadable_pages
          WHERE run_id = $1 AND doc_id = $2
            AND page_number BETWEEN $3 AND $4`,
        [run.id, documentId, pageStart, pageEnd],
      );
      for (const row of r.rows) out.set(Number(row.page_number), row.reason);
    } catch (err) {
      // Pre-076 DB or a transient read failure. Falling through means we do
      // the extraction we would have done before this feature existed —
      // the safe direction to be wrong in.
      logger.debug(
        { err, claimId, documentId },
        'docExtractor: prior-unreadable lookup failed (continuing)',
      );
    }
    return out;
  }

  private async recordSectionUnreadables(
    claimId: string,
    documentId: string,
    sectionId: string,
    pages: ReturnType<typeof unreadablePagesOf>,
  ): Promise<void> {
    if (pages.length === 0) return;
    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claimId);
      if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
      await persistUnreadablePages({
        run_id: run.id,
        doc_id: documentId,
        section_id: sectionId,
        phase: 'extract',
        pages,
      });
    } catch (err) {
      logger.debug(
        { err, sectionId },
        'docExtractor: unreadable persist failed (non-fatal)',
      );
    }
  }

  /** §C.3.4 rule 4 — the page rendered after all; drop the marker. */
  private async clearRenderedUnreadables(
    claimId: string,
    documentId: string,
    pageNumbers: number[],
  ): Promise<void> {
    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claimId);
      if (!run) return;
      await clearUnreadablePages(run.id, documentId, pageNumbers);
      logger.info(
        { claimId, documentId, pages: pageNumbers },
        'docExtractor: pages previously marked render_failed rendered successfully — markers cleared',
      );
    } catch (err) {
      logger.debug({ err, documentId }, 'docExtractor: marker clear failed');
    }
  }

  /**
   * THE SETTLED-SKIP SHAPE (§C.3.3 / §C.3.4 rule 1), mirroring the existing
   * no_field_schema return exactly.
   *
   * extracted_fields='{}' is NOT NULL, which is what makes the run aggregator
   * count this section as settled — so the doc completes and the run can
   * reach a terminal state. Leaving it NULL would make the section invisible
   * to every reconciliation path and the run would never finish.
   */
  private async stampUnreadableSection(
    sectionId: string,
    pageNumbers: number[],
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE hospital.document_sections
            SET extractor_version     = $2,
                extractor_provider    = 'system',
                extractor_model       = 'unreadable',
                extracted_fields      = COALESCE(extracted_fields, '{}'::jsonb),
                extraction_confidence = COALESCE(
                  extraction_confidence,
                  $3::jsonb
                ),
                status                = 'needs_review',
                updated_at            = NOW()
          WHERE id = $1`,
        [
          sectionId,
          EXTRACTOR_VERSION,
          JSON.stringify({
            _meta: {
              skipped: 'unreadable_pages',
              unreadable_pages: [...pageNumbers].sort((a, b) => a - b),
            },
          }),
        ],
      );
    } catch (err) {
      logger.warn(
        { err, sectionId },
        'docExtractor: failed to stamp unreadable section (the run may not settle)',
      );
    }
  }

  /**
   * The run's approved budget is spent. Park this phase and pause the run.
   * Returns without throwing — see the call site for why a throw here would
   * dead-letter a run that is deliberately waiting on a person.
   */
  private async pauseRunForConsent(
    claimId: string,
    documentId: string,
    sectionId: string,
  ): Promise<void> {
    try {
      const { default: claimAiRunService } = await import('./claimAiRun.service.js');
      const run = await claimAiRunService.getLatestRun(claimId);
      if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
      const spend = await claimAiRunService
        .getRunSpend(run)
        .catch(() => ({ totalInr: 0 }) as any);
      const remaining = await claimAiRunService
        .computeProjectedRemainingInr(run)
        .catch(() => 0);
      await claimAiRunService.pauseForConsent({
        run_id: run.id,
        claim_id: claimId,
        spend_inr: spend.totalInr ?? 0,
        projected_remaining_inr: remaining,
      });
      const { default: ledger } = await import('./docPhaseLedger.service.js');
      await ledger
        .blockPhase(documentId, run.id, 'extract', 'run_budget_exhausted')
        .catch(() => {});
      logger.warn(
        { claimId, documentId, sectionId, run_id: run.id },
        'docExtractor: run budget exhausted — run paused for consent, extract phase blocked',
      );
    } catch (err) {
      logger.error(
        { err, claimId, sectionId },
        'docExtractor: pauseForConsent failed — the run may keep spending; investigate',
      );
    }
  }

  private async persistExtraction(
    sectionId: string,
    fields: Record<string, unknown>,
    perFieldConfidence: Record<string, unknown>,
    validationReasons: Record<string, string> = {},
    usedVision = false,
    deterministicFacts?: DeterministicFacts,
    /**
     * §C.3.4 rule 2 — the pages of this section that could not be read.
     * Recorded in extraction_confidence._meta.unreadable_pages so the UI can
     * say "extracted from 3 of 5 pages" rather than presenting a partial bill
     * as complete. A line_items total mismatch on such a section is EXPECTED
     * and must not be reported as a data-quality defect.
     */
    unreadablePageNumbers: number[] = [],
  ): Promise<void> {
    // Honour per-field human corrections. The /document-sections/:id/fields/:key
    // endpoint stamps `_corrected_fields: [field_key, ...]` into
    // extraction_confidence whenever a reviewer overrides a value. On
    // a forced re-run the LLM produces a fresh extraction for the whole
    // section; without this guard we'd silently overwrite the human's
    // canonical values. We READ the existing row's _corrected_fields
    // here (instead of taking it as a parameter) so this guard works
    // regardless of who triggered the extraction.
    const existing = await this.pool.query<{
      extracted_fields: Record<string, any> | null;
      extraction_confidence: Record<string, any> | null;
    }>(
      `SELECT extracted_fields, extraction_confidence
         FROM hospital.document_sections
        WHERE id = $1`,
      [sectionId],
    );
    const prev = existing.rows[0];
    const correctedList: string[] = Array.isArray(
      prev?.extraction_confidence?._corrected_fields,
    )
      ? (prev!.extraction_confidence!._corrected_fields as string[])
      : [];
    const prevFields = prev?.extracted_fields ?? {};
    const prevConfidence = prev?.extraction_confidence ?? {};

    // Merge: LLM output first, then human-corrected values overwrite.
    const mergedFields: Record<string, unknown> = { ...fields };
    const mergedConfidence: Record<string, unknown> = { ...perFieldConfidence };
    for (const k of correctedList) {
      if (prevFields[k] !== undefined) {
        mergedFields[k] = prevFields[k];
        // Human is canonical → confidence stays 1.0; also strip any
        // newly-produced validation error for this field.
        mergedConfidence[k] = 1.0;
        if (
          mergedConfidence._validation_errors &&
          typeof mergedConfidence._validation_errors === 'object'
        ) {
          const errs = { ...(mergedConfidence._validation_errors as any) };
          delete errs[k];
          if (Object.keys(errs).length === 0) {
            delete mergedConfidence._validation_errors;
          } else {
            mergedConfidence._validation_errors = errs;
          }
        }
        logger.debug(
          { sectionId, field: k },
          'docExtractor: preserved human-corrected field on re-run',
        );
      }
    }
    if (correctedList.length > 0) {
      mergedConfidence._corrected_fields = correctedList;
    }

    // §C.3.4 rule 2 — say, on the row itself, that this extraction is
    // partial. Downstream (the FE, and any totals cross-check) can then
    // distinguish "this bill's lines do not add up" from "we only read some
    // of this bill's pages", which are different defects with different fixes.
    if (unreadablePageNumbers.length > 0) {
      const meta = (mergedConfidence._meta as Record<string, unknown>) ?? {};
      mergedConfidence._meta = {
        ...meta,
        unreadable_pages: [...unreadablePageNumbers].sort((a, b) => a - b),
        partial_extraction: true,
      };
      const warnings = Array.isArray(mergedConfidence._warnings)
        ? (mergedConfidence._warnings as string[])
        : [];
      if (!warnings.includes('unreadable_pages')) warnings.push('unreadable_pages');
      mergedConfidence._warnings = warnings;
    }

    // Validation reasons are folded into extraction_confidence under a
    // reserved `_validation_errors` key. The column is JSONB so this is
    // a free annotation channel — FE consumers that want it can read
    // it, the rest happily ignore the extra key (Zod schemas on the FE
    // are .passthrough()-y). Storing in a separate column would mean a
    // migration just to surface a per-field reason string.
    if (Object.keys(validationReasons).length > 0) {
      // Filter out reasons for fields the human has already corrected
      // (we trust the human; running validators on corrected values
      // would be confusing).
      const filteredReasons: Record<string, string> = {};
      for (const [k, v] of Object.entries(validationReasons)) {
        if (!correctedList.includes(k)) filteredReasons[k] = v;
      }
      if (Object.keys(filteredReasons).length > 0) {
        const existingErrors =
          (mergedConfidence._validation_errors as Record<string, string>) ?? {};
        mergedConfidence._validation_errors = {
          ...existingErrors,
          ...filteredReasons,
        };
      }
    }

    // Persist the regex-derived facts on a reserved key alongside the
    // other _-prefixed channels (_validation_errors, _corrected_fields,
    // _meta). Downstream consumers (harmoniser, audit, FE) read these
    // as high-confidence ground truth. Only emit the key when at least
    // one fact was found — keeps the JSONB compact for sections that
    // had no regex hits.
    if (deterministicFacts) {
      const anyFacts =
        deterministicFacts.doctor_nmc_ids.length > 0 ||
        deterministicFacts.aadhaar_numbers.length > 0 ||
        deterministicFacts.pmjay_ids.length > 0 ||
        deterministicFacts.abha_numbers.length > 0 ||
        deterministicFacts.mobile_numbers.length > 0 ||
        deterministicFacts.dates.length > 0 ||
        deterministicFacts.currency_amounts.length > 0;
      if (anyFacts) {
        mergedConfidence._deterministic_facts = deterministicFacts;
      }
    }

    // Stamp extractor_model='vision' when we routed through Claude
    // vision so the FE / audit can tell at a glance which sections paid
    // the vision premium vs the cheap OCR path. extractor_provider stays
    // 'claude' since the model family is the same.
    const modelMarker = usedVision ? 'vision' : 'standard';
    const sql = `
      UPDATE hospital.document_sections
         SET extracted_fields = $2::jsonb,
             extraction_confidence = $3::jsonb,
             extractor_provider = 'claude',
             extractor_model = $5,
             extractor_version = $4,
             updated_at = NOW()
       WHERE id = $1
    `;
    const res = await this.pool.query(sql, [
      sectionId,
      JSON.stringify(mergedFields),
      JSON.stringify(mergedConfidence),
      EXTRACTOR_VERSION,
      modelMarker,
    ]);
    // Suppress lint warning — prevConfidence is read above for the guard
    // logic; we don't use it again.
    void prevConfidence;
    if ((res.rowCount ?? 0) === 0) {
      throw new Error(`docExtractor: UPDATE returned no row for section ${sectionId}`);
    }
  }
}

let _singleton: DocExtractorService | null = null;
const docExtractorService = {
  extractSection: (input: ExtractSectionInput) => {
    if (!_singleton) _singleton = new DocExtractorService();
    return _singleton.extractSection(input);
  },
};
export default docExtractorService;
