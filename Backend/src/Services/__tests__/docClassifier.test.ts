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
  /**
   * Sibling rows returned by `loadBundleContext` (the v2 bundle-aware
   * prompt). Defaults to the single current section, which makes
   * loadBundleContext return null — the pre-v2 behaviour. Before this
   * responder existed the query fell through to the "unmocked SQL" throw and
   * every test that got as far as the LLM call died there.
   */
  bundleSiblings?: Array<Record<string, unknown>>;
} = {}) {
  const calls: PoolCall[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const trimmed = sql.trim();
      if (
        /SELECT id, page_start, page_end, category, classification_confidence/i.test(
          trimmed,
        )
      ) {
        const rows =
          opts.bundleSiblings ??
          [
            {
              id: SECTION_ID,
              page_start: 1,
              page_end: 3,
              category: null,
              classification_confidence: null,
            },
          ];
        return { rows, rowCount: rows.length };
      }
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

/**
 * `optsCalls` records the OcrExtractOpts each read was made with. ocr.service
 * sizes the vision page budget from those opts and the engine it picks per
 * page follows from that budget, so "which opts did the classifier pass" IS
 * "which transcription did the classifier see".
 */
function makeMockOcr(text: string = 'DISCHARGE SUMMARY\nPatient: Mock\nDate: 2026-05-18\n...') {
  const optsCalls: any[] = [];
  return {
    optsCalls,
    extractTextFromPdf: async (_buf: Buffer, opts?: any) => {
      optsCalls.push(opts ?? null);
      return {
        pages: [{ pageNumber: 1, text, confidence: 0.95, source: 'typed_pdf' as const }],
        totalPages: 1,
        avgConfidence: 0.95,
        processedAtMs: Date.now(),
        fileHash: 'mockhash',
        engineVersions: {},
      };
    },
    // The image fast path. Present so the double satisfies the full injected
    // surface rather than type-checking and then exploding the first time a
    // section turns out to be a JPEG.
    extractTextFromImage: async (_buf: Buffer, opts?: any) => {
      optsCalls.push(opts ?? null);
      return {
        pageNumber: 1,
        text,
        confidence: 0.95,
        source: 'vision_fallback' as const,
      };
    },
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

function makeMockCostAccounting(
  action: 'allow' | 'block' | 'throttle' | 'pause_for_consent' = 'allow',
) {
  // `recorded` captures every recordCall so tests can assert that classify
  // spend is now logged (benchmark B1 fix). The array is attached to the
  // same object the service receives as its costAccounting dep — the
  // service ignores the extra property (structural typing).
  //
  // `budgetCalls` captures the ARGUMENTS of every checkBudget. That matters
  // as much as the verdict: checkBudget only reads the run's approved budget
  // — and so can only ever answer 'pause_for_consent' — when it is handed a
  // run id in its 4th argument. Without it the whole consent path below is
  // unreachable dead code.
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
 * its methods is sufficient — no module mocker required.
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
    blockPhase: ledger.blockPhase,
  };
  const pauses: any[] = [];
  const blocks: any[][] = [];
  (claimAiRunService as any).getLatestRun = async () => run;
  (claimAiRunService as any).getRunSpend = async () => ({ totalInr: 42 });
  (claimAiRunService as any).computeProjectedRemainingInr = async () => 88;
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
    Object.assign(claimAiRunService as any, {
      getLatestRun: orig.getLatestRun,
      getRunSpend: orig.getRunSpend,
      computeProjectedRemainingInr: orig.computeProjectedRemainingInr,
      pauseForConsent: orig.pauseForConsent,
    });
    (ledger as any).blockPhase = orig.blockPhase;
  }
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
  const cost = makeMockCostAccounting('allow');
  let extractorEnqueued: { sectionId: string; claimId: string; hospitalId: string } | null = null;

  const service = new DocClassifierService({
    pool: pool as any,
    llm,
    s3,
    ocr,
    events,
    costAccounting: cost,
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

  // The section slice is read as an ATTENDED, SECTION-scoped call
  // (2026-09-14). This used to pass no opts at all, which ocr.service reads
  // as unattended inbound-email ingestion and caps at 3 vision pages — while
  // docExtractor, reading the byte-identical slice with a claim context, got
  // 8. Two dependent steps, two transcriptions of the same page. These four
  // fields are exactly what docExtractor's ocrCallOpts passes, which is what
  // makes the two reads resolve to the same engine per page.
  assert.equal(ocr.optsCalls.length, 1);
  const ocrOpts = ocr.optsCalls[0];
  assert.ok(ocrOpts, 'the OCR call must not be made with undefined opts');
  assert.equal(ocrOpts.attended, true);
  assert.equal(ocrOpts.visionBudgetScope, 'section');
  assert.equal(ocrOpts.claimId, CLAIM_ID);
  assert.equal(ocrOpts.hospitalId, HOSPITAL_ID);

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

  // B1 fix: classify spend is recorded to the cost log exactly once, with
  // the claim/hospital/task attribution checkBudget reads back.
  assert.equal(cost.recorded.length, 1, 'expected exactly one recordCall');
  assert.equal(cost.recorded[0]!.task, 'doc_classify');
  assert.equal(cost.recorded[0]!.claimId, CLAIM_ID);
  assert.equal(cost.recorded[0]!.hospitalId, HOSPITAL_ID);
  assert.equal(cost.recorded[0]!.costInr, 0.08);
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

// ────────────────────────────────────────────────────────────────────────────
// MID-RUN COST CONSENT (requirement 3b).
//
// `checkBudget` returns 'pause_for_consent' ONLY inside `if (opts?.runId)`.
// This call site passed no runId, so the pause arm below it — and
// pauseRunForConsent with it — was unreachable dead code: classify spent
// against the static operator caps alone while the budget the user actually
// approved bound nothing.
// ────────────────────────────────────────────────────────────────────────────

test('classifySection: the budget pre-flight passes the ACTIVE RUN ID', async () => {
  const { pool } = makeMockPool();
  const { llm } = makeMockLlm({ category: 'discharge_slip', confidence: 0.92 });
  const cost = makeMockCostAccounting('allow');

  await withRun({ id: 'run-9', status: 'running' }, async () => {
    const service = new DocClassifierService({
      pool: pool as any,
      llm,
      s3: makeMockS3(),
      ocr: makeMockOcr(),
      events: makeMockEvents().events,
      costAccounting: cost,
      enqueueExtractor: async () => {},
    });
    await service.classifySection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    });

    assert.equal(cost.budgetCalls.length, 1);
    const [claimId, hospitalId, , budgetOpts] = cost.budgetCalls[0]!;
    assert.equal(claimId, CLAIM_ID);
    assert.equal(hospitalId, HOSPITAL_ID);
    assert.deepEqual(budgetOpts, { runId: 'run-9' });

    // …and the same id lands on the cost row, so per-run spend is this run's
    // spend and not "every rupee on this claim since triggered_at".
    assert.equal(cost.recorded.length, 1);
    assert.equal(cost.recorded[0]!.runId, 'run-9');
  });
});

test('classifySection: a paused or terminal run resolves to NO run id', async () => {
  const { pool } = makeMockPool();
  const { llm } = makeMockLlm({ category: 'discharge_slip', confidence: 0.92 });
  const cost = makeMockCostAccounting('allow');

  await withRun({ id: 'run-9', status: 'paused' }, async () => {
    const service = new DocClassifierService({
      pool: pool as any,
      llm,
      s3: makeMockS3(),
      ocr: makeMockOcr(),
      events: makeMockEvents().events,
      costAccounting: cost,
      enqueueExtractor: async () => {},
    });
    await service.classifySection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    });
    assert.deepEqual(cost.budgetCalls[0]![3], { runId: null });
    assert.equal(cost.recorded[0]!.runId, null);
  });
});

test('classifySection: pause_for_consent parks the run instead of throwing', async () => {
  const { pool } = makeMockPool();
  const { llm, calls: llmCalls } = makeMockLlm({});
  const cost = makeMockCostAccounting('pause_for_consent');

  await withRun({ id: 'run-9', status: 'running' }, async ({ pauses, blocks }) => {
    const service = new DocClassifierService({
      pool: pool as any,
      llm,
      s3: makeMockS3(),
      ocr: makeMockOcr(),
      events: makeMockEvents().events,
      costAccounting: cost,
      enqueueExtractor: async () => {},
    });

    // Returns, does NOT throw. A throw would burn Bull's three retries
    // against a run that is deliberately waiting on a person, and the
    // section would dead-letter — the pause would have destroyed work
    // rather than deferred it.
    const out = await service.classifySection({
      sectionId: SECTION_ID,
      claimId: CLAIM_ID,
      hospitalId: HOSPITAL_ID,
    });
    assert.equal(out.category, '');
    assert.equal(out.costInr, 0);

    // Nothing was spent.
    assert.equal(llmCalls.length, 0);
    assert.equal(cost.recorded.length, 0);

    // The run is parked and the classify phase is marked for re-run on resume.
    assert.equal(pauses.length, 1);
    assert.equal(pauses[0]!.run_id, 'run-9');
    assert.equal(pauses[0]!.spend_inr, 42);
    assert.equal(pauses[0]!.projected_remaining_inr, 88);
    assert.deepEqual(blocks[0]!.slice(0, 4), [
      DOCUMENT_ID,
      'run-9',
      'classify',
      'run_budget_exhausted',
    ]);
  });
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
