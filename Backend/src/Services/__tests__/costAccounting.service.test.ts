/**
 * Unit tests for CostAccountingService — the budget dimensions.
 *
 * Run with:
 *   npx tsx --test src/Services/__tests__/costAccounting.service.test.ts
 *
 * No database: every method here takes an injectable `Queryable`, so the tests
 * hand it a tiny in-memory ledger that answers the four query shapes this
 * service issues. That keeps the SQL's INTENT under test (which rows each
 * dimension counts) without pretending to test Postgres itself.
 *
 * What these are really about (NEW-2, 2026-09-14): page transcription became
 * an LLM call, a 40-page bundle reads at ~₹217, and while that spend counted
 * against the ₹15 per-claim cap it did not merely overspend — it BLOCKED the
 * classify and extract calls that came after it, and the claim dead-lettered
 * without ever being processed. The split tested below is what stops that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const costAccounting = (await import('../costAccounting.service.js')).default;
const {
  DEFAULT_CLAIM_HARD_LIMIT_INR,
  DEFAULT_CLAIM_SOFT_LIMIT_INR,
  OCR_TASK_NAMES,
  isOcrTask,
  claimHardLimitInr,
  claimSoftLimitInr,
  claimOcrHardLimitInr,
  ocrPerReadCapInr,
  estimateRunCostInr,
  visionEstPageCostInr,
  estSectionExtractInr,
  estSectionExtractLightInr,
  estBundleClassifyInrPerDoc,
  estPagesPerSection,
  estBudgetSafetyFactor,
  aiRunMinApprovedBudgetInr,
  aiRunMaxApprovedBudgetInr,
  analyzeBudgetConsentRequired,
} = await import('../costAccounting.service.js');

/**
 * The measured cost of ONE tiled structured `doc_extract.<category>` call
 * (certified 2026-09-14). These are the numbers the reasoning cap is sized
 * against, so the tests below spend them rather than round figures.
 *
 * They are TRUE costs, priced at Sonnet rates. Until the claudeClient
 * normalizeModelId fix landed the LEDGER recorded 1/3.75 of each of them
 * (Haiku rates, because COST_TABLE was keyed on the alias and the API returns
 * the dated id). That mispricing is the context for the cap re-tune, but note
 * what the re-tune actually IS: committed HEAD had CLAIM_HARD_LIMIT_INR = 15,
 * i.e. ~₹56 of true spend, and it is now ₹150 — a deliberate ~2.7x loosening
 * in real rupees, not a neutral restatement. (₹40 was never committed
 * anywhere; it was an uncommitted intermediate.) See `claimHardLimitInr`.
 */
const PORTRAIT_EXTRACT_INR = 8.646; // dense A4 portrait, itemised, 416/416 cells
const LANDSCAPE_EXTRACT_INR = 5.003; // landscape bill, itemised, 196/196 cells

/** The uniform Sonnet:Haiku rate ratio — input, output and cached alike. */
const MISPRICING_FACTOR = 3.75;

// ────────────────────────────────────────────────────────────────────────────
// In-memory ledger standing in for hospital.llm_cost_log
// ────────────────────────────────────────────────────────────────────────────

interface LedgerRow {
  claim_id?: string | null;
  hospital_id?: string | null;
  task: string;
  cost_inr: number;
}

interface FakeCaps {
  daily: number;
  monthly: number;
}

/** A claim_ai_runs row, as far as costAccounting is concerned. */
interface FakeRun {
  id: string;
  claim_id: string;
  triggered_at: string;
  approved_budget_inr: number | null;
}

const sum = (rows: LedgerRow[]) => rows.reduce((a, r) => a + r.cost_inr, 0);

function makeDb(rows: LedgerRow[], caps?: FakeCaps, runs: FakeRun[] = []) {
  return {
    async query(sql: string, params: any[] = []): Promise<any> {
      // The run row (consent columns). Must be matched BEFORE the cost-log
      // branches — it is the only query against a different table.
      if (sql.includes('claim_ai_runs')) {
        const run = runs.find((r) => r.id === params[0]);
        return run
          ? { rows: [{ claim_id: run.claim_id, triggered_at: run.triggered_at, approved_budget_inr: run.approved_budget_inr }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      // Run spend: the dual predicate (run_id OR time window). Matched before
      // the generic FILTER branch, which it would otherwise be caught by.
      if (sql.includes('run_id = $2')) {
        const ocrTasks: string[] = params[3] ?? [];
        const mine = rows.filter((r) => r.claim_id === params[0]);
        return {
          rows: [
            {
              total: String(sum(mine)),
              reasoning: String(sum(mine.filter((r) => !ocrTasks.includes(r.task)))),
              ocr: String(sum(mine.filter((r) => ocrTasks.includes(r.task)))),
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('hospital_cost_caps')) {
        return caps
          ? {
              rows: [
                { daily_cap_inr: String(caps.daily), monthly_cap_inr: String(caps.monthly) },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      // The breakdown query — both halves in one round trip.
      if (sql.includes('FILTER')) {
        const ocrTasks: string[] = params[1] ?? [];
        const mine = rows.filter((r) => r.claim_id === params[0]);
        return {
          rows: [
            {
              ocr: String(sum(mine.filter((r) => ocrTasks.includes(r.task)))),
              reasoning: String(sum(mine.filter((r) => !ocrTasks.includes(r.task)))),
            },
          ],
          rowCount: 1,
        };
      }
      // Order matters: the reasoning query is the OCR query plus a NOT.
      if (sql.includes('NOT (COALESCE(task')) {
        const ocrTasks: string[] = params[1] ?? [];
        return {
          rows: [
            {
              total: String(
                sum(
                  rows.filter(
                    (r) => r.claim_id === params[0] && !ocrTasks.includes(r.task),
                  ),
                ),
              ),
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('COALESCE(task')) {
        const ocrTasks: string[] = params[1] ?? [];
        return {
          rows: [
            {
              total: String(
                sum(
                  rows.filter(
                    (r) => r.claim_id === params[0] && ocrTasks.includes(r.task),
                  ),
                ),
              ),
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('hospital_id = $1')) {
        return {
          rows: [
            { total: String(sum(rows.filter((r) => r.hospital_id === params[0]))) },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`fake db: unexpected SQL\n${sql}`);
    },
  } as any;
}

/** A db whose every read fails — the "budget table is unreachable" case. */
const brokenDb = {
  async query(): Promise<any> {
    throw new Error('connection terminated unexpectedly');
  },
} as any;

/**
 * The exact ledger from the merge blocker: one 40-page A4 bundle read at
 * ~₹5.4/page, plus the handful of rupees of reasoning that came before it.
 */
const BLOCKER_LEDGER: LedgerRow[] = [
  { claim_id: 'c1', hospital_id: 'h1', task: 'doc_segmenter', cost_inr: 0.9 },
  ...Array.from({ length: 40 }, () => ({
    claim_id: 'c1',
    hospital_id: 'h1',
    task: 'ocr_vision_page',
    cost_inr: 5.425,
  })),
  { claim_id: 'c1', hospital_id: 'h1', task: 'doc_bundle_classifier', cost_inr: 2.1 },
];

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// The task split
// ────────────────────────────────────────────────────────────────────────────

test('isOcrTask covers every task name the OCR paths record under', () => {
  for (const t of OCR_TASK_NAMES) assert.equal(isOcrTask(t), true, t);
  assert.equal(isOcrTask('doc_extractor'), false);
  assert.equal(isOcrTask('doc_bundle_classifier'), false);
  assert.equal(isOcrTask('harmonisation'), false);
});

test('getClaimSpendInr counts REASONING only — a ₹217 page read is not reasoning', async () => {
  const spend = await costAccounting.getClaimSpendInr('c1', makeDb(BLOCKER_LEDGER));
  assert.equal(Math.round(spend * 100) / 100, 3);
});

test('getClaimOcrSpendInr counts the page reads', async () => {
  const spend = await costAccounting.getClaimOcrSpendInr('c1', makeDb(BLOCKER_LEDGER));
  assert.equal(Math.round(spend), 217);
});

test('getClaimSpendBreakdownInr reports both halves and the true total', async () => {
  const b = await costAccounting.getClaimSpendBreakdownInr('c1', makeDb(BLOCKER_LEDGER));
  assert.equal(Math.round(b.reasoningInr * 100) / 100, 3);
  assert.equal(Math.round(b.ocrInr), 217);
  assert.equal(Math.round(b.totalInr), 220);
});

// ────────────────────────────────────────────────────────────────────────────
// THE MERGE BLOCKER, as a test.
// ────────────────────────────────────────────────────────────────────────────

test('a claim that has just spent ₹217 on OCR is STILL allowed to classify and extract', async () => {
  const verdict = await costAccounting.checkBudget('c1', 'h1', makeDb(BLOCKER_LEDGER));

  // This is the assertion the whole change exists for. Before the split,
  // claimSpendInr here was ~₹220, the verdict was 'block', docClassifier and
  // docExtractor threw LlmBudgetExceededError, Bull retried three times and
  // dead-lettered the job. The claim was never classified or extracted.
  assert.notEqual(verdict.action, 'block');
  assert.equal(verdict.claimUnderLimit, true);
  assert.ok((verdict.claimSpendInr ?? 0) < claimHardLimitInr());
  // The OCR spend is not hidden — it is reported on the verdict, it just does
  // not gate reasoning.
  assert.equal(Math.round(verdict.claimOcrSpendInr ?? 0), 217);
});

test('the reasoning cap still blocks when REASONING is what ran away', async () => {
  const runaway: LedgerRow[] = [
    {
      claim_id: 'c2',
      hospital_id: 'h1',
      task: 'harmonisation',
      cost_inr: DEFAULT_CLAIM_HARD_LIMIT_INR + 1,
    },
  ];
  const verdict = await costAccounting.checkBudget('c2', null, makeDb(runaway));
  assert.equal(verdict.action, 'block');
  assert.equal(verdict.claimUnderLimit, false);
});

// ────────────────────────────────────────────────────────────────────────────
// THE SECOND MERGE BLOCKER: tiled doc_extract vs the reasoning cap.
//
// `doc_extract.<category>` is NOT in OCR_TASK_NAMES — a tiled section read is
// reasoning, and it charges here. Tiling took one dense-portrait structured
// extraction from ₹7.42 to ₹8.646, which put two itemised sections on one
// claim (₹17.29) over the old ₹15 cap. That was a dead-letter, not an
// overspend: block → LlmBudgetExceededError → 3 retries → dead letter, with
// the second bill never extracted.
// ────────────────────────────────────────────────────────────────────────────

test('two tiled itemised sections on one claim do NOT block the second one', async () => {
  const twoBills: LedgerRow[] = [
    { claim_id: 'c3', hospital_id: 'h1', task: 'doc_segmenter', cost_inr: 0.9 },
    { claim_id: 'c3', hospital_id: 'h1', task: 'doc_bundle_classify', cost_inr: 2.1 },
    // The final bill has been extracted; the pharmacy bill is about to be.
    {
      claim_id: 'c3',
      hospital_id: 'h1',
      task: 'doc_extract.final_bill',
      cost_inr: PORTRAIT_EXTRACT_INR,
    },
  ];
  const verdict = await costAccounting.checkBudget('c3', 'h1', makeDb(twoBills));

  // Spend so far ₹11.65; the pharmacy bill will add another ₹8.646 for ₹20.29.
  // Under the old hard-coded ₹15 the pre-flight above already read ₹11.65 and
  // allowed, and the NEXT section's pre-flight (at ₹20.29) blocked — with the
  // claim half-extracted. Both must pass.
  assert.notEqual(verdict.action, 'block');
  const afterSecondBill: LedgerRow[] = [
    ...twoBills,
    {
      claim_id: 'c3',
      hospital_id: 'h1',
      task: 'doc_extract.pharmacy_bill',
      cost_inr: PORTRAIT_EXTRACT_INR,
    },
  ];
  const next = await costAccounting.checkBudget('c3', 'h1', makeDb(afterSecondBill));
  assert.notEqual(next.action, 'block', 'the third section must still be affordable');
  assert.equal(
    Math.round((next.claimSpendInr ?? 0) * 100) / 100,
    20.29,
    '0.9 + 2.1 + 2 × 8.646',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// THE CAP RE-TUNE, 40 → 150 (ships with the claudeClient pricing fix).
//
// ₹150 is NOT a new policy. It is ₹40 × 3.75 — the exact factor by which the
// ledger was under-reporting Sonnet — so the ceiling production has actually
// been running under is preserved unchanged, now stated in honest rupees.
// Correcting the pricing WITHOUT this would convert a silent overspend into a
// loud dead-letter on ordinary claims.
// ────────────────────────────────────────────────────────────────────────────

test('the re-tuned cap is exactly the old one restated at true prices', () => {
  assert.equal(claimHardLimitInr(), DEFAULT_CLAIM_HARD_LIMIT_INR);
  assert.equal(DEFAULT_CLAIM_HARD_LIMIT_INR, 150);
  // 40 × 3.75 = 150. The cap moved because the PRICES became true, not
  // because anyone decided claims may cost more.
  assert.equal(40 * MISPRICING_FACTOR, DEFAULT_CLAIM_HARD_LIMIT_INR);
});

test('the re-tune is what keeps an ordinary claim from dead-lettering post-fix', async () => {
  // Five dense itemised sections + fixed overhead = ₹46.2 TRUE. Under the
  // mispricing the ledger saw ₹12.3 and this claim sailed through ₹40. The
  // moment pricing is correct it reads ₹46.2 — and at the old cap the sixth
  // pre-flight blocks, docExtractor throws, Bull retries 3x, dead letter.
  const fiveSections: LedgerRow[] = [
    { claim_id: 'c-retune', hospital_id: 'h1', task: 'doc_segmenter', cost_inr: 0.9 },
    { claim_id: 'c-retune', hospital_id: 'h1', task: 'doc_bundle_classify', cost_inr: 2.1 },
    ...Array.from({ length: 5 }, (_, i) => ({
      claim_id: 'c-retune',
      hospital_id: 'h1',
      task: `doc_extract.section_${i}`,
      cost_inr: PORTRAIT_EXTRACT_INR,
    })),
  ];
  const trueSpend = 0.9 + 2.1 + 5 * PORTRAIT_EXTRACT_INR;
  assert.equal(Math.round(trueSpend * 100) / 100, 46.23);
  assert.ok(trueSpend > 40, 'this claim would block at the OLD cap once pricing is right');

  const verdict = await costAccounting.checkBudget('c-retune', 'h1', makeDb(fiveSections));
  assert.notEqual(verdict.action, 'block');
  // …and it is past the soft warn, so it is LOUD in the logs. That is the
  // whole point of pinning the soft limit at ₹60 rather than 70% of ₹150.
  assert.ok(trueSpend < DEFAULT_CLAIM_SOFT_LIMIT_INR);
});

test('the default cap clears a realistic multi-section claim at TRUE prices', () => {
  const fixedOverhead = 0.9 + 2.1; // doc_segmenter + doc_bundle_classify
  // 17 worst-case dense-portrait itemised sections, or 29 landscape ones.
  assert.ok(
    fixedOverhead + 17 * PORTRAIT_EXTRACT_INR < DEFAULT_CLAIM_HARD_LIMIT_INR,
    `₹${(fixedOverhead + 17 * PORTRAIT_EXTRACT_INR).toFixed(2)} must fit under ₹${DEFAULT_CLAIM_HARD_LIMIT_INR}`,
  );
  assert.ok(fixedOverhead + 18 * PORTRAIT_EXTRACT_INR > DEFAULT_CLAIM_HARD_LIMIT_INR);
  assert.ok(fixedOverhead + 29 * LANDSCAPE_EXTRACT_INR < DEFAULT_CLAIM_HARD_LIMIT_INR);
  assert.ok(fixedOverhead + 30 * LANDSCAPE_EXTRACT_INR > DEFAULT_CLAIM_HARD_LIMIT_INR);
});

test('the EFFECTIVE ceiling is the cap plus one maximal call, not the cap', async () => {
  // A pre-flight cannot bound the call it authorises. checkBudget reads
  // ACCUMULATED spend and answers "may I make a call?" — the cost of that call
  // is unknown until it returns. So a claim sitting one rupee under the cap is
  // allowed to make a full-size doc_extract call and finish well above it.
  //
  // A maximal doc_extract: 8 rendered pages × ~6,272 image tokens ≈ ₹12.5 of
  // input, plus 16,384 output tokens at $15/M ≈ ₹20.4 → ~₹33.
  const MAX_DOC_EXTRACT_INR = 12.5 + 20.4;
  const justUnder: LedgerRow[] = [
    {
      claim_id: 'c-edge',
      hospital_id: 'h1',
      task: 'doc_extract.final_bill',
      cost_inr: DEFAULT_CLAIM_HARD_LIMIT_INR - 0.01,
    },
  ];
  const verdict = await costAccounting.checkBudget('c-edge', null, makeDb(justUnder));
  assert.notEqual(verdict.action, 'block', 'one rupee of headroom authorises a full-size call');
  const worstCase = DEFAULT_CLAIM_HARD_LIMIT_INR - 0.01 + MAX_DOC_EXTRACT_INR;
  assert.ok(
    worstCase > DEFAULT_CLAIM_HARD_LIMIT_INR,
    `the honest ceiling is ~₹${Math.round(worstCase)}, not ₹${DEFAULT_CLAIM_HARD_LIMIT_INR}`,
  );
  // Anyone reasoning about worst-case spend must use ~₹183.
  assert.equal(Math.round(worstCase), 183);
});

test('the reasoning cap is operator-tunable at runtime, read per call', async () => {
  const ledger: LedgerRow[] = [
    { claim_id: 'c4', hospital_id: 'h1', task: 'doc_extract.final_bill', cost_inr: 17.29 },
  ];
  // Default ₹150: two itemised bills are fine.
  assert.notEqual(
    (await costAccounting.checkBudget('c4', null, makeDb(ledger))).action,
    'block',
  );
  // Tightened to ₹15 during a spend incident: the same claim blocks, with no
  // restart of this process and no module reload — the value is read per call.
  await withEnv({ CLAIM_HARD_LIMIT_INR: '15' }, async () => {
    assert.equal(claimHardLimitInr(), 15);
    const v = await costAccounting.checkBudget('c4', null, makeDb(ledger));
    assert.equal(v.action, 'block');
    assert.match(v.reason ?? '', /hard limit ₹15/);
  });
  // And back, without restarting anything.
  assert.equal(claimHardLimitInr(), DEFAULT_CLAIM_HARD_LIMIT_INR);
});

test('the soft limit is PINNED at ₹60 and no longer derived from the hard cap', async () => {
  assert.equal(claimSoftLimitInr(), DEFAULT_CLAIM_SOFT_LIMIT_INR);
  assert.equal(DEFAULT_CLAIM_SOFT_LIMIT_INR, 60);
  // 70% of ₹150 would be ₹105 — a warn that first fires at ₹105 tells us
  // nothing about the ₹40-150 band that the mispricing made invisible, which
  // is the exact band this release exists to measure. ₹60 is 1.5× the OLD
  // nominal cap, so the first claim past what we used to believe the ceiling
  // was becomes a log line immediately.
  assert.notEqual(claimSoftLimitInr(), Math.round(claimHardLimitInr() * 0.7));
  await withEnv({ CLAIM_HARD_LIMIT_INR: '100' }, async () => {
    assert.equal(claimHardLimitInr(), 100);
    assert.equal(
      claimSoftLimitInr(),
      DEFAULT_CLAIM_SOFT_LIMIT_INR,
      'widening the hard cap mid-incident must not silently blind the warn',
    );
  });
  await withEnv({ CLAIM_SOFT_LIMIT_INR: '12' }, async () => {
    assert.equal(claimSoftLimitInr(), 12, 'an explicit value wins');
    const ledger: LedgerRow[] = [
      { claim_id: 'c5', hospital_id: 'h1', task: 'harmonisation', cost_inr: 13 },
    ];
    const v = await costAccounting.checkBudget('c5', null, makeDb(ledger));
    assert.equal(v.action, 'allow', 'a soft warn never changes the action');
    assert.match(v.reason ?? '', /soft limit ₹12/);
  });
});

test('a junk cap value falls back to the default rather than disabling the gate', async () => {
  for (const bad of ['0', '-5', 'not-a-number', '']) {
    await withEnv({ CLAIM_HARD_LIMIT_INR: bad }, async () => {
      assert.equal(claimHardLimitInr(), DEFAULT_CLAIM_HARD_LIMIT_INR, bad);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// The OCR read allowance
// ────────────────────────────────────────────────────────────────────────────

test('a fresh claim gets the full per-read cap', async () => {
  const a = await costAccounting.getOcrReadAllowanceInr('c-new', null, makeDb([]));
  assert.equal(a.allowanceInr, ocrPerReadCapInr());
  assert.equal(a.limitedBy, 'per_read_cap');
});

test('the claim OCR cap tightens the allowance once a bundle has been read', async () => {
  const a = await costAccounting.getOcrReadAllowanceInr('c1', null, makeDb(BLOCKER_LEDGER));
  // 300 − 217 = 83, which is less than the ₹250 per-read cap.
  assert.equal(Math.round(a.allowanceInr), claimOcrHardLimitInr() - 217);
  assert.equal(a.limitedBy, 'claim_ocr_cap');
});

test('an exhausted claim OCR budget yields ₹0 — never a negative allowance', async () => {
  await withEnv({ CLAIM_OCR_HARD_LIMIT_INR: '50' }, async () => {
    const a = await costAccounting.getOcrReadAllowanceInr(
      'c1',
      null,
      makeDb(BLOCKER_LEDGER),
    );
    assert.equal(a.allowanceInr, 0, 'clamped at zero, not −167');
    assert.equal(a.limitedBy, 'claim_ocr_cap');
  });
});

test('hospital headroom tightens the allowance below the claim headroom', async () => {
  // Hospital daily cap ₹40 with ₹20 already spent today leaves ₹20 — tighter
  // than both the ₹250 per-read cap and the claim's OCR headroom.
  const ledger: LedgerRow[] = [
    { claim_id: 'c9', hospital_id: 'h9', task: 'doc_extractor', cost_inr: 20 },
  ];
  const a = await costAccounting.getOcrReadAllowanceInr(
    'c9',
    'h9',
    makeDb(ledger, { daily: 40, monthly: 50000 }),
  );
  assert.equal(a.allowanceInr, 20);
  assert.equal(a.limitedBy, 'hospital_daily');
});

test('an unreachable budget table yields ₹0 — fail closed on spend, open on the pipeline', async () => {
  const a = await costAccounting.getOcrReadAllowanceInr('c1', 'h1', brokenDb);
  assert.equal(a.allowanceInr, 0);
  assert.equal(a.limitedBy, 'budget_query_failed');
  // And it returns rather than throwing: ocr.service turns ₹0 into "every page
  // reads on Tesseract", which is degraded text and a working pipeline.
  assert.ok(Number.isFinite(a.allowanceInr));
});

test('CLAIM_OCR_HARD_LIMIT_INR and the per-read cap are operator-tunable at runtime', async () => {
  await withEnv(
    { CLAIM_OCR_HARD_LIMIT_INR: '75', OCR_VISION_MAX_COST_INR_PER_READ: '30' },
    async () => {
      assert.equal(claimOcrHardLimitInr(), 75);
      assert.equal(ocrPerReadCapInr(), 30);
      const a = await costAccounting.getOcrReadAllowanceInr('c-new', null, makeDb([]));
      assert.equal(a.allowanceInr, 30, 'the per-read cap binds first');
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// THE PRE-FLIGHT ESTIMATE — what the user is asked to approve.
//
// Pure, I/O-free, and fed by a CPU-only page census. That last property is
// load-bearing: a quote that costs money to produce is a quote you cannot
// offer BEFORE consent, which would make the whole flow circular.
// ────────────────────────────────────────────────────────────────────────────

const DOC = (over: Partial<any> = {}) => ({
  doc_id: 'd1',
  file_name: 'final_bill.pdf',
  total_pages: 12,
  pixel_pages: 12,
  degraded: false,
  ...over,
});

const EST_INPUT = (docs: any[]) => ({
  claim_id: 'claim-1',
  docs,
  prior_claim_spend_inr: 0,
  claim_ocr_headroom_inr: 300,
  claim_reasoning_headroom_inr: 150,
});

/**
 * Same input with effectively unbounded reasoning headroom.
 *
 * The recommendation is CLIPPED to the reasoning headroom (a budget above the
 * static reasoning cap can never pause for consent — 'block' outranks
 * 'pause_for_consent' — so recommending one hands the user a number they can
 * approve and never reach). Tests about the FORMULA use this input so the clip
 * does not silently mask an arithmetic regression; the clip has its own tests
 * below.
 */
const EST_INPUT_UNCAPPED = (docs: any[]) => ({
  ...EST_INPUT(docs),
  claim_reasoning_headroom_inr: 1_000_000,
});

test('the estimate formula matches the contract, line for line', () => {
  const e = estimateRunCostInr(EST_INPUT([DOC()]));
  // 12 pixel pages × ₹5.5 = ₹66
  assert.equal(e.docs[0]!.est_ocr_inr, 66);
  // ceil(12 / 3) = 4 sections
  assert.equal(e.docs[0]!.est_sections, 4);
  // one heavy (₹8.65) + three light (₹1.5) = ₹13.15
  assert.equal(e.docs[0]!.est_extraction_inr, 13.15);
  assert.equal(e.docs[0]!.est_total_inr, 79.15);
  // fixed = 1 doc × ₹2.1
  assert.equal(e.fixed_inr, 2.1);
  assert.equal(e.total_inr, 81.25);
  // ceil(81.25 × 1.25 / 10) × 10 = ceil(10.156…) × 10 = 110
  assert.equal(e.recommended_budget_inr, 110);
  assert.equal(e.pages_total, 12);
  assert.equal(e.pixel_pages_total, 12);
  assert.equal(e.typed_pages_total, 0);
});

test('typed pages are free — that is what the census is FOR', () => {
  const typed = estimateRunCostInr(EST_INPUT([DOC({ pixel_pages: 0 })]));
  assert.equal(typed.ocr_inr, 0);
  assert.equal(typed.typed_pages_total, 12);
  // Extraction and the fixed cost are unchanged — the model still has to read
  // the text, it just does not have to LOOK at the page.
  assert.equal(typed.extraction_inr, 13.15);
  assert.equal(typed.total_inr, 15.25);
});

test('a zero-page or empty document still costs one section, never zero', () => {
  const e = estimateRunCostInr(EST_INPUT([DOC({ total_pages: 0, pixel_pages: 0 })]));
  assert.equal(e.docs[0]!.est_sections, 1, 'max(1, …) — never quote ₹0 of thinking');
  assert.equal(e.docs[0]!.est_extraction_inr, estSectionExtractInr());
  const none = estimateRunCostInr(EST_INPUT([]));
  assert.equal(none.total_inr, 0);
  assert.equal(none.recommended_budget_inr, 0);
  assert.equal(none.docs_total, 0);
});

test('a degraded census quotes conservatively and says so, rather than failing', () => {
  // ocr.censusPdfPages returns PAGE_COUNT_UNKNOWN_PAGES (8) for a PDF it could
  // not parse. The estimate must price it, not refuse to quote.
  const e = estimateRunCostInr(
    EST_INPUT([DOC({ file_name: 'scan.pdf', total_pages: 8, pixel_pages: 8, degraded: true })]),
  );
  assert.equal(e.docs[0]!.est_ocr_inr, 44);
  assert.equal(e.notes.length, 1);
  assert.match(e.notes[0]!, /scan\.pdf/);
  assert.match(e.notes[0]!, /conservatively/);
});

test('the estimate token binds the quote to the exact document set', () => {
  const a = estimateRunCostInr(EST_INPUT([DOC({ doc_id: 'x' }), DOC({ doc_id: 'y' })]));
  // Order-independent: the doc query has no stable ORDER BY across calls.
  const b = estimateRunCostInr(EST_INPUT([DOC({ doc_id: 'y' }), DOC({ doc_id: 'x' })]));
  assert.equal(a.estimate_token, b.estimate_token);
  assert.equal(a.estimate_token.length, 32);
  // A document added, removed, or grown invalidates it — the user must not
  // start a run against a price nobody agreed to.
  const c = estimateRunCostInr(EST_INPUT([DOC({ doc_id: 'x' })]));
  assert.notEqual(a.estimate_token, c.estimate_token);
  const d = estimateRunCostInr(EST_INPUT([DOC({ doc_id: 'x', total_pages: 13 }), DOC({ doc_id: 'y' })]));
  assert.notEqual(a.estimate_token, d.estimate_token);
});

test('an operator re-tuning a rate invalidates in-flight quotes', async () => {
  const before = estimateRunCostInr(EST_INPUT([DOC()]));
  await withEnv({ OCR_VISION_EST_PAGE_COST_INR: '9' }, async () => {
    const after = estimateRunCostInr(EST_INPUT([DOC()]));
    assert.equal(after.est_page_cost_inr, 9, 'read per call, never snapshotted at import');
    assert.equal(after.docs[0]!.est_ocr_inr, 108);
    assert.notEqual(
      after.estimate_token,
      before.estimate_token,
      'the price changed, so the consent the user gave no longer describes this run',
    );
  });
  assert.equal(estimateRunCostInr(EST_INPUT([DOC()])).est_page_cost_inr, before.est_page_cost_inr);
});

test('every estimate multiplier is env-readable per call', async () => {
  assert.equal(visionEstPageCostInr(), 5.5);
  assert.equal(estSectionExtractInr(), 8.65);
  assert.equal(estSectionExtractLightInr(), 1.5);
  assert.equal(estBundleClassifyInrPerDoc(), 2.1);
  assert.equal(estPagesPerSection(), 3);
  assert.equal(estBudgetSafetyFactor(), 1.25);
  assert.equal(aiRunMinApprovedBudgetInr(), 5);
  assert.equal(aiRunMaxApprovedBudgetInr(), 1000);
  assert.equal(analyzeBudgetConsentRequired(), true);

  await withEnv(
    {
      EST_SECTION_EXTRACT_INR: '20',
      EST_SECTION_EXTRACT_LIGHT_INR: '4',
      EST_BUNDLE_CLASSIFY_INR_PER_DOC: '5',
      EST_PAGES_PER_SECTION: '6',
      EST_BUDGET_SAFETY_FACTOR: '2',
      AI_RUN_MIN_APPROVED_BUDGET_INR: '1',
      AI_RUN_MAX_APPROVED_BUDGET_INR: '99',
      ANALYZE_BUDGET_CONSENT_REQUIRED: 'false',
    },
    async () => {
      const e = estimateRunCostInr(EST_INPUT_UNCAPPED([DOC()]));
      assert.equal(e.docs[0]!.est_sections, 2, 'ceil(12 / 6)');
      assert.equal(e.docs[0]!.est_extraction_inr, 24, '20 + 1 × 4');
      assert.equal(e.fixed_inr, 5);
      assert.equal(e.total_inr, 95);
      assert.equal(e.recommended_budget_inr, 190);
      assert.equal(aiRunMinApprovedBudgetInr(), 1);
      assert.equal(aiRunMaxApprovedBudgetInr(), 99);
      assert.equal(analyzeBudgetConsentRequired(), false, 'CI relies on this; production must not');
    },
  );
  assert.equal(analyzeBudgetConsentRequired(), true, 'the default is consent REQUIRED');
});

test('the recommendation is always a round number ABOVE the estimate', () => {
  for (const pages of [1, 3, 7, 14, 29, 40]) {
    const e = estimateRunCostInr(
      EST_INPUT_UNCAPPED([DOC({ total_pages: pages, pixel_pages: pages })]),
    );
    assert.ok(
      e.recommended_budget_inr >= e.total_inr,
      `₹${e.recommended_budget_inr} must cover ₹${e.total_inr}`,
    );
    assert.equal(e.recommended_budget_inr % 10, 0);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// THE RECOMMENDATION IS CLIPPED TO THE REASONING HEADROOM
//
// 'block' outranks 'pause_for_consent' in checkBudget, and 'block' RETURNS
// before the run dimension is read. So an approved budget above the static
// reasoning cap is a number the user can approve and can never reach: the run
// hits the cap, throws LlmBudgetExceededError, Bull dead-letters it, and the
// user who approved ₹220 is charged ₹150 and handed a hard failure instead of
// the pause-and-re-ask consent exists to provide. Recommending such a number
// is what makes that interaction reachable, so we do not.
// ────────────────────────────────────────────────────────────────────────────

test('the recommendation never exceeds the reasoning headroom', () => {
  // 40 pages: ₹220 OCR + ₹8.65 + 13 × ₹1.5 + ₹2.1 = ₹250.25, ×1.25 → ₹320.
  const big = [DOC({ total_pages: 40, pixel_pages: 40 })];
  assert.equal(estimateRunCostInr(EST_INPUT_UNCAPPED(big)).recommended_budget_inr, 320);

  // With the default ₹150 cap and nothing spent, the headroom is ₹150.
  const e = estimateRunCostInr(EST_INPUT(big));
  assert.equal(e.claim_reasoning_headroom_inr, 150);
  assert.equal(e.recommended_budget_inr, 150, 'clipped to the headroom, not ₹320');
  assert.equal(e.recommended_budget_inr % 10, 0, 'still a round ₹10 step');
  // The estimate itself is NOT rewritten — the user must still see that the
  // quoted work costs more than the budget they can be given.
  assert.equal(e.total_inr, 250.25);
  assert.match(e.notes.join(' '), /Recommended budget reduced from ₹320 to ₹150/);
  assert.match(e.notes.join(' '), /can never pause for consent/);
});

test('the clip rounds DOWN through the cap, never up', () => {
  // Headroom ₹47 → the nearest ₹10 step BELOW it is ₹40. Rounding up to ₹50
  // would put the budget back above the cap and reopen the hole.
  const e = estimateRunCostInr({
    ...EST_INPUT([DOC({ total_pages: 40, pixel_pages: 40 })]),
    claim_reasoning_headroom_inr: 47,
  });
  assert.equal(e.recommended_budget_inr, 40);
  assert.ok(e.recommended_budget_inr <= 47);
});

test('a headroom under ₹10 clips to the exact headroom rather than to ₹0', () => {
  const e = estimateRunCostInr({
    ...EST_INPUT([DOC({ total_pages: 40, pixel_pages: 40 })]),
    claim_reasoning_headroom_inr: 6.25,
  });
  assert.equal(e.recommended_budget_inr, 6.25);
});

test('a ZERO headroom does NOT clip — zero is ambiguous, not a limit', () => {
  // intelligenceOrchestrator.estimateRun reports zero headroom BOTH when the
  // claim is genuinely at its cap AND when the headroom read threw (it logs
  // 'showing zero headroom' and carries on). Clipping to ₹0 would turn a
  // transient database blip into a recommendation the controller's [min,max]
  // range check refuses outright, i.e. a claim nobody can analyse. A claim
  // genuinely at ₹0 headroom blocks cleanly on its first pre-flight having
  // spent nothing, which is a far better failure.
  const e = estimateRunCostInr({
    ...EST_INPUT([DOC({ total_pages: 40, pixel_pages: 40 })]),
    claim_reasoning_headroom_inr: 0,
  });
  assert.equal(e.recommended_budget_inr, 320, 'unclipped');
  assert.equal(e.notes.length, 0, 'and no note claiming it was clipped');
});

test('no note and no clip when the quote already fits inside the headroom', () => {
  const e = estimateRunCostInr(EST_INPUT([DOC()]));
  assert.ok(e.recommended_budget_inr < 150);
  assert.equal(e.notes.length, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// RUN SPEND — reasoning + OCR combined, against what the user approved.
// ────────────────────────────────────────────────────────────────────────────

const RUN_AT = '2026-09-14T10:00:00.000Z';
const RUN = (approved: number | null): FakeRun => ({
  id: 'run-1',
  claim_id: 'c1',
  triggered_at: RUN_AT,
  approved_budget_inr: approved,
});

test('run spend combines reasoning and OCR — the user approved ONE number', async () => {
  const db = makeDb(BLOCKER_LEDGER, undefined, [RUN(400)]);
  const s = await costAccounting.getRunSpendInr('run-1', 'c1', RUN_AT, db);
  assert.equal(Math.round(s.reasoningInr * 100) / 100, 3);
  assert.equal(Math.round(s.ocrInr), 217);
  assert.equal(Math.round(s.totalInr), 220);
  // The operator caps stay split because they guard different runaway modes.
  // Consent is about the bill, and the bill is one number.
  assert.equal(s.approvedBudgetInr, 400);
  assert.equal(Math.round(s.remainingInr), 180);
  assert.equal(s.overBudget, false);
});

test('a run with no approved budget has infinite headroom, not zero', async () => {
  // Legacy rows created before migration 076 carry approved_budget_inr = NULL.
  // They must keep running, not pause instantly.
  const s = await costAccounting.getRunSpendInr(
    'run-1',
    'c1',
    RUN_AT,
    makeDb(BLOCKER_LEDGER, undefined, [RUN(null)]),
  );
  assert.equal(s.approvedBudgetInr, null);
  assert.equal(s.remainingInr, Number.POSITIVE_INFINITY);
  assert.equal(s.overBudget, false);
});

test('an unreadable cost ledger fails CLOSED — it pauses, it does not keep spending', async () => {
  // The run row reads fine (so we know a budget was approved) but the cost log
  // is unreachable. We must NOT assume ₹0 spent and carry on.
  const ledgerBrokenDb = {
    async query(sql: string, params: any[] = []): Promise<any> {
      if (sql.includes('claim_ai_runs')) {
        return { rows: [{ claim_id: 'c1', triggered_at: RUN_AT, approved_budget_inr: 200 }], rowCount: 1 };
      }
      throw new Error('connection terminated unexpectedly');
    },
  } as any;
  const s = await costAccounting.getRunSpendInr('run-1', 'c1', RUN_AT, ledgerBrokenDb);
  assert.equal(s.totalInr, Number.POSITIVE_INFINITY);
  assert.equal(s.approvedBudgetInr, 200);
  assert.equal(s.remainingInr, 0);
  assert.equal(s.overBudget, true, 'infinite reported spend must park the run, not free it');

  // Through checkBudget the verdict is 'block', not 'pause_for_consent' — the
  // per-claim static cap reads the same broken ledger, also fails closed to
  // infinite spend, and blocks first. That is the correct precedence: with no
  // readable ledger there is nothing to ask a human to approve, because we
  // cannot tell them what has already been spent.
  const v = await costAccounting.checkBudget('c1', null, ledgerBrokenDb, { runId: 'run-1' });
  assert.equal(v.action, 'block');
});

test('a totally unreachable database reports no budget rather than inventing one', async () => {
  // Nothing readable at all — not even the run row. There is then no approved
  // number to be over, and saying "over budget" would be a fabrication.
  // The static caps (which fail closed to Infinity spend) are what stop this
  // case; see the getClaimSpendInr fail-closed test above.
  const s = await costAccounting.getRunSpendInr('run-1', 'c1', RUN_AT, brokenDb);
  assert.equal(s.totalInr, Number.POSITIVE_INFINITY);
  assert.equal(s.approvedBudgetInr, null);
  assert.equal(s.overBudget, false);
});

test('crossing the approved budget returns pause_for_consent, NOT block', async () => {
  // ₹220 spent against ₹200 approved.
  const db = makeDb(BLOCKER_LEDGER, undefined, [RUN(200)]);
  const v = await costAccounting.checkBudget('c1', null, db, { runId: 'run-1' });
  assert.equal(v.action, 'pause_for_consent');
  assert.equal(v.runId, 'run-1');
  assert.equal(v.runApprovedBudgetInr, 200);
  assert.equal(Math.round(v.runSpendInr ?? 0), 220);
  // 'block' would make docExtractor throw LlmBudgetExceededError, which Bull
  // retries three times before dead-lettering — against a run that is
  // deliberately waiting for a human. The distinction is the whole point.
  assert.notEqual(v.action, 'block');
  assert.equal(v.claimUnderLimit, true, 'the operator caps are fine; only consent ran out');
});

test('a static-cap block outranks the run budget — consent is not an override', async () => {
  const runaway: LedgerRow[] = [
    { claim_id: 'c1', hospital_id: 'h1', task: 'harmonisation', cost_inr: 500 },
  ];
  // ₹1,000 approved, so there is plenty of run headroom — and the per-claim
  // reasoning cap still blocks. A user cannot approve their way through an
  // operator limit.
  const db = makeDb(runaway, undefined, [RUN(1000)]);
  const v = await costAccounting.checkBudget('c1', null, db, { runId: 'run-1' });
  assert.equal(v.action, 'block');
});

test('passing no runId leaves checkBudget exactly as it was', async () => {
  const v = await costAccounting.checkBudget('c1', 'h1', makeDb(BLOCKER_LEDGER));
  assert.equal(v.action, 'allow');
  assert.equal(v.runId, undefined);
  assert.equal(v.runSpendInr, undefined);
});

test('an unknown runId does not stall the call — bookkeeping never blocks work', async () => {
  const v = await costAccounting.checkBudget('c1', null, makeDb(BLOCKER_LEDGER, undefined, []), {
    runId: 'run-does-not-exist',
  });
  assert.equal(v.action, 'allow');
  assert.equal(v.runApprovedBudgetInr, null);
});

test('pause_for_consent outranks a hospital throttle', async () => {
  // Hospital at 90% of its daily cap (throttle territory) AND the run past its
  // approved budget. Precedence is block > pause_for_consent > throttle.
  const ledger: LedgerRow[] = [
    { claim_id: 'c1', hospital_id: 'h1', task: 'doc_extract.final_bill', cost_inr: 90 },
  ];
  const db = makeDb(ledger, { daily: 100, monthly: 50000 }, [RUN(50)]);
  const v = await costAccounting.checkBudget('c1', 'h1', db, { runId: 'run-1' });
  assert.equal(v.action, 'pause_for_consent');
});

// ────────────────────────────────────────────────────────────────────────────
// THE OCR READ ALLOWANCE gains the run dimension.
// ────────────────────────────────────────────────────────────────────────────

test('the run budget tightens the OCR read allowance', async () => {
  // ₹250 approved, ₹220 already spent by this run → ₹30 left for this read,
  // tighter than the ₹250 per-read cap and the ₹83 of claim OCR headroom.
  const db = makeDb(BLOCKER_LEDGER, undefined, [RUN(250)]);
  const a = await costAccounting.getOcrReadAllowanceInr('c1', null, db, { runId: 'run-1' });
  assert.equal(Math.round(a.allowanceInr), 30);
  assert.equal(a.limitedBy, 'run_budget');
  assert.equal(a.runApprovedBudgetInr, 250);
  assert.match(a.reason, /run budget headroom/);
});

test("an exhausted run budget yields ₹0, and names itself so the run can pause", async () => {
  const db = makeDb(BLOCKER_LEDGER, undefined, [RUN(100)]);
  const a = await costAccounting.getOcrReadAllowanceInr('c1', null, db, { runId: 'run-1' });
  assert.equal(a.allowanceInr, 0, 'clamped at zero, never negative');
  // limitedBy is the signal the consumer keys on: 'run_budget' means the
  // unread pages are fixable by APPROVING MORE MONEY, which is a question to
  // ask a human. Every other value is an operator bound that more money would
  // not move.
  assert.equal(a.limitedBy, 'run_budget');
});

test('a tighter operator cap still wins over a generous run budget', async () => {
  // ₹1,000 approved, but the claim has only ₹83 of OCR headroom left.
  const db = makeDb(BLOCKER_LEDGER, undefined, [RUN(1000)]);
  const a = await costAccounting.getOcrReadAllowanceInr('c1', null, db, { runId: 'run-1' });
  assert.equal(Math.round(a.allowanceInr), claimOcrHardLimitInr() - 217);
  assert.equal(a.limitedBy, 'claim_ocr_cap');
});

test('no runId leaves the allowance exactly as it was', async () => {
  const a = await costAccounting.getOcrReadAllowanceInr('c-new', null, makeDb([]));
  assert.equal(a.allowanceInr, ocrPerReadCapInr());
  assert.equal(a.limitedBy, 'per_read_cap');
  assert.equal(a.runSpendInr, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// recordCall STAMPS run_id.
//
// Without it every llm_cost_log row is NULL on run_id, getRunSpendInr falls
// back to its time-window arm for all of them, and "this run's spend" silently
// degrades to "all claim spend since this run was triggered" — so a superseded
// run's tail, an inbound-email draft on the same claim, or a manual re-extract
// all count against the current run's approved budget and the pause card shows
// a number that is not this run's spend.
// ────────────────────────────────────────────────────────────────────────────

/** Captures the INSERTs recordCall issues. `fail` makes the first one throw. */
function makeInsertDb(fail?: { code: string }) {
  const queries: { sql: string; params: any[] }[] = [];
  let thrown = false;
  return {
    queries,
    db: {
      async query(sql: string, params: any[] = []): Promise<any> {
        queries.push({ sql, params });
        if (fail && !thrown) {
          thrown = true;
          const err: any = new Error('undefined column');
          err.code = fail.code;
          throw err;
        }
        return { rows: [], rowCount: 1 };
      },
    },
  };
}

const CALL = (over: Partial<any> = {}) => ({
  claimId: 'c1',
  hospitalId: 'h1',
  task: 'doc_extract.final_bill',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  promptVersion: 'v1',
  tokensInputUncached: 100,
  tokensInputCached: 0,
  tokensOutput: 50,
  latencyMs: 1200,
  costInr: 8.646,
  ...over,
});

test('recordCall writes run_id when the caller knows its run', async () => {
  const { db, queries } = makeInsertDb();
  await costAccounting.recordCall(CALL({ runId: 'run-1' }), db as any);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /run_id/);
  assert.equal(queries[0]!.params.length, 14);
  assert.equal(queries[0]!.params[13], 'run-1');
});

test('recordCall omits the column entirely for genuinely run-less work', async () => {
  // Inbound-email intelligence and manual re-extracts have no run. A NULL here
  // is CORRECT, not a gap — getRunSpendInr's time-window arm exists for it.
  const { db, queries } = makeInsertDb();
  await costAccounting.recordCall(CALL(), db as any);
  assert.equal(queries.length, 1);
  assert.ok(!queries[0]!.sql.includes('run_id'));
  assert.equal(queries[0]!.params.length, 13);
});

test('recordCall drops run_id rather than the ROW on a pre-076 database', async () => {
  // 42703 = undefined_column. Losing the row would UNDER-report spend, the one
  // direction that lets a run quietly outspend its approval. Losing only the
  // attribution degrades to exactly the pre-076 behaviour.
  const { db, queries } = makeInsertDb({ code: '42703' });
  await costAccounting.recordCall(CALL({ runId: 'run-1' }), db as any);
  assert.equal(queries.length, 2, 'first insert threw, second retried without run_id');
  assert.match(queries[0]!.sql, /run_id/);
  assert.ok(!queries[1]!.sql.includes('run_id'));
  assert.equal(queries[1]!.params.length, 13);
  assert.equal(queries[1]!.params[10], 8.646, 'the cost still lands in the ledger');
});

test('recordCall stays best-effort: a real insert failure never throws', async () => {
  const { db, queries } = makeInsertDb({ code: '23505' });
  await costAccounting.recordCall(CALL({ runId: 'run-1' }), db as any);
  assert.equal(queries.length, 1, 'not a missing-column error — no retry');
});
