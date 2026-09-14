/**
 * The proof gate: single image vs overlapping tiles, scored on 196 known
 * cells of a degraded landscape bill.
 *
 * This is what makes "tiling fixes the money column" a measurement instead of
 * a claim. Both strategies get the SAME fixture, the SAME prompt, and the
 * SAME scorer. The only difference is how the pixels reach the model:
 *
 *   single — one whole-page image fitted to a 1568px long edge. This is the
 *            status quo (and is in fact slightly GENEROUS to it: today's code
 *            sends a 2.0-scale render and lets Anthropic do the downscale,
 *            which is no better).
 *   tiled  — prepareVisionInput: aspect-aware DPI, deskew, a downscaled
 *            overview, and N native-resolution overlapping horizontal slices.
 *
 * Ship criterion (per the spec): every tiled trial ≥ TILED_ACCURACY_FLOOR and
 * tiled > single. The CLI exits 1 otherwise.
 *
 * SPEND: this makes real, billable Anthropic calls — one per strategy per
 * trial. `assertSpendAllowed` refuses to run without an explicit
 * EXTRACT_HARNESS_ALLOW_SPEND=1, mirroring pipelineV2's assertReplaySafe.
 *
 * Run:
 *   EXTRACT_HARNESS_ALLOW_SPEND=1 npx tsx src/Services/extractor/harness/visionRegression.ts
 */

import { pathToFileURL } from 'url';
import { z } from 'zod';

import { LineItemSchema, type LineItem } from '../lineItems.js';
import { prepareVisionInput, type VisionTileAxis } from '../visionRead.js';
import { ANTHROPIC_MAX_EDGE_PX } from '../imageTiler.js';
import {
  generateSyntheticLandscapeBill,
  type SyntheticBillFixture,
} from './syntheticBill.js';
import { scoreAgainstGroundTruth, type ExtractionScore } from './score.js';

// ─── Public types ────────────────────────────────────────────────────────

export type VisionRegressionStrategy = 'single' | 'tiled';

/** The gate. Tiled must clear this or the change does not ship. */
export const TILED_ACCURACY_FLOOR = 0.99 as const;

export interface VisionRegressionResult {
  strategy: VisionRegressionStrategy;
  trial: number;
  score: ExtractionScore;
  imagesSent: number;
  /**
   * Cut axes the tiler chose for this trial, and therefore which merge rule the
   * system prompt carried. Reported because a score is only comparable to
   * another score taken under the same contract.
   */
  tileAxes: VisionTileAxis[];
  costInr: number;
  latencyMs: number;
}

export interface VisionRegressionOptions {
  strategies?: readonly VisionRegressionStrategy[];
  fixture?: SyntheticBillFixture;
  /** Default 1. */
  trials?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────

const HARNESS_MODEL = 'claude-sonnet-4-5';
const HARNESS_MAX_TOKENS = 16_384;
const USD_PER_M_INPUT = 3;
const USD_PER_M_OUTPUT = 15;
const USD_TO_INR = 83;

const HarnessPayloadSchema = z.object({
  header: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
  line_items: z.array(LineItemSchema).default([]),
  totals: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
});

// ─── System prompt: SAME CONTRACT THE SERVICE SHIPS ──────────────────────
//
// A harness that measures a different prompt from the one production sends is
// not a gate, it is a coincidence. visionRead's system prompt is now built per
// call from the axes imageTiler actually cut on ('x' = vertical column strips,
// 'y' = horizontal row bands), because the two merge rules are OPPOSITES. This
// prompt is the extraction-flavoured twin of that: same three cases, same
// claims about how the images relate, JSON instead of plain text.
//
// buildHarnessSystemPrompt(['x']) is BYTE-IDENTICAL to the prompt that scored
// 196/196 on the landscape fixture. Do not reflow it.

const HARNESS_PROMPT_BASE_LINES: readonly string[] = [
  'You are a medical-bill data extractor. You read images of Indian hospital',
  'bills and return STRICT JSON — no prose, no markdown, no code fence.',
];

/** axis 'x' — vertical cuts, so every slice repeats the same rows. */
const HARNESS_PROMPT_X_LINES: readonly string[] = [
  'When you are given more than one image they are ONE page, not several',
  'documents. The first image may be a DOWNSCALED OVERVIEW of the whole page:',
  'use it for header and grand-total fields only. The remaining images are',
  'FULL-RESOLUTION OVERLAPPING HORIZONTAL SLICES of that same page, ordered',
  'left to right, each overlapping its neighbour by about 16%.',
  '',
  'Reconstruct each table row by matching its row key (the Sr number, or the',
  'Particulars text) ACROSS slices, then read that row\'s cells from whichever',
  'slice shows them most clearly. A row visible in two adjacent slices is ONE',
  'row — emit it exactly once. Never invent a row, never drop one, and never',
  'move a value from one row onto another: if a money column looks misaligned,',
  're-anchor on the row key and read it again.',
];

/**
 * axis 'y' — horizontal cuts, so each band carries DIFFERENT rows. The inverse
 * instruction. Telling the model to match rows "across slices" here would make
 * it reconcile band 1's rows with band 2's completely different rows.
 */
const HARNESS_PROMPT_Y_LINES: readonly string[] = [
  'When you are given more than one image they are ONE page, not several',
  'documents. The first image may be a DOWNSCALED OVERVIEW of the whole page:',
  'use it for header and grand-total fields only. The remaining images are',
  'FULL-RESOLUTION OVERLAPPING FULL-WIDTH BANDS of that same page, ordered top',
  'to bottom, each overlapping its neighbour by about 16%.',
  '',
  'Each band shows a DIFFERENT, CONSECUTIVE block of table rows: band 2',
  'continues where band 1 stopped, and no band repeats the whole table. Read',
  'the bands in order and CONCATENATE their rows into one array, so line_items',
  'holds every row of the page, not the rows of any one band. Only the FIRST',
  'band shows the column headers; later bands have the SAME columns in the',
  'SAME left-to-right order, so apply that header layout to them. Because the',
  'bands overlap, the last rows of one band reappear as the first rows of the',
  'next: de-duplicate ONLY that overlap, matching on the row key (the Sr',
  'number, or the Particulars text) — never by position, and never by counting',
  'rows against the first band. Never invent a row, never drop one, and never',
  'move a value from one row onto another: if a money column looks misaligned,',
  're-anchor on the row key and read it again.',
];

/** No tiles — the 'single' strategy. Say nothing about slices that were not sent. */
const HARNESS_PROMPT_UNTILED_LINES: readonly string[] = [
  'You are being given ONE image: the whole bill page. There are no slices to',
  'merge and no rows to de-duplicate — read every printed row exactly once, in',
  'printed order. Never invent a row, and never drop one. Never',
  'move a value from one row onto another: if a money column looks misaligned,',
  're-anchor on the row key (the Sr number, or the Particulars text) and read',
  'it again.',
];

/**
 * Build the harness system prompt for the axes the tiler actually used —
 * mirroring visionRead.buildVisionReadSystemPrompt, so what this measures is
 * what production ships.
 */
export function buildHarnessSystemPrompt(axes: readonly VisionTileAxis[] = []): string {
  const hasX = axes.includes('x');
  const hasY = axes.includes('y');
  const lines: string[] = [...HARNESS_PROMPT_BASE_LINES];

  if (!hasX && !hasY) {
    lines.push('', ...HARNESS_PROMPT_UNTILED_LINES);
  } else if (hasX && !hasY) {
    lines.push('', ...HARNESS_PROMPT_X_LINES);
  } else if (hasY && !hasX) {
    lines.push('', ...HARNESS_PROMPT_Y_LINES);
  } else {
    lines.push('', 'For a page cut into VERTICAL slices:', ...HARNESS_PROMPT_X_LINES);
    lines.push('', 'For a page cut into HORIZONTAL bands:', ...HARNESS_PROMPT_Y_LINES);
    lines.push(
      '',
      'The text sent with the images says which page was cut which way.',
    );
  }

  return lines.join('\n');
}

// ─── Spend guard ─────────────────────────────────────────────────────────

/** Throws unless EXTRACT_HARNESS_ALLOW_SPEND === '1'. Mirrors pipelineV2's assertReplaySafe guard. */
export function assertSpendAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.EXTRACT_HARNESS_ALLOW_SPEND === '1') return;
  throw new Error(
    'visionRegression: refusing to run without EXTRACT_HARNESS_ALLOW_SPEND=1. ' +
      'Every trial makes real, billable Anthropic vision calls (one per strategy). ' +
      'Re-run as: EXTRACT_HARNESS_ALLOW_SPEND=1 npx tsx src/Services/extractor/harness/visionRegression.ts',
  );
}

// ─── Extraction ──────────────────────────────────────────────────────────

function buildUserPrompt(fixture: SyntheticBillFixture, layoutContext: string): string {
  const headerKeys = Object.keys(fixture.groundTruth.header);
  const totalsKeys = Object.keys(fixture.groundTruth.totals);
  return [
    layoutContext,
    layoutContext ? '' : null,
    'Extract this itemised final bill as JSON with exactly three top-level keys:',
    '',
    `1. "header" — an object with exactly these keys: ${headerKeys.join(', ')}.`,
    '   Dates as YYYY-MM-DD. Values exactly as printed otherwise.',
    '',
    '2. "line_items" — an array with ONE object per printed table row, in printed',
    '   order, each with these keys: row_index (0-based integer), particulars,',
    '   code, date (YYYY-MM-DD), qty, rate, gross, discount, net, tax_pct, payable.',
    '   Money and quantity values are NUMBERS, not strings, with no currency symbol',
    '   and no thousands separator. Emit a printed zero as 0; emit null ONLY when',
    '   the bill has no such column. Emit EVERY row — do not summarise or stop early.',
    '',
    `3. "totals" — an object with exactly these keys: ${totalsKeys.join(', ')}, as numbers.`,
    '',
    'Return ONLY the JSON object.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function parsePayload(raw: string): z.infer<typeof HarnessPayloadSchema> {
  let text = raw.trim();
  const fenced = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced && fenced[1] !== undefined) text = fenced[1];
  // Some snapshots prepend a sentence despite the instruction — take the
  // outermost JSON object.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first > 0 || last < text.length - 1) {
    if (first >= 0 && last > first) text = text.slice(first, last + 1);
  }
  return HarnessPayloadSchema.parse(JSON.parse(text));
}

interface StrategyImages {
  attachments: Array<{ kind: 'image'; data: Buffer; mime: string }>;
  layoutContext: string;
  /** Cut axes actually used. Drives the merge rule in the system prompt. */
  tileAxes: VisionTileAxis[];
}

async function buildStrategyImages(
  strategy: VisionRegressionStrategy,
  fixture: SyntheticBillFixture,
): Promise<StrategyImages> {
  if (strategy === 'tiled') {
    const prepared = await prepareVisionInput({
      source: fixture.imageBytes,
      kind: 'image',
    });
    if (prepared.attachments.length === 0) {
      throw new Error(`visionRegression: tiled strategy produced no images (${prepared.warnings.join(',')})`);
    }
    return {
      attachments: prepared.attachments,
      layoutContext: prepared.layoutContext,
      tileAxes: prepared.tileAxes,
    };
  }

  // 'single' — the status quo: one whole-page image at the API's ceiling.
  const sharpMod: any = await import('sharp');
  const sharp = sharpMod?.default ?? sharpMod;
  const fitted: Buffer = await sharp(fixture.imageBytes)
    .resize({
      width: ANTHROPIC_MAX_EDGE_PX,
      height: ANTHROPIC_MAX_EDGE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92 })
    .toBuffer();
  return {
    attachments: [{ kind: 'image', data: fitted, mime: 'image/jpeg' }],
    layoutContext: 'You are being sent 1 image: the whole bill page.',
    tileAxes: [],
  };
}

async function runOneTrial(
  strategy: VisionRegressionStrategy,
  trial: number,
  fixture: SyntheticBillFixture,
): Promise<VisionRegressionResult> {
  const started = Date.now();
  const { attachments, layoutContext, tileAxes } = await buildStrategyImages(strategy, fixture);

  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ maxRetries: 3, timeout: 180_000 });

  const content: any[] = attachments.map((a) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: a.mime,
      data: (a.data as Buffer).toString('base64'),
    },
  }));
  content.push({ type: 'text', text: buildUserPrompt(fixture, layoutContext) });

  const response: any = await client.messages.create({
    model: HARNESS_MODEL,
    max_tokens: HARNESS_MAX_TOKENS,
    system: buildHarnessSystemPrompt(tileAxes),
    messages: [{ role: 'user', content }],
  });

  const rawText: string = Array.isArray(response?.content)
    ? response.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
    : '';

  const payload = parsePayload(rawText);
  const score = scoreAgainstGroundTruth(fixture.groundTruth, {
    header: payload.header as Record<string, unknown>,
    line_items: payload.line_items as LineItem[],
    totals: payload.totals as Record<string, unknown>,
  });

  const tokensIn = Number(response?.usage?.input_tokens ?? 0);
  const tokensOut = Number(response?.usage?.output_tokens ?? 0);
  const usd = (tokensIn * USD_PER_M_INPUT + tokensOut * USD_PER_M_OUTPUT) / 1_000_000;

  return {
    strategy,
    trial,
    score,
    imagesSent: attachments.length,
    tileAxes,
    costInr: Math.round(usd * USD_TO_INR * 10000) / 10000,
    latencyMs: Date.now() - started,
  };
}

/**
 * Generate (or accept) the fixture, extract it BOTH ways, score 196 fields.
 * Refuses to run unless EXTRACT_HARNESS_ALLOW_SPEND=1 — this makes real
 * Anthropic calls. Exposed as a library function AND run as a CLI
 * (`npx tsx src/Services/extractor/harness/visionRegression.ts`), which
 * prints a table and exits 1 if any tiled trial is below TILED_ACCURACY_FLOOR
 * or if tiled does not beat single.
 */
export async function runVisionRegression(
  opts: VisionRegressionOptions = {},
): Promise<VisionRegressionResult[]> {
  assertSpendAllowed();

  const strategies = opts.strategies ?? (['single', 'tiled'] as const);
  const trials = Math.max(1, opts.trials ?? 1);
  const fixture = opts.fixture ?? (await generateSyntheticLandscapeBill());

  const results: VisionRegressionResult[] = [];
  for (let trial = 1; trial <= trials; trial++) {
    for (const strategy of strategies) {
      results.push(await runOneTrial(strategy, trial, fixture));
    }
  }
  return results;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  assertSpendAllowed();

  const trials = Number(process.env.EXTRACT_HARNESS_TRIALS ?? 1) || 1;
  const fixture = await generateSyntheticLandscapeBill();

  console.log(
    `\nVision regression — synthetic landscape bill ${fixture.widthPx}x${fixture.heightPx}, ` +
      `${fixture.groundTruth.fieldCount} scored cells, ${trials} trial(s) per strategy.\n`,
  );

  const results = await runVisionRegression({ fixture, trials });

  console.log(
    ['strategy', 'trial', 'images', 'axis', 'accuracy', 'money', 'hits/total', 'cost ₹', 'ms']
      .map((h, i) => (i === 0 ? h.padEnd(9) : h.padStart(11)))
      .join(' '),
  );
  for (const r of results) {
    console.log(
      [
        r.strategy.padEnd(9),
        String(r.trial).padStart(11),
        String(r.imagesSent).padStart(11),
        (r.tileAxes.length > 0 ? r.tileAxes.join('+') : 'none').padStart(11),
        pct(r.score.accuracy).padStart(11),
        pct(r.score.moneyAccuracy).padStart(11),
        `${r.score.hits}/${r.score.total}`.padStart(11),
        r.costInr.toFixed(3).padStart(11),
        String(r.latencyMs).padStart(11),
      ].join(' '),
    );
  }

  const tiled = results.filter((r) => r.strategy === 'tiled');
  const single = results.filter((r) => r.strategy === 'single');
  const tiledMean = mean(tiled.map((r) => r.score.accuracy));
  const singleMean = mean(single.map((r) => r.score.accuracy));

  console.log(
    `\nmean accuracy — single ${pct(singleMean)}, tiled ${pct(tiledMean)} ` +
      `(floor ${pct(TILED_ACCURACY_FLOOR)})`,
  );

  const worstTiled = tiled.find((r) => r.score.accuracy < TILED_ACCURACY_FLOOR);
  if (worstTiled) {
    console.log(`\nFAIL: tiled trial ${worstTiled.trial} scored ${pct(worstTiled.score.accuracy)}.`);
    for (const m of worstTiled.score.misses.slice(0, 25)) {
      console.log(`  MISS ${m.key}: expected "${m.expected}" got "${m.actual ?? '<absent>'}"`);
    }
    if (worstTiled.score.misses.length > 25) {
      console.log(`  ... and ${worstTiled.score.misses.length - 25} more`);
    }
    process.exit(1);
  }

  if (tiled.length > 0 && single.length > 0 && tiledMean <= singleMean) {
    console.log(
      `\nFAIL: tiled (${pct(tiledMean)}) did not beat single (${pct(singleMean)}). ` +
        'The tiling change is not earning its cost — do not ship it.',
    );
    process.exit(1);
  }

  console.log('\nPASS: tiled clears the floor and beats single.\n');
}

// Guarded so importing this module (e.g. from a test) never spends.
const invokedDirectly = (() => {
  const entry = process.argv?.[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\nvisionRegression failed: ${(err as any)?.message ?? String(err)}`);
    process.exit(1);
  });
}
