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
import defaultOcrService from './ocr.service.js';
import costAccountingService from './costAccounting.service.js';
import { eventDispatcher as defaultEventDispatcher } from './events/eventDispatcher.service.js';
import { getLlmClient } from './llm/factory.js';
import { LlmBudgetExceededError, LlmSchemaValidationError } from './llm/LlmClient.js';
import {
  DOC_EXTRACTOR_GENERIC_SYSTEM_PROMPT,
  buildDocExtractorUserPrompt,
  EXTRACTOR_PROMPT_VERSION,
  type ExtractorFieldDescriptor,
} from './llm/prompts/docExtractor.generic.v1.js';

/**
 * Bumped whenever the prompt OR the dynamic-Zod-generation logic changes
 * in a way that would change extraction output for the same input.
 */
export const EXTRACTOR_VERSION = 'v1';

const SECTION_TEXT_MAX_CHARS = 24_000; // ≈ 6k tokens — extractor needs body, not just heading.

export interface ExtractSectionInput {
  sectionId: string;
  claimId: string;
  hospitalId: string;
}

export interface ExtractSectionResult {
  fields: Record<string, unknown>;
  perFieldConfidence: Record<string, number>;
  costInr: number;
  tierEscalated: boolean;
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
      // ISO YYYY-MM-DD. The prompt explicitly tells the model to normalise
      // to this format; a non-matching value fails validation rather than
      // silently accepting "12/05/2026" and confusing downstream consumers.
      base = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
      break;
    case 'number':
      base = z.number();
      break;
    case 'money':
      base = z.number().nonnegative();
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
  // Required-or-optional wrap. Optional fields use .optional() so they
  // can be omitted entirely from the LLM payload — the prompt instructs
  // the model to omit (NOT null-out) missing optionals.
  return row.is_required ? base : base.optional();
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
  return z.object({
    fields: z.object(fieldShape),
    per_field_confidence: z.record(z.string(), z.number().min(0).max(1)),
    confidence: z.number().min(0).max(1).optional(),
  });
}

export interface DocExtractorDeps {
  pool?: Pick<Pool, 'query'>;
  llm?: ReturnType<typeof getLlmClient>;
  s3?: Pick<typeof defaultS3Service, 'download'>;
  ocr?: Pick<typeof defaultOcrService, 'extractTextFromPdf'>;
  events?: Pick<typeof defaultEventDispatcher, 'dispatch'>;
  costAccounting?: Pick<typeof costAccountingService, 'checkBudget'>;
}

export class DocExtractorService {
  private readonly pool: Pick<Pool, 'query'>;
  private readonly llm: ReturnType<typeof getLlmClient>;
  private readonly s3: Pick<typeof defaultS3Service, 'download'>;
  private readonly ocr: Pick<typeof defaultOcrService, 'extractTextFromPdf'>;
  private readonly events: Pick<typeof defaultEventDispatcher, 'dispatch'>;
  private readonly costAccounting: Pick<typeof costAccountingService, 'checkBudget'>;

  constructor(deps: DocExtractorDeps = {}) {
    this.pool = deps.pool ?? defaultPool;
    this.llm = deps.llm ?? getLlmClient();
    this.s3 = deps.s3 ?? defaultS3Service;
    this.ocr = deps.ocr ?? defaultOcrService;
    this.events = deps.events ?? defaultEventDispatcher;
    this.costAccounting = deps.costAccounting ?? costAccountingService;
  }

  async extractSection(input: ExtractSectionInput): Promise<ExtractSectionResult> {
    const { sectionId, claimId, hospitalId } = input;

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

    // 2. Idempotency.
    if (
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
    const verdict = await this.costAccounting.checkBudget(claimId, hospitalId);
    if (verdict.action === 'block') {
      throw new LlmBudgetExceededError(
        verdict.claimUnderLimit ? 'hospital_daily' : 'claim',
        verdict.claimUnderLimit
          ? (verdict.hospitalDailySpendInr ?? 0)
          : (verdict.claimSpendInr ?? 0),
        verdict.claimUnderLimit
          ? (verdict.hospitalDailyCapInr ?? 0)
          : 15,
        { claimId, hospitalId },
      );
    }

    // 4. Load the field schema rows for this category at the latest
    //    schema_version. If a category has no rows yet (e.g. one of the
    //    new categories that hasn't been seeded), throw — extraction
    //    without a schema is meaningless.
    const fieldRows = await this.loadFieldSchema(section.category);
    if (fieldRows.length === 0) {
      throw new Error(
        `docExtractor: no document_field_schemas rows for category '${section.category}' — add seed rows before re-enqueuing`,
      );
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

    // 6. Re-OCR the section's pages. Same approach as classifier; see the
    //    rationale comment in docClassifier.service.ts.
    const slicedPdf = await this.fetchAndSlicePdf(
      section.s3_key,
      section.page_start,
      section.page_end,
    );
    const ocr = await this.ocr.extractTextFromPdf(slicedPdf);
    const sectionText = this.joinAndTruncate(ocr.pages.map((p) => p.text));
    const pagesContext = `Section spans pages ${section.page_start}-${section.page_end} of the parent document (this slice is ${ocr.totalPages} page${ocr.totalPages === 1 ? '' : 's'}, avg OCR confidence ${ocr.avgConfidence.toFixed(2)}).`;

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

    // 8. Cache key — section text + extractor version + category. The
    //    category goes in because the same text might (in degenerate
    //    cases) be re-classified into a different category, and we want
    //    a fresh extraction in that case.
    const cacheKey = createHash('sha256')
      .update(sectionText)
      .update('::')
      .update(EXTRACTOR_VERSION)
      .update('::')
      .update(section.category)
      .digest('hex');

    // 9. Call the LLM bridge. extract() validates against the Zod schema
    //    and throws LlmSchemaValidationError on a malformed model
    //    response. Catch that one specifically so we can surface a
    //    structured error with the section context.
    let extractResult;
    try {
      extractResult = await this.llm.extract({
        systemPrompt: DOC_EXTRACTOR_GENERIC_SYSTEM_PROMPT,
        userPrompt: buildDocExtractorUserPrompt({
          category: section.category,
          fields: fieldDescriptors,
          sectionText,
          pagesContext,
        }),
        schema: payloadSchema,
        cacheKey,
        promptVersion: EXTRACTOR_PROMPT_VERSION,
        taskName: `doc_extract.${section.category}`,
        tier: 'standard',
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

    const data = extractResult.data as {
      fields: Record<string, unknown>;
      per_field_confidence: Record<string, number>;
      confidence?: number;
    };

    // 10. Persist + emit.
    await this.persistExtraction(
      sectionId,
      data.fields,
      data.per_field_confidence,
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
      fields: data.fields,
      perFieldConfidence: data.per_field_confidence,
      costInr: extractResult.costInr,
      tierEscalated: extractResult.tierEscalated,
    };
  }

  // ────────────────────────────────────────────────────────────────────────

  private async loadSection(sectionId: string): Promise<SectionRow | null> {
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
        COALESCE(d.s3_key, hd.s3_key) AS s3_key
      FROM hospital.document_sections ds
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
                  ds.extraction_confidence, hd.s3_key AS s3_key
             FROM hospital.document_sections ds
             JOIN hospital.hospital_documents hd ON hd.id = ds.document_id
            WHERE ds.id = $1
            LIMIT 1`,
          [sectionId],
        );
        return fallback.rows[0] ?? null;
      }
      throw err;
    }
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

  private joinAndTruncate(pages: string[]): string {
    const joined = pages.join('\n\n--- page break ---\n\n').trim();
    if (joined.length <= SECTION_TEXT_MAX_CHARS) return joined;
    return joined.slice(0, SECTION_TEXT_MAX_CHARS) + '\n... [truncated]';
  }

  private async persistExtraction(
    sectionId: string,
    fields: Record<string, unknown>,
    perFieldConfidence: Record<string, number>,
  ): Promise<void> {
    const sql = `
      UPDATE hospital.document_sections
         SET extracted_fields = $2::jsonb,
             extraction_confidence = $3::jsonb,
             extractor_provider = 'claude',
             extractor_model = 'standard',
             extractor_version = $4,
             updated_at = NOW()
       WHERE id = $1
    `;
    const res = await this.pool.query(sql, [
      sectionId,
      JSON.stringify(fields),
      JSON.stringify(perFieldConfidence),
      EXTRACTOR_VERSION,
    ]);
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
