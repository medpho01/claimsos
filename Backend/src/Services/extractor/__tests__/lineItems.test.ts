/**
 * Line-items contract tests. Pure, no network, no LLM.
 *
 * Run: npx tsx --test src/Services/extractor/__tests__/lineItems.test.ts
 *
 * Two invariants are worth more than the rest and are asserted hardest:
 *   1. null and 0 stay distinguishable end to end (a fabricated zero in a
 *      discount column silently changes what a claim is worth);
 *   2. the schema fragment is OPTIONAL, so a category with no table keeps
 *      validating exactly as it does today.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  LINE_ITEMS_SCHEMA_FRAGMENT,
  LINE_ITEM_CATEGORIES,
  LineItemSchema,
  buildLineItemsPromptBlock,
  checkLineItemTotals,
  dedupeLineItems,
  isLineItemCategory,
  type LineItem,
} from '../lineItems.js';

// ── fixture ─────────────────────────────────────────────────────────────

function row(partial: Partial<LineItem> & { particulars: string }): LineItem {
  return {
    row_index: 0,
    code: null,
    date: null,
    qty: null,
    rate: null,
    gross: null,
    discount: null,
    net: null,
    tax_pct: null,
    payable: null,
    source_page: null,
    ...partial,
  } as LineItem;
}

// ── schema ──────────────────────────────────────────────────────────────

describe('LineItemSchema', () => {
  it('accepts a minimal row and keeps null distinct from 0', () => {
    const parsed = LineItemSchema.parse({
      row_index: 0,
      particulars: 'Room Rent - Semi Private',
      discount: null,
      payable: 0,
    });
    assert.equal(parsed.discount, null, 'null must survive as null, not become 0');
    assert.equal(parsed.payable, 0, 'a printed zero must survive as 0');
    assert.equal(parsed.code, undefined, 'an absent key stays absent');
  });

  it('coerces numeric strings the model sometimes emits', () => {
    const parsed = LineItemSchema.parse({
      row_index: '3',
      particulars: 'Inj. Pantoprazole',
      qty: '2',
      payable: '1250.50',
    });
    assert.equal(parsed.row_index, 3);
    assert.equal(parsed.qty, 2);
    assert.equal(parsed.payable, 1250.5);
  });

  it('rejects a row with no particulars', () => {
    assert.throws(() => LineItemSchema.parse({ row_index: 0 }));
  });
});

describe('LINE_ITEMS_SCHEMA_FRAGMENT', () => {
  it('is spreadable into a payload schema without breaking existing payloads', () => {
    const schema = z.object({
      fields: z.record(z.string(), z.unknown()),
      confidence: z.number(),
      ...LINE_ITEMS_SCHEMA_FRAGMENT,
    });

    // A category with no table — byte-for-byte the payload shape today.
    const noTable = schema.parse({ fields: { bill_no: 'FB/1' }, confidence: 0.9 });
    assert.equal('line_items' in noTable ? noTable.line_items : undefined, undefined);

    // A category with a table.
    const withTable = schema.parse({
      fields: { bill_no: 'FB/1' },
      confidence: 0.9,
      line_items: [{ row_index: 0, particulars: 'Room Rent', payable: 100 }],
      line_items_confidence: 0.88,
    });
    assert.equal(withTable.line_items?.length, 1);
    assert.equal(withTable.line_items_confidence, 0.88);
  });
});

describe('isLineItemCategory', () => {
  it('recognises the seeded itemised-table categories', () => {
    assert.equal(isLineItemCategory('final_bill'), true);
    assert.equal(isLineItemCategory('pharmacy_bill'), true);
    assert.equal(isLineItemCategory('FINAL_BILL'), true, 'case-insensitive');
    assert.equal(isLineItemCategory(' final_bill '), true, 'whitespace-tolerant');
  });

  it('rejects everything else, including empty input', () => {
    assert.equal(isLineItemCategory('discharge_summary'), false);
    assert.equal(isLineItemCategory(''), false);
    assert.equal(isLineItemCategory(undefined as any), false);
  });

  it('exposes the seed set', () => {
    assert.ok(LINE_ITEM_CATEGORIES.has('interim_bill'));
    assert.ok(LINE_ITEM_CATEGORIES.has('itemised_bill'));
  });
});

// ── dedupe ──────────────────────────────────────────────────────────────

describe('dedupeLineItems', () => {
  /** An overlap-region artefact: the shared row emitted twice, byte-identical. */
  const overlapArtefact = () => [
    row({ row_index: 0, particulars: 'Room Rent - Semi Private', code: 'HCP1001', date: '2026-02-11', payable: 4500 }),
    row({ row_index: 1, particulars: 'Nursing Charges', code: 'HCP1002', date: '2026-02-11', payable: 900 }),
    row({ row_index: 2, particulars: 'Nursing  Charges', code: 'hcp1002', date: '2026-02-11', payable: 900 }),
    row({ row_index: 3, particulars: 'ECG 12 Lead', code: 'LAB2001', date: '2026-02-12', payable: 350 }),
  ];

  it('drops the overlap duplicate ONLY when doing so fixes the declared total', () => {
    // Rows as read sum to 6650; the bill says 5750. Dropping the repeat makes
    // the arithmetic work, which is the evidence that licenses the delete.
    const { items, removed, possibleDuplicates, deduped } = dedupeLineItems(overlapArtefact(), 5750);
    assert.equal(deduped, true);
    assert.equal(removed, 1);
    assert.equal(possibleDuplicates, 1);
    assert.deepEqual(items.map((i) => i.row_index), [0, 1, 2]);
    assert.deepEqual(items.map((i) => i.particulars), [
      'Room Rent - Semi Private',
      'Nursing Charges',
      'ECG 12 Lead',
    ]);
  });

  it('keeps a genuinely repeated pharmacy row that the bill total vouches for', () => {
    // An Indian pharmacy bill prints the same drug at the same price on
    // consecutive rows with NO per-row date. All three dispensings are real:
    // the printed total says 45, and the rows as read already sum to 45.
    // Dropping two of them would understate the bill by 30 rupees.
    const rows = [
      row({ row_index: 0, particulars: 'TAB PARACETAMOL 650', payable: 15 }),
      row({ row_index: 1, particulars: 'TAB PARACETAMOL 650', payable: 15 }),
      row({ row_index: 2, particulars: 'TAB PARACETAMOL 650', payable: 15 }),
    ];
    const { items, removed, possibleDuplicates, deduped } = dedupeLineItems(rows, 45);
    assert.equal(deduped, false, 'the total already matches — nothing licences a delete');
    assert.equal(removed, 0);
    assert.equal(items.length, 3, 'every printed row survives');
    assert.equal(possibleDuplicates, 2, 'but the repeats are reported');
  });

  it('keeps every row when dropping duplicates still would not fix the total', () => {
    // A mismatch that dedupe does not resolve means the duplicates were not
    // the problem. Deleting rows on a guess is unrecoverable; keeping them is
    // visible to the reviewer.
    const { items, removed, deduped } = dedupeLineItems(overlapArtefact(), 9999);
    assert.equal(deduped, false);
    assert.equal(removed, 0);
    assert.equal(items.length, 4);
  });

  it('keeps every row when there is no declared total to test against', () => {
    // No total = no evidence. This is the single-argument call shape, and it
    // must never silently shorten a bill.
    const { items, removed, possibleDuplicates, deduped } = dedupeLineItems(overlapArtefact());
    assert.equal(deduped, false);
    assert.equal(removed, 0);
    assert.equal(items.length, 4);
    assert.equal(possibleDuplicates, 1);
    assert.deepEqual(items.map((i) => i.row_index), [0, 1, 2, 3], 'still renumbered contiguously');
  });

  it('keeps two genuinely repeated charges that differ on any key part', () => {
    // Same drug given on two days is TWO rows, not a duplicate.
    const { items, removed, possibleDuplicates } = dedupeLineItems([
      row({ row_index: 0, particulars: 'Inj. Pantoprazole 40mg', date: '2026-02-11', payable: 120 }),
      row({ row_index: 1, particulars: 'Inj. Pantoprazole 40mg', date: '2026-02-12', payable: 120 }),
      row({ row_index: 2, particulars: 'Inj. Pantoprazole 40mg', date: '2026-02-12', payable: 240 }),
    ]);
    assert.equal(removed, 0);
    assert.equal(possibleDuplicates, 0);
    assert.equal(items.length, 3);
  });

  it('handles an empty array and malformed entries without throwing', () => {
    assert.deepEqual(dedupeLineItems([]), {
      items: [],
      removed: 0,
      possibleDuplicates: 0,
      deduped: false,
    });
    // A null is not a row — it is always dropped, with or without evidence.
    const { items, removed } = dedupeLineItems([null as any, row({ particulars: 'X' })]);
    assert.equal(items.length, 1);
    assert.equal(removed, 1);
  });
});

// ── totals cross-check ──────────────────────────────────────────────────

describe('checkLineItemTotals', () => {
  const rows = [
    row({ row_index: 0, particulars: 'A', net: 1000, payable: 1180 }),
    row({ row_index: 1, particulars: 'B', net: 2000, payable: 2240 }),
    row({ row_index: 2, particulars: 'C', net: 500, payable: 500 }),
  ];

  it('matches when the rows add up to the declared grand total', () => {
    const check = checkLineItemTotals(rows, 3920);
    assert.equal(check.rowCount, 3);
    assert.equal(check.sumPayable, 3920);
    assert.equal(check.sumNet, 3500);
    assert.equal(check.matchesDeclaredTotal, true);
    assert.equal(check.deltaAbs, 0);
    assert.deepEqual(check.warnings, []);
  });

  it('tolerates rounding within the default 1 rupee', () => {
    assert.equal(checkLineItemTotals(rows, 3920.6).matchesDeclaredTotal, true);
    assert.equal(checkLineItemTotals(rows, 3922).matchesDeclaredTotal, false);
  });

  it('warns when a row is missing — the signal tiling exists to fix', () => {
    const check = checkLineItemTotals(rows.slice(0, 2), 3920);
    assert.equal(check.matchesDeclaredTotal, false);
    assert.equal(check.deltaAbs, 500);
    assert.ok(check.warnings.includes('line_items_total_mismatch'));
  });

  it('falls back to the net column when no row has a payable', () => {
    const netOnly = rows.map((r) => ({ ...r, payable: null }));
    const check = checkLineItemTotals(netOnly, 3500);
    assert.equal(check.sumPayable, null);
    assert.equal(check.matchesDeclaredTotal, true);
  });

  it('returns null verdicts when there is nothing to compare against', () => {
    const check = checkLineItemTotals(rows, null);
    assert.equal(check.matchesDeclaredTotal, null);
    assert.equal(check.deltaAbs, null);
    assert.deepEqual(check.warnings, []);
  });

  it('warns on an empty table', () => {
    const check = checkLineItemTotals([], 100);
    assert.equal(check.rowCount, 0);
    assert.equal(check.sumPayable, null);
    assert.equal(check.matchesDeclaredTotal, null);
    assert.ok(check.warnings.includes('line_items_empty'));
  });

  it('reports duplicate-key rows without removing them', () => {
    // This is the warning that reaches _line_items_meta when dedupeLineItems
    // declined to delete — the reviewer's only signal that repeats exist.
    const repeated = [
      row({ row_index: 0, particulars: 'TAB PARACETAMOL 650', payable: 15 }),
      row({ row_index: 1, particulars: 'TAB PARACETAMOL 650', payable: 15 }),
    ];
    const check = checkLineItemTotals(repeated, 30);
    assert.equal(check.rowCount, 2, 'the rows are still there');
    assert.equal(check.possibleDuplicateRows, 1);
    assert.ok(check.warnings.includes('line_items_possible_duplicates'));
    assert.equal(check.matchesDeclaredTotal, true);
  });

  it('reports no duplicates for a table of distinct rows', () => {
    assert.equal(checkLineItemTotals(rows, 3920).possibleDuplicateRows, 0);
  });

  it('ignores nulls rather than treating them as zero', () => {
    const mixed = [
      row({ row_index: 0, particulars: 'A', payable: 100 }),
      row({ row_index: 1, particulars: 'B', payable: null }),
    ];
    assert.equal(checkLineItemTotals(mixed, 100).sumPayable, 100);
  });
});

// ── prompt block ────────────────────────────────────────────────────────

describe('buildLineItemsPromptBlock', () => {
  it('states the null-vs-zero rule, the merge rule and the no-summarising rule', () => {
    // Rule 3 is the MERGE rule, and it is now selected from the axis the tiler
    // actually used — a wide page is cut into VERTICAL column strips ('x'), a
    // dense portrait page into HORIZONTAL row bands ('y'), and the two rules
    // are opposites. Pass the axis explicitly here; the axis-by-axis contract
    // lives in llm/prompts/__tests__/axisPrompts.test.ts.
    const block = buildLineItemsPromptBlock('final_bill', ['x']);
    assert.match(block, /line_items/);
    assert.match(block, /NULL vs ZERO/);
    assert.match(block, /MERGE BY ROW KEY/);
    assert.match(block, /120 rows/, 'must forbid summarising a long table');
    assert.match(block, /row_index/);
    assert.match(block, /payable/);
    assert.match(block, /final bill/, 'names the document type');
  });

  it('tells the model to fit by being terse, never by dropping a row', () => {
    // The output ceiling is now sized for the whole table (claudeClient gives
    // doc_extract.* 16384 on the premium tier), so the prompt must not leave
    // "stop early" open as a way to fit — a short table that validates is the
    // failure mode this rule exists to close.
    const block = buildLineItemsPromptBlock('final_bill');
    assert.match(block, /FIT BY BEING TERSE, NEVER BY DROPPING A ROW/);
    assert.match(block, /and N more rows/, 'names the specific cop-out to forbid');
    assert.match(block, /budget for this call is sized for/);
  });

  it('degrades gracefully on an unknown category', () => {
    const block = buildLineItemsPromptBlock('');
    assert.match(block, /document/);
  });
});
