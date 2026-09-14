/**
 * The TRANSCRIPTION gate — the other half of the proof.
 *
 * `visionRegression.ts` measures the STRUCTURED path: prepareVisionInput →
 * a JSON-emitting extraction call → 196/416 scored cells. That is what
 * docExtractor does. It is NOT what `ocr.service` does.
 *
 * ocr.service.readPdfPagesViaVision → visionRead.transcribePagesViaVision asks
 * the model for PLAIN TEXT, under a different system prompt, and everything
 * downstream of OCR (bundle classifier, segmenter, harmoniser, the
 * deterministic extractors) regexes over that string. A row the transcription
 * drops or duplicates is invisible to visionRegression and fatal downstream.
 * Until this file existed that path had never been measured on a row-banded
 * portrait page at all — which is the exact shape whose merge rule is the
 * INVERSE of the certified landscape one (see buildVisionReadSystemPrompt).
 *
 * So this runs the REAL `transcribePagesViaVision` — not a copy of it — over
 * the dense 40-row A4 portrait fixture, and scores the plain text it returns
 * against the SAME 416 ground-truth cells visionRegression uses, so the two
 * numbers are directly comparable.
 *
 * ── How you score a table against free text ──────────────────────────────
 *
 * Three properties, and the scoring has to be strict about all three or it
 * flatters the model:
 *
 *  1. EVERY ROW, ONCE, IN ORDER. Rows are aligned SEQUENTIALLY by particulars
 *     text with a forward-only cursor. The fixture's particulars repeat every
 *     22 rows, so a lookup would happily match row 23 against row 1's line and
 *     hide a dropped row; a forward-only walk cannot. A row found only by
 *     searching backwards sets `rowsOrdered = false`.
 *  2. NO BAND-OVERLAP DUPLICATION. Tiles overlap ~16%, so the failure mode of
 *     the row-band ('y') prompt is emitting the overlap twice. `rowLikeLines`
 *     counts every line carrying ≥ 4 two-decimal money figures; anything above
 *     the true row count is duplication the sequential alignment would
 *     otherwise absorb silently.
 *  3. VALUES ON THE RIGHT ROW. The seven trailing numerics (qty, rate, gross,
 *     discount, net, tax_pct, payable) are compared BY POSITION against the
 *     numeric tokens left on the line once the Sr / particulars / code / date
 *     are consumed. Positional, not "is this number somewhere on the page":
 *     a money value that slides one row down is the precise failure tiling
 *     exists to prevent, and a presence check cannot see it.
 *
 * Header and totals are presence checks over the whole transcript — they are
 * not tabular and have no row to land on.
 *
 * SPEND: real, billable Anthropic calls, one per trial. `assertSpendAllowed`
 * (re-used from visionRegression) refuses to run without an explicit
 * EXTRACT_HARNESS_ALLOW_SPEND=1.
 *
 * Run:
 *   EXTRACT_HARNESS_ALLOW_SPEND=1 npx tsx \
 *     src/Services/extractor/harness/transcriptionRegression.ts
 *
 * Measured 2026-09-14 (n=3, claude-sonnet-4-5, axis 'y', 4 images/page):
 *   40/40 rows, in order, 0 duplicated rows, 99.76% of 416 cells,
 *   ~₹4.8 and ~60s per page. See TRANSCRIPTION_ACCURACY_FLOOR.
 */

import { pathToFileURL } from 'url';

import { prepareVisionInput, transcribePagesViaVision } from '../visionRead.js';
import type { VisionTileAxis } from '../visionRead.js';
import {
  generateSyntheticLandscapeBill,
  type SyntheticBillFixture,
  type SyntheticBillGroundTruth,
} from './syntheticBill.js';
import { normaliseCell } from './score.js';
import { assertSpendAllowed } from './visionRegression.js';

// ─── The gate ────────────────────────────────────────────────────────────

/**
 * Cell-accuracy floor for the transcription path. Lower than the structured
 * path's 0.99 on purpose: a transcription is scored on positional numeric
 * tokens parsed out of free text, so ONE misread digit costs a cell with no
 * schema to fall back on. The floors that actually matter for this path are
 * the two structural ones below — a 99% cell score on a transcription that
 * dropped eight rows is worthless.
 */
export const TRANSCRIPTION_ACCURACY_FLOOR = 0.98 as const;
/** Every printed row must appear. No allowance: a dropped row is a dropped charge. */
export const TRANSCRIPTION_ROW_RECALL_FLOOR = 1 as const;
/** Lines that look like table rows, over the true row count. Must be zero. */
export const TRANSCRIPTION_MAX_DUPLICATE_ROWS = 0 as const;

/** The dense A4 portrait fixture: 2480×3508 at 40 rows ⇒ 416 scored cells. */
export const PORTRAIT_FIXTURE = {
  widthPx: 2480,
  heightPx: 3508,
  rows: 40,
} as const;

// ─── Scoring ─────────────────────────────────────────────────────────────

export interface TranscriptCell {
  /** e.g. 'header.uhid', 'row[7].payable', 'totals.net_total'. */
  key: string;
  expected: string;
  actual: string | null;
  hit: boolean;
}

export interface TranscriptScore {
  total: number;
  hits: number;
  accuracy: number;
  moneyTotal: number;
  moneyHits: number;
  moneyAccuracy: number;
  /** Ground-truth rows found in the transcript. */
  rowsFound: number;
  rowsTotal: number;
  rowRecall: number;
  /** False when a row had to be found by searching BACKWARDS — i.e. out of order. */
  rowsOrdered: boolean;
  /** Lines carrying ≥4 two-decimal money figures. Should equal rowsTotal. */
  rowLikeLines: number;
  /** rowLikeLines − rowsTotal, floored at 0. The band-overlap duplication count. */
  duplicateRowLines: number;
  cells: TranscriptCell[];
  misses: TranscriptCell[];
}

/** The five columns that row-shift when a page is downscaled instead of tiled. */
const MONEY_COLUMNS: ReadonlySet<string> = new Set([
  'rate',
  'gross',
  'discount',
  'net',
  'payable',
]);

/** The trailing numerics, in printed order, after particulars / code / date. */
const NUMERIC_COLUMNS = [
  'qty',
  'rate',
  'gross',
  'discount',
  'net',
  'tax_pct',
  'payable',
] as const;

/** A row's fixture code: three letters + four digits, e.g. "LAB1034". */
const CODE_RE = /\b([A-Z]{3}\s?\d{4})\b/i;
/** ISO or DD/MM/YYYY-ish. normaliseCell canonicalises whichever form comes back. */
const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/;
/** A printed money figure. Four or more of these make a line a table row. */
const MONEY_TOKEN_RE = /\b\d+\.\d{2}\b/g;
const MIN_MONEY_TOKENS_FOR_ROW_LINE = 4;

/**
 * Line-level normalisation: drop column rules, currency marks and the
 * thousands separators inside numbers, then collapse whitespace. Deliberately
 * does NOT touch the decimal point — "1,234.56" must become "1234.56", not
 * "123456".
 */
export function normaliseTranscriptLine(s: string): string {
  return s
    .replace(/[|¦]/g, ' ')
    .replace(/[₹$]/g, ' ')
    .replace(/\b(?:rs|inr)\b\.?/gi, ' ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Alphanumerics only, lowercased — for matching particulars across spacing noise. */
function textKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Score a plain-text transcription against the synthetic bill's ground truth.
 * Pure — no network, no provider. See the module header for the three
 * properties this is strict about.
 */
export function scoreTranscription(
  groundTruth: SyntheticBillGroundTruth,
  text: string,
): TranscriptScore {
  const cells: TranscriptCell[] = [];
  const push = (key: string, expected: unknown, actual: unknown): void => {
    const e = normaliseCell(expected);
    const a = actual === null || actual === undefined ? null : normaliseCell(actual);
    cells.push({ key, expected: e, actual: a, hit: a !== null && a === e });
  };

  const lines = text.split(/\r?\n/).map(normaliseTranscriptLine);
  const lineKeys = lines.map(textKey);
  const wholeKey = textKey(text);
  const wholeNorm = normaliseTranscriptLine(text.replace(/\r?\n/g, ' '));

  // ── header — presence anywhere in the transcript ──────────────────────
  for (const [k, v] of Object.entries(groundTruth.header)) {
    const want = String(v);
    const found =
      wholeKey.includes(textKey(want)) || wholeNorm.toLowerCase().includes(want.toLowerCase());
    push(`header.${k}`, want, found ? want : null);
  }

  // ── rows — forward-only sequential alignment ──────────────────────────
  const rows = groundTruth.rows;
  const assigned = new Set<number>();
  let cursor = 0;
  let rowsOrdered = true;
  let rowsFound = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const particularsKey = textKey(row.particulars ?? '');

    let at = -1;
    // An empty key would substring-match EVERY line and score a blank row as
    // found. A row with no particulars has no anchor: report it as missing.
    if (particularsKey.length > 0) {
      for (let li = cursor; li < lines.length; li++) {
        if (lineKeys[li]!.includes(particularsKey)) {
          at = li;
          break;
        }
      }
    }
    if (at === -1 && particularsKey.length > 0) {
      // Nothing ahead of the cursor. Search the whole transcript: a hit here
      // is an OUT-OF-ORDER emission, which is a different (and also fatal)
      // failure from a dropped row, so record which one it was.
      for (let li = 0; li < lines.length; li++) {
        if (!assigned.has(li) && lineKeys[li]!.includes(particularsKey)) {
          at = li;
          rowsOrdered = false;
          break;
        }
      }
    }

    if (at === -1) {
      for (const c of ['particulars', 'code', 'date', ...NUMERIC_COLUMNS]) {
        push(`row[${i}].${c}`, row[c], null);
      }
      continue;
    }

    rowsFound++;
    assigned.add(at);
    cursor = at + 1;

    // particulars matched by construction.
    push(`row[${i}].particulars`, row.particulars, row.particulars);

    // Consume the line left to right: particulars, then code, then date. What
    // is left is the seven numerics, in printed order.
    let rest = lines[at]!;
    const anchor = (row.particulars ?? '').slice(0, 12).toLowerCase();
    const anchorAt = rest.toLowerCase().indexOf(anchor);
    if (anchorAt >= 0) rest = rest.slice(anchorAt);

    const codeMatch = rest.match(CODE_RE);
    push(`row[${i}].code`, row.code, codeMatch ? codeMatch[1]!.replace(/\s+/g, '') : null);
    if (codeMatch) rest = rest.slice(rest.indexOf(codeMatch[0]) + codeMatch[0].length);

    const dateMatch = rest.match(DATE_RE);
    push(`row[${i}].date`, row.date, dateMatch ? dateMatch[1] : null);
    if (dateMatch) rest = rest.slice(rest.indexOf(dateMatch[0]) + dateMatch[0].length);

    const nums = rest.match(/-?\d+(?:\.\d+)?/g) ?? [];
    NUMERIC_COLUMNS.forEach((col, ci) => {
      push(`row[${i}].${col}`, row[col], ci < nums.length ? nums[ci] : null);
    });
  }

  // ── totals — presence anywhere ────────────────────────────────────────
  for (const [k, v] of Object.entries(groundTruth.totals)) {
    const want = String(v);
    const found = wholeNorm.includes(want.replace(/,/g, '')) || wholeNorm.includes(want);
    push(`totals.${k}`, want, found ? want : null);
  }

  // ── structural: duplicated table-row lines ────────────────────────────
  let rowLikeLines = 0;
  for (const line of lines) {
    if ((line.match(MONEY_TOKEN_RE) ?? []).length >= MIN_MONEY_TOKENS_FOR_ROW_LINE) {
      rowLikeLines++;
    }
  }

  const moneyCells = cells.filter((c) => {
    const m = c.key.match(/^row\[\d+\]\.(\w+)$/);
    return m ? MONEY_COLUMNS.has(m[1]!) : false;
  });
  const hits = cells.filter((c) => c.hit).length;
  const moneyHits = moneyCells.filter((c) => c.hit).length;

  return {
    total: cells.length,
    hits,
    accuracy: cells.length > 0 ? hits / cells.length : 0,
    moneyTotal: moneyCells.length,
    moneyHits,
    moneyAccuracy: moneyCells.length > 0 ? moneyHits / moneyCells.length : 0,
    rowsFound,
    rowsTotal: rows.length,
    rowRecall: rows.length > 0 ? rowsFound / rows.length : 0,
    rowsOrdered,
    rowLikeLines,
    duplicateRowLines: Math.max(0, rowLikeLines - rows.length),
    cells,
    misses: cells.filter((c) => !c.hit),
  };
}

// ─── Runner ──────────────────────────────────────────────────────────────

export interface TranscriptionRegressionResult {
  trial: number;
  score: TranscriptScore;
  /** Images actually sent for the page — overview + tiles. */
  imagesSent: number;
  tileAxes: VisionTileAxis[];
  confidence: number;
  truncated: boolean;
  warnings: string[];
  costInr: number;
  latencyMs: number;
  text: string;
}

export interface TranscriptionRegressionOptions {
  fixture?: SyntheticBillFixture;
  /** Default 1. */
  trials?: number;
}

/**
 * Run the REAL transcription path over the dense portrait fixture and score
 * every trial. Refuses to run without EXTRACT_HARNESS_ALLOW_SPEND=1.
 */
export async function runTranscriptionRegression(
  opts: TranscriptionRegressionOptions = {},
): Promise<TranscriptionRegressionResult[]> {
  assertSpendAllowed();

  const trials = Math.max(1, opts.trials ?? 1);
  const fixture = opts.fixture ?? (await generateSyntheticLandscapeBill({ ...PORTRAIT_FIXTURE }));

  // What the reader will build internally, built once here so the result can
  // report the images and the cut axis the model was actually given. Free —
  // prepareVisionInput makes no provider call.
  const prepared = await prepareVisionInput({ source: fixture.imageBytes, kind: 'image' });

  const results: TranscriptionRegressionResult[] = [];
  for (let trial = 1; trial <= trials; trial++) {
    const started = Date.now();
    const res = await transcribePagesViaVision({
      source: fixture.imageBytes,
      kind: 'image',
      taskName: 'ocr_vision_image',
    });
    const page = res.pages[0];
    const text = page?.text ?? '';
    results.push({
      trial,
      score: scoreTranscription(fixture.groundTruth, text),
      imagesSent: prepared.attachments.length,
      tileAxes: prepared.tileAxes,
      confidence: page?.confidence ?? 0,
      truncated: page?.truncated === true,
      warnings: page?.warnings ?? [],
      costInr: res.costInr,
      latencyMs: Date.now() - started,
      text,
    });
  }
  return results;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

async function main(): Promise<void> {
  assertSpendAllowed();

  const trials = Number(process.env.EXTRACT_HARNESS_TRIALS ?? 1) || 1;
  const fixture = await generateSyntheticLandscapeBill({ ...PORTRAIT_FIXTURE });
  const prepared = await prepareVisionInput({ source: fixture.imageBytes, kind: 'image' });

  console.log(
    `\nTranscription regression — dense A4 portrait ${fixture.widthPx}x${fixture.heightPx}, ` +
      `${PORTRAIT_FIXTURE.rows} rows, ${fixture.groundTruth.fieldCount} scored cells, ` +
      `${trials} trial(s).`,
  );
  console.log(
    `Tiler: ${prepared.attachments.length} image(s), axes [${prepared.tileAxes.join(',') || 'none'}], ` +
      `warnings [${prepared.warnings.join(',') || 'none'}]\n`,
  );

  const results = await runTranscriptionRegression({ fixture, trials });

  console.log(
    ['trial', 'rows', 'ordered', 'dupRows', 'accuracy', 'money', 'hits/total', 'cost ₹', 'ms']
      .map((h, i) => (i === 0 ? h.padEnd(6) : h.padStart(11)))
      .join(' '),
  );
  for (const r of results) {
    console.log(
      [
        String(r.trial).padEnd(6),
        `${r.score.rowsFound}/${r.score.rowsTotal}`.padStart(11),
        String(r.score.rowsOrdered).padStart(11),
        String(r.score.duplicateRowLines).padStart(11),
        pct(r.score.accuracy).padStart(11),
        pct(r.score.moneyAccuracy).padStart(11),
        `${r.score.hits}/${r.score.total}`.padStart(11),
        r.costInr.toFixed(3).padStart(11),
        String(r.latencyMs).padStart(11),
      ].join(' '),
    );
  }

  const meanAcc = mean(results.map((r) => r.score.accuracy));
  const meanRecall = mean(results.map((r) => r.score.rowRecall));
  console.log(
    `\nmean — cell accuracy ${pct(meanAcc)} (floor ${pct(TRANSCRIPTION_ACCURACY_FLOOR)}), ` +
      `row recall ${pct(meanRecall)} (floor ${pct(TRANSCRIPTION_ROW_RECALL_FLOOR)})`,
  );

  const failures: string[] = [];
  for (const r of results) {
    if (r.score.rowRecall < TRANSCRIPTION_ROW_RECALL_FLOOR) {
      failures.push(
        `trial ${r.trial}: ${r.score.rowsTotal - r.score.rowsFound} row(s) DROPPED ` +
          `(${r.score.rowsFound}/${r.score.rowsTotal})`,
      );
    }
    if (!r.score.rowsOrdered) failures.push(`trial ${r.trial}: rows emitted OUT OF ORDER`);
    if (r.score.duplicateRowLines > TRANSCRIPTION_MAX_DUPLICATE_ROWS) {
      failures.push(
        `trial ${r.trial}: ${r.score.duplicateRowLines} DUPLICATED row line(s) — ` +
          'the band overlap was transcribed twice',
      );
    }
    if (r.truncated) failures.push(`trial ${r.trial}: response hit max_tokens (page is INCOMPLETE)`);
    if (r.score.accuracy < TRANSCRIPTION_ACCURACY_FLOOR) {
      failures.push(`trial ${r.trial}: cell accuracy ${pct(r.score.accuracy)} below floor`);
    }
  }

  if (failures.length > 0) {
    console.log('\nFAIL:');
    for (const f of failures) console.log(`  ${f}`);
    const worst = results.reduce((a, b) => (a.score.accuracy <= b.score.accuracy ? a : b));
    for (const m of worst.score.misses.slice(0, 25)) {
      console.log(`  MISS ${m.key}: expected "${m.expected}" got "${m.actual ?? '<absent>'}"`);
    }
    process.exit(1);
  }

  console.log('\nPASS: every row present, in order, once; cell accuracy clears the floor.\n');
}

// Guarded so importing this module (e.g. from a test) never spends.
const invokedDirectly = (() => {
  const entry = process.argv?.[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\ntranscriptionRegression failed: ${(err as any)?.message ?? String(err)}`);
    process.exit(1);
  });
}
