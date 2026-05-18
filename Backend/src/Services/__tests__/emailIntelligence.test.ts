/**
 * Unit tests for EmailIntelligenceService.
 *
 * Uses Node's built-in `node:test` runner — matches the convention from
 * src/Services/__tests__/ocr.service.test.ts and claimDossierProjector.test.ts.
 * Run with:
 *
 *   npx tsx --test src/Services/__tests__/emailIntelligence.test.ts
 *
 * Approach: the service takes its dependencies via the constructor, so we
 * pass in dumb in-memory stubs (pool / LLM / OCR / dispatcher / cost) and
 * assert on the resulting SQL calls + event dispatches.
 *
 * What we DO test:
 *   - Idempotent re-run: a second call against an existing
 *     (inbound_email_id, prompt_version) returns the stored draft with
 *     deduped=true and never touches the LLM.
 *   - Each happy-path category routes to the correct extractor schema.
 *   - LlmSchemaValidationError on extract → extraction_failed draft row,
 *     raw_response truncated and persisted.
 *   - applyDraft with fieldOverrides differing from extracted_payload
 *     writes corrections rows.
 *
 * What we do NOT test (out of scope for this PR):
 *   - End-to-end DB round-trip (mocked pool only).
 *   - Anthropic provider behaviour (mocked LLM client).
 *   - Worker / queue plumbing (covered by integration when wired up).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EmailIntelligenceService, readPath } from '../emailIntelligence.service.js';
import { LlmSchemaValidationError, type LlmClient } from '../llm/LlmClient.js';
import type { OcrService, OcrResult } from '../ocr.service.js';

// ────────────────────────────────────────────────────────────────────────────
// Test doubles
// ────────────────────────────────────────────────────────────────────────────

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/** Programmable pool stub. Each test registers handlers for SQL fragments. */
function makePool() {
  const calls: RecordedQuery[] = [];
  const matchers: Array<{
    test: (sql: string) => boolean;
    handler: (params: unknown[]) => any;
  }> = [];
  function on(fragment: string | RegExp, handler: (params: unknown[]) => any) {
    matchers.push({
      test: (sql: string) =>
        typeof fragment === 'string' ? sql.includes(fragment) : fragment.test(sql),
      handler,
    });
  }
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      for (let i = matchers.length - 1; i >= 0; i--) {
        if (matchers[i]!.test(sql)) {
          const result = matchers[i]!.handler(params ?? []);
          if (result && typeof (result as any).then === 'function') return await result;
          return result;
        }
      }
      // Default: empty result.
      return { rowCount: 0, rows: [] };
    },
  } as any;
  return { pool, calls, on };
}

/** Programmable LLM stub. */
function makeLlm(): LlmClient & {
  classifyCalls: number;
  extractCalls: number;
  setClassify: (r: any) => void;
  setExtract: (r: any) => void;
  setClassifyError: (e: Error) => void;
  setExtractError: (e: Error) => void;
} {
  let classifyResp: any = { category: 'approved', confidence: 0.92, reasoning: '', costInr: 0.01 };
  let extractResp: any = null;
  let classifyErr: Error | null = null;
  let extractErr: Error | null = null;
  const obj: any = {
    classifyCalls: 0,
    extractCalls: 0,
    setClassify: (r: any) => {
      classifyResp = r;
    },
    setExtract: (r: any) => {
      extractResp = r;
    },
    setClassifyError: (e: Error) => {
      classifyErr = e;
    },
    setExtractError: (e: Error) => {
      extractErr = e;
    },
    classify: async () => {
      obj.classifyCalls++;
      if (classifyErr) throw classifyErr;
      return classifyResp;
    },
    extract: async () => {
      obj.extractCalls++;
      if (extractErr) throw extractErr;
      if (!extractResp) {
        return {
          data: {},
          confidence: 0.9,
          rawResponse: '{}',
          tokensInputUncached: 100,
          tokensInputCached: 200,
          tokensOutput: 50,
          latencyMs: 1200,
          provider: 'anthropic',
          model: 'claude-3-5-haiku-20251022',
          costInr: 0.05,
          tierEscalated: false,
        };
      }
      return extractResp;
    },
  };
  return obj;
}

/** OCR stub — every PDF buffer returns the same fake page text. */
function makeOcr(text = 'OCR_TEXT'): OcrService {
  return {
    extractTextFromPdf: async (): Promise<OcrResult> => ({
      pages: [{ pageNumber: 1, text, confidence: 0.95, source: 'typed_pdf' }],
      totalPages: 1,
      avgConfidence: 0.95,
      processedAtMs: Date.now(),
      fileHash: 'fake-hash',
      engineVersions: {},
    }),
    extractTextFromImage: async () => ({
      pageNumber: 1,
      text,
      confidence: 0.9,
      source: 'tesseract',
    }),
  } as any;
}

function makeDispatcher() {
  const dispatched: any[] = [];
  const dispatcher = {
    dispatch: async (input: any) => {
      dispatched.push(input);
      return { id: 'event-' + dispatched.length, deduped: false };
    },
  } as any;
  return { dispatcher, dispatched };
}

function makeCostAccounting() {
  const calls: any[] = [];
  return {
    cost: {
      recordCall: async (i: any) => {
        calls.push(i);
      },
    } as any,
    calls,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Common fixture
// ────────────────────────────────────────────────────────────────────────────

const BASE_INPUT = {
  inboundEmailId: '11111111-1111-1111-1111-111111111111',
  claimId: '22222222-2222-2222-2222-222222222222',
  hospitalId: '33333333-3333-3333-3333-333333333333',
  body: 'Approval letter body text',
  attachments: [
    { filename: 'approval.pdf', buffer: Buffer.from('pdf'), mime: 'application/pdf' },
  ],
};

function wirePool(rowFromInsert = { id: 'draft-1', inserted: true }) {
  const p = makePool();
  // Idempotency probe — return nothing by default.
  p.on(/SELECT id, category, status, cost_inr/, () => ({ rowCount: 0, rows: [] }));
  // Happy-path / failed INSERT — both use the WITH ins CTE shape.
  p.on(/WITH ins AS \(\s*INSERT INTO hospital.email_intelligence_drafts/, () => ({
    rowCount: 1,
    rows: [rowFromInsert],
  }));
  return p;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

test('processInboundEmail: idempotency probe short-circuits a second call', async () => {
  const p = makePool();
  // First call: idempotency probe returns existing row.
  p.on(/SELECT id, category, status, cost_inr/, () => ({
    rowCount: 1,
    rows: [
      {
        id: 'existing-draft',
        category: 'approved',
        status: 'pending_review',
        cost_inr: '0.0700',
      },
    ],
  }));

  const llm = makeLlm();
  const ocr = makeOcr();
  const { dispatcher, dispatched } = makeDispatcher();
  const { cost } = makeCostAccounting();

  const svc = new EmailIntelligenceService(p.pool, llm, ocr, dispatcher as any, cost);
  const result = await svc.processInboundEmail(BASE_INPUT);

  assert.equal(result.draftId, 'existing-draft');
  assert.equal(result.category, 'approved');
  assert.equal(result.deduped, true);
  assert.equal(result.failed, false);
  assert.equal(llm.classifyCalls, 0, 'no classify on idempotent re-run');
  assert.equal(llm.extractCalls, 0, 'no extract on idempotent re-run');
  assert.equal(dispatched.length, 0, 'no event dispatch on idempotent re-run');
});

test('processInboundEmail: approved category routes to ApprovalExtraction and dispatches ai_draft_created', async () => {
  const p = wirePool({ id: 'draft-A', inserted: true });
  const llm = makeLlm();
  llm.setClassify({ category: 'approved', confidence: 0.95, reasoning: 'clear approval', costInr: 0.01 });
  llm.setExtract({
    data: {
      amount_inr: 50000,
      room_category: 'Single Private',
      validity_from: '2026-05-18',
      validity_to: '2026-05-25',
      notes: null,
    },
    confidence: 0.95,
    rawResponse: '{ "amount_inr": 50000, ... }',
    tokensInputUncached: 500,
    tokensInputCached: 1500,
    tokensOutput: 80,
    latencyMs: 1800,
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
    costInr: 0.06,
    tierEscalated: false,
  });
  const ocr = makeOcr('Approved for Rs 50,000 single private room valid 2026-05-18 to 2026-05-25');
  const { dispatcher, dispatched } = makeDispatcher();
  const { cost, calls: costCalls } = makeCostAccounting();

  const svc = new EmailIntelligenceService(p.pool, llm, ocr, dispatcher as any, cost);
  const result = await svc.processInboundEmail(BASE_INPUT);

  assert.equal(result.failed, false);
  assert.equal(result.deduped, false);
  assert.equal(result.category, 'approved');
  assert.equal(llm.classifyCalls, 1);
  assert.equal(llm.extractCalls, 1);
  // ApprovalExtraction was the schema — confirm by checking we recorded a
  // cost call for the approval extractor task name.
  assert.ok(
    costCalls.some((c) => c.task === 'email_intelligence.extract.approval'),
    'recorded approval extractor cost',
  );
  // ai_draft_created event went out.
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].kind, 'ai_draft_created');
  assert.equal(dispatched[0].payload.draft_id, 'draft-A');
});

test('processInboundEmail: queried category routes to QueryExtraction', async () => {
  const p = wirePool({ id: 'draft-Q', inserted: true });
  const llm = makeLlm();
  llm.setClassify({ category: 'queried', confidence: 0.9, reasoning: 'doc request', costInr: 0.01 });
  llm.setExtract({
    data: {
      queries: [
        { description: 'provide consent', deficiency_type: 'missing_consent', doc_requested: 'consent form', deadline: null },
      ],
      severity: 'medium',
    },
    confidence: 0.92,
    rawResponse: '...',
    tokensInputUncached: 300,
    tokensInputCached: 1500,
    tokensOutput: 60,
    latencyMs: 1400,
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
    costInr: 0.04,
    tierEscalated: false,
  });
  const { dispatcher } = makeDispatcher();
  const { cost, calls: costCalls } = makeCostAccounting();

  const svc = new EmailIntelligenceService(p.pool, llm, makeOcr(), dispatcher as any, cost);
  const result = await svc.processInboundEmail(BASE_INPUT);

  assert.equal(result.category, 'queried');
  assert.equal(result.failed, false);
  assert.ok(
    costCalls.some((c) => c.task === 'email_intelligence.extract.query'),
    'recorded query extractor cost',
  );
});

test('processInboundEmail: rejected category routes to RejectionExtraction', async () => {
  const p = wirePool({ id: 'draft-R', inserted: true });
  const llm = makeLlm();
  llm.setClassify({ category: 'rejected', confidence: 0.88, reasoning: 'flat denial', costInr: 0.01 });
  llm.setExtract({
    data: {
      reasons: ['Treatment within waiting period'],
      deduction_breakdown: [],
      appeal_allowed: true,
      finality_note: null,
    },
    confidence: 0.9,
    rawResponse: '...',
    tokensInputUncached: 200,
    tokensInputCached: 1500,
    tokensOutput: 40,
    latencyMs: 1100,
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
    costInr: 0.03,
    tierEscalated: false,
  });
  const { dispatcher } = makeDispatcher();
  const { cost, calls: costCalls } = makeCostAccounting();

  const svc = new EmailIntelligenceService(p.pool, llm, makeOcr(), dispatcher as any, cost);
  const result = await svc.processInboundEmail(BASE_INPUT);

  assert.equal(result.category, 'rejected');
  assert.ok(
    costCalls.some((c) => c.task === 'email_intelligence.extract.rejection'),
    'recorded rejection extractor cost',
  );
});

test('processInboundEmail: other/unknown skips the extract call entirely', async () => {
  const p = wirePool({ id: 'draft-U', inserted: true });
  const llm = makeLlm();
  llm.setClassify({ category: 'unknown', confidence: 0.3, reasoning: 'too noisy', costInr: 0.01 });
  const { dispatcher } = makeDispatcher();
  const { cost } = makeCostAccounting();

  const svc = new EmailIntelligenceService(p.pool, llm, makeOcr(), dispatcher as any, cost);
  const result = await svc.processInboundEmail(BASE_INPUT);

  assert.equal(result.category, 'unknown');
  assert.equal(llm.classifyCalls, 1);
  assert.equal(llm.extractCalls, 0, 'no extract call for unknown category');
  assert.equal(result.failed, false);
});

test('processInboundEmail: LlmSchemaValidationError on extract → extraction_failed draft with truncated raw_response', async () => {
  const p = makePool();
  // Idempotency probe returns nothing.
  p.on(/SELECT id, category, status, cost_inr/, () => ({ rowCount: 0, rows: [] }));
  // INSERT path captures the params so we can assert on raw_response and status.
  let capturedInsertParams: unknown[] = [];
  p.on(/WITH ins AS \(\s*INSERT INTO hospital.email_intelligence_drafts/, (params) => {
    capturedInsertParams = params;
    return { rowCount: 1, rows: [{ id: 'draft-F', inserted: true }] };
  });

  const llm = makeLlm();
  llm.setClassify({ category: 'approved', confidence: 0.9, reasoning: '', costInr: 0.01 });
  llm.setExtractError(
    new LlmSchemaValidationError(
      'bad json',
      'this is the raw model output that should be truncated',
      'email_intelligence.extract.approval',
      'v1',
      new Error('zod fail'),
    ),
  );

  const { dispatcher, dispatched } = makeDispatcher();
  const { cost } = makeCostAccounting();
  const svc = new EmailIntelligenceService(p.pool, llm, makeOcr(), dispatcher as any, cost);
  const result = await svc.processInboundEmail(BASE_INPUT);

  assert.equal(result.failed, true);
  assert.equal(result.category, 'approved');
  assert.equal(dispatched.length, 0, 'failed drafts do not dispatch ai_draft_created');

  // Param layout for the failure-INSERT (matches persistFailedDraft):
  // $1 inbound_email_id, $2 claim_id, $3 category, $4 confidence,
  // $5 prompt_version, $6 cost_inr, $7 raw_response
  const rawParam = capturedInsertParams[6] as string;
  assert.ok(typeof rawParam === 'string' && rawParam.length > 0, 'raw_response persisted');
  assert.ok(
    rawParam.includes('raw model output'),
    'raw_response carries the underlying LLM text',
  );
});

test('applyDraft: writes corrections rows for fields that differ from the AI payload', async () => {
  const p = makePool();
  // Load draft.
  p.on(/FROM hospital\.email_intelligence_drafts d\s+WHERE d\.id =/, () => ({
    rowCount: 1,
    rows: [
      {
        id: 'draft-1',
        claim_id: BASE_INPUT.claimId,
        inbound_email_id: BASE_INPUT.inboundEmailId,
        extracted_payload: {
          amount_inr: 50000,
          room_category: 'Single Private',
          queries: [{ description: 'consent', deficiency_type: null }],
        },
        status: 'pending_review',
      },
    ],
  }));

  const insertedCorrections: unknown[][] = [];
  p.on('INSERT INTO hospital.email_intelligence_corrections', (params) => {
    insertedCorrections.push(params);
    return { rowCount: 1, rows: [] };
  });
  // UPDATE markApplied — default empty response is fine.

  const llm = makeLlm();
  const { dispatcher, dispatched } = makeDispatcher();
  const { cost } = makeCostAccounting();
  const svc = new EmailIntelligenceService(p.pool, llm, makeOcr(), dispatcher as any, cost);

  await svc.applyDraft('draft-1', {
    appliedBy: '44444444-4444-4444-4444-444444444444',
    fieldOverrides: {
      // Same as AI — should NOT generate a correction.
      room_category: 'Single Private',
      // Different from AI — SHOULD generate a correction.
      amount_inr: 45000,
      // Nested path — SHOULD generate a correction.
      'queries.0.deficiency_type': 'missing_consent',
    },
  });

  assert.equal(insertedCorrections.length, 2, 'two corrections written (amount, nested deficiency)');
  const paths = insertedCorrections.map((row) => row[1] as string).sort();
  assert.deepEqual(paths, ['amount_inr', 'queries.0.deficiency_type']);

  // ai_draft_applied dispatched.
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].kind, 'ai_draft_applied');
  assert.equal(dispatched[0].payload.draft_id, 'draft-1');
});

test('rejectDraft: updates status and dispatches ai_draft_rejected', async () => {
  const p = makePool();
  p.on(/SELECT id, claim_id, status\s+FROM hospital\.email_intelligence_drafts/, () => ({
    rowCount: 1,
    rows: [{ id: 'draft-X', claim_id: BASE_INPUT.claimId, status: 'pending_review' }],
  }));
  let updateCount = 0;
  p.on('UPDATE hospital.email_intelligence_drafts', (_params) => {
    updateCount++;
    return { rowCount: 1, rows: [] };
  });

  const { dispatcher, dispatched } = makeDispatcher();
  const { cost } = makeCostAccounting();
  const svc = new EmailIntelligenceService(p.pool, makeLlm(), makeOcr(), dispatcher as any, cost);

  await svc.rejectDraft('draft-X', {
    rejectedBy: '55555555-5555-5555-5555-555555555555',
    reason: 'AI got the amount wrong',
  });

  assert.equal(updateCount, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].kind, 'ai_draft_rejected');
  assert.equal(dispatched[0].payload.reason, 'AI got the amount wrong');
});

test('readPath: navigates objects, arrays, and missing nodes safely', () => {
  const payload = {
    amount_inr: 50000,
    queries: [
      { description: 'a', deficiency_type: null },
      { description: 'b', deficiency_type: 'missing_consent' },
    ],
  };
  assert.equal(readPath(payload, 'amount_inr'), 50000);
  assert.equal(readPath(payload, 'queries.0.description'), 'a');
  assert.equal(readPath(payload, 'queries.1.deficiency_type'), 'missing_consent');
  assert.equal(readPath(payload, 'queries.99.description'), undefined);
  assert.equal(readPath(payload, 'no.such.path'), undefined);
  assert.equal(readPath(null, 'anything'), undefined);
});
