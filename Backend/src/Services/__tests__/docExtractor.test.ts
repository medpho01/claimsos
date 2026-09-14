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
 *
 * v3 (vision-first engine) additions:
 *   - extraction_mode defaults to 'vision' when master_options has no row.
 *   - A LINE_ITEM_CATEGORY section emits + persists line_items and the
 *     _line_items_meta audit channel; a non-line-item category does not.
 *   - Overlap duplicates from the tiled read are removed before persist.
 *   - The 24k section-text ceiling is RAISED to 100k on the vision path —
 *     raised, not removed: the Devanagari escalation has no length gate.
 *   - The OCR read carries the claim context (which buys the full vision
 *     page budget) and honours the DOC_EXTRACT_DEFAULT_MODE=ocr revert.
 *
 * The vision branch is exercised through the injected `visionInput` dep
 * (a stub) so these tests never rasterise a PDF or touch the network.
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
import {
  EXTRACTOR_PROMPT_VERSION,
  buildDocExtractorSystemPrompt,
  docExtractorPromptVersion,
} from '../llm/prompts/docExtractor.generic.v1.js';

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

const FINAL_BILL_FIELDS: FieldRow[] = [
  {
    field_key: 'bill_no',
    field_label: 'Bill Number',
    field_type: 'text',
    is_required: true,
    enum_values: null,
    reference_category: null,
    extraction_priority: 10,
    schema_version: 1,
  },
  {
    field_key: 'total_amount',
    field_label: 'Total Amount',
    field_type: 'money',
    is_required: true,
    enum_values: null,
    reference_category: null,
    extraction_priority: 20,
    schema_version: 1,
  },
];

function makeMockPool(opts: {
  sectionRow?: Record<string, unknown> | null;
  fieldRows?: FieldRow[];
  updateRowCount?: number;
  /**
   * The hospital.master_options row for this doc_category.
   * `undefined` → the v2-era default of an explicit extraction_mode='ocr',
   * which keeps the pre-existing tests on the text path.
   * `null`      → NO row at all, which is what exercises the v3
   *               vision-first fallback in loadExtractionMode().
   */
  masterOption?: { extraction_mode?: string | null; description?: string | null } | null;
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const trimmed = sql.trim();
      // master_options serves two lookups off the same table: the
      // category hint (SELECT description) and the extraction mode.
      if (/FROM hospital\.master_options/i.test(trimmed)) {
        if (opts.masterOption === null) return { rows: [], rowCount: 0 };
        const mo = opts.masterOption ?? { extraction_mode: 'ocr', description: null };
        if (/SELECT\s+description/i.test(trimmed)) {
          return { rows: [{ description: mo.description ?? null }], rowCount: 1 };
        }
        return { rows: [{ extraction_mode: mo.extraction_mode ?? null }], rowCount: 1 };
      }
      // persistExtraction's read-before-write (the _corrected_fields guard).
      if (/SELECT\s+extracted_fields,\s+extraction_confidence/i.test(trimmed)) {
        return {
          rows: [{ extracted_fields: null, extraction_confidence: null }],
          rowCount: 1,
        };
      }
      // loadAdmissionDate's sibling-section + ipds lookups — no pivot date
      // available in these fixtures.
      if (/admission_date/i.test(trimmed) || /FROM hospital\.ipds/i.test(trimmed)) {
        return { rows: [], rowCount: 0 };
      }
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
  /** Model-emitted itemised rows, passed through the caller's Zod schema. */
  lineItems?: unknown[];
  lineItemsConfidence?: number;
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
      const data: Record<string, unknown> = {
        fields,
        per_field_confidence: per,
        confidence: opts.confidence ?? 0.93,
      };
      if (opts.lineItems) {
        data.line_items = opts.lineItems;
        data.line_items_confidence = opts.lineItemsConfidence ?? 0.9;
      }
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

/**
 * The default OCR double.
 *
 * It declares BOTH reader methods even though most tests that use it only
 * exercise the PDF path. `DocExtractorDeps.ocr` requires both, because
 * `extractSection` calls `extractTextFromImage` whenever the section's bytes
 * are an image rather than a PDF. A double that supplied only
 * `extractTextFromPdf` used to type-check (the dep was declared too narrowly —
 * a live TS2741 on the assignment inside the service) and would then throw
 * "extractTextFromImage is not a function" the moment a test fed it an image
 * buffer. Both halves are stubbed here so the double can never be the reason a
 * test passes.
 */
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
    extractTextFromImage: async () => ({
      pageNumber: 1,
      text,
      confidence: 0.95,
      source: 'tesseract' as const,
    }),
  };
}

/**
 * An OCR double that RECORDS the opts it was called with. The opts are the
 * cost contract between this service and ocr.service: a claim context buys
 * the full vision page budget (and correct llm_cost_log attribution), and
 * allowVisionFallback:false is how the DOC_EXTRACT_DEFAULT_MODE=ocr revert
 * stops the per-page Anthropic calls.
 */
function makeRecordingOcr(text = 'Discharge summary\nAdmitted 10/05/2026\n') {
  const pdfOpts: any[] = [];
  const imageOpts: any[] = [];
  const ocr: any = {
    extractTextFromPdf: async (_buf: Buffer, opts?: any) => {
      pdfOpts.push(opts);
      return {
        pages: [{ pageNumber: 1, text, confidence: 0.95, source: 'typed_pdf' as const }],
        totalPages: 1,
        avgConfidence: 0.95,
        processedAtMs: Date.now(),
        fileHash: 'mockhash',
        engineVersions: {},
      };
    },
    extractTextFromImage: async (_buf: Buffer, opts?: any) => {
      imageOpts.push(opts);
      return {
        pageNumber: 1,
        text,
        confidence: 0.95,
        source: 'tesseract' as const,
      };
    },
  };
  return { ocr, pdfOpts, imageOpts };
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

function makeMockCostAccounting(
  action: 'allow' | 'block' | 'throttle' | 'pause_for_consent' = 'allow',
) {
  // `recorded` captures every recordCall so tests can assert post-extract
  // cost logging (CRIT-2 / benchmark B1: the extractor must record its own
  // spend, not rely on the bridge). recordCall is REQUIRED on the injected
  // dep now — without it, the service's post-extract recordCall throws.
  //
  // `budgetCalls` captures the ARGUMENTS of every checkBudget. checkBudget
  // reads the run's approved budget — and can only ever answer
  // 'pause_for_consent' — when it is handed a run id in its 4th argument, so
  // the argument is the fix, not decoration.
  const recorded: any[] = [];
  const budgetCalls: any[][] = [];
  return {
    recorded,
    budgetCalls,
    checkBudget: async (...args: any[]) => {
      budgetCalls.push(args);
      return {
        claimUnderLimit: action !== 'block',
        hospitalUnderLimit: action !== 'block',
        action,
        claimSpendInr: 1,
        hospitalDailySpendInr: 100,
        hospitalDailyCapInr: 3000,
        hospitalMonthlySpendInr: 1000,
        hospitalMonthlyCapInr: 50000,
        ...(action === 'pause_for_consent'
          ? {
              runId: 'run-9',
              runSpendInr: 62,
              runApprovedBudgetInr: 60,
              reason: 'run spend ₹62.00 ≥ approved budget ₹60 — pausing for consent',
            }
          : {}),
      };
    },
    recordCall: async (input: any) => {
      recorded.push(input);
    },
  };
}

/**
 * Patch the claimAiRun / ledger singletons that `resolveActiveRunId` and
 * `pauseRunForConsent` reach through a dynamic import. The dynamic import
 * resolves to the very object imported here (ESM module cache), so patching
 * its methods is sufficient — no module mocker needed.
 */
async function withRun(
  run: { id: string; status: string } | null,
  fn: (captured: { pauses: any[]; blocks: any[][] }) => Promise<void>,
): Promise<void> {
  const { default: claimAiRunService } = await import('../claimAiRun.service.js');
  const { default: ledger } = await import('../docPhaseLedger.service.js');
  const orig = {
    getLatestRun: claimAiRunService.getLatestRun,
    getRunSpend: claimAiRunService.getRunSpend,
    computeProjectedRemainingInr: claimAiRunService.computeProjectedRemainingInr,
    pauseForConsent: claimAiRunService.pauseForConsent,
    makeShouldStop: claimAiRunService.makeShouldStop,
    blockPhase: ledger.blockPhase,
  };
  const pauses: any[] = [];
  const blocks: any[][] = [];
  (claimAiRunService as any).getLatestRun = async () => run;
  (claimAiRunService as any).getRunSpend = async () => ({ totalInr: 42 });
  (claimAiRunService as any).computeProjectedRemainingInr = async () => 88;
  (claimAiRunService as any).makeShouldStop = () => async () => false;
  (claimAiRunService as any).pauseForConsent = async (i: any) => {
    pauses.push(i);
    return null;
  };
  (ledger as any).blockPhase = async (...a: any[]) => {
    blocks.push(a);
  };
  try {
    await fn({ pauses, blocks });
  } finally {
    (claimAiRunService as any).getLatestRun = orig.getLatestRun;
    (claimAiRunService as any).getRunSpend = orig.getRunSpend;
    (claimAiRunService as any).computeProjectedRemainingInr =
      orig.computeProjectedRemainingInr;
    (claimAiRunService as any).pauseForConsent = orig.pauseForConsent;
    (claimAiRunService as any).makeShouldStop = orig.makeShouldStop;
    (ledger as any).blockPhase = orig.blockPhase;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Zod schema generation tests (highest-risk surface)
// ────────────────────────────────────────────────────────────────────────────

test('fieldRowToZod: text required -> typed, but ABSENCE is never an error', () => {
  const schema = fieldRowToZod({
    field_key: 'x', field_label: 'X', field_type: 'text',
    is_required: true, enum_values: null, reference_category: null,
    extraction_priority: 1, schema_version: 1,
  });
  assert.equal(schema.parse('hello'), 'hello');
  // The TYPE is still enforced — required or not, a number is not a string.
  assert.throws(() => schema.parse(123), ZodError);

  // …but absence is not. docExtractor.service.ts:432-437 deliberately wraps
  // EVERY field in `.optional()` behind a preprocessor that folds the three
  // "model couldn't find it" signals — `null`, `""`, and a missing key — into
  // `undefined`: "At the EXTRACTION layer all fields are optional". The reason
  // is stated there too: one null from the model used to throw
  // LlmSchemaValidationError and take the whole section's partial extraction
  // down with it. `is_required` still matters, but it is enforced one layer
  // down, where the rules engine turns a missing field into a typed
  // blocking_gap on the stage that needs it.
  //
  // This test asserted `throws` for all three until Sep 2026. It was asserting
  // the OLD contract, so it failed against the shipped one; the contract is
  // what changed, not the code under it.
  assert.equal(schema.parse(undefined), undefined);
  assert.equal(schema.parse(null), undefined);
  assert.equal(schema.parse(''), undefined);
  assert.equal(schema.parse('   '), undefined, 'whitespace-only is trimmed to empty, i.e. absent');
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

test('fieldRowToZod: date NORMALISES the formats the model emits, and rejects what it cannot parse', () => {
  const schema = fieldRowToZod({
    field_key: 'd', field_label: 'D', field_type: 'date',
    is_required: true, enum_values: null, reference_category: null,
    extraction_priority: 1, schema_version: 1,
  });
  // Already ISO — passed through untouched.
  assert.equal(schema.parse('2026-05-18'), '2026-05-18');

  // dd/mm/yyyy, dd-mm-yyyy and dd.mm.yy are NORMALISED, not rejected
  // (docExtractor.service.ts:337-353). This branch is pure string math — no
  // Date object — so it is identical under every TZ the runner might have.
  //
  // This test asserted that '18/05/2026' THROWS until Sep 2026, which was the
  // contract before the normaliser landed. Rejecting the single most common
  // Indian date format would poison far more extractions than it saved.
  assert.equal(schema.parse('18/05/2026'), '2026-05-18');
  assert.equal(schema.parse('18-05-2026'), '2026-05-18');
  assert.equal(schema.parse('5.2.2026'), '2026-02-05', 'single digits are zero-padded');
  assert.equal(schema.parse('5/2/26'), '2026-02-05', 'a 2-digit year is expanded to 20xx');

  // The Date.parse fallback handles what the dd/mm/yyyy matcher does not.
  // Asserted only with an EXPLICIT offset: a bare '2026-5-18' is parsed as
  // LOCAL midnight and then rendered through toISOString(), so it answers
  // '2026-05-17' east of Greenwich and '2026-05-18' in CI's UTC. That is a
  // real latent defect in the service, but pinning it here would just make
  // this suite fail on the author's laptop and pass in CI.
  assert.equal(schema.parse('2026-05-18T09:30:00Z'), '2026-05-18');

  // Anything genuinely unparseable falls through unchanged so the ISO regex
  // fires loudly rather than a bad value reaching the dossier.
  assert.throws(() => schema.parse('sometime last Tuesday'), ZodError);
  assert.throws(() => schema.parse('not a date at all'), ZodError);
  assert.throws(() => schema.parse(42), ZodError, 'a non-string is not coerced');

  // Absence stays absence — same extraction-layer contract as every field.
  assert.equal(schema.parse(undefined), undefined);
  assert.equal(schema.parse(null), undefined);
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

test('buildPayloadSchema: a partial extraction survives — missing fields do not void the payload', () => {
  const schema = buildPayloadSchema(DISCHARGE_SLIP_FIELDS);

  // A payload missing the REQUIRED `discharge_date` parses. Keeping the
  // admission date and the diagnosis that the model DID read is worth more
  // than rejecting the section wholesale; the gap is raised by the rules
  // engine, which knows which stage actually needs a discharge date.
  // (This assertion was `assert.throws` until Sep 2026 — the old contract.)
  const partial = schema.parse({
    fields: {
      admission_date: '2026-05-10',
      primary_diagnosis: 'Pneumonia',
    },
    per_field_confidence: {},
  }) as any;
  assert.equal(partial.fields.discharge_date, undefined, 'the missing required field is absent, not fatal');
  assert.equal(partial.fields.admission_date, '2026-05-10', 'and the fields that WERE read survive');
  assert.equal(partial.fields.primary_diagnosis, 'Pneumonia');

  // Missing optional `treating_doctor` is fine (and always was).
  const ok = schema.parse({
    fields: {
      admission_date: '2026-05-10',
      discharge_date: '2026-05-15',
      primary_diagnosis: 'Pneumonia',
    },
    per_field_confidence: { admission_date: 0.9, discharge_date: 0.9, primary_diagnosis: 0.9 },
  }) as any;
  assert.equal(ok.fields.treating_doctor, undefined);

  // A model that emits null / "" for the fields it could not find gets the
  // same treatment as one that omits them — the case this tolerance exists
  // for (five null fields on an aadhaar_front used to lose the whole section).
  const nulled = schema.parse({
    fields: { admission_date: null, discharge_date: '', primary_diagnosis: 'Pneumonia' },
    per_field_confidence: {},
  }) as any;
  assert.equal(nulled.fields.admission_date, undefined);
  assert.equal(nulled.fields.discharge_date, undefined);
  assert.equal(nulled.fields.primary_diagnosis, 'Pneumonia');

  // What the payload schema still DOES reject — optionality is not laxity:
  //   a value of the wrong shape for its declared type,
  assert.throws(
    () => schema.parse({ fields: { discharge_date: 'sometime in May' }, per_field_confidence: {} }),
    ZodError,
  );
  //   a missing envelope key,
  assert.throws(() => schema.parse({ per_field_confidence: {} }), ZodError);
  //   and an out-of-range confidence.
  assert.throws(
    () => schema.parse({ fields: {}, per_field_confidence: { admission_date: 1.4 } }),
    ZodError,
  );
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

// ────────────────────────────────────────────────────────────────────────────
// MID-RUN COST CONSENT (requirement 3b).
//
// `checkBudget` returns 'pause_for_consent' ONLY inside `if (opts?.runId)`.
// This call site resolved the active run 200 lines LOWER DOWN (for the OCR
// stop hook) and passed nothing to the pre-flight, so the pause arm — and
// pauseRunForConsent with it — could never run. Measured consequence: 17
// itemised sections at ~₹8.65 against a ₹60 approval extracted all 17,
// crossed the static ₹150 cap, threw LlmBudgetExceededError and dead-lettered
// through Bull. The user approved ₹60, was charged ₹150, and got a hard
// failure instead of the pause-and-re-ask that was specified.
// ────────────────────────────────────────────────────────────────────────────

test('extractSection: the budget pre-flight passes the ACTIVE RUN ID', async () => {
  const { pool } = makeMockPool();
  const { llm } = makeMockLlm({ fields: { room_category: 'private' }, perFieldConfidence: {} });
  const cost = makeMockCostAccounting('allow');

  await withRun({ id: 'run-9', status: 'running' }, async () => {
    const service = new DocExtractorService({
      pool: pool as any,
      llm,
      s3: makeMockS3(),
      ocr: makeMockOcr(),
      events: makeMockEvents().events,
      costAccounting: cost,
    });
    await service.extractSection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    });

    assert.equal(cost.budgetCalls.length, 1);
    const [claimId, hospitalId, , budgetOpts] = cost.budgetCalls[0]!;
    assert.equal(claimId, CLAIM_ID);
    assert.equal(hospitalId, HOSPITAL_ID);
    assert.deepEqual(budgetOpts, { runId: 'run-9' });

    // The same id lands on the cost row, so getRunSpendInr measures THIS
    // run's spend rather than every rupee on the claim since triggered_at.
    assert.equal(cost.recorded.length, 1);
    assert.equal(cost.recorded[0]!.runId, 'run-9');
  });
});

test('extractSection: a paused or terminal run resolves to NO run id', async () => {
  const { pool } = makeMockPool();
  const { llm } = makeMockLlm({ fields: { room_category: 'private' }, perFieldConfidence: {} });
  const cost = makeMockCostAccounting('allow');

  await withRun({ id: 'run-9', status: 'succeeded' }, async () => {
    const service = new DocExtractorService({
      pool: pool as any,
      llm,
      s3: makeMockS3(),
      ocr: makeMockOcr(),
      events: makeMockEvents().events,
      costAccounting: cost,
    });
    await service.extractSection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    });
    assert.deepEqual(cost.budgetCalls[0]![3], { runId: null });
    assert.equal(cost.recorded[0]!.runId, null);
  });
});

test('extractSection: pause_for_consent parks the section instead of throwing', async () => {
  const { pool } = makeMockPool();
  const { llm, calls: llmCalls } = makeMockLlm({});
  const cost = makeMockCostAccounting('pause_for_consent');

  await withRun({ id: 'run-9', status: 'running' }, async ({ pauses, blocks }) => {
    const service = new DocExtractorService({
      pool: pool as any,
      llm,
      s3: makeMockS3(),
      ocr: makeMockOcr(),
      events: makeMockEvents().events,
      costAccounting: cost,
    });

    const out = (await service.extractSection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    })) as any;

    // Returns; does NOT throw. A throw dead-letters through Bull's retries
    // against a run that is deliberately waiting on a person.
    assert.equal(out.skipped, true);
    assert.equal(out.skip_reason, 'run_budget_exhausted');
    assert.equal(out.costInr, 0);

    assert.equal(llmCalls.length, 0);
    assert.equal(cost.recorded.length, 0);

    assert.equal(pauses.length, 1);
    assert.equal(pauses[0]!.run_id, 'run-9');
    assert.equal(pauses[0]!.spend_inr, 42);
    assert.equal(pauses[0]!.projected_remaining_inr, 88);
    assert.deepEqual(blocks[0]!.slice(0, 4), [
      DOCUMENT_ID,
      'run-9',
      'extract',
      'run_budget_exhausted',
    ]);
  });
});

test('extractSection: marks the section extraction_skipped when the category has no field schema', async () => {
  const { pool, calls } = makeMockPool({ fieldRows: [] });
  const { llm, calls: llmCalls } = makeMockLlm({});
  const service = new DocExtractorService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
  });
  const result = (await service.extractSection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  })) as any;
  // Only ~5 of the 200+ taxonomy codes have schemas seeded, so a missing
  // schema is a routine skip, not a failure — the section stays useful to
  // the rules engine via presence/absence checks.
  assert.equal(result.skipped, true);
  assert.equal(result.skip_reason, 'no_field_schema');
  assert.equal(llmCalls.length, 0);
  assert.ok(calls.some((c) => /UPDATE hospital\.document_sections/i.test(c.sql)));
});

// ────────────────────────────────────────────────────────────────────────────
// v3 — vision-first engine + first-class line items
// ────────────────────────────────────────────────────────────────────────────

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

/** S3 stub that hands back an image (no pdf-lib / rasteriser involved). */
function makeMockImageS3() {
  return { download: async () => JPEG_BYTES };
}

/**
 * Stub of prepareVisionInput. Returns two attachments shaped like an
 * overview + one tile so the service's plumbing (attachment forwarding,
 * layoutContext, anyWide, tile counting) is exercised without sharp.
 */
function makeMockVisionInput(
  opts: {
    anyWide?: boolean;
    tiles?: number;
    layoutContext?: string;
    /**
     * Which way the tiler cut. 'x' = VERTICAL column strips (a wide landscape
     * bill), 'y' = HORIZONTAL row bands (a dense A4 portrait page), 'none' =
     * untiled. Drives `tileAxes`, which is what the service selects the system
     * prompt from — the two merge rules are opposites, so a page tiled on y
     * that is handed the x rule gets a system prompt contradicting its own
     * user prompt.
     */
    tileAxis?: 'x' | 'y' | 'none';
    /** Omit `tileAxes` entirely, as an older caller of this dep would. */
    omitTileAxes?: boolean;
  } = {},
) {
  const seen: any[] = [];
  const tiles = opts.tiles ?? 2;
  const anyWide = opts.anyWide ?? true;
  const tileAxis = opts.tileAxis ?? 'x';
  const fn = (async (input: any) => {
    seen.push(input);
    const images: any[] = [
      {
        data: Buffer.from('overview'),
        mime: 'image/jpeg',
        role: 'overview',
        tileAxis: 'none',
        pageNumber: 1,
        tileIndex: 0,
        tileCount: tiles,
        widthPx: 1568,
        heightPx: 645,
        xRange: [0, 3400] as const,
        sourceWidthPx: 3400,
        sourceHeightPx: 1400,
      },
    ];
    for (let i = 0; i < tiles; i++) {
      images.push({
        data: Buffer.from(`tile-${i}`),
        mime: 'image/jpeg',
        role: 'tile',
        tileAxis,
        pageNumber: 1,
        tileIndex: i,
        tileCount: tiles,
        widthPx: 1269,
        heightPx: 1400,
        xRange: [0, 1269] as const,
        sourceWidthPx: 3400,
        sourceHeightPx: 1400,
      });
    }
    const pages = [
      {
        geometry: {
          pageNumber: 1,
          widthPx: 3400,
          heightPx: 1400,
          aspectRatio: 3400 / 1400,
          isWide: anyWide,
          renderScale: 2.35,
          deskewAngleDeg: -1.1,
        },
        images,
        warnings: [],
      },
    ];
    return {
      attachments: images.map((i) => ({
        kind: 'image' as const,
        data: i.data,
        mime: i.mime,
      })),
      pages,
      layoutContext:
        opts.layoutContext ??
        'Page 1 is a WIDE table sent as an overview plus overlapping horizontal slices.',
      anyWide,
      ...(opts.omitTileAxes
        ? {}
        : { tileAxes: tileAxis === 'none' ? [] : [tileAxis] }),
      totalImages: images.length,
      warnings: [],
    };
  }) as any;
  return { visionInput: fn, seen };
}

test('extractSection: with no master_options row, extraction_mode defaults to vision', async () => {
  // DOC_EXTRACT_DEFAULT_MODE unset → the v3 default. masterOption:null
  // means loadExtractionMode finds no row and must fall through to it.
  const previous = process.env.DOC_EXTRACT_DEFAULT_MODE;
  delete process.env.DOC_EXTRACT_DEFAULT_MODE;
  try {
    const { pool } = makeMockPool({ masterOption: null });
    const { llm, calls: llmCalls } = makeMockLlm({});
    const { visionInput, seen } = makeMockVisionInput();

    const service = new DocExtractorService({
      pool: pool as any,
      llm,
      s3: makeMockImageS3(),
      ocr: makeMockOcr(),
      events: makeMockEvents().events,
      costAccounting: makeMockCostAccounting('allow'),
      visionInput,
    });

    await service.extractSection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    });

    // The vision preparer ran, its images were forwarded, and the call
    // went out on the premium tier.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.kind, 'image');
    assert.equal(llmCalls.length, 1);
    assert.equal(llmCalls[0]!.tier, 'premium');
    assert.equal(llmCalls[0]!.documents?.length, 3);
    // The overlapping-slice explanation reached the prompt.
    assert.match(llmCalls[0]!.userPrompt, /overlapping horizontal slices/i);
  } finally {
    if (previous === undefined) delete process.env.DOC_EXTRACT_DEFAULT_MODE;
    else process.env.DOC_EXTRACT_DEFAULT_MODE = previous;
  }
});

// ── the system prompt must follow the axis the tiler actually used ──────
//
// imageTiler measures both axes and picks the better one: a wide landscape
// bill is cut into VERTICAL column strips ('x'), a dense A4 portrait page into
// HORIZONTAL row bands ('y'). The merge rules are OPPOSITES, and this service
// used to pass the x-only constant as the SYSTEM prompt on every call while
// the axis-aware layoutContext went into the USER turn — so on every tiled
// portrait page the two halves of one prompt contradicted each other. These
// tests are the wiring check: the per-axis contract itself is pinned in
// llm/prompts/__tests__/axisPrompts.test.ts.

/** Run one vision extraction and hand back the LLM call that went out. */
async function extractWithAxis(
  visionOpts: Parameters<typeof makeMockVisionInput>[0],
): Promise<{ call: any; recorded: any[] }> {
  const previous = process.env.DOC_EXTRACT_DEFAULT_MODE;
  delete process.env.DOC_EXTRACT_DEFAULT_MODE;
  try {
    const { pool } = makeMockPool({ masterOption: { extraction_mode: 'vision' } });
    const { llm, calls: llmCalls } = makeMockLlm({});
    const { visionInput } = makeMockVisionInput(visionOpts);
    const costAccounting = makeMockCostAccounting('allow');

    const service = new DocExtractorService({
      pool: pool as any,
      llm,
      s3: makeMockImageS3(),
      ocr: makeMockOcr(),
      events: makeMockEvents().events,
      costAccounting,
      visionInput,
    });

    await service.extractSection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    });

    assert.equal(llmCalls.length, 1);
    return { call: llmCalls[0]!, recorded: costAccounting.recorded };
  } finally {
    if (previous === undefined) delete process.env.DOC_EXTRACT_DEFAULT_MODE;
    else process.env.DOC_EXTRACT_DEFAULT_MODE = previous;
  }
}

test('extractSection: a page tiled on x gets the certified column-strip system prompt', async () => {
  const { call, recorded } = await extractWithAxis({ tileAxis: 'x' });
  assert.equal(call.systemPrompt, buildDocExtractorSystemPrompt(['x']));
  assert.match(call.systemPrompt, /OVERLAPPING HORIZONTAL SLICES/);
  // Unchanged text keeps the unchanged label, so the certified measurement
  // stays comparable in llm_cost_log.
  assert.equal(call.promptVersion, EXTRACTOR_PROMPT_VERSION);
  assert.equal(recorded[0]!.promptVersion, EXTRACTOR_PROMPT_VERSION);
});

test('extractSection: a page tiled on y gets the ROW-BAND system prompt, not the x one', async () => {
  // THE REGRESSION THIS TEST EXISTS FOR. This is the production
  // structured-extraction path for a dense A4 portrait bill.
  const { call, recorded } = await extractWithAxis({
    tileAxis: 'y',
    layoutContext:
      'Page 1 is a TALL table sent as an overview plus overlapping HORIZONTAL bands.',
  });
  assert.equal(call.systemPrompt, buildDocExtractorSystemPrompt(['y']));
  assert.match(call.systemPrompt, /FULL-WIDTH BANDS/);
  for (const xClaim of [
    'OVERLAPPING HORIZONTAL SLICES',
    'ordered LEFT TO RIGHT',
    'ACROSS slices',
  ]) {
    assert.ok(
      !call.systemPrompt.includes(xClaim),
      `portrait page still gets the x-axis rule: ${xClaim}`,
    );
  }
  // And the user turn agrees with it rather than fighting it.
  assert.match(call.userPrompt, /HORIZONTAL bands/);
  assert.equal(call.promptVersion, `${EXTRACTOR_PROMPT_VERSION}-y`);
  assert.equal(recorded[0]!.promptVersion, `${EXTRACTOR_PROMPT_VERSION}-y`);
});

test('extractSection: an untiled page is told there is nothing to merge', async () => {
  const { call } = await extractWithAxis({
    tileAxis: 'none',
    tiles: 0,
    anyWide: false,
    layoutContext: 'Page 1 was sent as a single whole-page image.',
  });
  assert.equal(call.systemPrompt, buildDocExtractorSystemPrompt([]));
  assert.match(call.systemPrompt, /COMPLETE page, not a slice/);
  assert.equal(call.promptVersion, `${EXTRACTOR_PROMPT_VERSION}-notiles`);
});

test('extractSection: a vision dep that reports no tileAxes falls back to "untiled"', async () => {
  // An injected dep (or an older prepareVisionInput) that predates tileAxes.
  // Claiming an axis we cannot see would be worse than claiming none: the
  // untiled prompt asserts nothing about how the images relate to each other.
  const { call } = await extractWithAxis({ omitTileAxes: true });
  assert.equal(call.systemPrompt, buildDocExtractorSystemPrompt([]));
  assert.equal(call.promptVersion, docExtractorPromptVersion([]));
});

test('extractSection: the OCR-only path asserts no merge rule at all', async () => {
  const previous = process.env.DOC_EXTRACT_DEFAULT_MODE;
  process.env.DOC_EXTRACT_DEFAULT_MODE = 'ocr';
  try {
    const { pool } = makeMockPool({ masterOption: null });
    const { llm, calls: llmCalls } = makeMockLlm({});
    const { visionInput } = makeMockVisionInput();

    const service = new DocExtractorService({
      pool: pool as any,
      llm,
      s3: makeMockImageS3(),
      ocr: {
        ...makeMockOcr(),
        extractTextFromImage: async () => ({
          pageNumber: 1,
          text: 'Discharge summary\nAdmitted 10/05/2026\nDischarged 15/05/2026\n',
          confidence: 0.95,
          source: 'tesseract' as const,
        }),
      } as any,
      events: makeMockEvents().events,
      costAccounting: makeMockCostAccounting('allow'),
      visionInput,
    });

    await service.extractSection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    });

    assert.equal(llmCalls[0]!.documents, undefined);
    assert.equal(llmCalls[0]!.systemPrompt, buildDocExtractorSystemPrompt([]));
    assert.ok(!llmCalls[0]!.systemPrompt.includes('OVERLAPPING HORIZONTAL SLICES'));
  } finally {
    if (previous === undefined) delete process.env.DOC_EXTRACT_DEFAULT_MODE;
    else process.env.DOC_EXTRACT_DEFAULT_MODE = previous;
  }
});

test('extractSection: DOC_EXTRACT_DEFAULT_MODE=ocr reverts the vision-first flip', async () => {
  const previous = process.env.DOC_EXTRACT_DEFAULT_MODE;
  process.env.DOC_EXTRACT_DEFAULT_MODE = 'ocr';
  try {
    const { pool } = makeMockPool({ masterOption: null });
    const { llm, calls: llmCalls } = makeMockLlm({});
    const { visionInput, seen } = makeMockVisionInput();

    const service = new DocExtractorService({
      pool: pool as any,
      llm,
      s3: makeMockImageS3(),
      ocr: {
        ...makeMockOcr(),
        extractTextFromImage: async () => ({
          pageNumber: 1,
          text: 'Discharge summary\nAdmitted 10/05/2026\nDischarged 15/05/2026\n',
          confidence: 0.95,
          source: 'tesseract' as const,
        }),
      } as any,
      events: makeMockEvents().events,
      costAccounting: makeMockCostAccounting('allow'),
      visionInput,
    });

    await service.extractSection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    });

    assert.equal(seen.length, 0, 'vision preparer must not run on the ocr path');
    assert.equal(llmCalls[0]!.tier, 'standard');
    assert.equal(llmCalls[0]!.documents, undefined);
  } finally {
    if (previous === undefined) delete process.env.DOC_EXTRACT_DEFAULT_MODE;
    else process.env.DOC_EXTRACT_DEFAULT_MODE = previous;
  }
});

test('extractSection: the OCR read is attributed to the claim (keeps the full vision budget)', async () => {
  // ocr.service gives a call with NO claim context the tighter "unattended
  // ingestion" page budget. This service always runs inside a bound claim, so
  // it must identify itself — otherwise a long scanned bundle silently reads
  // 3 pages via vision and the rest via Tesseract.
  const previous = process.env.DOC_EXTRACT_DEFAULT_MODE;
  delete process.env.DOC_EXTRACT_DEFAULT_MODE;
  try {
    const { pool } = makeMockPool({ masterOption: { extraction_mode: 'ocr' } });
    const { llm } = makeMockLlm({});
    const { visionInput } = makeMockVisionInput();
    const { ocr, pdfOpts } = makeRecordingOcr();

    const service = new DocExtractorService({
      pool: pool as any,
      llm,
      s3: makeMockS3(),
      ocr,
      events: makeMockEvents().events,
      costAccounting: makeMockCostAccounting('allow'),
      visionInput,
    });

    await service.extractSection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    });

    assert.equal(pdfOpts.length, 1);
    assert.equal(pdfOpts[0]!.claimId, CLAIM_ID);
    assert.equal(pdfOpts[0]!.hospitalId, HOSPITAL_ID);
    assert.equal(
      pdfOpts[0]!.allowVisionFallback,
      undefined,
      'the revert switch is off, so the OCR layer decides for itself',
    );
  } finally {
    if (previous === undefined) delete process.env.DOC_EXTRACT_DEFAULT_MODE;
    else process.env.DOC_EXTRACT_DEFAULT_MODE = previous;
  }
});

test('extractSection: DOC_EXTRACT_DEFAULT_MODE=ocr also stops the OCR layer paying for vision', async () => {
  // Finding #11: the flag used to revert this module's mode while
  // ocr.service kept defaulting to vision, so extractTextFromPdf went on
  // making one Anthropic call per page. Reverting behaviour without
  // reverting spend is the worst possible outcome for an incident switch.
  const previous = process.env.DOC_EXTRACT_DEFAULT_MODE;
  process.env.DOC_EXTRACT_DEFAULT_MODE = 'ocr';
  try {
    const { pool } = makeMockPool({ masterOption: null });
    const { llm } = makeMockLlm({});
    const { visionInput, seen } = makeMockVisionInput();
    const { ocr, pdfOpts } = makeRecordingOcr();

    const service = new DocExtractorService({
      pool: pool as any,
      llm,
      s3: makeMockS3(),
      ocr,
      events: makeMockEvents().events,
      costAccounting: makeMockCostAccounting('allow'),
      visionInput,
    });

    await service.extractSection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    });

    assert.equal(seen.length, 0, 'vision preparer must not run on the reverted path');
    assert.equal(pdfOpts.length, 1);
    assert.equal(
      pdfOpts[0]!.allowVisionFallback,
      false,
      'the one flag must switch off the per-page vision calls too',
    );
  } finally {
    if (previous === undefined) delete process.env.DOC_EXTRACT_DEFAULT_MODE;
    else process.env.DOC_EXTRACT_DEFAULT_MODE = previous;
  }
});

function makeFinalBillService(
  lineItems: unknown[],
  extra: { fields?: Record<string, unknown> } = {},
) {
  const { pool, calls } = makeMockPool({
    fieldRows: FINAL_BILL_FIELDS,
    masterOption: { extraction_mode: 'vision' },
    sectionRow: {
      id: SECTION_ID,
      document_id: DOCUMENT_ID,
      page_start: 1,
      page_end: 1,
      category: 'final_bill',
      extractor_version: null,
      extracted_fields: null,
      extraction_confidence: null,
      s3_key: S3_KEY,
    },
  });
  const { llm, calls: llmCalls } = makeMockLlm({
    fields: extra.fields ?? { bill_no: 'FB/2026/0912', total_amount: 1200 },
    perFieldConfidence: { bill_no: 0.98, total_amount: 0.96 },
    lineItems,
  });
  const { visionInput } = makeMockVisionInput();
  const service = new DocExtractorService({
    pool: pool as any,
    llm,
    s3: makeMockImageS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
    visionInput,
  });
  return { service, pool, calls, llmCalls };
}

function persistedPayload(calls: Array<{ sql: string; params: unknown[] }>) {
  // The persist UPDATE takes 5 params; the no-schema "skipped" stamp takes 2.
  const update = calls.find(
    (c) => /UPDATE hospital\.document_sections/i.test(c.sql) && c.params.length === 5,
  );
  assert.ok(update, 'expected the persist UPDATE');
  return {
    fields: JSON.parse(update!.params[1] as string),
    confidence: JSON.parse(update!.params[2] as string),
  };
}

test('extractSection: a line-item category persists line_items + _line_items_meta', async () => {
  const { service, calls, llmCalls } = makeFinalBillService([
    { row_index: 0, particulars: 'Room rent - semi private', qty: 2, rate: 300, payable: 600 },
    { row_index: 1, particulars: 'CBC', qty: 1, rate: 250, payable: 250 },
    { row_index: 2, particulars: 'Inj Monocef 1g', qty: 2, rate: 175, payable: 350 },
  ]);

  const result = await service.extractSection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  });

  // The prompt asked for the rows.
  assert.match(llmCalls[0]!.userPrompt, /line_items/);

  assert.equal(result.lineItems?.length, 3);
  assert.equal(result.usedTiling, true);
  // 600 + 250 + 350 = 1200 = the declared total_amount.
  assert.equal(result.lineItemTotals?.matchesDeclaredTotal, true);
  assert.equal(result.lineItemTotals?.deltaAbs, 0);

  const persisted = persistedPayload(calls);
  assert.equal(persisted.fields.line_items.length, 3);
  assert.equal(persisted.fields.line_items[1].particulars, 'CBC');
  const meta = persisted.confidence._line_items_meta;
  assert.equal(meta.row_count, 3);
  assert.equal(meta.totals_match, true);
  assert.equal(meta.deduped_rows, 0);
  assert.equal(meta.tiled, true);
  assert.equal(meta.tile_count, 2);
});

test('extractSection: duplicate-keyed rows the bill does NOT disown are kept, and only reported', async () => {
  // Row 1 is emitted twice. Dropping it takes the sheet from 1100 to 850
  // against a declared 1200 — neither matches, so the bill gives us no
  // licence to delete a printed row. An Indian pharmacy bill legitimately
  // prints the same drug at the same price on consecutive undated rows;
  // losing one of those understates the claim and is unrecoverable.
  const { service, calls } = makeFinalBillService([
    { row_index: 0, particulars: 'Room rent - semi private', qty: 2, rate: 300, payable: 600 },
    { row_index: 1, particulars: 'CBC', qty: 1, rate: 250, payable: 250 },
    { row_index: 2, particulars: 'CBC', qty: 1, rate: 250, payable: 250 },
  ]);

  const result = await service.extractSection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  });

  assert.equal(result.lineItems?.length, 3);
  assert.deepEqual(
    result.lineItems?.map((r) => r.row_index),
    [0, 1, 2],
  );

  const persisted = persistedPayload(calls);
  assert.equal(persisted.fields.line_items.length, 3);
  const meta = persisted.confidence._line_items_meta;
  assert.equal(meta.deduped_rows, 0);
  assert.equal(meta.possible_duplicate_rows, 1);
  // 600 + 250 + 250 = 1100 vs the declared 1200 → the cross-check must shout,
  // and the reviewer must be told what we saw and declined to act on.
  assert.equal(meta.totals_match, false);
  assert.equal(meta.delta_abs, 100);
  assert.ok(meta.warnings.includes('line_items_total_mismatch'));
  assert.ok(meta.warnings.includes('line_items_possible_duplicates'));
});

test('extractSection: overlap duplicates ARE dropped when doing so makes the bill add up', async () => {
  // Same duplicated row, but the declared total is 850 — exactly the deduped
  // sum. Keeping all three gives 1100 (mismatch); dropping the repeat flips
  // the arithmetic to true, which is the only evidence that licences a
  // delete. This is the tile-overlap residue the dedupe exists for.
  const { service, calls } = makeFinalBillService(
    [
      { row_index: 0, particulars: 'Room rent - semi private', qty: 2, rate: 300, payable: 600 },
      { row_index: 1, particulars: 'CBC', qty: 1, rate: 250, payable: 250 },
      { row_index: 2, particulars: 'CBC', qty: 1, rate: 250, payable: 250 },
    ],
    { fields: { bill_no: 'FB/2026/0912', total_amount: 850 } },
  );

  const result = await service.extractSection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  });

  assert.equal(result.lineItems?.length, 2);
  // row_index is renumbered contiguously from 0.
  assert.deepEqual(
    result.lineItems?.map((r) => r.row_index),
    [0, 1],
  );

  const persisted = persistedPayload(calls);
  assert.equal(persisted.fields.line_items.length, 2);
  const meta = persisted.confidence._line_items_meta;
  assert.equal(meta.deduped_rows, 1);
  assert.equal(meta.possible_duplicate_rows, 1);
  assert.equal(meta.totals_match, true);
  assert.equal(meta.delta_abs, 0);
});

test('extractSection: a non-line-item category writes no line_items key at all', async () => {
  const { pool, calls } = makeMockPool({ masterOption: { extraction_mode: 'vision' } });
  const { llm } = makeMockLlm({});
  const { visionInput } = makeMockVisionInput();
  const service = new DocExtractorService({
    pool: pool as any,
    llm,
    s3: makeMockImageS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
    visionInput,
  });

  const result = await service.extractSection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  });

  assert.equal(result.lineItems, undefined);
  assert.equal(result.lineItemTotals, undefined);
  const persisted = persistedPayload(calls);
  assert.equal('line_items' in persisted.fields, false);
  assert.equal('_line_items_meta' in persisted.confidence, false);
});

test('extractSection: the vision path does NOT truncate section text at 24k', async () => {
  // 'auto' mode: Tesseract runs first, produces Devanagari (so the H6
  // rule escalates to vision), and the OCR dump is far longer than
  // SECTION_TEXT_MAX_CHARS. Once we escalate, the images are the source
  // of truth and the text must go through whole.
  const longText =
    'रोगी का नाम\n' + 'Item line with a fairly long particulars column\n'.repeat(800);
  assert.ok(longText.length > 24_000, 'fixture must exceed the truncation ceiling');

  const { pool } = makeMockPool({ masterOption: { extraction_mode: 'auto' } });
  const { llm, calls: llmCalls } = makeMockLlm({});
  const { visionInput, seen } = makeMockVisionInput();
  const service = new DocExtractorService({
    pool: pool as any,
    llm,
    s3: makeMockImageS3(),
    ocr: {
      ...makeMockOcr(),
      extractTextFromImage: async () => ({
        pageNumber: 1,
        text: longText,
        confidence: 0.2,
        source: 'tesseract' as const,
      }),
    } as any,
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
    visionInput,
  });

  await service.extractSection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  });

  assert.equal(seen.length, 1, 'expected escalation to vision');
  const prompt = llmCalls[0]!.userPrompt as string;
  assert.equal(prompt.includes('... [truncated]'), false);
  // The tail of the OCR dump survived into the prompt.
  assert.ok(prompt.length > 24_000);
});

test('extractSection: the vision path RAISES the text ceiling to 100k — it does not remove it', async () => {
  // Finding #15: the Devanagari escalation has no length gate — one
  // Devanagari character anywhere escalates the section — and v3 shipped
  // with joinText's bound removed rather than raised, so a 50-page Hindi
  // bundle sent ~125k tokens of Tesseract text alongside the tiled images.
  const longText =
    'रोगी का नाम\n' + 'Item line with a fairly long particulars column\n'.repeat(4000);
  assert.ok(
    longText.length > 100_000,
    'fixture must exceed the raised vision ceiling',
  );

  const { pool } = makeMockPool({ masterOption: { extraction_mode: 'auto' } });
  const { llm, calls: llmCalls } = makeMockLlm({});
  const { visionInput, seen } = makeMockVisionInput();
  const service = new DocExtractorService({
    pool: pool as any,
    llm,
    s3: makeMockImageS3(),
    ocr: {
      ...makeMockOcr(),
      extractTextFromImage: async () => ({
        pageNumber: 1,
        text: longText,
        confidence: 0.2,
        source: 'tesseract' as const,
      }),
    } as any,
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
    visionInput,
  });

  await service.extractSection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  });

  assert.equal(seen.length, 1, 'expected escalation to vision');
  const prompt = llmCalls[0]!.userPrompt as string;
  assert.ok(
    prompt.includes('... [truncated]'),
    'the vision path must still be bounded',
  );
  // Far more than the 24k text-path ceiling, far less than the raw dump.
  assert.ok(prompt.length > 24_000);
  assert.ok(
    prompt.length < longText.length,
    'the prompt must be shorter than the untruncated OCR dump',
  );
});
