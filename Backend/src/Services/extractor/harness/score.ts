/**
 * 196-field scorer for the vision regression gate.
 *
 * The metric that matters is not "did the model produce plausible JSON" but
 * "did every printed cell come back with the value that was printed". So we
 * compare cell by cell against the synthetic bill's ground truth and report
 * a flat accuracy plus a separate `moneyAccuracy` over the five money
 * columns — the columns that row-shift when a wide page is downscaled, and
 * therefore the ones the tiling change exists to fix. An extraction can look
 * 95% accurate overall while being 70% on money, which is worthless.
 *
 * Rows are matched by INDEX, not by particulars text. That is deliberate: a
 * dropped or duplicated row is exactly the failure we are hunting, and index
 * matching makes it visible as a cascade of misses instead of quietly
 * re-aligning around it.
 */

import type { LineItem } from '../lineItems.js';
import type { SyntheticBillGroundTruth } from './syntheticBill.js';

// ─── Public types ────────────────────────────────────────────────────────

export interface FieldScore {
  /** e.g. 'header.bill_no', 'row[7].payable', 'totals.net_total'. */
  key: string;
  expected: string;
  actual: string | null;
  hit: boolean;
}

export interface ExtractionScore {
  total: number;
  hits: number;
  /** hits / total, 0..1. */
  accuracy: number;
  fields: FieldScore[];
  misses: FieldScore[];
  /** accuracy restricted to the money columns (rate/gross/discount/net/payable) — the column that fails today. */
  moneyAccuracy: number;
}

/** The columns that row-shift when a wide page is downscaled. */
const MONEY_COLUMNS = ['rate', 'gross', 'discount', 'net', 'payable'] as const;

/** The ten scored cells of a row, in printed order. */
const ROW_COLUMNS = [
  'particulars',
  'code',
  'date',
  'qty',
  'rate',
  'gross',
  'discount',
  'net',
  'tax_pct',
  'payable',
] as const;

// ─── Normalisation ───────────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Turn a printed date into ISO. Handles DD/MM/YYYY, DD-MM-YYYY, DD.MM.YY,
 * DD-Mon-YYYY and an already-ISO string. Returns null when it isn't a date —
 * the caller then keeps the text form.
 */
function toIsoDate(s: string): string | null {
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;

  const named = s.match(/^(\d{1,2})[-/ ]([a-z]{3})[a-z]*[-/ ](\d{2,4})$/);
  if (named) {
    const mm = MONTHS[named[2]];
    if (mm) {
      const yyyy = named[3].length === 2 ? `20${named[3]}` : named[3];
      return `${yyyy}-${mm}-${named[1].padStart(2, '0')}`;
    }
  }

  const numeric = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (numeric) {
    const yyyy = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3];
    return `${yyyy}-${numeric[2].padStart(2, '0')}-${numeric[1].padStart(2, '0')}`;
  }

  return null;
}

/** Whitespace-collapse, strip currency symbols/commas/trailing "/-", normalise dates to ISO, lowercase. */
export function normaliseCell(v: unknown): string {
  if (v === null || v === undefined) return '';

  let s = String(v).replace(/\s+/g, ' ').trim().toLowerCase();
  if (s === '') return '';

  // Currency noise. "₹ 1,250.00/-" and "Rs.1250" must both reduce to 1250.
  s = s
    .replace(/[₹$]/g, '')
    .replace(/\b(?:rs|inr|rupees)\b\.?/g, '')
    .replace(/\/-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const asDate = toIsoDate(s);
  if (asDate) return asDate;

  // Numeric canonicalisation: "1,250.00", "1250", "1250.0" all become
  // "1250". Without this a model that drops trailing zeros scores 0 on
  // every money cell for no real reason.
  const numeric = s.replace(/,/g, '');
  if (/^-?\d+(\.\d+)?%?$/.test(numeric)) {
    const n = Number(numeric.replace(/%$/, ''));
    if (Number.isFinite(n)) return String(Math.round(n * 100) / 100);
  }

  // Residual punctuation that varies between renderings of the same text.
  return s.replace(/[.,]+$/, '').trim();
}

// ─── Scoring ─────────────────────────────────────────────────────────────

function compare(key: string, expected: unknown, actual: unknown): FieldScore {
  const e = normaliseCell(expected);
  const a = actual === null || actual === undefined ? null : normaliseCell(actual);
  return { key, expected: e, actual: a, hit: a !== null && a === e };
}

export function scoreAgainstGroundTruth(
  groundTruth: SyntheticBillGroundTruth,
  actual: {
    header: Record<string, unknown>;
    line_items: readonly LineItem[];
    totals: Record<string, unknown>;
  },
): ExtractionScore {
  const fields: FieldScore[] = [];
  const actualHeader = actual?.header ?? {};
  const actualTotals = actual?.totals ?? {};
  const actualRows = Array.isArray(actual?.line_items) ? actual.line_items : [];

  for (const [key, expected] of Object.entries(groundTruth.header)) {
    fields.push(compare(`header.${key}`, expected, (actualHeader as any)[key]));
  }

  groundTruth.rows.forEach((expectedRow, i) => {
    const got = actualRows[i] as Record<string, unknown> | undefined;
    for (const col of ROW_COLUMNS) {
      fields.push(compare(`row[${i}].${col}`, expectedRow[col], got ? got[col] : null));
    }
  });

  for (const [key, expected] of Object.entries(groundTruth.totals)) {
    fields.push(compare(`totals.${key}`, expected, (actualTotals as any)[key]));
  }

  const hits = fields.filter((f) => f.hit).length;
  const total = fields.length;

  const moneyFields = fields.filter((f) =>
    MONEY_COLUMNS.some((c) => f.key.endsWith(`.${c}`) && f.key.startsWith('row[')),
  );
  const moneyHits = moneyFields.filter((f) => f.hit).length;

  return {
    total,
    hits,
    accuracy: total === 0 ? 0 : Math.round((hits / total) * 10000) / 10000,
    fields,
    misses: fields.filter((f) => !f.hit),
    moneyAccuracy:
      moneyFields.length === 0 ? 0 : Math.round((moneyHits / moneyFields.length) * 10000) / 10000,
  };
}
