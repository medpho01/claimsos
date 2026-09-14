/**
 * Vision read — the OCR replacement.
 *
 * Two entry points, deliberately separated:
 *
 *  - `prepareVisionInput` turns a source document into vision attachments
 *    (render at an aspect-aware DPI → deskew → tile → overview + tiles). It
 *    makes NO network call and costs nothing. docExtractor uses it to build
 *    the images for its own structured-extraction call.
 *
 *  - `transcribePagesViaVision` is the actual OCR replacement: one Claude
 *    vision call per page, sent as overview + overlapping tiles, returning a
 *    faithful plain-text transcription that slots straight into
 *    `OcrPage.text`. ocr.service calls this instead of Tesseract.
 *
 * Correctness-first rationale (the user's directive): Tesseract on a phone
 * photo of a hospital bill is not a cheaper way to get the same answer, it is
 * a cheaper way to get a WRONG answer that then poisons every downstream
 * stage. Claude Vision on high-DPI overlapping tiles reads the same page at
 * ~99.5%. The typed-PDF text layer stays the first choice because it is free
 * AND exact; Tesseract drops to a failure fallback.
 *
 * Failure policy: nothing here throws for a single bad page. A page that
 * fails comes back with empty text and a warning so ocr.service can fall
 * back to Tesseract for JUST that page. Only a total wipe-out (every page
 * failed) throws, because that means the provider or the buffer is broken
 * and the caller needs to know.
 *
 * Cost is recorded best-effort to hospital.llm_cost_log via
 * costAccounting.recordCall. OCR runs upstream of claim binding, so claimId
 * and hospitalId are both optional and usually null.
 */

import { logger } from '../../Utils/logger.js';
import {
  describeTiling,
  tileImage,
  tilePdf,
  toLlmAttachments,
} from './imageTiler.js';
import type {
  RenderScaleOptions,
  TileOptions,
  TiledPage,
  VisionImageMime,
} from './visionTypes.js';

// ─── Constants ───────────────────────────────────────────────────────────

export const VISION_READ_PROMPT_VERSION = 'vision-read-v1' as const;
export const VISION_READ_MODEL = 'claude-sonnet-4-5' as const;

/** Mirrors docExtractor's MAX_VISION_PAGES budget. */
const DEFAULT_MAX_PAGES = 8;

/**
 * USD per million tokens. Duplicated from
 * Services/llm/providers/claudeClient.ts (and from ocr.service.ts) to avoid
 * an import cycle — this module is consumed BY ocr.service, which the LLM
 * bridge transitively imports in some test paths.
 */
const USD_PER_M_INPUT = 3;
const USD_PER_M_OUTPUT = 15;
const USD_TO_INR = 83;

/**
 * Output ceiling for a transcription. A dense bill page runs 2-5k tokens, but
 * a 120-row itemised final bill transcribed row by row overruns 8192 — and a
 * transcription cut off at the ceiling is a page whose bottom half simply does
 * not exist downstream. Anthropic bills per OUTPUT token, not per max_tokens,
 * so the headroom costs nothing unless the page really is that dense; Sonnet
 * 4.5 supports far more than this. Truncation is still detected (stop_reason)
 * and still caps the page's confidence below the review threshold — this
 * raise reduces how often that has to fire, it does not replace the check.
 */
const VISION_READ_MAX_TOKENS = 16384;

/**
 * CONFIDENCE IS EVIDENCE, NOT A CONSTANT.
 *
 * This number is not decoration: docBundleClassifier gates human review on it
 * (QUALITY_MIN_CONF = 0.3 → needs_human_review, skip LLM classify). Stamping
 * a flat 0.93 on every page whose text is >20 chars and carries no
 * illegibility phrase — which is what this module used to do — silently
 * deletes that gate for every scanned document, because the vision path now
 * handles ALL of them. A scan Tesseract scored 0.1 and routed to a human
 * sailed through at 0.93 with whatever the model produced.
 *
 * So 0.93 is the CEILING for a clean read, and `scoreVisionReadConfidence`
 * walks it down against what we actually observed: a response truncated at
 * max_tokens, tiles that failed to render, a deskew that failed or could not
 * find the page's text rows, an implausibly low alphanumeric yield per image,
 * and (when the caller has them) line-item totals that do not add up.
 */
export const VISION_READ_CONFIDENCE = 0.93;
/**
 * Confidence when the model explicitly says it cannot read the page. Set
 * BELOW docBundleClassifier's 0.3 review threshold on purpose — "I cannot
 * read this" is exactly the signal the human-review gate exists for.
 */
export const VISION_READ_ILLEGIBLE_CONFIDENCE = 0.25;
/** Confidence for a near-empty read. Below the review threshold. */
export const VISION_READ_EMPTY_CONFIDENCE = 0.2;
/**
 * The threshold the downstream gate uses. Mirrors docBundleClassifier's
 * QUALITY_MIN_CONF. Exported so a caller can ask "would this page be reviewed?"
 * without hard-coding 0.3 a third time.
 */
export const VISION_READ_REVIEW_THRESHOLD = 0.3;
/**
 * Confidence for a page we KNOW is not whole: the response was cut off at
 * max_tokens, or a tile/render failed so the model never saw part of the page.
 *
 * This is a CAP, not a multiplier, and that is the entire point. As a
 * multiplier (0.93 x 0.5 = 0.47) truncation alone never reached the review
 * gate: 0.47 is above QUALITY_MIN_CONF = 0.3, and docBundleClassifier tests
 * the AVERAGE confidence across pages, so one truncated page in twenty moved
 * the mean by 0.02 and nothing fired. A page that is provably missing content
 * must trip the gate on its own evidence, whatever the other pages scored.
 */
export const VISION_READ_INCOMPLETE_CONFIDENCE = 0.25;
/** Nothing goes to zero — zero means "the page failed", which is a different fact. */
const MIN_SCORED_CONFIDENCE = 0.05;
/** Below this many characters a "successful" read is really a failure. */
const MIN_USEFUL_TEXT_CHARS = 20;

/**
 * Alphanumeric characters per image below which the read is implausible.
 * A full-resolution tile of a real hospital document yields many hundreds;
 * a blurred or blank one yields a handful. Two bands so a legitimately
 * sparse page (a stamp, an ID card) is nudged rather than condemned.
 */
const ALNUM_PER_IMAGE_IMPLAUSIBLE = 40;
const ALNUM_PER_IMAGE_SPARSE = 120;

/** Multipliers applied to VISION_READ_CONFIDENCE, one per piece of bad evidence. */
const PENALTY_ORIENTATION_UNKNOWN = 0.9;
const PENALTY_DESKEW_FAILED = 0.85;
const PENALTY_DESKEW_LOW_CONFIDENCE = 0.9;
const PENALTY_ALNUM_IMPLAUSIBLE = 0.35;
const PENALTY_ALNUM_SPARSE = 0.8;
const PENALTY_TOTALS_MISMATCH = 0.7;

/**
 * Tiler/render warnings that mean the model never saw part of the page —
 * a tile that failed to render, a page that never rasterised, a PDF slice
 * that could not be produced. These are not "a slightly worse image": they
 * are MISSING CONTENT, indistinguishable downstream from a page that simply
 * had less on it. They cap confidence at VISION_READ_INCOMPLETE_CONFIDENCE.
 *
 * Kept as an explicit list rather than a prefix match so a benign warning
 * (`tiling_disabled`, `deskew_disabled`, `tile_downscaled`,
 * `tile_no_resolution_gain`) never costs a page its confidence.
 *
 * COUPLING, stated so a rename here is not a silent behaviour change there
 * (2026-09-14). `ocr.service.ts` keeps its own, NARROWER set —
 * RENDER_FAILURE_WARNINGS = { 'vision_no_images_rendered',
 * 'vision_pdf_slice_failed', 'vision_prepare_failed', 'vision_read_no_images' }
 * — and applies it ONLY to a page that came back with empty text, to decide
 * whether that page's `unreadableReason` is 'render_failed' (the operator must
 * RE-UPLOAD the document) rather than 'vision_failed' (retry it). The lists
 * differ on purpose: the members here that ocr.service omits ('tile_failed',
 * 'tile_empty_source', 'tile_metadata_unavailable', 'pdf_page_render_failed')
 * describe a PARTIAL image, where the page usually still returns text and a
 * capped confidence is the right response — telling a user to re-upload a
 * document that produced a readable page would be wrong. ocr.service cannot
 * import this constant: every runtime touch of ./extractor/ from that file is
 * lazy by design, so the four strings are duplicated there with this note.
 */
const INCOMPLETE_IMAGE_WARNINGS: ReadonlySet<string> = new Set([
  'tile_failed',
  'tile_empty_source',
  'tile_metadata_unavailable',
  'pdf_page_render_failed',
  'vision_no_images_rendered',
  'vision_pdf_slice_failed',
  'vision_prepare_failed',
]);

/**
 * Warnings that mean the image we sent was WORSE than intended but still
 * whole. A nudge, not a gate — the page may be sideways, which the model
 * usually still reads.
 */
const DEGRADING_IMAGE_WARNINGS: ReadonlySet<string> = new Set([
  'exif_orientation_unreadable',
]);

// ─── The system prompt is AXIS-AWARE ─────────────────────────────────────
//
// The merge rule is not a constant, because the cut direction is not a
// constant. imageTiler measures both axes and picks the better one: a wide
// landscape bill is cut into VERTICAL column strips (axis 'x'), a dense A4
// portrait page into HORIZONTAL row bands (axis 'y'). The two merge rules are
// OPPOSITES:
//
//   x — every strip shows the SAME rows; join a row's cells ACROSS strips.
//   y — every band shows DIFFERENT, CONSECUTIVE rows; CONCATENATE the bands
//       and de-duplicate only the few overlapping rows, by row key.
//
// Shipping the 'x' rule on a 'y' page tells the model to expect the same rows
// in every image, which makes it either duplicate the overlap across the whole
// table or throw away every band after the first — and it directly contradicts
// the per-axis text describeTiling puts in the USER prompt. So the prompt is
// BUILT per call from the axes actually used, and the untiled case gets no
// merge rule at all.
//
// buildVisionReadSystemPrompt(['x']) is BYTE-IDENTICAL to the prompt that
// measured 100.00% on the landscape fixture. That path must not move.

/** Which way a page was cut. Mirrors imageTiler's TileAxis without importing it. */
export type VisionTileAxis = 'x' | 'y';

/**
 * Plain-text-only OCR instructions. Every downstream OCR consumer (bundle
 * classifier, harmoniser, deterministic extractors) regexes over the returned
 * string, so markdown pipes would corrupt those matches. Ported from the
 * proven VISION_FALLBACK_SYSTEM_PROMPT in ocr.service.ts.
 */
const PROMPT_BASE_LINES: readonly string[] = [
  'You are an OCR engine. Transcribe ALL visible text from this medical',
  'document image, preserving the layout where feasible (use newlines',
  'between blocks). Include text from:',
  '- Letterheads, headers, footers',
  '- Doctor stamps and signatures (especially registration numbers like',
  '  "MPMC Reg No 21274")',
  '- Handwritten fields on pre-printed forms (read the handwriting)',
  '- Photo overlays (GPS Map Camera timestamps, ward numbers)',
  '- Tables — render row by row',
  '- Hindi/Devanagari text — transliterate to English where possible,',
  '  else keep Devanagari',
];

/** Shared preamble for the tiled cases: what the images ARE. */
const PROMPT_TILED_INTRO_LINES: readonly string[] = [
  'MULTIPLE IMAGES OF ONE PAGE',
  'When you are given more than one image, they are NOT different documents',
  'and NOT different pages. They are one single page, supplied as:',
  '- a DOWNSCALED OVERVIEW of the whole page (sent first) — use it to',
  '  understand the layout and to read headers, footers and grand totals;',
  '  its small text is not reliable, so never prefer it over a slice; and',
];

/** axis 'x': what the slices are. */
const PROMPT_X_SLICES_LINES: readonly string[] = [
  '- FULL-RESOLUTION OVERLAPPING horizontal slices of that same page,',
  '  ordered left to right, each overlapping its neighbour.',
];

/** axis 'y': what the bands are. The OPPOSITE claim to the 'x' text above. */
const PROMPT_Y_SLICES_LINES: readonly string[] = [
  '- FULL-RESOLUTION OVERLAPPING full-width bands of that same page,',
  '  ordered top to bottom, each overlapping its neighbour.',
];

/** axis 'x' merge rule — column strips. The landscape-certified wording. */
const PROMPT_X_MERGE_LINES: readonly string[] = [
  'Reconstruct the page from the slices:',
  '- The cuts are VERTICAL, so every slice shows the SAME rows in the SAME',
  '  top-to-bottom order. The Nth data row of one slice is the Nth data row',
  '  of every other slice. The LEFTMOST slice is the one carrying the row',
  '  keys (serial number, description); a rightmost slice may show only',
  '  money columns, with no key at all. That is expected — join its cells to',
  '  the rows by position and by the columns it shares with its neighbour.',
  '- Output ONE line per table row, containing all of that row\'s columns',
  '  joined left to right. A row visible in two adjacent slices is ONE row:',
  '  emit it EXACTLY ONCE.',
  '- Never invent a row that is not visible. Never drop a row that is. If',
  '  the slices disagree on the row count, count again against the leftmost',
  '  slice.',
  '- If a cell is cut off at a slice boundary, read it from the',
  '  neighbouring slice instead of guessing.',
];

/**
 * axis 'y' merge rule — row bands. Deliberately the inverse of the 'x' rule,
 * and deliberately free of the words "same rows", "Nth row" and "leftmost
 * slice": a model told those things about a set of row bands duplicates the
 * overlap across the table or drops every band after the first.
 */
const PROMPT_Y_MERGE_LINES: readonly string[] = [
  'Reconstruct the page from the bands:',
  '- The cuts are HORIZONTAL, so each band is the FULL WIDTH of the page and',
  '  shows a DIFFERENT, CONSECUTIVE block of rows. Band 2 continues where',
  '  band 1 stopped. NO band repeats the whole table, and the Nth row of one',
  '  band is NOT the Nth row of another.',
  '- Read the bands in the order given and CONCATENATE their rows, top to',
  '  bottom, into one continuous table. The page has as many rows as all the',
  '  bands together, not as many as any one band.',
  '- Only the FIRST band shows the column headers. Every later band has the',
  '  SAME columns in the SAME left-to-right order, so apply that header',
  '  layout to the later bands even though their headers are not repeated.',
  '- Adjacent bands OVERLAP: the last rows of one band are repeated as the',
  '  first rows of the next. De-duplicate ONLY that overlap, and do it by ROW',
  '  KEY (serial number, description, date) — never by position, and never by',
  '  re-counting rows against the first band.',
  '- Output ONE line per table row, containing all of that row\'s columns',
  '  joined left to right. A row visible in two adjacent bands is ONE row:',
  '  emit it EXACTLY ONCE.',
  '- Never invent a row that is not visible. Never drop a row that is — a row',
  '  that appears in only one band is still a row.',
  '- If a row is sliced through at a band boundary, read it from the',
  '  neighbouring band where it is whole instead of guessing.',
];

/**
 * Row integrity — the one rule that holds on both axes. Only the RECOVERY
 * differs: inside a column strip a row is identified by its POSITION (the
 * strip may not show a key at all), inside a row band by its KEY (position
 * means nothing once the bands are concatenated).
 */
const PROMPT_ROW_INTEGRITY_X_LINES: readonly string[] = [
  '- Never move a value from one row onto another. If a money column looks',
  '  misaligned with its row, re-anchor on the row position and read again.',
];
const PROMPT_ROW_INTEGRITY_Y_LINES: readonly string[] = [
  '- Never move a value from one row onto another. If a money column looks',
  '  misaligned with its row, re-anchor on the row key and read again.',
];

/** No tiles: say so, so the model never hunts for slices that were not sent. */
const PROMPT_UNTILED_LINES: readonly string[] = [
  'ONE IMAGE PER PAGE',
  'Each image you are given is a COMPLETE page, not a slice of one. There is',
  'nothing to merge and nothing to de-duplicate: transcribe each image in',
  'full, in the order given.',
];

const PROMPT_TAIL_LINES: readonly string[] = [
  'Output JUST the transcribed text. NO commentary, NO markdown',
  "formatting, NO \"Here's the transcription:\" prefix.",
];

/**
 * Build the transcription system prompt for the axes actually used on this
 * call. `axes` comes from the tiles that were emitted — see `visionTileAxes`.
 *
 * - `[]`      → no merge rule at all (a single whole-page image).
 * - `['x']`   → column-strip rule. BYTE-IDENTICAL to the certified prompt.
 * - `['y']`   → row-band rule (the inverse instruction).
 * - both      → both rules, each labelled, for a mixed-orientation batch.
 */
export function buildVisionReadSystemPrompt(
  axes: readonly VisionTileAxis[] = [],
): string {
  const hasX = axes.includes('x');
  const hasY = axes.includes('y');
  const lines: string[] = [...PROMPT_BASE_LINES];

  if (!hasX && !hasY) {
    lines.push('', ...PROMPT_UNTILED_LINES);
  } else if (hasX && !hasY) {
    lines.push('', ...PROMPT_TILED_INTRO_LINES, ...PROMPT_X_SLICES_LINES);
    lines.push('', ...PROMPT_X_MERGE_LINES, ...PROMPT_ROW_INTEGRITY_X_LINES);
  } else if (hasY && !hasX) {
    lines.push('', ...PROMPT_TILED_INTRO_LINES, ...PROMPT_Y_SLICES_LINES);
    lines.push('', ...PROMPT_Y_MERGE_LINES, ...PROMPT_ROW_INTEGRITY_Y_LINES);
  } else {
    // Mixed batch: some pages were cut into columns, others into rows. Label
    // both rules rather than picking one — the user prompt (describeTiling)
    // says which page got which.
    lines.push(
      '',
      ...PROMPT_TILED_INTRO_LINES,
      ...PROMPT_X_SLICES_LINES,
      '  Some pages are supplied this way; the others are supplied as:',
      ...PROMPT_Y_SLICES_LINES,
      '  The text sent with the images says which page is which.',
    );
    lines.push(
      '',
      'When a page is cut into VERTICAL slices:',
      ...PROMPT_X_MERGE_LINES,
      ...PROMPT_ROW_INTEGRITY_X_LINES,
    );
    lines.push(
      '',
      'When a page is cut into HORIZONTAL bands:',
      ...PROMPT_Y_MERGE_LINES,
      ...PROMPT_ROW_INTEGRITY_Y_LINES,
    );
  }

  lines.push('', ...PROMPT_TAIL_LINES);
  return lines.join('\n');
}

/**
 * The axes a prepared input actually used, sorted and de-duplicated. Reads
 * `tileAxis` off the emitted tiles (imageTiler stamps it; an overview and an
 * untiled page carry 'none'). A VisionImage built by an older caller has no
 * such field, in which case the page contributes no axis and the untiled
 * prompt is used — the conservative choice, because it asserts nothing about
 * how the images relate to each other.
 */
export function visionTileAxes(
  pages: ReadonlyArray<{ images: ReadonlyArray<{ role?: string; tileAxis?: string }> }>,
): VisionTileAxis[] {
  const seen = new Set<VisionTileAxis>();
  for (const page of pages ?? []) {
    for (const img of page?.images ?? []) {
      if (img?.role !== 'tile') continue;
      if (img.tileAxis === 'x') seen.add('x');
      else if (img.tileAxis === 'y') seen.add('y');
    }
  }
  return (['x', 'y'] as const).filter((a) => seen.has(a));
}

/**
 * Cost-log prompt version for a given set of axes. The 'x' and untiled paths
 * keep the certified `vision-read-v1` label because their prompt text is
 * unchanged byte for byte; the row-band prompt is genuinely different text and
 * says so, which is the whole point of logging a prompt version — an A/B over
 * llm_cost_log that lumped the two together would compare nothing.
 */
export function visionReadPromptVersion(axes: readonly VisionTileAxis[] = []): string {
  const hasX = axes.includes('x');
  const hasY = axes.includes('y');
  if (hasX && hasY) return `${VISION_READ_PROMPT_VERSION}-xy`;
  if (hasY) return `${VISION_READ_PROMPT_VERSION}-y`;
  return VISION_READ_PROMPT_VERSION;
}

/**
 * The column-strip prompt, i.e. buildVisionReadSystemPrompt(['x']). Exported
 * so a test can pin the certified landscape text; the runtime path always
 * builds from the measured axes instead of reaching for this.
 */
export const VISION_READ_SYSTEM_PROMPT_X = buildVisionReadSystemPrompt(['x']);

/** Phrases a model emits when it cannot read the page. Downgrades confidence. */
const ILLEGIBILITY_MARKERS = [
  'illegible',
  'unable to read',
  'cannot read',
  'could not read',
  'no text visible',
  'no legible text',
  'unreadable',
  'too blurry',
  'i cannot',
  "i'm unable",
];

// ─── Public types ────────────────────────────────────────────────────────

export interface PrepareVisionInputOptions {
  source: Buffer;
  kind: 'pdf' | 'image';
  /** PDF only. 1-based, inclusive. Omit for the whole buffer. */
  pageStart?: number;
  pageEnd?: number;
  /** Hard cap on pages rendered. Default 8. */
  maxPages?: number;
  tileOptions?: TileOptions & RenderScaleOptions;
  /**
   * PDF only. An already-parsed handle on `source`, from acquirePdfSource.
   * Pass it when calling this function repeatedly over ONE document (page by
   * page) so the pdf-lib parse happens once for the whole run instead of once
   * per page. Omitted, the handle is looked up in the shared per-buffer cache
   * and released again at the end of the call.
   */
  pdfSource?: PdfSourceHandle;
}

export interface PreparedVisionInput {
  /** Send order: per page, overview then tiles L→R. Assignable to LlmAttachment[]. */
  attachments: Array<{ kind: 'image'; data: Buffer; mime: string }>;
  pages: TiledPage[];
  /** Prompt-ready sentence(s) explaining the overlapping-slice layout. Equals describeTiling(pages). */
  layoutContext: string;
  /**
   * The cut axes actually used: 'x' = vertical column strips, 'y' = horizontal
   * row bands, empty = nothing was tiled. The SYSTEM prompt's merge rule must
   * be built from this (buildVisionReadSystemPrompt), because the rule for row
   * bands is the OPPOSITE of the rule for column strips and `layoutContext`
   * already commits to the correct one in the user turn. Equals
   * visionTileAxes(pages).
   */
  tileAxes: VisionTileAxis[];
  /** True when at least one page was tiled. */
  anyWide: boolean;
  totalImages: number;
  warnings: string[];
}

export interface VisionTranscribeInput {
  source: Buffer;
  kind: 'pdf' | 'image';
  /** PDF only, 1-based inclusive. Omit for all pages. */
  pageNumbers?: number[];
  maxPages?: number;
  tileOptions?: TileOptions & RenderScaleOptions;
  /** Cost-log attribution. Both optional — OCR runs upstream of claim binding. */
  claimId?: string | null;
  hospitalId?: string | null;
  /**
   * The analysis run these page reads belong to, when the caller knows it.
   *
   * Without this every `ocr_vision_page` row lands with run_id NULL, and
   * `getRunSpendInr` silently degrades to "all claim spend since the run was
   * triggered" — so a superseded run's tail, or an inbound-email draft on the
   * same claim, is charged to this run's approved budget and the consent card
   * shows a number that is not this run's spend. OCR is the single largest
   * cost dimension, so leaving it unattributed unattributes most of the run.
   */
  runId?: string | null;
  /** Cost-log task name. Default 'ocr_vision_read'. */
  taskName?: string;
}

export interface VisionTranscribedPage {
  /** 1-based, matching OcrPage.pageNumber. */
  pageNumber: number;
  /** Plain-text transcription. NO markdown — downstream consumers regex over this. */
  text: string;
  /**
   * 0..1, suitable for OcrPage.confidence. 0.93 is the CEILING, awarded only
   * to a read with no adverse evidence; see scoreVisionReadConfidence. Below
   * 0.3 routes the bundle to human review downstream.
   */
  confidence: number;
  /** Tiles sent for this page (0 = single image). */
  tileCount: number;
  deskewAngleDeg: number | null;
  warnings: string[];
  /**
   * PER-PAGE SIGNALS (N5). Optional on the type so existing stubs and fixtures
   * still satisfy it, but ALWAYS populated by transcribePagesViaVision.
   *
   * `truncated` — the model's response hit max_tokens: the text is cut off
   *   mid-page.
   * `incomplete` — truncated, OR an image the model needed never rendered.
   *   Either way the stored text is provably not the whole page.
   * `needsHumanReview` — this page's own confidence is below
   *   VISION_READ_REVIEW_THRESHOLD. The downstream bundle gate averages
   *   confidence across pages, which one bad page in twenty cannot move; a
   *   caller that wants to act on THAT page reads this flag.
   * `confidenceReasons` — the codes behind the number, in the order applied.
   */
  truncated?: boolean;
  incomplete?: boolean;
  needsHumanReview?: boolean;
  confidenceReasons?: string[];
}

export interface VisionTranscribeResult {
  pages: VisionTranscribedPage[];
  costInr: number;
  model: string;
  latencyMs: number;
  tokensInput: number;
  tokensOutput: number;
  warnings: string[];
  /**
   * Page numbers whose own confidence is below the review threshold, and page
   * numbers whose text is provably partial. Optional for the same
   * back-compatibility reason as the per-page flags; always populated here.
   * A caller can route exactly these pages to a human (or re-read them) rather
   * than accepting or rejecting the whole document on an average.
   */
  pagesNeedingReview?: number[];
  pagesIncomplete?: number[];
}

// ─── Magic-byte sniffers ─────────────────────────────────────────────────
//
// Ported from ocr.service.ts:327-359 and docExtractor.service.ts:1335-1391 so
// this module is self-contained. The two owners keep their private copies —
// this is an additive port, not a refactor of their files.

/** Sniff an Anthropic-acceptable media type from magic bytes. Defaults to 'image/jpeg'. */
export function detectVisionMime(buf: Buffer): VisionImageMime {
  if (!buf || buf.length < 3) return 'image/jpeg';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  return 'image/jpeg';
}

/** True when the buffer's magic bytes are a supported raster image. */
export function isImageBuffer(buf: Buffer): boolean {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return true;
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return true;
  }
  return false;
}

/**
 * Remove a leading ```...``` fence wrapper if the vision model emitted one
 * despite the "no markdown" instruction. Ported from ocr.service.ts:367-373.
 * We ONLY strip a fence that wraps the WHOLE response.
 */
function stripLeadingFence(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```\s*$/);
  if (m && m[1] !== undefined) return m[1];
  return s;
}

// ─── prepareVisionInput ──────────────────────────────────────────────────

// ─── Parsed-PDF handle: ONE pdf-lib load per document ────────────────────
//
// N3. The per-page loop used to call prepareVisionInput → slicePdf, which did
// a full `PDFDocument.load` of the WHOLE source for every page, and
// resolvePageNumbers did another one per call. With ocr.service dispatching
// OCR_VISION_CONCURRENCY (default 3) lanes over the SAME buffer, a 40-page
// scanned bundle parsed the document 3 x pages times and held up to three
// independent copies of the parsed object graph live at once — peak memory
// roughly 3x, for no benefit, since every lane parses byte-identical input.
//
// So the parse is hoisted and SHARED:
//   - keyed by the source Buffer identity in a WeakMap, so the three lanes
//     ocr.service dispatches with the same buffer share one parse and the
//     entry disappears when the buffer does;
//   - ref-counted, so transcribePagesViaVision can hold the document open
//     across its whole run while each per-page prepareVisionInput borrows and
//     returns it — and the last release frees it rather than pinning a parsed
//     PDF in memory forever;
//   - slicing is SERIALISED per document. copyPages() reads the shared source
//     context; running several copies against one PDFDocument concurrently is
//     not a contract pdf-lib states, and a queue costs nothing next to the
//     render that follows.

export interface PdfSourceHandle {
  /** Pages in the ORIGINAL document. 0 when the buffer could not be parsed. */
  readonly pageCount: number;
  /**
   * Copy pages [startPage, endPage] (1-based, inclusive, clamped to the
   * document) into a fresh single-use PDF. `offset` re-stamps the slice's
   * 1..n page numbers back onto the ORIGINAL document's numbering, so
   * VisionTranscribedPage.pageNumber lines up with OcrPage.pageNumber for the
   * caller. Returns null when the source is unusable.
   */
  slicePages(startPage: number, endPage: number): Promise<{ bytes: Buffer; offset: number } | null>;
  /** Give the shared handle back. Idempotent; safe to call in a finally. */
  release(): void;
}

interface PdfSourceEntry {
  refs: number;
  /** The parsed document, or null when pdf-lib could not read the buffer. */
  loading: Promise<any | null>;
  /** Serialises copyPages() against the one shared source document. */
  queue: Promise<unknown>;
}

const PDF_SOURCE_CACHE = new WeakMap<Buffer, PdfSourceEntry>();

async function loadPdfDocument(bytes: Buffer): Promise<any | null> {
  try {
    const { PDFDocument } = await import('pdf-lib');
    return await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (err) {
    logger.warn(
      { err: (err as any)?.message ?? String(err), bytes: bytes?.length ?? 0 },
      'visionRead: pdf-lib could not parse the source buffer',
    );
    return null;
  }
}

/** Run `fn` after every previously-queued slice on this document. */
function enqueue<T>(entry: PdfSourceEntry, fn: () => Promise<T>): Promise<T> {
  // .then(fn, fn) so one failed slice does not wedge the queue for the rest.
  const run = entry.queue.then(fn, fn);
  entry.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function copyPageRange(
  src: any,
  startPage: number,
  endPage: number,
): Promise<{ bytes: Buffer; offset: number } | null> {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const total = src.getPageCount();
    if (!Number.isFinite(total) || total < 1) return null;
    const start = Math.max(1, Math.min(startPage, total));
    const end = Math.max(start, Math.min(endPage, total));
    const dst = await PDFDocument.create();
    const indices: number[] = [];
    for (let i = start - 1; i <= end - 1; i++) indices.push(i);
    const copied = await dst.copyPages(src, indices);
    for (const p of copied) dst.addPage(p);
    const bytes = await dst.save();
    return { bytes: Buffer.from(bytes), offset: start - 1 };
  } catch (err) {
    logger.warn(
      { err: (err as any)?.message ?? String(err), startPage, endPage },
      'visionRead: PDF slice failed',
    );
    return null;
  }
}

/**
 * Borrow the parsed form of `bytes`, loading it only if nobody else already
 * has. ALWAYS pair with `release()` in a finally — the last release drops the
 * parsed document.
 *
 * Exported so a caller that reads the same buffer repeatedly (ocr.service's
 * lanes, docExtractor's per-section vision prep) can hold one ref for the
 * duration of its run and pay for exactly one parse.
 */
export async function acquirePdfSource(bytes: Buffer): Promise<PdfSourceHandle> {
  let entry = PDF_SOURCE_CACHE.get(bytes);
  if (!entry) {
    entry = { refs: 0, loading: loadPdfDocument(bytes), queue: Promise.resolve() };
    PDF_SOURCE_CACHE.set(bytes, entry);
  }
  const held = entry;
  held.refs++;

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    held.refs--;
    if (held.refs <= 0 && PDF_SOURCE_CACHE.get(bytes) === held) {
      PDF_SOURCE_CACHE.delete(bytes);
    }
  };

  let doc: any | null = null;
  try {
    doc = await held.loading;
  } catch {
    doc = null;
  }

  let pageCount = 0;
  if (doc) {
    try {
      const n = doc.getPageCount();
      pageCount = Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      pageCount = 0;
    }
  }

  return {
    pageCount,
    slicePages: (startPage: number, endPage: number) =>
      doc ? enqueue(held, () => copyPageRange(doc, startPage, endPage)) : Promise.resolve(null),
    release,
  };
}

function restampPageNumbers(pages: TiledPage[], offset: number): TiledPage[] {
  if (offset === 0) return pages;
  for (const page of pages) {
    page.geometry.pageNumber += offset;
    for (const img of page.images) img.pageNumber += offset;
  }
  return pages;
}

const EMPTY_PREPARED: Omit<PreparedVisionInput, 'warnings'> = {
  attachments: [],
  pages: [],
  layoutContext: '',
  tileAxes: [],
  anyWide: false,
  totalImages: 0,
};

/**
 * The single entry point callers use to turn a source document into vision
 * attachments: render at an aspect-aware DPI, deskew, tile, emit overview +
 * tiles. Never throws — on failure returns { attachments: [], pages: [],
 * anyWide: false, totalImages: 0 } plus a warning, so a caller can fall back.
 */
export async function prepareVisionInput(
  opts: PrepareVisionInputOptions,
): Promise<PreparedVisionInput> {
  const warnings: string[] = [];
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);

  try {
    if (!opts.source || opts.source.length === 0) {
      return { ...EMPTY_PREPARED, warnings: ['vision_input_empty'] };
    }

    let pages: TiledPage[];

    if (opts.kind === 'image') {
      pages = [await tileImage(opts.source, 1, opts.tileOptions ?? {})];
    } else {
      let pdfBytes = opts.source;
      let offset = 0;
      if (opts.pageStart !== undefined || opts.pageEnd !== undefined) {
        const start = opts.pageStart ?? 1;
        const end = opts.pageEnd ?? start;
        // Borrowed, not loaded: the caller's handle if it has one, otherwise
        // the shared per-buffer entry — which an enclosing
        // transcribePagesViaVision is already holding open, so the parse is
        // paid for once per document, not once per page and not once per lane.
        const borrowed = opts.pdfSource ?? (await acquirePdfSource(opts.source));
        let sliced: { bytes: Buffer; offset: number } | null;
        try {
          sliced = await borrowed.slicePages(start, end);
        } finally {
          if (!opts.pdfSource) borrowed.release();
        }
        if (!sliced) return { ...EMPTY_PREPARED, warnings: ['vision_pdf_slice_failed'] };
        pdfBytes = sliced.bytes;
        offset = sliced.offset;
      }
      pages = restampPageNumbers(
        await tilePdf(pdfBytes, { ...(opts.tileOptions ?? {}), maxPages }),
        offset,
      );
    }

    for (const p of pages) warnings.push(...p.warnings);

    const attachments = toLlmAttachments(pages);
    if (attachments.length === 0) {
      return { ...EMPTY_PREPARED, warnings: [...warnings, 'vision_no_images_rendered'] };
    }

    return {
      attachments,
      pages,
      layoutContext: describeTiling(pages),
      // Both prompt halves are now derived from the SAME fact. describeTiling
      // writes the per-axis text into the user turn; visionTileAxes gives the
      // caller what it needs to build the matching system-prompt merge rule.
      tileAxes: visionTileAxes(pages),
      anyWide: pages.some((p) => p.geometry.isWide && p.images.some((i) => i.role === 'tile')),
      totalImages: attachments.length,
      warnings,
    };
  } catch (err) {
    logger.warn(
      { err: (err as any)?.message ?? String(err), kind: opts.kind },
      'visionRead: prepareVisionInput failed; caller must fall back',
    );
    return { ...EMPTY_PREPARED, warnings: [...warnings, 'vision_prepare_failed'] };
  }
}

// ─── transcribePagesViaVision ────────────────────────────────────────────

/**
 * Page numbers to read. For a PDF with no explicit list, enumerate the doc —
 * from the ALREADY-PARSED handle, not a fresh PDFDocument.load (N3: that load
 * used to happen once per lane, on top of the two per page).
 */
function resolvePageNumbers(
  input: VisionTranscribeInput,
  pdfSource: PdfSourceHandle | null,
): number[] {
  const maxPages = Math.max(1, input.maxPages ?? DEFAULT_MAX_PAGES);
  if (input.kind === 'image') return [1];
  if (input.pageNumbers && input.pageNumbers.length > 0) {
    return input.pageNumbers.filter((n) => Number.isFinite(n) && n >= 1).slice(0, maxPages);
  }
  const count = pdfSource?.pageCount ?? 0;
  if (count < 1) {
    logger.warn(
      {},
      'visionRead: could not read PDF page count; assuming a single page',
    );
    return [1];
  }
  const out: number[] = [];
  for (let i = 1; i <= Math.min(count, maxPages); i++) out.push(i);
  return out;
}

function looksIllegible(text: string): boolean {
  const lower = text.toLowerCase();
  return ILLEGIBILITY_MARKERS.some((m) => lower.includes(m));
}

/** Count [0-9A-Za-z] plus Devanagari — the characters a real document is made of. */
export function countAlnum(text: string): number {
  if (!text) return 0;
  const m = text.match(/[0-9A-Za-zऀ-ॿ]/g);
  return m ? m.length : 0;
}

/** Everything we know about a page read, as input to the confidence score. */
export interface VisionConfidenceEvidence {
  /** The transcription as it will be stored. */
  text: string;
  /** Total images sent for this page (overview + tiles). Used as the density denominator. */
  imageCount: number;
  /** True when the response's stop_reason was 'max_tokens' — the text is cut off. */
  truncated?: boolean;
  /** Tiler / prepare warnings for this page. */
  warnings?: readonly string[];
  /**
   * Line-item totals verdict when the caller has one (docExtractor does, the
   * transcription path does not). `false` — rows do not sum to the declared
   * grand total — is strong evidence the page was misread.
   */
  lineItemsTotalsMatch?: boolean | null;
}

export interface VisionConfidenceVerdict {
  confidence: number;
  /** Warning codes explaining every downgrade, in the order applied. */
  reasons: string[];
  /**
   * True when we KNOW the stored text is not the whole page — the response
   * was cut off at max_tokens, or an image the model needed never rendered.
   * This is a FACT about the page, not a score, and it is per page: a caller
   * averaging confidence across a bundle cannot reconstruct it.
   */
  incomplete: boolean;
  /**
   * True when this page's own confidence is below VISION_READ_REVIEW_THRESHOLD.
   * The per-page signal N5 asks for: the downstream bundle gate averages
   * confidence across pages, so one bad page in twenty never moves the mean
   * far enough to fire. A caller that wants to route THAT page to a human
   * reads this flag instead of re-deriving the threshold.
   */
  needsHumanReview: boolean;
}

/**
 * Derive a page's confidence from evidence. Pure — no I/O, no clock — so the
 * gate that decides whether a human looks at a document is testable.
 *
 * Starts at the VISION_READ_CONFIDENCE ceiling and multiplies a penalty in
 * for each adverse signal, then applies the hard caps (illegibility, empty
 * text) that must land below the downstream 0.3 review threshold regardless
 * of what else was observed.
 */
export function scoreVisionReadConfidence(
  ev: VisionConfidenceEvidence,
): VisionConfidenceVerdict {
  const reasons: string[] = [];
  const text = ev.text ?? '';
  const warnings = ev.warnings ?? [];
  let confidence = VISION_READ_CONFIDENCE;
  let incomplete = false;

  // A response cut off at max_tokens is a PARTIAL page presented as a whole
  // one. Nothing downstream can tell the difference from the text alone.
  if (ev.truncated) {
    incomplete = true;
    reasons.push('vision_read_truncated');
  }

  // A tile that never rendered is content the model was never shown.
  if (warnings.some((w) => INCOMPLETE_IMAGE_WARNINGS.has(w))) {
    incomplete = true;
    reasons.push('vision_read_degraded_images');
  }

  if (warnings.some((w) => DEGRADING_IMAGE_WARNINGS.has(w))) {
    confidence *= PENALTY_ORIENTATION_UNKNOWN;
    reasons.push('vision_read_orientation_unknown');
  }

  // deskew_failed = the rotation itself blew up; deskew_low_confidence = the
  // projection profile had no clear peak at any angle, which on a text page
  // means the text rows were not resolvable — blur, noise, or a photo of a
  // crumpled sheet.
  if (warnings.includes('deskew_failed')) {
    confidence *= PENALTY_DESKEW_FAILED;
    reasons.push('vision_read_deskew_failed');
  }
  if (warnings.includes('deskew_low_confidence')) {
    confidence *= PENALTY_DESKEW_LOW_CONFIDENCE;
    reasons.push('vision_read_deskew_low_confidence');
  }

  const alnumPerImage = countAlnum(text) / Math.max(1, ev.imageCount || 1);
  if (alnumPerImage < ALNUM_PER_IMAGE_IMPLAUSIBLE) {
    confidence *= PENALTY_ALNUM_IMPLAUSIBLE;
    reasons.push('vision_read_low_text_density');
  } else if (alnumPerImage < ALNUM_PER_IMAGE_SPARSE) {
    confidence *= PENALTY_ALNUM_SPARSE;
    reasons.push('vision_read_low_text_density');
  }

  if (ev.lineItemsTotalsMatch === false) {
    confidence *= PENALTY_TOTALS_MISMATCH;
    reasons.push('vision_read_totals_mismatch');
  }

  // Hard caps. These are statements about the page, not adjustments to it.
  // A cap must land BELOW the review threshold on its own, because the
  // downstream gate averages across pages: anything that only nudges the
  // number is invisible in a twenty-page bundle.
  if (incomplete) {
    confidence = Math.min(confidence, VISION_READ_INCOMPLETE_CONFIDENCE);
  }
  if (text.trim().length < MIN_USEFUL_TEXT_CHARS) {
    confidence = Math.min(confidence, VISION_READ_EMPTY_CONFIDENCE);
    reasons.push('vision_read_short_text');
  }
  if (looksIllegible(text)) {
    confidence = Math.min(confidence, VISION_READ_ILLEGIBLE_CONFIDENCE);
    reasons.push('vision_read_illegible_marker');
  }

  const scored = Math.round(Math.max(MIN_SCORED_CONFIDENCE, confidence) * 100) / 100;
  return {
    confidence: scored,
    reasons,
    incomplete,
    needsHumanReview: scored < VISION_READ_REVIEW_THRESHOLD,
  };
}

/**
 * Would this page be routed to a human on its own evidence? The one place
 * the 0.3 threshold is applied, so a caller (ocr.service, the bundle
 * classifier, a reviewer UI) never re-derives it. Accepts anything with a
 * confidence — a VisionTranscribedPage, a verdict, an OcrPage.
 */
export function visionPageNeedsReview(page: {
  confidence?: number | null;
  needsHumanReview?: boolean;
}): boolean {
  if (page?.needsHumanReview === true) return true;
  const c = Number(page?.confidence);
  if (!Number.isFinite(c)) return true;
  return c < VISION_READ_REVIEW_THRESHOLD;
}

/**
 * THE OCR REPLACEMENT. One Claude vision call per page, sent as overview +
 * overlapping tiles, returning a faithful plain-text transcription that
 * slots straight into OcrPage.text. Records cost to hospital.llm_cost_log via
 * costAccounting.recordCall (best-effort, never blocks). Throws only when
 * every page fails — per-page failures come back as an empty-text page with
 * a warning so the caller can fall back to Tesseract for just that page.
 */
export async function transcribePagesViaVision(
  input: VisionTranscribeInput,
): Promise<VisionTranscribeResult> {
  const started = Date.now();
  const taskName = input.taskName ?? 'ocr_vision_read';
  const warnings: string[] = [];

  if (!input.source || input.source.length === 0) {
    throw new Error('visionRead.transcribePagesViaVision: empty source buffer');
  }

  // Lazy imports — keep this module light when vision is disabled and avoid a
  // static import cycle with costAccounting.
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const costAccounting = (await import('../costAccounting.service.js')).default;
  const client = new Anthropic({ maxRetries: 3, timeout: 120_000 });

  // N3 — THE HOIST. One pdf-lib parse of the WHOLE document for this run,
  // borrowed by every per-page prepareVisionInput below instead of each of
  // them loading the whole document again to cut one page out of it. (The
  // tiler still parses the one-page slice it is handed; that is a few KB, not
  // the bundle.) Because the handle is keyed on the source Buffer,
  // the OCR_VISION_CONCURRENCY lanes ocr.service dispatches over the SAME
  // buffer share this one parse rather than holding one parsed copy each.
  // Released in the finally below; the last release frees the document.
  const pdfSource = input.kind === 'pdf' ? await acquirePdfSource(input.source) : null;

  const pages: VisionTranscribedPage[] = [];
  let tokensInput = 0;
  let tokensOutput = 0;
  let costInr = 0;
  let model: string = VISION_READ_MODEL;
  let failures = 0;

  try {
    const pageNumbers = resolvePageNumbers(input, pdfSource);

    for (const pageNumber of pageNumbers) {
      const pageWarnings: string[] = [];
      const failedPage = (reason: string): VisionTranscribedPage => {
        failures++;
        return {
          pageNumber,
          text: '',
          confidence: 0,
          tileCount: 0,
          deskewAngleDeg: null,
          warnings: [...pageWarnings, reason],
          truncated: false,
          // A page we could not read AT ALL is not whole and is not something
          // a machine should silently accept. confidence 0 already says so,
          // but a caller filtering on the flags must see it there too.
          incomplete: true,
          needsHumanReview: true,
          confidenceReasons: [reason],
        };
      };

      try {
        const prepared = await prepareVisionInput({
          source: input.source,
          kind: input.kind,
          ...(input.kind === 'pdf' ? { pageStart: pageNumber, pageEnd: pageNumber } : {}),
          maxPages: 1,
          tileOptions: input.tileOptions,
          // The hoisted handle. Without it this call re-parses the whole PDF.
          ...(pdfSource ? { pdfSource } : {}),
        });
        pageWarnings.push(...prepared.warnings);

        if (prepared.attachments.length === 0) {
          pages.push(failedPage('vision_read_no_images'));
          continue;
        }

        const geometry = prepared.pages[0]?.geometry;
        const tileCount = prepared.pages[0]?.images.filter((i) => i.role === 'tile').length ?? 0;

        const content: any[] = prepared.attachments.map((a) => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: a.mime,
            data: (a.data as Buffer).toString('base64'),
          },
        }));
        content.push({
          type: 'text',
          text: [
            prepared.layoutContext,
            '',
            'Transcribe this page in full, as plain text.',
          ]
            .filter(Boolean)
            .join('\n'),
        });

        // AXIS-AWARE SYSTEM PROMPT. The merge rule must agree with the cut the
        // tiler actually made: `prepared.layoutContext` (describeTiling) has
        // already told the model, in the user turn, whether these are vertical
        // column strips or horizontal row bands. Hard-coding the column-strip
        // rule here contradicted that on every portrait page.
        const tileAxes = prepared.tileAxes;
        const systemPrompt = buildVisionReadSystemPrompt(tileAxes);
        const promptVersion = visionReadPromptVersion(tileAxes);

        const callStarted = Date.now();
        const response: any = await client.messages.create({
          model: VISION_READ_MODEL,
          max_tokens: VISION_READ_MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content }],
        });
        const callLatencyMs = Date.now() - callStarted;

        const rawText: string = Array.isArray(response?.content)
          ? response.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('\n')
          : '';
        const text = stripLeadingFence(rawText).trim();

        // stop_reason is the ONLY way to know the transcription is complete.
        // 'max_tokens' means the model was cut off mid-page: the text that came
        // back is real, is longer than the 20-char floor, and contains no
        // illegibility phrase, so every other check here would call it a clean
        // read of a page whose bottom half is simply missing.
        const truncated = response?.stop_reason === 'max_tokens';
        if (truncated) {
          pageWarnings.push('vision_read_truncated');
          logger.warn(
            {
              page: pageNumber,
              max_tokens: VISION_READ_MAX_TOKENS,
              text_len: text.length,
              tokens_out: Number(response?.usage?.output_tokens ?? 0),
            },
            'visionRead: response hit max_tokens — the page transcription is INCOMPLETE',
          );
        }

        const tokensIn = Number(response?.usage?.input_tokens ?? 0);
        const tokensOut = Number(response?.usage?.output_tokens ?? 0);
        const usd = (tokensIn * USD_PER_M_INPUT + tokensOut * USD_PER_M_OUTPUT) / 1_000_000;
        const pageCostInr = Math.round(usd * USD_TO_INR * 10000) / 10000;

        tokensInput += tokensIn;
        tokensOutput += tokensOut;
        costInr = Math.round((costInr + pageCostInr) * 10000) / 10000;
        model = response?.model ?? VISION_READ_MODEL;

        // Best-effort cost log. Never blocks the OCR pipeline — the
        // transcription is already computed and far more valuable than an
        // audit insert.
        try {
          await costAccounting.recordCall({
            claimId: input.claimId ?? null,
            hospitalId: input.hospitalId ?? null,
            runId: input.runId ?? null,
            task: taskName,
            provider: 'anthropic',
            model,
            promptVersion,
            tokensInputUncached: tokensIn,
            tokensInputCached: 0,
            tokensOutput: tokensOut,
            latencyMs: callLatencyMs,
            costInr: pageCostInr,
            succeeded: true,
          });
        } catch (logErr) {
          logger.warn(
            { err: (logErr as any)?.message ?? String(logErr) },
            'visionRead: cost log failed (continuing)',
          );
        }

        // Confidence is derived from what we observed, never stamped. The
        // reasons ARE the warnings — a downstream reviewer reading
        // OcrPage.warnings sees exactly why the number is what it is.
        const verdict = scoreVisionReadConfidence({
          text,
          imageCount: prepared.totalImages,
          truncated,
          warnings: pageWarnings,
        });

        pages.push({
          pageNumber,
          text,
          confidence: verdict.confidence,
          tileCount,
          deskewAngleDeg: geometry?.deskewAngleDeg ?? null,
          warnings: [...pageWarnings, ...verdict.reasons.filter((r) => !pageWarnings.includes(r))],
          truncated,
          incomplete: verdict.incomplete,
          needsHumanReview: verdict.needsHumanReview,
          confidenceReasons: verdict.reasons,
        });

        logger.info(
          {
            page: pageNumber,
            images: prepared.totalImages,
            tiles: tileCount,
            tiled: prepared.anyWide,
            // Which merge rule the model was actually given, and under which
            // prompt label it was billed. Without these two, a row-band
            // regression is indistinguishable in the logs from a bad scan.
            tile_axes: tileAxes,
            prompt_version: promptVersion,
            text_len: text.length,
            alnum_per_image: Math.round(countAlnum(text) / Math.max(1, prepared.totalImages)),
            truncated,
            incomplete: verdict.incomplete,
            needs_human_review: verdict.needsHumanReview,
            confidence: verdict.confidence,
            confidence_reasons: verdict.reasons,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            cost_inr: pageCostInr,
            latency_ms: callLatencyMs,
          },
          verdict.needsHumanReview
            ? 'visionRead: page transcription is NOT trustworthy — this page needs a human'
            : verdict.confidence < VISION_READ_CONFIDENCE
              ? 'visionRead: page transcribed with DEGRADED confidence'
              : 'visionRead: page transcribed',
        );
      } catch (err) {
        logger.error(
          { err: (err as any)?.message ?? String(err), page: pageNumber },
          'visionRead: page transcription failed; caller may fall back to Tesseract',
        );
        pages.push(failedPage('vision_read_failed'));
      }
    }
  } finally {
    // Drop our reference to the parsed document. The last holder frees it —
    // sibling lanes on the same buffer keep it alive until they finish too.
    pdfSource?.release();
  }

  if (pages.length > 0 && failures === pages.length) {
    throw new Error(
      `visionRead: every page failed to transcribe (${failures}/${pages.length}). ` +
        'The provider call or the source buffer is broken — caller should fall back to Tesseract.',
    );
  }
  if (failures > 0) warnings.push('vision_read_partial_failure');

  // PER-PAGE, not an average (N5). docBundleClassifier gates on the MEAN
  // confidence across pages, which one bad page in twenty cannot move; these
  // two lists are what lets a caller act on the individual page — re-read it,
  // fall back to Tesseract for it, or put it in front of a human — instead of
  // accepting or rejecting the whole document on a number that hid it.
  const pagesNeedingReview = pages.filter((p) => visionPageNeedsReview(p)).map((p) => p.pageNumber);
  const pagesIncomplete = pages.filter((p) => p.incomplete === true).map((p) => p.pageNumber);
  if (pagesIncomplete.length > 0) warnings.push('vision_read_pages_incomplete');
  if (pagesNeedingReview.length > 0) warnings.push('vision_read_pages_need_review');

  if (pagesNeedingReview.length > 0) {
    logger.warn(
      {
        pages_total: pages.length,
        pages_needing_review: pagesNeedingReview,
        pages_incomplete: pagesIncomplete,
        review_threshold: VISION_READ_REVIEW_THRESHOLD,
        mean_confidence:
          pages.length > 0
            ? Math.round((pages.reduce((a, p) => a + p.confidence, 0) / pages.length) * 100) / 100
            : 0,
      },
      'visionRead: some pages are below the human-review threshold on their own evidence — ' +
        'the bundle average will NOT show this',
    );
  }

  return {
    pages,
    costInr,
    model,
    latencyMs: Date.now() - started,
    tokensInput,
    tokensOutput,
    warnings,
    pagesNeedingReview,
    pagesIncomplete,
  };
}
