/**
 * Scorer + synthetic-fixture tests. No network, no LLM.
 *
 * Run: npx tsx --test src/Services/extractor/__tests__/harnessScore.test.ts
 *
 * The scorer is the instrument the whole change is measured on, so it needs
 * its own ground truth. The row-shift case is the important one: an
 * extraction where the money column slid down by one row must score BADLY,
 * because that is precisely the failure single-image vision produces and the
 * gate has to be able to see it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { LineItem } from '../lineItems.js';
import { generateSyntheticLandscapeBill } from '../harness/syntheticBill.js';
import { normaliseCell, scoreAgainstGroundTruth } from '../harness/score.js';
import type { SyntheticBillGroundTruth } from '../harness/syntheticBill.js';

// ── normaliseCell ───────────────────────────────────────────────────────

describe('normaliseCell', () => {
  it('strips currency noise and canonicalises numbers', () => {
    assert.equal(normaliseCell('₹ 1,250.00/-'), '1250');
    assert.equal(normaliseCell('Rs.1250'), '1250');
    assert.equal(normaliseCell('INR 1250.50'), '1250.5');
    assert.equal(normaliseCell(1250), '1250');
    assert.equal(normaliseCell('1250.00'), '1250');
    assert.equal(normaliseCell('0.00'), '0');
  });

  it('keeps a real zero distinct from an absent value', () => {
    assert.equal(normaliseCell(0), '0');
    assert.equal(normaliseCell(null), '');
    assert.equal(normaliseCell(undefined), '');
    assert.notEqual(normaliseCell(0), normaliseCell(null));
  });

  it('normalises dates to ISO across the formats Indian bills print', () => {
    assert.equal(normaliseCell('11/02/2026'), '2026-02-11');
    assert.equal(normaliseCell('11-02-2026'), '2026-02-11');
    assert.equal(normaliseCell('11.02.26'), '2026-02-11');
    assert.equal(normaliseCell('11-Feb-2026'), '2026-02-11');
    assert.equal(normaliseCell('2026-02-11'), '2026-02-11');
  });

  it('collapses whitespace and lowercases text', () => {
    assert.equal(normaliseCell('  Room   Rent - SEMI Private  '), 'room rent - semi private');
  });
});

// ── scoreAgainstGroundTruth ─────────────────────────────────────────────

const GT: SyntheticBillGroundTruth = {
  header: { bill_no: 'FB/2026/1001', patient_name: 'Sunita Kulkarni' },
  rows: [
    { particulars: 'Room Rent', code: 'HCP1', date: '2026-02-11', qty: '1', rate: '4500.00', gross: '4500.00', discount: '0.00', net: '4500.00', tax_pct: '0', payable: '4500.00' },
    { particulars: 'Nursing', code: 'HCP2', date: '2026-02-11', qty: '2', rate: '450.00', gross: '900.00', discount: '0.00', net: '900.00', tax_pct: '5', payable: '945.00' },
    { particulars: 'ECG', code: 'LAB1', date: '2026-02-12', qty: '1', rate: '350.00', gross: '350.00', discount: '0.00', net: '350.00', tax_pct: '18', payable: '413.00' },
  ],
  totals: { net_total: '5750.00', payable_total: '5858.00' },
  fieldCount: 2 + 3 * 10 + 2,
};

function perfectRows(): LineItem[] {
  return GT.rows.map((r, i) => ({
    row_index: i,
    particulars: r.particulars,
    code: r.code,
    date: r.date,
    qty: Number(r.qty),
    rate: Number(r.rate),
    gross: Number(r.gross),
    discount: Number(r.discount),
    net: Number(r.net),
    tax_pct: Number(r.tax_pct),
    payable: Number(r.payable),
    source_page: 1,
  }));
}

describe('scoreAgainstGroundTruth', () => {
  it('scores a perfect extraction at 100%', () => {
    const score = scoreAgainstGroundTruth(GT, {
      header: { bill_no: 'FB/2026/1001', patient_name: 'Sunita Kulkarni' },
      line_items: perfectRows(),
      totals: { net_total: 5750, payable_total: 5858 },
    });
    assert.equal(score.total, GT.fieldCount);
    assert.equal(score.total, 34);
    assert.equal(score.hits, 34);
    assert.equal(score.accuracy, 1);
    assert.equal(score.moneyAccuracy, 1);
    assert.deepEqual(score.misses, []);
  });

  it('is not fooled by formatting — commas, currency and 11/02/2026 still hit', () => {
    const rows = perfectRows().map((r) => ({ ...r, payable: `₹${r.payable!.toFixed(2)}` as any, date: '11/02/2026' }));
    const score = scoreAgainstGroundTruth(GT, {
      header: { bill_no: 'FB/2026/1001', patient_name: 'sunita   kulkarni' },
      line_items: rows as LineItem[],
      totals: { net_total: '5,750.00', payable_total: 'Rs. 5858/-' },
    });
    // Row 2's date genuinely differs (2026-02-12), so exactly one date misses.
    assert.equal(score.misses.length, 1);
    assert.equal(score.misses[0].key, 'row[2].date');
    assert.equal(score.moneyAccuracy, 1);
  });

  it('punishes a money column that slid down one row', () => {
    // THE failure mode: amounts read off the neighbouring line item. The text
    // columns are all still perfect, so an overall-accuracy-only metric would
    // call this 85% — moneyAccuracy has to expose it.
    const rows = perfectRows();
    const shifted = rows.map((r, i) => ({
      ...r,
      rate: rows[Math.max(0, i - 1)].rate,
      gross: rows[Math.max(0, i - 1)].gross,
      net: rows[Math.max(0, i - 1)].net,
      payable: rows[Math.max(0, i - 1)].payable,
    }));

    const score = scoreAgainstGroundTruth(GT, {
      header: { bill_no: 'FB/2026/1001', patient_name: 'Sunita Kulkarni' },
      line_items: shifted,
      totals: { net_total: 5750, payable_total: 5858 },
    });

    assert.ok(score.accuracy < 1);
    assert.ok(
      score.moneyAccuracy < score.accuracy,
      `moneyAccuracy (${score.moneyAccuracy}) must be worse than overall (${score.accuracy})`,
    );
    // Rows 1 and 2 have four wrong money cells each; row 0 keeps its own.
    assert.equal(score.misses.filter((m) => m.key.startsWith('row[')).length, 8);
    assert.ok(score.misses.some((m) => m.key === 'row[1].payable'));
  });

  it('punishes a dropped row as a cascade, not a silent realignment', () => {
    const dropped = perfectRows().filter((_, i) => i !== 1);
    const score = scoreAgainstGroundTruth(GT, {
      header: { bill_no: 'FB/2026/1001', patient_name: 'Sunita Kulkarni' },
      line_items: dropped,
      totals: { net_total: 5750, payable_total: 5858 },
    });
    // Rows 1 and 2 both go wrong once row 1 is gone — 19 of the 20 cells,
    // the 20th being a coincidence (both rows print a 0.00 discount).
    assert.equal(score.misses.length, 19);
    assert.ok(score.misses.some((m) => m.key === 'row[1].particulars'));
    assert.ok(score.misses.some((m) => m.key === 'row[2].particulars'));
  });

  it('reports a missing value as actual=null rather than throwing', () => {
    const score = scoreAgainstGroundTruth(GT, {
      header: {},
      line_items: [],
      totals: {},
    });
    assert.equal(score.hits, 0);
    assert.equal(score.accuracy, 0);
    assert.ok(score.fields.every((f) => f.actual === null));
  });
});

// ── synthetic fixture ───────────────────────────────────────────────────

describe('generateSyntheticLandscapeBill', () => {
  it('produces a wide JPEG with exactly 196 ground-truth cells', async () => {
    const fixture = await generateSyntheticLandscapeBill();
    assert.equal(fixture.mime, 'image/jpeg');
    assert.equal(fixture.groundTruth.fieldCount, 196);
    assert.equal(Object.keys(fixture.groundTruth.header).length, 11);
    assert.equal(fixture.groundTruth.rows.length, 18);
    assert.equal(Object.keys(fixture.groundTruth.totals).length, 5);
    assert.ok(fixture.imageBytes.length > 10_000, 'render must not be empty');
    // The degraded render rotates by 1 degree, so the canvas grows slightly.
    assert.ok(fixture.widthPx >= 3400 && fixture.widthPx < 3500);
    assert.ok(fixture.widthPx / fixture.heightPx > 1.3, 'must be a wide page');
  });

  it('is deterministic for a given seed and different across seeds', async () => {
    const a = await generateSyntheticLandscapeBill({ seed: 7, degrade: null });
    const b = await generateSyntheticLandscapeBill({ seed: 7, degrade: null });
    const c = await generateSyntheticLandscapeBill({ seed: 8, degrade: null });
    assert.deepEqual(a.groundTruth, b.groundTruth);
    assert.notDeepEqual(a.groundTruth.rows[0], c.groundTruth.rows[0]);
  });

  it('emits rows whose payable column sums to the declared payable total', async () => {
    // If the fixture itself did not add up, a totals mismatch in a real run
    // would be unattributable.
    const { groundTruth } = await generateSyntheticLandscapeBill({ degrade: null });
    const sum = groundTruth.rows.reduce((acc, r) => acc + Number(r.payable), 0);
    assert.ok(
      Math.abs(sum - Number(groundTruth.totals.payable_total)) < 0.05,
      `rows sum ${sum} vs declared ${groundTruth.totals.payable_total}`,
    );
  });

  it('scales the row count and the field count together', async () => {
    const fixture = await generateSyntheticLandscapeBill({ rows: 5, degrade: null });
    assert.equal(fixture.groundTruth.rows.length, 5);
    assert.equal(fixture.groundTruth.fieldCount, 11 + 5 * 10 + 5);
  });
});
