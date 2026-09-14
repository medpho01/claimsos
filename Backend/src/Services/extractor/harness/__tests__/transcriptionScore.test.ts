/**
 * Scorer tests for the TRANSCRIPTION gate. Pure — no network, no LLM, no spend.
 *
 * Run: npx tsx --test src/Services/extractor/harness/__tests__/transcriptionScore.test.ts
 *
 * A scorer for free text is only worth the gate it backs if it FAILS on the
 * three things that actually go wrong when a row-banded page is transcribed:
 *
 *   1. a dropped row (the band stopped short),
 *   2. a duplicated row (the ~16% band overlap transcribed twice — the
 *      signature failure of giving a 'y' page the 'x' merge rule),
 *   3. a money value landing on the neighbouring row.
 *
 * Every one of those is invisible to a naive "is this number somewhere in the
 * text" check, and (1) and (2) partially cancel each other in a raw cell count.
 * So each has its own assertion here, against a synthetically perfect
 * transcript that is then damaged in exactly one way.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PORTRAIT_FIXTURE,
  normaliseTranscriptLine,
  scoreTranscription,
} from '../transcriptionRegression.js';
import type { SyntheticBillGroundTruth } from '../syntheticBill.js';

// ── A ground truth small enough to reason about, same SHAPE as the fixture ──

function makeGroundTruth(rowCount = 6): SyntheticBillGroundTruth {
  const header: Record<string, string> = {
    bill_no: 'FB/2026/6409',
    patient_name: 'Sunita Ramesh Kulkarni',
    uhid: 'UH503461',
  };
  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < rowCount; i++) {
    const rate = 1000 + i * 111;
    const qty = (i % 3) + 1;
    const gross = rate * qty;
    const discount = i % 2 === 0 ? 0 : 100;
    const net = gross - discount;
    const taxPct = i % 2 === 0 ? 0 : 5;
    const payable = Math.round((net + net * (taxPct / 100)) * 100) / 100;
    rows.push({
      // Deliberately REPEATING after 3, the way the real fixture repeats after
      // 22 — a scorer that looks rows up instead of walking forward passes the
      // happy case and hides a dropped row.
      particulars: ['Room Rent - Semi Private Ward (AC)', 'Nursing Charges - General Ward', 'ICU Charges - Level II'][i % 3]!,
      code: `SVC${1000 + i}`,
      date: `2026-02-${String(11 + i).padStart(2, '0')}`,
      qty: String(qty),
      rate: rate.toFixed(2),
      gross: gross.toFixed(2),
      discount: discount.toFixed(2),
      net: net.toFixed(2),
      tax_pct: String(taxPct),
      payable: payable.toFixed(2),
    });
  }
  const totals: Record<string, string> = {
    net_total: rows.reduce((a, r) => a + Number(r.net), 0).toFixed(2),
    payable_total: rows.reduce((a, r) => a + Number(r.payable), 0).toFixed(2),
  };
  return {
    header,
    rows,
    totals,
    fieldCount: Object.keys(header).length + rows.length * 10 + Object.keys(totals).length,
  };
}

/** The line shape a faithful transcription produces, column-aligned. */
function rowLine(gt: SyntheticBillGroundTruth, i: number, overrides: Record<string, string> = {}): string {
  const r = { ...gt.rows[i]!, ...overrides };
  return [
    String(i + 1).padEnd(4),
    r.particulars.padEnd(40),
    r.code.padEnd(11),
    r.date.padEnd(12),
    r.qty.padEnd(8),
    r.rate.padEnd(11),
    r.gross.padEnd(12),
    r.discount.padEnd(12),
    r.net.padEnd(12),
    r.tax_pct.padEnd(8),
    r.payable,
  ].join('');
}

function perfectTranscript(gt: SyntheticBillGroundTruth): string {
  const out: string[] = [
    'SAHYADRI MULTISPECIALITY HOSPITAL          FINAL BILL / SUMMARY OF CHARGES',
    '',
    ...Object.entries(gt.header).map(([k, v]) => `${k}: ${v}`),
    '',
    'Sr  Particulars                             Code       Date        Qty     Rate       Gross Amt   Discount    Net Amt     Tax %   Payable',
  ];
  for (let i = 0; i < gt.rows.length; i++) out.push(rowLine(gt, i));
  out.push('');
  for (const [k, v] of Object.entries(gt.totals)) out.push(`${k.replace(/_/g, ' ')}   ${v}`);
  return out.join('\n');
}

// ── tests ────────────────────────────────────────────────────────────────

describe('normaliseTranscriptLine', () => {
  it('strips currency marks and thousands separators without eating the decimal', () => {
    assert.equal(normaliseTranscriptLine('₹ 1,234.56'), '1234.56');
    assert.equal(normaliseTranscriptLine('Rs. 1,690,115.61'), '1690115.61');
    // A comma that is NOT a thousands separator stays put — it is prose.
    assert.equal(normaliseTranscriptLine('IV Set, Cannula'), 'IV Set, Cannula');
  });

  it('turns column rules into whitespace so a piped table still parses', () => {
    assert.equal(normaliseTranscriptLine('1 | Room Rent | 4500.00'), '1 Room Rent 4500.00');
  });
});

describe('scoreTranscription — a faithful transcription', () => {
  const gt = makeGroundTruth();
  const score = scoreTranscription(gt, perfectTranscript(gt));

  it('scores every cell', () => {
    assert.equal(score.total, gt.fieldCount);
    assert.equal(score.hits, gt.fieldCount, `misses: ${score.misses.map((m) => m.key).join(',')}`);
    assert.equal(score.accuracy, 1);
    assert.equal(score.moneyAccuracy, 1);
  });

  it('finds every row, in order, exactly once', () => {
    assert.equal(score.rowsFound, gt.rows.length);
    assert.equal(score.rowRecall, 1);
    assert.equal(score.rowsOrdered, true);
    assert.equal(score.rowLikeLines, gt.rows.length);
    assert.equal(score.duplicateRowLines, 0);
  });
});

describe('scoreTranscription — the three failure modes it exists to catch', () => {
  const gt = makeGroundTruth();

  it('a DROPPED row costs row recall and all ten of its cells', () => {
    const lines = perfectTranscript(gt).split('\n');
    // Drop row index 4 — one of the REPEATED particulars, so a lookup-based
    // matcher would re-find it on row 1's line and report nothing wrong.
    const dropped = lines.filter((l) => !l.includes(gt.rows[4]!.code));
    const score = scoreTranscription(gt, dropped.join('\n'));

    assert.equal(score.rowsFound, gt.rows.length - 1);
    assert.ok(score.rowRecall < 1, 'a dropped row must show up as row recall < 1');
    const rowFourMisses = score.misses.filter((m) => m.key.startsWith('row[4].'));
    assert.equal(rowFourMisses.length, 10, 'all ten cells of the dropped row must miss');
    assert.equal(score.rowLikeLines, gt.rows.length - 1);
  });

  it('a DUPLICATED band overlap is counted even though every row is still found', () => {
    const lines = perfectTranscript(gt).split('\n');
    const dupIdx = lines.findIndex((l) => l.includes(gt.rows[3]!.code));
    // The band-overlap signature: the last rows of one band repeated as the
    // first rows of the next.
    lines.splice(dupIdx, 0, rowLine(gt, 2), rowLine(gt, 3));
    const score = scoreTranscription(gt, lines.join('\n'));

    // Cell accuracy is UNHARMED by duplication — which is exactly why the
    // structural counter has to exist.
    assert.equal(score.rowsFound, gt.rows.length);
    assert.equal(score.accuracy, 1);
    assert.equal(score.rowLikeLines, gt.rows.length + 2);
    assert.equal(score.duplicateRowLines, 2);
  });

  it('a money value shifted onto the NEIGHBOURING row is a miss, not a pass', () => {
    const lines = perfectTranscript(gt).split('\n');
    const iA = lines.findIndex((l) => l.includes(gt.rows[1]!.code));
    const iB = lines.findIndex((l) => l.includes(gt.rows[2]!.code));
    // Row 1 gets row 2's payable and vice versa. Every printed figure is still
    // SOMEWHERE in the text — a presence check scores this 100%.
    lines[iA] = rowLine(gt, 1, { payable: gt.rows[2]!.payable! });
    lines[iB] = rowLine(gt, 2, { payable: gt.rows[1]!.payable! });
    const score = scoreTranscription(gt, lines.join('\n'));

    assert.equal(score.rowsFound, gt.rows.length);
    assert.ok(score.misses.some((m) => m.key === 'row[1].payable'));
    assert.ok(score.misses.some((m) => m.key === 'row[2].payable'));
    assert.ok(score.moneyAccuracy < 1, 'a row shift must cost money accuracy');
  });

  it('rows emitted OUT OF ORDER are flagged even when nothing is lost', () => {
    const lines = perfectTranscript(gt).split('\n');
    // Rows 1 and 5 carry DIFFERENT particulars (the pool repeats every 3), so
    // swapping them is a genuine reordering rather than a no-op.
    const iA = lines.findIndex((l) => l.includes(gt.rows[1]!.code));
    const iB = lines.findIndex((l) => l.includes(gt.rows[5]!.code));
    assert.notEqual(gt.rows[1]!.particulars, gt.rows[5]!.particulars);
    const tmp = lines[iA]!;
    lines[iA] = lines[iB]!;
    lines[iB] = tmp;
    const score = scoreTranscription(gt, lines.join('\n'));

    // Nothing was lost — every row line is still on the page.
    assert.equal(score.rowLikeLines, gt.rows.length);
    assert.equal(score.rowsOrdered, false);
  });
});

describe('scoreTranscription — empty and degenerate input', () => {
  const gt = makeGroundTruth();

  it('an empty transcription scores zero rather than throwing', () => {
    const score = scoreTranscription(gt, '');
    assert.equal(score.hits, 0);
    assert.equal(score.accuracy, 0);
    assert.equal(score.rowsFound, 0);
    assert.equal(score.rowLikeLines, 0);
    assert.equal(score.duplicateRowLines, 0);
    assert.equal(score.total, gt.fieldCount);
  });
});

describe('PORTRAIT_FIXTURE', () => {
  it('is the dense A4 shape the 416-cell number was taken on', () => {
    assert.equal(PORTRAIT_FIXTURE.widthPx, 2480);
    assert.equal(PORTRAIT_FIXTURE.heightPx, 3508);
    assert.equal(PORTRAIT_FIXTURE.rows, 40);
    // 11 header + 40x10 + 5 totals = 416 on the real fixture; the shape here
    // is what makes that arithmetic hold.
    assert.equal(PORTRAIT_FIXTURE.rows * 10 + 16, 416);
  });
});
