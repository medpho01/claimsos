/**
 * First-class line items — the arbitrary-length itemised-table contract.
 *
 * Today `docExtractor.buildPayloadSchema` produces only
 * `{ fields, per_field_confidence, confidence }` — a flat bag of scalars.
 * That is fine for a discharge summary and useless for a final bill, whose
 * whole value is the 18–300 row table. Everything downstream of extraction
 * (tariff comparison, duplicate-charge detection, non-payable flagging) needs
 * those rows as DATA, not as a paragraph of OCR text.
 *
 * Design notes worth defending:
 *
 *  - EVERY money/quantity column is nullable. A bill with no discount column
 *    must emit null, never 0, because "this hospital gave no discount" and
 *    "this bill has no discount column" are different facts and only the
 *    former is a claim-adjudication input. Zod's `.optional().nullable()`
 *    keeps both `undefined` (key absent) and `null` (explicitly absent)
 *    valid.
 *
 *  - The numeric columns use `z.coerce.number()`, which is still a
 *    `ZodNumber` structurally but survives a model that emits "1250" instead
 *    of 1250. Null and undefined short-circuit inside ZodNullable/ZodOptional
 *    before coercion runs, so `null` never becomes 0.
 *
 *  - `row_index` is the model's own row ordinal, re-numbered contiguously by
 *    dedupeLineItems so consumers can address a row stably.
 *
 *  - checkLineItemTotals is the honesty check. Rows summing to the declared
 *    grand total is the strongest available evidence that no row was dropped
 *    and no amount landed on the wrong line — precisely the failure mode that
 *    overlapping tiles exist to fix.
 *
 *  - OUTPUT BUDGET. buildLineItemsPromptBlock tells the model to emit every
 *    row of a 120+ row table. That instruction is only honest if the call is
 *    actually given the tokens to do it: a 120-row array at ~100 output tokens
 *    a row is ~12k, which overran the old 8192 doc_extract ceiling, and a
 *    response cut off mid-array is rejected by Zod — so the model was being
 *    asked for something the transport could not carry. claudeClient's
 *    resolveMaxOutputTokens now gives doc_extract.* 16384 on the premium
 *    (vision / line-item) tier and rejects a truncated response outright
 *    (LlmResponseTruncatedError) instead of letting a short table pass as a
 *    complete one. The prompt's job here is only to keep the cells terse
 *    enough to fit inside that budget — never to trade a row for length.
 */

import { z } from 'zod';

// Type-only: erased at compile time, so this cannot create a runtime cycle
// with visionRead.ts (which does not import this module in any case).
import type { VisionTileAxis } from './visionRead.js';

// ─── Row schema ──────────────────────────────────────────────────────────

/**
 * ONE row of an itemised bill / pharmacy bill / investigation table.
 * Every money/quantity column is nullable: a bill that has no discount column
 * must emit null, never 0, so a real zero stays distinguishable from "absent".
 */
export const LineItemSchema = z.object({
  row_index: z.coerce.number(),
  particulars: z.string(),
  code: z.string().optional().nullable(),
  date: z.string().optional().nullable(),
  qty: z.coerce.number().optional().nullable(),
  rate: z.coerce.number().optional().nullable(),
  gross: z.coerce.number().optional().nullable(),
  discount: z.coerce.number().optional().nullable(),
  net: z.coerce.number().optional().nullable(),
  tax_pct: z.coerce.number().optional().nullable(),
  payable: z.coerce.number().optional().nullable(),
  source_page: z.coerce.number().optional().nullable(),
  confidence: z.coerce.number().optional(),
});

export type LineItem = z.infer<typeof LineItemSchema>;

/**
 * Spread into the object passed to z.object() in
 * docExtractor.buildPayloadSchema so the extractor payload gains
 * `line_items` / `line_items_confidence` WITHOUT the extractor re-declaring
 * the row shape. Both keys are optional, so a category with no table is
 * unaffected and existing model outputs still validate.
 */
export const LINE_ITEMS_SCHEMA_FRAGMENT = {
  line_items: z.array(LineItemSchema).optional(),
  line_items_confidence: z.coerce.number().optional(),
};

/** doc_category codes that carry an itemised table and must request line_items. */
export const LINE_ITEM_CATEGORIES: ReadonlySet<string> = new Set([
  'final_bill',
  'pharmacy_bill',
  'interim_bill',
  'investigation_report',
  'pathology_reports',
  'bill_of_supply',
  'itemised_bill',
]);

export function isLineItemCategory(category: string): boolean {
  if (!category) return false;
  return LINE_ITEM_CATEGORIES.has(String(category).trim().toLowerCase());
}

// ─── Dedupe ──────────────────────────────────────────────────────────────

/** Collapse whitespace + case so two readings of the same cell key alike. */
function normaliseKeyPart(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The dedupe key: normalised particulars + code + date + payable. */
function dedupeKey(item: LineItem): string {
  return [
    normaliseKeyPart(item.particulars),
    normaliseKeyPart(item.code),
    normaliseKeyPart(item.date),
    normaliseKeyPart(item.payable),
  ].join('|');
}

/** Warning surfaced when rows share a key but dropping them was NOT justified. */
export const POSSIBLE_DUPLICATES_WARNING = 'line_items_possible_duplicates' as const;

export interface DedupeLineItemsResult {
  /** The adopted rows, row_index renumbered contiguously from 0. */
  items: LineItem[];
  /** Rows actually dropped. 0 whenever the deduped set was NOT adopted. */
  removed: number;
  /** Rows that share a key with an earlier row, whether or not they were dropped. */
  possibleDuplicates: number;
  /** True when the deduped set was adopted (it fixed the declared-total match). */
  deduped: boolean;
}

/**
 * Collapse overlap-region duplicates — but ONLY when doing so is provably
 * right.
 *
 * The key (particulars + code + date + payable) cannot tell a tile-overlap
 * artefact from a genuine repeat, and on Indian bills the genuine repeat is
 * the common case: a pharmacy bill routinely prints the same drug at the same
 * price on consecutive rows with no per-row date column, so three dispensings
 * of `TAB PARACETAMOL 650 … 15.00` collapse to one and the bill silently
 * understates by ₹30. Dropping a real row is unrecoverable; keeping a
 * duplicate is visible downstream (the totals check fires, a human looks).
 *
 * So the dedupe is CONDITIONAL. We build both sets and adopt the deduped one
 * only when it flips `matchesDeclaredTotal` from false to true — i.e. only
 * when the arithmetic of the bill itself says the duplicates were the
 * extraction's fault. Otherwise every row is kept and `possibleDuplicates`
 * (surfaced as `line_items_possible_duplicates` by checkLineItemTotals) tells
 * the reviewer what we saw and declined to act on.
 *
 * `declaredTotal` is optional so the existing single-argument call site keeps
 * compiling and keeps its rows; pass the bill's printed grand total to enable
 * the flip. With no declared total there is no evidence, so nothing is
 * dropped.
 *
 * Malformed entries (null, non-objects) are always removed — those are not
 * rows at all.
 */
export function dedupeLineItems(
  items: readonly LineItem[],
  declaredTotal?: number | null,
  tolerance = 1,
): DedupeLineItemsResult {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: [], removed: 0, possibleDuplicates: 0, deduped: false };
  }

  const renumber = (rows: readonly LineItem[]): LineItem[] =>
    rows.map((item, i) => ({ ...item, row_index: i }));

  // Pass 1: drop the entries that are not rows, and count key collisions.
  const clean: LineItem[] = [];
  const unique: LineItem[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  let possibleDuplicates = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      malformed++;
      continue;
    }
    clean.push(item);
    const key = dedupeKey(item);
    if (seen.has(key)) {
      possibleDuplicates++;
      continue;
    }
    seen.add(key);
    unique.push(item);
  }

  if (possibleDuplicates === 0) {
    return { items: renumber(clean), removed: malformed, possibleDuplicates: 0, deduped: false };
  }

  // Pass 2: does dropping them actually fix the bill? Only the transition
  // false → true counts. A set that already matched, or that still does not
  // match, gives us no licence to delete a printed row.
  const keptMatches = checkLineItemTotals(clean, declaredTotal, tolerance).matchesDeclaredTotal;
  const dedupedMatches = checkLineItemTotals(unique, declaredTotal, tolerance).matchesDeclaredTotal;

  if (keptMatches === false && dedupedMatches === true) {
    return {
      items: renumber(unique),
      removed: malformed + possibleDuplicates,
      possibleDuplicates,
      deduped: true,
    };
  }

  return {
    items: renumber(clean),
    removed: malformed,
    possibleDuplicates,
    deduped: false,
  };
}

// ─── Totals cross-check ──────────────────────────────────────────────────

export interface LineItemTotalsCheck {
  rowCount: number;
  sumPayable: number | null;
  sumNet: number | null;
  declaredTotal: number | null;
  /** null when there is nothing to compare against. */
  matchesDeclaredTotal: boolean | null;
  deltaAbs: number | null;
  /**
   * Rows sharing a dedupe key with an earlier row. Non-zero means the table
   * MAY carry a tile-overlap artefact — or a genuine repeated charge. The
   * rows are still present; this is a flag for a human, not a deletion.
   */
  possibleDuplicateRows: number;
  warnings: string[];
}

/** Sum a column, ignoring null/undefined/NaN. Returns null when no cell had a value. */
function sumColumn(items: readonly LineItem[], key: 'payable' | 'net'): number | null {
  let total = 0;
  let seen = 0;
  for (const item of items) {
    const v = item?.[key];
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    total += n;
    seen++;
  }
  if (seen === 0) return null;
  return Math.round(total * 100) / 100;
}

/**
 * Cross-check the extracted rows against the bill's declared grand total.
 * A mismatch is the strongest available signal that a row was dropped or
 * an amount landed on the wrong line — the exact failure tiling fixes.
 * `tolerance` defaults to 1 (rupee).
 */
export function checkLineItemTotals(
  items: readonly LineItem[],
  declaredTotal?: number | null,
  tolerance = 1,
): LineItemTotalsCheck {
  const rows = Array.isArray(items) ? items : [];
  const warnings: string[] = [];

  const sumPayable = sumColumn(rows, 'payable');
  const sumNet = sumColumn(rows, 'net');

  if (rows.length === 0) warnings.push('line_items_empty');

  // Duplicate-key rows are REPORTED, never removed here. dedupeLineItems only
  // drops them when the declared total proves they were an artefact; when it
  // declines, this warning is how the reviewer learns the table has repeats.
  const keys = new Set<string>();
  let possibleDuplicateRows = 0;
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const key = dedupeKey(item);
    if (keys.has(key)) possibleDuplicateRows++;
    else keys.add(key);
  }
  if (possibleDuplicateRows > 0) warnings.push(POSSIBLE_DUPLICATES_WARNING);

  const declaredRaw = declaredTotal === null || declaredTotal === undefined ? null : Number(declaredTotal);
  const declared = declaredRaw !== null && Number.isFinite(declaredRaw) ? declaredRaw : null;

  // Prefer the payable column (post-tax, what the hospital actually charges);
  // fall back to net when the bill has no payable column at all.
  const comparable = sumPayable ?? sumNet;

  let matchesDeclaredTotal: boolean | null = null;
  let deltaAbs: number | null = null;

  if (declared !== null && comparable !== null) {
    deltaAbs = Math.round(Math.abs(comparable - declared) * 100) / 100;
    matchesDeclaredTotal = deltaAbs <= Math.abs(tolerance);
    if (!matchesDeclaredTotal) warnings.push('line_items_total_mismatch');
  }

  return {
    rowCount: rows.length,
    sumPayable,
    sumNet,
    declaredTotal: declared,
    matchesDeclaredTotal,
    deltaAbs,
    possibleDuplicateRows,
    warnings,
  };
}

// ─── Prompt fragment ─────────────────────────────────────────────────────

/**
 * Rule 3 — the merge rule, and the ONLY axis-dependent line in this block.
 *
 * The tiler cuts a wide landscape bill into VERTICAL column strips (axis 'x')
 * and a dense portrait page into HORIZONTAL row bands (axis 'y'). The two
 * merge rules are opposites, so a single hard-coded rule is wrong half the
 * time — and this block goes into the USER turn, right next to describeTiling's
 * axis-correct prose, so a hard-coded rule contradicts its own neighbour.
 *
 * The 'x' text is byte-for-byte what shipped with the certified landscape
 * measurement. Do not reflow it.
 */
const MERGE_RULE_X_LINES: readonly string[] = [
  '3. MERGE BY ROW KEY. When the page is supplied as overlapping horizontal slices,',
  '   the cuts are VERTICAL: every slice shows the SAME rows in the SAME order, and',
  '   the Nth data row of one slice is the Nth data row of every other slice. The',
  '   LEFTMOST slice carries the row keys; a rightmost slice may show only money',
  '   columns with no key, which is expected. Join a row\'s cells across slices by',
  '   that shared ordering plus the columns adjacent slices have in common, take each',
  '   cell from whichever slice renders it most legibly, and emit the row ONCE.',
];

/**
 * The inverse instruction. Free of "the SAME rows", "the Nth data row" and
 * "LEFTMOST slice": told those things about row bands, a model repeats the
 * overlap down the whole table or drops every band after the first.
 */
const MERGE_RULE_Y_LINES: readonly string[] = [
  '3. CONCATENATE THE BANDS, DE-DUPLICATE BY ROW KEY. When the page is supplied as',
  '   overlapping full-width bands, the cuts are HORIZONTAL: each band shows a',
  '   DIFFERENT, CONSECUTIVE block of rows, band 2 continues where band 1 stopped,',
  '   no band repeats the whole table, and the Nth row of one band is NOT the Nth row',
  '   of another. Read the bands in order and CONCATENATE their rows into one array,',
  '   so line_items holds every row of the PAGE, not the rows of any one band. Only',
  '   the FIRST band prints the column headers; later bands have the SAME columns in',
  '   the SAME left-to-right order, so apply that header layout to them. Adjacent',
  '   bands overlap, so the last rows of one band reappear as the first rows of the',
  '   next: de-duplicate ONLY that overlap, matching on the row key — never by',
  '   position, and never by re-counting rows against the first band. Emit each row',
  '   ONCE, and remember a row that appears in only one band is still a row.',
];

/** No tiles: there is nothing to merge, so promise nothing. */
const MERGE_RULE_UNTILED_LINES: readonly string[] = [
  '3. NOTHING TO MERGE. This page was supplied whole, not as overlapping slices or',
  '   bands. There is no second view of any row and nothing to de-duplicate: read',
  '   the table straight down, in printed order, and emit each printed row ONCE.',
];

function mergeRuleLines(axes: readonly VisionTileAxis[]): readonly string[] {
  const hasX = axes.includes('x');
  const hasY = axes.includes('y');
  if (hasX && hasY) {
    // Mixed-orientation section: state both rules under labels rather than
    // picking one. The tiling paragraph in this same user turn says which
    // page was cut which way.
    return [
      '3. MERGE ACCORDING TO HOW EACH PAGE WAS CUT. Some pages of this section were cut',
      '   into VERTICAL slices and the rest into HORIZONTAL bands; the tiling note above',
      '   says which page is which.',
      '3a. For a page cut into VERTICAL slices — MERGE BY ROW KEY. Every slice shows the',
      '   SAME rows in the SAME order, and the Nth data row of one slice is the Nth data',
      '   row of every other slice. The LEFTMOST slice carries the row keys; a rightmost',
      '   slice may show only money columns with no key, which is expected. Join a row\'s',
      '   cells across slices by that shared ordering plus the columns adjacent slices',
      '   have in common, and emit the row ONCE.',
      '3b. For a page cut into HORIZONTAL bands — CONCATENATE, DE-DUPLICATE BY ROW KEY.',
      '   Each band shows a DIFFERENT, CONSECUTIVE block of rows and band 2 continues',
      '   where band 1 stopped, so read the bands in order and CONCATENATE their rows.',
      '   Only the FIRST band prints the headers. De-duplicate ONLY the few rows adjacent',
      '   bands share, matching on the row key — never by position, and never by',
      '   re-counting rows against the first band.',
    ];
  }
  if (hasX) return MERGE_RULE_X_LINES;
  if (hasY) return MERGE_RULE_Y_LINES;
  return MERGE_RULE_UNTILED_LINES;
}

/**
 * Prompt fragment describing the line_items contract. Injected by the
 * extractor prompt builder.
 *
 * @param category  the doc_category code, used only for the prose label.
 * @param axes      the axes the tiler actually used for this section, from
 *                  `prepareVisionInput(...).tileAxes`. Defaults to "untiled",
 *                  which asserts no merge rule at all — the conservative
 *                  choice, and the correct one for an OCR-text-only call.
 */
export function buildLineItemsPromptBlock(
  category: string,
  axes: readonly VisionTileAxis[] = [],
): string {
  const label = String(category ?? '').replace(/_/g, ' ').trim() || 'document';
  return [
    'ITEMISED TABLE (line_items) — REQUIRED for this document type',
    '',
    `This ${label} carries an itemised table. In ADDITION to the scalar fields above,`,
    'return a top-level "line_items" array with ONE object per printed table row,',
    'in the order the rows appear on the page, using exactly these keys:',
    '',
    '  row_index    integer, 0-based, in printed order',
    '  particulars  string, the item/service/drug description exactly as printed',
    '  code         string or null — service/HSN/CGHS/item code, if the bill prints one',
    '  date         string or null — the row\'s service date, as YYYY-MM-DD',
    '  qty          number or null — quantity / units / days',
    '  rate         number or null — per-unit rate',
    '  gross        number or null — pre-discount amount for the row',
    '  discount     number or null — discount on the row',
    '  net          number or null — post-discount, pre-tax amount',
    '  tax_pct      number or null — GST/tax percentage applied to the row',
    '  payable      number or null — final amount charged for the row',
    '  source_page  integer or null — the page number the row was read from',
    '',
    'RULES — these matter more than the field list:',
    '1. NULL vs ZERO. If the bill has NO column for a value, emit null. Emit 0 ONLY',
    '   when the bill actually prints a zero. A null and a zero mean different things',
    '   downstream and a wrong zero corrupts the claim.',
    '2. EVERY ROW, EXACTLY ONCE. Transcribe every printed row, including sub-total',
    '   rows inside a section only if they are printed as line items. Do NOT summarise,',
    '   do NOT collapse similar rows, do NOT stop early. If the table runs to more than',
    '   120 rows, still emit every row — the response budget for this call is sized for',
    '   the whole table, so there is no length you need to trade a row away for.',
    '2a. FIT BY BEING TERSE, NEVER BY DROPPING A ROW. Keep every cell to what is',
    '   printed: no commentary, no restating the column header inside the cell, no',
    '   repeating units the header already gives, no explanatory notes. Never write',
    '   "... and N more rows", never write "(continued)", never end the array early.',
    '   A long, terse, COMPLETE table is the correct answer; a short one is a wrong',
    '   answer that looks like a clean extraction.',
    ...mergeRuleLines(axes),
    '4. NEVER SHIFT A COLUMN. An amount belongs to the row it is printed on. If a money',
    '   column looks like it has drifted off its row, re-anchor on the row key before',
    '   reading it — do not guess from vertical position alone.',
    '5. NO INVENTION. Never add a row that is not printed, and never drop one that is.',
    '   If a cell is genuinely illegible, emit null for that cell rather than a guess.',
    '6. The row amounts must add up to the bill\'s printed grand total. If your rows do',
    '   not sum to it, re-read the table before answering — you have missed or',
    '   mis-assigned a row.',
    '',
    'Also return "line_items_confidence": a number 0-1 for the table as a whole.',
  ].join('\n');
}
