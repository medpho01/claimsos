/**
 * Tests for DocClassifierService (Wave 2B).
 *
 * Runner: node:test (matches the rest of Backend's test suite). Execute with:
 *   npx tsx --test src/Services/__tests__/docClassifier.test.ts
 *
 * We mock pool, llm client, s3, ocr, events, costAccounting, and the
 * extractor enqueue hook — the service exposes a deps-bag constructor so
 * no module mocker is needed. The mocks are intentionally minimal and
 * verifiable (we record calls + assert on them rather than relying on
 * generic spy frameworks).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DocClassifierService, CLASSIFIER_VERSION } from '../docClassifier.service.js';
import { LlmBudgetExceededError } from '../llm/LlmClient.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const SECTION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLAIM_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const HOSPITAL_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DOCUMENT_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const S3_KEY = 'hosp/panel/patient/discharge_slip/123_xyz.pdf';

const CANDIDATE_CATEGORIES = [
  'discharge_slip',
  'investigations',
  'treatment',
  'icps',
  'surgical_discharge_slip',
  'ot_notes_and_photos',
  'post_op_photos',
  'post_op_reports',
  'implant_invoice',
  'insurer_response',
  'others',
  'admission_notes',
  'diagnosis_summary',
  'procedure_estimate',
  'consent',
  'final_bill',
  'oncologist_consent',
  'identity_proof',
  'claim_form',
  'insurer_query_letter',
  'insurer_approval_letter',
];

interface PoolCall {
  sql: string;
  params: unknown[];
}

function makeMockPool(opts: {
  sectionRow?: Record<string, unknown> | null;
  candidatesEmpty?: boolean;
  updateRowCount?: number;
} = {}) {
  const calls: PoolCall[] = [];
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
          page_end: 3,
          classifier_version: null,
          category: null,
          classification_confidence: null,
          s3_key: S3_KEY,
        };
        return { rows: [row], rowCount: 1 };
      }
      if (/FROM hospital\.master_options/i.test(trimmed)) {
        if (opts.candidatesEmpty) return { rows: [], rowCount: 0 };
        return {
          rows: CANDIDATE_CATEGORIES.map((c) => ({ code: c })),
          rowCount: CANDIDATE_CATEGORIES.length,
        };
      }
      if (/UPDATE hospital\.document_sections/i.test(trimmed)) {
        return {
          rows: [{ classifier_model: 'standard' }],
          rowCount: opts.updateRowCount ?? 1,
        };
      }
      throw new Error(`unmocked SQL in test: ${trimmed.slice(0, 80)}`);
    },
  };
  return { pool, calls };
}

interface ClassifyCall {
  systemPrompt: string;
  userPrompt: string;
  categories: readonly string[];
  promptVersion: string;
  taskName: string;
  tier: string;
  claimId?: string;
  hospitalId?: string;
}

function makeMockLlm(opts: {
  category?: string;
  confidence?: number;
  costInr?: number;
  throwError?: Error;
}) {
  const calls: ClassifyCall[] = [];
  const llm: any = {
    classify: async (params: any) => {
      calls.push(params);
      if (opts.throwError) throw opts.throwError;
      return {
        category: opts.category ?? 'discharge_slip',
        confidence: opts.confidence ?? 0.92,
        reasoning: 'mock reasoning',
        costInr: opts.costInr ?? 0.08,
      };
    },
    extract: async () => {
      throw new Error('extract should not be called in classifier tests');
    },
  };
  return { llm, calls };
}

function makeMockOcr(text: string = 'DISCHARGE SUMMARY\nPatient: Mock\nDate: 2026-05-18\n...') {
  return {
    extractTextFromPdf: async (_buf: Buffer) => ({
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
    download: async (_key: string) => {
      // A real but trivial PDF buffer: pdf-lib can load even a minimal
      // header. We build one in-memory so the slice path runs end-to-end.
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.create();
      doc.addPage([100, 100]);
      doc.addPage([100, 100]);
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
    events: {
      dispatch: async (input: any) => {
        dispatched.push(input);
        return { id: 'evt-1', deduped: false };
      },
    },
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
// Tests
// ────────────────────────────────────────────────────────────────────────────

test('classifySection: happy path persists category, dispatches event, enqueues extractor', async () => {
  const { pool, calls } = makeMockPool();
  const { llm, calls: llmCalls } = makeMockLlm({ category: 'discharge_slip', confidence: 0.92 });
  const ocr = makeMockOcr();
  const s3 = makeMockS3();
  const { dispatched, events } = makeMockEvents();
  let extractorEnqueued: { sectionId: string; claimId: string; hospitalId: string } | null = null;

  const service = new DocClassifierService({
    pool: pool as any,
    llm,
    s3,
    ocr,
    events,
    costAccounting: makeMockCostAccounting('allow'),
    enqueueExtractor: async (sectionId, claimId, hospitalId) => {
      extractorEnqueued = { sectionId, claimId, hospitalId };
    },
  });

  const result = await service.classifySection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  });

  assert.equal(result.category, 'discharge_slip');
  assert.equal(result.confidence, 0.92);

  // LLM called once with the right shape.
  assert.equal(llmCalls.length, 1);
  assert.equal(llmCalls[0]!.tier, 'standard');
  assert.equal(llmCalls[0]!.taskName, 'doc_classify');
  assert.deepEqual(llmCalls[0]!.categories, CANDIDATE_CATEGORIES);

  // UPDATE was called with the category + version.
  const updateCall = calls.find((c) => /UPDATE hospital\.document_sections/i.test(c.sql));
  assert.ok(updateCall, 'expected an UPDATE call');
  assert.equal(updateCall!.params[1], 'discharge_slip');
  assert.equal(updateCall!.params[3], CLASSIFIER_VERSION);

  // Event dispatched with idempotency key.
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.kind, 'section_classified');
  assert.equal(dispatched[0]!.payload.category, 'discharge_slip');
  assert.equal(dispatched[0]!.idempotencyKey, `section_classified:${SECTION_ID}:${CLASSIFIER_VERSION}`);

  // Extractor enqueued.
  assert.ok(extractorEnqueued, 'expected extractor enqueue');
  assert.equal(extractorEnqueued!.sectionId, SECTION_ID);
});

test('classifySection: idempotent short-circuit when classifier_version matches', async () => {
  const { pool } = makeMockPool({
    sectionRow: {
      id: SECTION_ID,
      document_id: DOCUMENT_ID,
      page_start: 1,
      page_end: 3,
      classifier_version: CLASSIFIER_VERSION,
      category: 'investigations',
      classification_confidence: 0.91,
      s3_key: S3_KEY,
    },
  });
  const { llm, calls: llmCalls } = makeMockLlm({});
  let extractorEnqueued = false;

  const service = new DocClassifierService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
    enqueueExtractor: async () => {
      extractorEnqueued = true;
    },
  });

  const result = await service.classifySection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  });

  assert.equal(result.category, 'investigations');
  assert.equal(result.costInr, 0);
  assert.equal(llmCalls.length, 0, 'LLM must NOT be called on idempotent short-circuit');
  assert.ok(extractorEnqueued, 'extractor enqueue still happens (it is itself idempotent)');
});

test('classifySection: throws LlmBudgetExceededError when checkBudget returns block', async () => {
  const { pool } = makeMockPool();
  const { llm, calls: llmCalls } = makeMockLlm({});

  const service = new DocClassifierService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('block'),
    enqueueExtractor: async () => {},
  });

  await assert.rejects(
    () =>
      service.classifySection({
        sectionId: SECTION_ID,
        claimId: CLAIM_ID,
        hospitalId: HOSPITAL_ID,
      }),
    (err: unknown) => err instanceof LlmBudgetExceededError,
  );

  // LLM never called because budget gate fired first.
  assert.equal(llmCalls.length, 0);
});

test('classifySection: low-confidence verdict is still persisted (tier escalation is bridge-internal)', async () => {
  // The standard-tier escalation lives inside the LLM bridge — by the time
  // .classify() returns, it has either escalated and returned a stronger
  // result OR returned the original low-confidence Haiku verdict. From
  // the service's perspective, both are persisted; the caller sees a low
  // confidence and can route to manual review downstream.
  const { pool, calls } = makeMockPool();
  // Mock returns 0.42 confidence simulating "bridge did NOT escalate or
  // escalation didn't help".
  const { llm, calls: llmCalls } = makeMockLlm({
    category: 'others',
    confidence: 0.42,
    // A high cost simulates the bridge having tried escalation.
    costInr: 0.7,
  });
  const { dispatched, events } = makeMockEvents();

  const service = new DocClassifierService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events,
    costAccounting: makeMockCostAccounting('allow'),
    enqueueExtractor: async () => {},
  });

  const result = await service.classifySection({
    sectionId: SECTION_ID,
    claimId: CLAIM_ID,
    hospitalId: HOSPITAL_ID,
  });

  assert.equal(result.category, 'others');
  assert.equal(result.confidence, 0.42);
  // Heuristic: cost > 0.5 -> tierEscalated true.
  assert.equal(result.tierEscalated, true);
  assert.equal(llmCalls.length, 1);

  const updateCall = calls.find((c) => /UPDATE hospital\.document_sections/i.test(c.sql));
  assert.equal(updateCall!.params[2], 0.42, 'persisted confidence matches LLM result');
  assert.equal(dispatched[0]!.payload.confidence, 0.42);
});

test('classifySection: throws if bridge returns off-list category (defence in depth)', async () => {
  const { pool } = makeMockPool();
  const { llm } = makeMockLlm({ category: 'not_a_real_category', confidence: 0.99 });
  const service = new DocClassifierService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
    enqueueExtractor: async () => {},
  });

  await assert.rejects(
    () =>
      service.classifySection({
        sectionId: SECTION_ID,
        claimId: CLAIM_ID,
        hospitalId: HOSPITAL_ID,
      }),
    (err: unknown) => /off-list category/.test((err as Error).message),
  );
});

test('classifySection: throws if section not found', async () => {
  const { pool } = makeMockPool({ sectionRow: null });
  const { llm } = makeMockLlm({});
  const service = new DocClassifierService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
    enqueueExtractor: async () => {},
  });

  await assert.rejects(
    () =>
      service.classifySection({
        sectionId: 'no-such-section',
        claimId: CLAIM_ID,
        hospitalId: HOSPITAL_ID,
      }),
    (err: unknown) => /section .* not found/.test((err as Error).message),
  );
});

test('classifySection: throws if no candidate categories in master_options', async () => {
  const { pool } = makeMockPool({ candidatesEmpty: true });
  const { llm } = makeMockLlm({});
  const service = new DocClassifierService({
    pool: pool as any,
    llm,
    s3: makeMockS3(),
    ocr: makeMockOcr(),
    events: makeMockEvents().events,
    costAccounting: makeMockCostAccounting('allow'),
    enqueueExtractor: async () => {},
  });

  await assert.rejects(
    () =>
      service.classifySection({
        sectionId: SECTION_ID,
        claimId: CLAIM_ID,
        hospitalId: HOSPITAL_ID,
      }),
    (err: unknown) => /no doc_category codes/.test((err as Error).message),
  );
});
