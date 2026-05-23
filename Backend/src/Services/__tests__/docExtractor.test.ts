/**
 * Tests for DocExtractorService (Wave 2B).
 *
 * The interesting surface here is the runtime Zod schema generation from
 * hospital.document_field_schemas rows. We cover:
 *   - Every supported field_type maps to the correct Zod shape.
 *   - is_required flips between bare and .optional() wrapping.
 *   - Malformed/empty enum_values gracefully fall back to z.string().
 *   - Unknown field_type throws a structured error.
 *   - End-to-end happy path with a small synthetic schema.
 *   - Budget block fires before LLM is called.
 *   - The extractor refuses to run on a section without a category.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { z, ZodError } from 'zod';

import {
  DocExtractorService,
  EXTRACTOR_VERSION,
  fieldRowToZod,
  buildPayloadSchema,
} from '../docExtractor.service.js';
import { LlmBudgetExceededError } from '../llm/LlmClient.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const SECTION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLAIM_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const HOSPITAL_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DOCUMENT_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const S3_KEY = 'hosp/panel/patient/discharge_slip/123_xyz.pdf';

interface FieldRow {
  field_key: string;
  field_label: string;
  field_type: string;
  is_required: boolean;
  enum_values: unknown;
  reference_category: string | null;
  extraction_priority: number;
  schema_version: number;
}

const DISCHARGE_SLIP_FIELDS: FieldRow[] = [
  {
    field_key: 'admission_date',
    field_label: 'Admission Date',
    field_type: 'date',
    is_required: true,
    enum_values: null,
    reference_category: null,
    extraction_priority: 10,
    schema_version: 1,
  },
  {
    field_key: 'discharge_date',
    field_label: 'Discharge Date',
    field_type: 'date',
    is_required: true,
    enum_values: null,
    reference_category: null,
    extraction_priority: 20,
    schema_version: 1,
  },
  {
    field_key: 'primary_diagnosis',
    field_label: 'Primary Diagnosis',
    field_type: 'text',
    is_required: true,
    enum_values: null,
    reference_category: null,
    extraction_priority: 30,
    schema_version: 1,
  },
  {
    field_key: 'treating_doctor',
    field_label: 'Treating Doctor',
    field_type: 'text',
    is_required: false,
    enum_values: null,
    reference_category: null,
    extraction_priority: 40,
    schema_version: 1,
  },
  {
    field_key: 'room_category',
    field_label: 'Room Category',
    field_type: 'enum',
    is_required: false,
    enum_values: ['general', 'semi_private', 'private', 'icu', 'iccu', 'nicu'],
    reference_category: null,
    extraction_priority: 50,
    schema_version: 1,
  },
  {
    field_key: 'total_amount',
    field_label: 'Total Amount',
    field_type: 'money',
    is_required: false,
    enum_values: null,
    reference_category: null,
    extraction_priority: 60,
    schema_version: 1,
  },
];

function makeMockPool(opts: {
  sectionRow?: Record<string, unknown> | null;
  fieldRows?: FieldRow[];
  updateRowCount?: number;
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const trimmed = sql.trim();
      if (/FROM hospital\.document_sections ds/i.test(trimmed) && /SELECT/i.test(trimmed)) {
        if (opts.sectionRow === null) return { rows: [], rowCount: 0 };
        const row = opts.sectionRow ?? {
          id: SECTION_ID,
          document_id: DOCUMENT_ID,
          page_start: 1,
          page_end: 2,
          category: 'discharge_slip',
          extractor_version: null,
          extracted_fields: null,
          extraction_confidence: null,
          s3_key: S3_KEY,
        };
        return { rows: [row], rowCount: 1 };
      }
      if (/FROM hospital\.document_field_schemas/i.test(trimmed)) {
        const rows = opts.fieldRows ?? DISCHARGE_SLIP_FIELDS;
        return { rows, rowCount: rows.length };
      }
      if (/UPDATE hospital\.document_sections/i.test(trimmed)) {
        return { rows: [], rowCount: opts.updateRowCount ?? 1 };
      }
      throw new Error(`unmocked SQL: ${trimmed.slice(0, 80)}`);
    },
  };
  return { pool, calls };
}

function makeMockLlm(opts: {
  fields?: Record<string, unknown>;
  perFieldConfidence?: Record<string, number>;
  confidence?: number;
  costInr?: number;
  tierEscalated?: boolean;
  throwError?: Error;
}) {
  const calls: any[] = [];
  const llm: any = {
    classify: async () => {
      throw new Error('classify should not be called in extractor tests');
    },
    extract: async (params: any) => {
      calls.push(params);
      if (opts.throwError) throw opts.throwError;
      const fields = opts.fields ?? {
        admission_date: '2026-05-10',
        discharge_date: '2026-05-15',
        primary_diagnosis: 'Acute appendicitis',
      };
      const per = opts.perFieldConfidence ?? {
        admission_date: 0.98,
        discharge_date: 0.97,
        primary_diagnosis: 0.9,
      };
      // The bridge's extract() validates against the supplied schema, so
      // we simulate that by running the schema parse here. If it fails,
      // throw something resembling LlmSchemaValidationError — but the
      // happy-path mocks should always conform.
      const data = { fields, per_field_confidence: per, confidence: opts.confidence ?? 0.93 };
      const validated = params.schema.parse(data);
      return {
        data: validated,
        confidence: opts.confidence ?? 0.93,
        rawResponse: JSON.stringify(data),
        tokensInputUncached: 1000,
        tokensInputCached: 500,
        tokensOutput: 200,
        latencyMs: 1234,
        provider: 'anthropic',
        model: 'claude-3-5-haiku-mock',
        costInr: opts.costInr ?? 0.12,
        tierEscalated: opts.tierEscalated ?? false,
      };
    },
  };
  return { llm, calls };
}

function makeMockOcr(text = 'Discharge summary\nAdmitted 10/05/2026\nDischarged 15/05/2026\n') {
  return {
    extractTextFromPdf: async () => ({
      pages: [{ pageNumber: 1, text, confidence: 0.95, source: 'typed_pdf' as const }],
      totalPages: 1,
      avgConfidence: 0.95,
      processedAtMs: Date.now(),
      fileHash: 'mockhash',
      engineVersions: {},
    }),
  };
}

function makeMockS3() {
  return {
    download: async () => {
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.create();
      doc.addPage([100, 100]);
      doc.addPage([100, 100]);
      const bytes = await doc.save();
      return Buffer.from(bytes);
    },
  };
}

function makeMockEvents() {
  const dispatched: any[] = [];
  return {
    dispatched,
    events: { dispatch: async (i: any) => (dispatched.push(i), { id: 'e', deduped: false }) },
  };
}

function makeMockCostAccounting(action: 'allow' | 'block' | 'throttle' = 'allow') {
  return {
    checkBudget: async () => ({
      claimUnderLimit: action !== 'block',
      hospitalUnderLimit: action !== 'block',
      action,
      claimSpendInr: 1,
      hospitalDailySpendInr: 100,
      hospitalDailyCapInr: 3000,
      hospitalMonthlySpendInr: 1000,
      hospitalMonthlyCapInr: 50000,
    }),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Zod schema generation tests (highest-risk surface)
// ────────────────────────────────────────────────────────────────────────────

test('fieldRowToZod: text required -> z.string()', () => {
  const schema = fieldRowToZod({
    field_key: 'x', field_label: 'X', field_type: 'text',
    is_required: true, enum_values: null, reference_category: null,
    extraction_priority: 1, schema_version: 1,
  });
  assert.equal(schema.parse('hello'), 'hello');
  assert.throws(() => schema.parse(123), ZodError);
  assert.throws(() => schema.parse(undefined), ZodError);
});

test('fieldRowToZod: text optional -> z.string().optional()', () => {
  const schema = fieldRowToZod({
    field_key: 'x', field_label: 'X', field_type: 'text',
    is_required: false, enum_values: null, reference_category: null,
    extraction_priority: 1, schema_version: 1,
  });
  assert.equal(schema.parse('hello'), 'hello');
  assert.equal(schema.parse(undefined), undefined);
});

test('fieldRowToZod: date enforces ISO YYYY-MM-DD regex', () => {
  const schema = fieldRowToZod({
    field_key: 'd', field_label: 'D', field_type: 'date',
    is_required: true, enum_values: null, reference_category: null,
    extraction_priority: 1, schema_version: 1,
  });
  assert.equal(schema.parse('2026-05-18'), '2026-05-18');
  assert.throws(() => schema.parse('18/05/2026'), ZodError);
  assert.throws(() => schema.parse('2026-5-18'), ZodError);
});

test('fieldRowToZod: number accepts any number; money requires nonnegative', () => {
  const num = fieldRowToZod({
    field_key: 'n', field_label: 'N', field_type: 'number',
    is_required: true, enum_values: null, reference_category: null,
    extraction_priority: 1, schema_version: 1,
  });
  assert.equal(num.parse(-5), -5);
  assert.equal(num.parse(42), 42);

  const money = fieldRowToZod({
    field_key: 'm', field_label: 'M', field_type: 'money',
    is_required: true, enum_values: null, reference_category: null,
    extraction_priority: 1, schema_version: 1,
  });
  assert.equal(money.parse(0), 0);
  assert.equal(money.parse(12345.67), 12345.67);
  assert.throws(() => money.parse(-1), ZodError);
});

test('fieldRowToZod: boolean', () => {
  const schema = fieldRowToZod({
    field_key: 'b', field_label: 'B', field_type: 'boolean',
    is_required: true, enum_values: null, reference_category: null,
    extraction_priority: 1, schema_version: 1,
  });
  assert.equal(schema.parse(true), true);
  assert.equal(schema.parse(false), false);
  assert.throws(() => schema.parse('true'), ZodError);
});

test('fieldRowToZod: enum with valid values constrains to the list', () => {
  const schema = fieldRowToZod({
    field_key: 'rc', field_label: 'Room Category', field_type: 'enum',
    is_required: true,
    enum_values: ['general', 'private', 'icu'],
    reference_category: null, extraction_priority: 1, schema_version: 1,
  });
  assert.equal(schema.parse('icu'), 'icu');
  assert.throws(() => schema.parse('penthouse'), ZodError);
});

test('fieldRowToZod: enum with empty enum_values falls back to z.string()', () => {
  const schema = fieldRowToZod({
    field_key: 'rc', field_label: 'R', field_type: 'enum',
    is_required: true,
    enum_values: [],
    reference_category: null, extraction_priority: 1, schema_version: 1,
  });
  // Any string accepted because we fell back.
  assert.equal(schema.parse('whatever'), 'whatever');
});

test('fieldRowToZod: enum with stringified JSON array still parses', () => {
  const schema = fieldRowToZod({
    field_key: 'rc', field_label: 'R', field_type: 'enum',
    is_required: true,
    enum_values: '["a","b","c"]',
    reference_category: null, extraction_priority: 1, schema_version: 1,
  });
  assert.equal(schema.parse('b'), 'b');
  assert.throws(() => schema.parse('d'), ZodError);
});

test('fieldRowToZod: reference -> string', () => {
  const schema = fieldRowToZod({
    field_key: 'icd', field_label: 'ICD', field_type: 'reference',
    is_required: false, enum_values: null,
    reference_category: 'icd10', extraction_priority: 1, schema_version: 1,
  });
  assert.equal(schema.parse('J18.9'), 'J18.9');
});

test('fieldRowToZod: array -> z.array(z.unknown())', () => {
  const schema = fieldRowToZod({
    field_key: 'items', field_label: 'Items', field_type: 'array',
    is_required: true, enum_values: null, reference_category: null,
    extraction_priority: 1, schema_version: 1,
  });
  assert.deepEqual(schema.parse(['a', 1, { x: 1 }]), ['a', 1, { x: 1 }]);
  assert.throws(() => schema.parse('not an array'), ZodError);
});

test('fieldRowToZod: unknown field_type throws a structured error', () => {
  assert.throws(
    () =>
      fieldRowToZod({
        field_key: 'oops', field_label: '', field_type: 'json_blob',
        is_required: true, enum_values: null, reference_category: null,
        extraction_priority: 1, schema_version: 1,
      }),
    (err: unknown) => /unknown field_type 'json_blob'/.test((err as Error).message),
  );
});

test('buildPayloadSchema: top-level shape has fields, per_field_confidence, optional confidence', () => {
  const schema = buildPayloadSchema(DISCHARGE_SLIP_FIELDS);
  const ok = schema.parse({
    fields: {
      admission_date: '2026-05-10',
      discharge_date: '2026-05-15',
      primary_diagnosis: 'Pneumonia',
    },
    per_field_confidence: {
      admission_date: 0.99,
      discharge_date: 0.98,
      primary_diagnosis: 0.91,
    },
  });
  assert.equal((ok as any).fields.primary_diagnosis, 'Pneumonia');
});

test('buildPayloadSchema: required fields are not optional, optional fields ARE optional', () => {
  const schema = buildPayloadSchema(DISCHARGE_SLIP_FIELDS);
  // Missing required `discharge_date` → ZodError.
  assert.throws(
    () =>
      schema.parse({
        fields: {
          admission_date: '2026-05-10',
          primary_diagnosis: 'Pneumonia',
        },
        per_field_confidence: {},
      }),
    ZodError,
  );
  // Missing optional `treating_doctor` is fine.
  const ok = schema.parse({
    fields: {
      admission_date: '2026-05-10',
      discharge_date: '2026-05-15',
      primary_diagnosis: 'Pneumonia',
    },
    per_field_confidence: { admission_date: 0.9, discharge_date: 0.9, primary_diagnosis: 0.9 },
  });
  assert.equal((ok as any).fields.treating_doctor, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// End-to-end happy path
// ────────────────────────────────────────────────────────────────────────────

test('extractSection: happy path persists extracted fields + per-field confidence', async () => {
  const { pool, calls } = makeMockPool();
  const { llm, calls: llmCalls } = makeMockLlm({
    fields: {
      admission_date: '2026-05-10',
      discharge_date: '2026-05-15',
      primary_diagnosis: 'Acute appendicitis',
      room_category: 'private',
      total_amount: 87650,
    },
    perFieldConfidence: {
      admission_date: 0.99,
      discharge_date: 0.98,
      primary_diagnosis: 0.94,
      room_category: 0.9,
      total_amount: 0.97,
    },
  });
  const { dispatched, events } = makeMockEvents();

  const service = new DocExtractorService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events,
    costAccounting: makeMockCostAccounting('allow'),
  });

  const result = await service.extractSection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  });

  assert.equal(result.fields.room_category, 'private');
  assert.equal(result.fields.total_amount, 87650);
  assert.equal(result.perFieldConfidence.admission_date, 0.99);

  // LLM was called with our dynamic schema (it ran a Zod parse internally).
  assert.equal(llmCalls.length, 1);
  assert.equal(llmCalls[0]!.taskName, 'doc_extract.discharge_slip');
  assert.equal(llmCalls[0]!.tier, 'standard');
  assert.ok(typeof llmCalls[0]!.schema?.parse === 'function', 'schema is a Zod object');

  // UPDATE call records the fields + version.
  const updateCall = calls.find((c) => /UPDATE hospital\.document_sections/i.test(c.sql));
  assert.ok(updateCall);
  const fieldsJson = JSON.parse(updateCall!.params[1] as string);
  assert.equal(fieldsJson.primary_diagnosis, 'Acute appendicitis');
  assert.equal(updateCall!.params[3], EXTRACTOR_VERSION);

  // Event dispatched.
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.kind, 'section_extracted');
  assert.equal(dispatched[0]!.payload.section_id, SECTION_ID);
});

test('extractSection: idempotent short-circuit when extractor_version matches and fields present', async () => {
  const cachedFields = { admission_date: '2025-01-01', discharge_date: '2025-01-02', primary_diagnosis: 'X' };
  const cachedConf = { admission_date: 1, discharge_date: 1, primary_diagnosis: 1 };
  const { pool } = makeMockPool({
    sectionRow: {
      id: SECTION_ID,
      document_id: DOCUMENT_ID,
      page_start: 1, page_end: 1,
      category: 'discharge_slip',
      extractor_version: EXTRACTOR_VERSION,
      extracted_fields: cachedFields,
      extraction_confidence: cachedConf,
      s3_key: S3_KEY,
    },
  });
  const { llm, calls: llmCalls } = makeMockLlm({});
  const service = new DocExtractorService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
  });
  const result = await service.extractSection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  });
  assert.deepEqual(result.fields, cachedFields);
  assert.equal(llmCalls.length, 0);
});

test('extractSection: throws if section has no category set', async () => {
  const { pool } = makeMockPool({
    sectionRow: {
      id: SECTION_ID,
      document_id: DOCUMENT_ID,
      page_start: 1, page_end: 1,
      category: null,
      extractor_version: null,
      extracted_fields: null,
      extraction_confidence: null,
      s3_key: S3_KEY,
    },
  });
  const { llm } = makeMockLlm({});
  const service = new DocExtractorService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
  });
  await assert.rejects(
    () =>
      service.extractSection({
        sectionId: SECTION_ID,
        claimId: CLAIM_ID,
        hospitalId: HOSPITAL_ID,
      }),
    (err: unknown) => /no category/.test((err as Error).message),
  );
});

test('extractSection: throws LlmBudgetExceededError on block', async () => {
  const { pool } = makeMockPool();
  const { llm, calls: llmCalls } = makeMockLlm({});
  const service = new DocExtractorService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('block'),
  });
  await assert.rejects(
    () =>
      service.extractSection({
        sectionId: SECTION_ID,
        claimId: CLAIM_ID,
        hospitalId: HOSPITAL_ID,
      }),
    (err: unknown) => err instanceof LlmBudgetExceededError,
  );
  assert.equal(llmCalls.length, 0);
});

test('extractSection: throws if no field schema rows for category', async () => {
  const { pool } = makeMockPool({ fieldRows: [] });
  const { llm } = makeMockLlm({});
  const service = new DocExtractorService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
  });
  await assert.rejects(
    () =>
      service.extractSection({
        sectionId: SECTION_ID,
        claimId: CLAIM_ID,
        hospitalId: HOSPITAL_ID,
      }),
    (err: unknown) => /no document_field_schemas rows/.test((err as Error).message),
  );
});
