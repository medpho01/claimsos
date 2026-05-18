/**
 * Unit tests for DocSegmenterService.
 *
 * Runner: node:test (matches the convention set by claimDossierProjector.test.ts
 * and ocr.service.test.ts). Run with:
 *
 *   npx tsx --test src/Services/__tests__/docSegmenter.test.ts
 *
 * Mocking strategy:
 *   - LlmClient: swapped via `__setLlmClientForTests` (exported by factory.ts).
 *   - OcrService: we re-implement just the `extractTextFromPdf` surface on a
 *     plain object and monkey-patch the singleton.
 *   - costAccounting: same pattern — monkey-patch the singleton methods.
 *   - eventDispatcher: same.
 *   - pg pool: the service accepts a pool in its constructor, so we pass a
 *     stub with a tracked `query` method.
 *
 * The classifier enqueue is overridden via `setClassifierEnqueue` and
 * collected for assertions.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __setLlmClientForTests } from '../llm/factory.js';
import {
  DocSegmenterService,
  SEGMENTER_VERSION,
  setClassifierEnqueue,
} from '../docSegmenter.service.js';
import { LlmBudgetExceededError, LlmSchemaValidationError } from '../llm/LlmClient.js';
import ocrService from '../ocr.service.js';
import costAccountingService from '../costAccounting.service.js';
import { eventDispatcher } from '../events/eventDispatcher.service.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = '22222222-2222-4222-8222-222222222222';
const HOSPITAL_ID = '33333333-3333-4333-8333-333333333333';

const SECTION_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECTION_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// ────────────────────────────────────────────────────────────────────────────
// Mock primitives
// ────────────────────────────────────────────────────────────────────────────

interface MockPoolState {
  // SQL fragment → response. Most-specific match wins.
  responders: Array<{ match: RegExp; rows: any[]; rowCount?: number }>;
  calls: Array<{ sql: string; params: unknown[] }>;
}

function makePool(state: MockPoolState) {
  return {
    query: async (sql: string, params: unknown[]) => {
      state.calls.push({ sql, params });
      for (const r of state.responders) {
        if (r.match.test(sql)) {
          return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

interface MockLlm {
  extractCalls: Array<any>;
  extractImpl: (opts: any) => Promise<any>;
}

function makeLlmClient(impl: (opts: any) => Promise<any>): MockLlm & { extract: any; classify: any } {
  const calls: any[] = [];
  return {
    extractCalls: calls,
    extractImpl: impl,
    extract: async (opts: any) => {
      calls.push(opts);
      return impl(opts);
    },
    classify: async () => {
      throw new Error('classify not used by segmenter');
    },
  };
}

// Snapshot / restore the methods we monkey-patch so a failing test doesn't
// poison the next one.
type Restore = () => void;
function patch<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]): Restore {
  const orig = obj[key];
  obj[key] = value;
  return () => {
    obj[key] = orig;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Test bed
// ────────────────────────────────────────────────────────────────────────────

interface Bed {
  poolState: MockPoolState;
  enqueueCalls: Array<{
    sectionId: string;
    documentId: string;
    claimId: string;
    hospitalId: string;
  }>;
  dispatchCalls: any[];
  costRecordCalls: any[];
  restores: Restore[];
  svc: DocSegmenterService;
  llm: MockLlm & { extract: any; classify: any };
}

function buildBed(opts: {
  ocrPages?: Array<{ pageNumber: number; text: string; confidence: number; source?: 'typed_pdf' | 'tesseract' | 'vision_fallback' }>;
  budgetAction?: 'allow' | 'throttle' | 'block';
  llmImpl?: (opts: any) => Promise<any>;
  existingSectionIds?: string[];
  insertedSectionIds?: string[];
}): Bed {
  const poolState: MockPoolState = { responders: [], calls: [] };

  // SELECT existing rows
  poolState.responders.push({
    match: /SELECT id\s+FROM hospital\.document_sections/i,
    rows: (opts.existingSectionIds ?? []).map((id) => ({ id })),
  });

  // INSERT ... RETURNING id
  poolState.responders.push({
    match: /INSERT INTO hospital\.document_sections/i,
    rows: (opts.insertedSectionIds ?? [SECTION_ID_1, SECTION_ID_2]).map((id) => ({ id })),
  });

  const pool = makePool(poolState);
  const svc = new DocSegmenterService(pool);

  const restores: Restore[] = [];

  // OCR
  const ocrPages = opts.ocrPages ?? [
    { pageNumber: 1, text: 'DISCHARGE SUMMARY for patient Asha. Admission 2026-05-01.', confidence: 0.95, source: 'typed_pdf' as const },
    { pageNumber: 2, text: 'INVESTIGATION REPORT. CBC. Hb 12.5. Platelets 250k.', confidence: 0.95, source: 'typed_pdf' as const },
  ];
  restores.push(
    patch(ocrService, 'extractTextFromPdf', (async () => ({
      pages: ocrPages,
      totalPages: ocrPages.length,
      avgConfidence: ocrPages.reduce((a, p) => a + p.confidence, 0) / Math.max(1, ocrPages.length),
      processedAtMs: Date.now(),
      fileHash: 'deadbeef',
      engineVersions: {},
    })) as any)
  );

  // Budget
  restores.push(
    patch(costAccountingService, 'checkBudget', (async () => ({
      claimUnderLimit: opts.budgetAction !== 'block',
      hospitalUnderLimit: opts.budgetAction !== 'block',
      action: opts.budgetAction ?? 'allow',
      claimSpendInr: opts.budgetAction === 'block' ? 20 : 0,
      hospitalDailySpendInr: 0,
      hospitalDailyCapInr: 3000,
      hospitalMonthlyCapInr: 50000,
      hospitalMonthlySpendInr: 0,
    })) as any)
  );

  // Cost record — collect calls
  const costRecordCalls: any[] = [];
  restores.push(
    patch(costAccountingService, 'recordCall', (async (c: any) => {
      costRecordCalls.push(c);
    }) as any)
  );

  // Event dispatcher
  const dispatchCalls: any[] = [];
  restores.push(
    patch(eventDispatcher, 'dispatch', (async (input: any) => {
      dispatchCalls.push(input);
      return { id: 'evt-1', deduped: false };
    }) as any)
  );

  // LLM
  const llm = makeLlmClient(
    opts.llmImpl ??
      (async (_o: any) => ({
        data: {
          sections: [
            { page_start: 1, page_end: 1, candidate_category: 'discharge_slip', boundary_confidence: 0.9 },
            { page_start: 2, page_end: 2, candidate_category: 'investigations', boundary_confidence: 0.85 },
          ],
          confidence: 0.88,
        },
        confidence: 0.88,
        rawResponse: '{"sections":[]}',
        tokensInputUncached: 1500,
        tokensInputCached: 0,
        tokensOutput: 200,
        latencyMs: 1200,
        provider: 'anthropic',
        model: 'claude-3-5-haiku-20241022',
        costInr: 0.12,
        tierEscalated: false,
      }))
  );
  __setLlmClientForTests(llm as any);

  // Classifier enqueue
  const enqueueCalls: Bed['enqueueCalls'] = [];
  setClassifierEnqueue(async (j) => {
    enqueueCalls.push(j);
  });

  return {
    poolState,
    enqueueCalls,
    dispatchCalls,
    costRecordCalls,
    restores,
    svc,
    llm,
  };
}

function teardownBed(bed: Bed) {
  for (const r of bed.restores) r();
  __setLlmClientForTests(null);
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('DocSegmenterService.segmentDocument', () => {
  beforeEach(() => {
    // node:test runs beforeEach inside the describe scope. Each `it` builds
    // its own bed; this hook is just here to satisfy the structure.
  });

  it('happy path: returns section ids, inserts rows, dispatches event, enqueues classifier jobs', async () => {
    const bed = buildBed({
      insertedSectionIds: [SECTION_ID_1, SECTION_ID_2],
    });
    try {
      const result = await bed.svc.segmentDocument({
        documentId: DOC_ID,
        claimId: CLAIM_ID,
        hospitalId: HOSPITAL_ID,
        buffer: Buffer.from('fake-pdf'),
      });

      assert.equal(result.shortCircuited, false);
      assert.equal(result.pagesProcessed, 2);
      assert.deepEqual(result.sectionIds, [SECTION_ID_1, SECTION_ID_2]);
      assert.ok(result.costInr > 0, 'cost should be > 0 on real LLM call');

      // One LLM call
      assert.equal(bed.llm.extractCalls.length, 1);
      const llmOpts = bed.llm.extractCalls[0];
      assert.equal(llmOpts.tier, 'cheap');
      assert.equal(llmOpts.taskName, 'doc_segmenter');
      assert.ok(llmOpts.cacheKey.includes(DOC_ID));

      // Cost recorded
      assert.equal(bed.costRecordCalls.length, 1);
      assert.equal(bed.costRecordCalls[0].task, 'doc_segmenter');

      // doc_segmented event dispatched with correct payload
      assert.equal(bed.dispatchCalls.length, 1);
      const evt = bed.dispatchCalls[0];
      assert.equal(evt.kind, 'doc_segmented');
      assert.equal(evt.claimId, CLAIM_ID);
      assert.deepEqual(evt.payload.section_ids, [SECTION_ID_1, SECTION_ID_2]);
      assert.equal(evt.payload.document_id, DOC_ID);
      assert.equal(evt.payload.segmenter_version, SEGMENTER_VERSION);

      // Classifier jobs enqueued — one per section
      assert.equal(bed.enqueueCalls.length, 2);
      assert.equal(bed.enqueueCalls[0].sectionId, SECTION_ID_1);
      assert.equal(bed.enqueueCalls[1].sectionId, SECTION_ID_2);
    } finally {
      teardownBed(bed);
    }
  });

  it('idempotency: existing sections at SEGMENTER_VERSION → short-circuits, no LLM call', async () => {
    const bed = buildBed({
      existingSectionIds: [SECTION_ID_1, SECTION_ID_2],
    });
    try {
      const result = await bed.svc.segmentDocument({
        documentId: DOC_ID,
        claimId: CLAIM_ID,
        hospitalId: HOSPITAL_ID,
        buffer: Buffer.from('fake-pdf'),
      });

      assert.equal(result.shortCircuited, true);
      assert.equal(result.pagesProcessed, 0);
      assert.equal(result.costInr, 0);
      assert.deepEqual(result.sectionIds, [SECTION_ID_1, SECTION_ID_2]);

      // No LLM call, no event, no enqueue
      assert.equal(bed.llm.extractCalls.length, 0);
      assert.equal(bed.dispatchCalls.length, 0);
      assert.equal(bed.enqueueCalls.length, 0);
      assert.equal(bed.costRecordCalls.length, 0);
    } finally {
      teardownBed(bed);
    }
  });

  it('budget block: checkBudget action=block → throws LlmBudgetExceededError before LLM call', async () => {
    const bed = buildBed({ budgetAction: 'block' });
    try {
      await assert.rejects(
        () =>
          bed.svc.segmentDocument({
            documentId: DOC_ID,
            claimId: CLAIM_ID,
            hospitalId: HOSPITAL_ID,
            buffer: Buffer.from('fake-pdf'),
          }),
        (err: unknown) => err instanceof LlmBudgetExceededError
      );

      // LLM must not be hit
      assert.equal(bed.llm.extractCalls.length, 0);
      // No event, no enqueue
      assert.equal(bed.dispatchCalls.length, 0);
      assert.equal(bed.enqueueCalls.length, 0);
    } finally {
      teardownBed(bed);
    }
  });

  it('schema validation failure: LLM throws LlmSchemaValidationError → propagates, no rows written', async () => {
    const bed = buildBed({
      llmImpl: async () => {
        throw new LlmSchemaValidationError(
          'bad shape',
          '{"not":"valid"}',
          'doc_segmenter',
          'docSegmenter.v1'
        );
      },
    });
    try {
      await assert.rejects(
        () =>
          bed.svc.segmentDocument({
            documentId: DOC_ID,
            claimId: CLAIM_ID,
            hospitalId: HOSPITAL_ID,
            buffer: Buffer.from('fake-pdf'),
          }),
        (err: unknown) => err instanceof LlmSchemaValidationError
      );

      // No INSERT should have happened
      const inserted = bed.poolState.calls.find((c) =>
        /INSERT INTO hospital\.document_sections/i.test(c.sql)
      );
      assert.equal(inserted, undefined, 'no INSERT on schema validation failure');

      // No event, no enqueue
      assert.equal(bed.dispatchCalls.length, 0);
      assert.equal(bed.enqueueCalls.length, 0);
    } finally {
      teardownBed(bed);
    }
  });

  it('empty PDF: zero pages → returns empty result without LLM call', async () => {
    const bed = buildBed({ ocrPages: [] });
    try {
      const result = await bed.svc.segmentDocument({
        documentId: DOC_ID,
        claimId: CLAIM_ID,
        hospitalId: HOSPITAL_ID,
        buffer: Buffer.from('empty'),
      });

      assert.equal(result.sectionIds.length, 0);
      assert.equal(result.pagesProcessed, 0);
      assert.equal(result.shortCircuited, false);
      assert.equal(bed.llm.extractCalls.length, 0);
    } finally {
      teardownBed(bed);
    }
  });
});
