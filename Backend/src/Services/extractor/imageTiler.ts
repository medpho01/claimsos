/**
 * High-DPI overlapping tiling — the core lever of the vision-first engine.
 *
 * WHY (docs/proposals/EXTRACTION_LANDSCAPE_FIX.md §3, plus the count_tokens
 * measurements below): Anthropic downsizes a large image before the model ever
 * sees it. A 3400×1400 itemised final bill arrives as ~1568×646 — the digits in
 * the rightmost money column collapse to 4–5 pixels tall and amounts get read
 * onto the wrong line item. Scored against ground truth that path lands at
 * 80–97%. Sending the SAME page as 3 overlapping slices plus one downscaled
 * overview scores 100.00% (196/196 cells, reproduced 2/2 trials).
 *
 * ─── THE BUDGET THAT ACTUALLY BINDS ──────────────────────────────────────
 *
 * The first version of this module modelled the resize as a single 1568px
 * LONG-EDGE ceiling, and concluded that any tile with both edges ≤ 1568 was
 * sent untouched. That premise is FALSE. Anthropic re-scales by AREA to about
 * 1.15 megapixels (≈1568 image tokens at 750px²/token). Measured against
 * /v1/messages/count_tokens:
 *
 *     1135×1568   raw 1.78MP  →  linear squeeze ≈0.81
 *     1176×1568   raw 1.84MP  →  ≈0.79   (the shipped portrait fitted image)
 *     1278×1459   raw 1.86MP  →  ≈0.79   (the shipped LANDSCAPE tile!)
 *      610×1568   raw 0.96MP  →  1.00    (not squeezed at all)
 *
 * So even the landscape tiles that score 100% are being downscaled — landscape
 * only wins because a short page has resolution to spare. A tall dense portrait
 * page is silently starved: the old rule refused to tile ANY portrait page, so
 * a 40-row A4 rendered at 2541×3551 was squeezed by 0.357 in one step and
 * scored 88.46%, while a crude vertical-strip emulation of the same page
 * scored 95.31%. The "don't tile portrait" rule was costing ~7pp.
 *
 * `effectiveScale(w,h)` below models the real thing:
 *
 *     effectiveScale = min(1, maxEdge / max(w,h), sqrt(maxPixels / (w·h)))
 *
 * It is "emitted pixels per source pixel, as the model finally sees them", so
 * the tiled and untiled candidates are directly comparable. Everything else in
 * this module is downstream of that one function.
 *
 * ─── THE THREE NUMBERS THAT MATTER ───────────────────────────────────────
 *
 *  1. RENDER SCALE. pdf.js renders 1 PDF point → 1 pixel at viewportScale 1.0.
 *     `chooseViewportScale` targets the SHORT edge at ~1500px for EVERY page,
 *     not just wide ones. A portrait A4 used to be rendered to 1108×1568 (its
 *     long edge pinned to the old ceiling), which left the tiler nothing to
 *     spend: bands of that render cap out at 1108 effective px of width. At
 *     1500×2123 the same page bands to 1476 effective px — a third more
 *     resolution on the money column, for one cheap render. A long-edge clamp
 *     (`maxRenderLongEdgePx`) keeps a freak aspect ratio from rendering a
 *     poster.
 *
 *  2. CUT AXIS. Tiling is no longer gated on orientation. For N tiles
 *     overlapping by ratio r along an axis of length L, the uniform tile length
 *     that exactly covers L is
 *
 *         tileLength = L / (N - r·(N-1))
 *
 *     We build that candidate for BOTH axes — vertical cuts (column strips,
 *     full page height) and horizontal cuts (row bands, full page width) — and
 *     keep whichever yields the higher effectiveScale. A wide bill wins on
 *     column strips (3400×1400 → 3 strips, 0.805 vs 0.461 untiled). A tall page
 *     wins on row bands (2541×3551 → 3 bands, 0.584 vs 0.357 untiled) because
 *     its strips would be starved by the page HEIGHT they still carry. Near
 *     ties go to cutting the long edge, which keeps tiles closer to square.
 *
 *  3. HOW MANY. Each extra tile must buy at least `marginalTileGain` (20%) more
 *     effective scale than the plan already chosen, and the first tiled
 *     candidate must beat the untiled image by `minTileResolutionGain` (10%).
 *     That is what stops a 3400×1400 bill from becoming 4 tiles for a 15% gain,
 *     and what keeps the proven 3-tile plan exactly as it is.
 *
 * ─── THE TWO GUARDS ──────────────────────────────────────────────────────
 *
 *  (a) RESOLUTION GAIN. If no candidate beats the untiled fitted image by
 *      minTileResolutionGain we emit `tile_no_resolution_gain` and send one
 *      image. A page that is already under the megapixel budget can never gain
 *      (its untiled effectiveScale is 1) and so is never tiled — the math
 *      self-guards, no absolute-pixel trigger needed.
 *
 *  (b) NO SLIVERS. A tile must still measure at least `minTileEffectiveEdgePx`
 *      (700) along the axis we cut it on, AFTER the squeeze. This is what stops
 *      a 3024×4032 phone photo from being shredded into four 859px-wide strips
 *      that reach the model 334px wide — unreadable in every one of them. It
 *      does NOT block that photo from being row-banded, which is full page
 *      width and a genuine 1.6× gain. Combined with `maxTiles` (4) it bounds
 *      both the shape and the cost of any plan.
 *
 * The overlap is not decoration: a cell straddling a cut would otherwise be
 * unreadable in both neighbours. 16% of a 1269px tile is ~200px — wider than
 * any column on a hospital bill and taller than any row — so every cell appears
 * whole in at least one slice. Duplicates are merged by the prompt (see
 * describeTiling) and, as a safety net, by lineItems.dedupeLineItems.
 *
 * ─── WHAT WE DOWNSCALE OURSELVES ─────────────────────────────────────────
 *
 * When a tile is already under the 1568px edge ceiling we emit it at native
 * resolution and let Anthropic apply the area squeeze. That is byte-for-byte
 * the path that measured 100% on landscape and it is deliberately left alone.
 * When the edge ceiling forces a resize anyway, we resize ONCE, with sharp, to
 * exactly the size the model will see (the effective scale) rather than to 1568
 * and then letting the API resample a second time. `preDownscaleToBudget: true`
 * forces the single-resample path everywhere, so the harness can A/B it.
 *
 * Flags: EXTRACT_TILING_ENABLED=0 emits a single fitted image per page;
 * EXTRACT_DESKEW_ENABLED=0 skips the deskew step. Both reversible without a
 * deploy.
 */

import { logger } from '../../Utils/logger.js';
import { deskewImage } from './deskew.js';
import type {
  PageGeometry,
  RenderScaleDecision,
  RenderScaleOptions,
  TileOptions,
  TilePlan,
  TiledPage,
  VisionImage,
  VisionImageMime,
} from './visionTypes.js';

// ─── Constants ───────────────────────────────────────────────────────────

export const TILER_VERSION = 'v2' as const;

/** Hard per-image edge ceiling. Above this Anthropic resizes. */
export const ANTHROPIC_MAX_EDGE_PX = 1568 as const;
/**
 * Area budget, in pixels, that Anthropic re-scales an image down to (≈1568
 * image tokens at ~750px² per token). THIS, not the edge, is the constraint
 * that binds on a dense page — see the module docblock.
 */
export const ANTHROPIC_MAX_IMAGE_PIXELS = 1_150_000 as const;
export const DEFAULT_LANDSCAPE_ASPECT = 1.3 as const;
export const DEFAULT_OVERLAP_RATIO = 0.16 as const;
export const DEFAULT_MAX_TILES = 4 as const;

/**
 * Tiling must buy at least this much extra EFFECTIVE resolution (tile ÷
 * untiled) to be worth 3–4× the images. 1.1 = a 10% floor.
 */
const DEFAULT_MIN_TILE_RESOLUTION_GAIN = 1.1;
/**
 * And each tile beyond the plan already chosen must buy at least this much
 * again. 1.2 keeps the proven 3-tile landscape plan (a 4th tile buys 15%) and
 * stops every page drifting to maxTiles.
 */
const DEFAULT_MARGINAL_TILE_GAIN = 1.2;
/**
 * A tile must measure at least this many px along the axis it was cut on,
 * AFTER the squeeze. Below it the slice is a sliver: too narrow (or too short)
 * to carry a legible fragment, and worse than the whole page in one image.
 */
const DEFAULT_MIN_TILE_EFFECTIVE_EDGE_PX = 700;
/** Two plans this close in effective scale are a tie; cut the long edge. */
const AXIS_TIE_TOLERANCE = 1.02;

/** Target rendered SHORT edge, both orientations. Just under the edge ceiling. */
const DEFAULT_TARGET_TILE_SHORT_EDGE_PX = 1500;
/** Clamp on the rendered LONG edge so a freak aspect ratio cannot render a poster. */
const DEFAULT_MAX_RENDER_LONG_EDGE_PX = 5000;
const DEFAULT_MIN_SCALE = 1.5;
const DEFAULT_MAX_SCALE = 6.0;
const DEFAULT_JPEG_QUALITY = 92;
/** Mirrors docExtractor's MAX_VISION_PAGES budget. */
const DEFAULT_MAX_PAGES = 8;

// ─── Local type extensions ───────────────────────────────────────────────
//
// visionTypes.ts is the frozen cross-module contract and is NOT owned here, so
// the axis-aware fields are added as structural supersets. Every value below is
// still assignable to the corresponding visionTypes shape, and every consumer
// that only knows the narrow shape keeps working unchanged.

/** 'x' = vertical cuts (column strips). 'y' = horizontal cuts (row bands). */
export type TileAxis = 'x' | 'y';

export interface TilerOptions extends TileOptions {
  /** Area budget in px. Default 1_150_000. Exposed for measurement, not tuning. */
  maxImagePixels?: number;
  /** Minimum effective px along the cut axis. Default 700. */
  minTileEffectiveEdgePx?: number;
  /** Extra effective scale each additional tile must buy. Default 1.2. */
  marginalTileGain?: number;
  /** Force an axis instead of measuring both. Default 'auto'. */
  tileAxis?: TileAxis | 'auto';
  /**
   * Resize every tile ourselves to the exact size the model will see, even when
   * it is already under the edge ceiling. Default false — the untouched-bytes
   * path is the one that measured 100% on landscape.
   */
  preDownscaleToBudget?: boolean;
}

export interface TilerRenderScaleOptions extends RenderScaleOptions {
  /** Clamp on the rendered long edge. Default 5000. */
  maxRenderLongEdgePx?: number;
}

export interface TilePlanEx extends TilePlan {
  /** Axis the page was cut along; 'none' when it was not tiled. */
  axis: TileAxis | 'none';
  /** [start, end) windows along `axis`, in rendered source px. */
  windows: Array<readonly [number, number]>;
  /** One tile's source size before `tileScale`. */
  tileWidthPx: number;
  tileHeightPx: number;
  /** Tile length along the cut axis (equals tileWidthPx on 'x', tileHeightPx on 'y'). */
  tileLengthPx: number;
  /** effectiveScale of ONE tile — what the model really receives per source px. */
  effectiveTileScale: number;
  /** effectiveScale of the whole page sent as one fitted image. */
  effectiveUntiledScale: number;
  /** effectiveTileScale ÷ effectiveUntiledScale. 1 when not tiled. */
  effectiveGain: number;
  /** Tile size along the cut axis after the squeeze; guarded by minTileEffectiveEdgePx. */
  effectiveCutEdgePx: number;
}

export interface TiledVisionImage extends VisionImage {
  /** Vertical crop window [top, bottom) in rendered source px. Full height for an 'x' tile. */
  yRange: readonly [number, number];
  /** Axis this image was cut on. 'none' for an overview or an untiled page. */
  tileAxis: TileAxis | 'none';
}

export interface TiledPageEx extends TiledPage {
  images: TiledVisionImage[];
}

let _sharp: any = null;
let _pdfToPng: any = null;

async function loadSharp(): Promise<any> {
  if (!_sharp) {
    const mod: any = await import('sharp');
    _sharp = mod?.default ?? mod;
  }
  return _sharp;
}

/**
 * Mirror of the guard at docExtractor.service.ts:1247-1254 — the package
 * has shipped both a named and a default-nested export across versions.
 */
async function loadPdfToPng(): Promise<any> {
  if (typeof _pdfToPng === 'function') return _pdfToPng;
  const mod: any = await import('pdf-to-png-converter');
  const fn = mod?.pdfToPng ?? mod?.default?.pdfToPng ?? mod?.default;
  if (typeof fn !== 'function') {
    throw new Error(
      'imageTiler: pdf-to-png-converter did not expose a callable pdfToPng ' +
        `(module shape: ${mod && typeof mod === 'object' ? `{${Object.keys(mod).join(',')}}` : typeof mod})`,
    );
  }
  _pdfToPng = fn;
  return _pdfToPng;
}

/**
 * Private mime sniffer. Deliberately duplicated from visionRead's public
 * `detectVisionMime` rather than imported, so imageTiler has no dependency
 * on visionRead (visionRead imports THIS module — importing back would be a
 * cycle).
 */
function sniffMime(buf: Buffer): VisionImageMime {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
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

function tilingEnabled(opts: TileOptions): boolean {
  if (opts.disableTiling === true) return false;
  return process.env.EXTRACT_TILING_ENABLED !== '0';
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ─── Pure geometry ───────────────────────────────────────────────────────

/**
 * Emitted pixels per source pixel for an image of w×h, as the model finally
 * sees it. The three terms, in order: we never upscale; the long edge is capped
 * at maxEdgePx; and the AREA is capped at maxImagePixels, which is the term the
 * previous version of this module was missing.
 *
 * Reproduces the count_tokens measurements: effectiveScale(1176,1568) = 0.790,
 * effectiveScale(1278,1459) = 0.785, effectiveScale(610,1568) = 1.
 *
 * Pure — no I/O.
 */
export function effectiveScale(
  widthPx: number,
  heightPx: number,
  opts: { maxEdgePx?: number; maxImagePixels?: number } = {},
): number {
  const maxEdge = opts.maxEdgePx ?? ANTHROPIC_MAX_EDGE_PX;
  const maxPixels = opts.maxImagePixels ?? ANTHROPIC_MAX_IMAGE_PIXELS;
  const w = Math.max(1, widthPx);
  const h = Math.max(1, heightPx);
  const byEdge = maxEdge / Math.max(w, h);
  const byArea = Math.sqrt(maxPixels / (w * h));
  return Math.min(1, byEdge, byArea);
}

/**
 * Decide the pdf-to-png-converter viewportScale for a page whose size is known
 * in PDF points (from pdf-lib `page.getSize()`; at scale 1.0, 1pt renders to
 * 1px).
 *
 * ONE rule for every orientation: target the SHORT edge at
 * targetTileShortEdgePx. Wide pages always did this — it is the axis carrying
 * the rows. Portrait pages used to target their LONG edge at 1568 instead,
 * which capped the render at the old (wrong) ceiling and left the tiler nothing
 * to spend: row bands of a 1108×1568 render top out at 1108 effective px of
 * width, where bands of a 1500×2123 render reach 1476.
 *
 * `targetSingleLongEdgePx` is accepted for API compatibility and no longer
 * used; `maxRenderLongEdgePx` is the clamp that replaces it. Pure — no I/O.
 */
export function chooseViewportScale(
  widthPt: number,
  heightPt: number,
  opts: TilerRenderScaleOptions = {},
): RenderScaleDecision {
  const landscapeAspect = opts.landscapeAspect ?? DEFAULT_LANDSCAPE_ASPECT;
  const targetShort = opts.targetTileShortEdgePx ?? DEFAULT_TARGET_TILE_SHORT_EDGE_PX;
  const maxLongEdge = opts.maxRenderLongEdgePx ?? DEFAULT_MAX_RENDER_LONG_EDGE_PX;
  const minScale = opts.minScale ?? DEFAULT_MIN_SCALE;
  const maxScale = opts.maxScale ?? DEFAULT_MAX_SCALE;

  // Defensive: pdf-lib has been seen to report 0 on a corrupt page tree.
  const w = Number.isFinite(widthPt) && widthPt > 0 ? widthPt : 595;
  const h = Number.isFinite(heightPt) && heightPt > 0 ? heightPt : 842;

  const isWide = w / h > landscapeAspect;
  const shortPt = Math.min(w, h);
  const longPt = Math.max(w, h);
  const raw = Math.min(targetShort / shortPt, maxLongEdge / longPt);
  const scale = Math.min(maxScale, Math.max(minScale, raw));

  return {
    scale: round4(scale),
    isWide,
    expectedWidthPx: Math.round(w * scale),
    expectedHeightPx: Math.round(h * scale),
  };
}

interface TileCandidate {
  axis: TileAxis;
  tileCount: number;
  tileLengthPx: number;
  tileWidthPx: number;
  tileHeightPx: number;
  /** effectiveScale of this tile. */
  effective: number;
  /** Tile size along the cut axis after the squeeze. */
  effectiveCutEdgePx: number;
}

function buildCandidate(
  w: number,
  h: number,
  axis: TileAxis,
  n: number,
  overlapRatio: number,
  maxEdgePx: number,
  maxImagePixels: number,
): TileCandidate {
  const along = axis === 'x' ? w : h;
  const tileLengthPx = along / (n - overlapRatio * (n - 1));
  const tileWidthPx = axis === 'x' ? tileLengthPx : w;
  const tileHeightPx = axis === 'x' ? h : tileLengthPx;
  const effective = effectiveScale(tileWidthPx, tileHeightPx, { maxEdgePx, maxImagePixels });
  return {
    axis,
    tileCount: n,
    tileLengthPx,
    tileWidthPx,
    tileHeightPx,
    effective,
    effectiveCutEdgePx: tileLengthPx * effective,
  };
}

/**
 * Best plan on ONE axis, or null when nothing on it qualifies.
 *
 * Walks N upward. The first accepted N must beat the untiled image by minGain;
 * every N after that must beat the plan already held by marginalGain, so we buy
 * the fewest images that capture the resolution actually on offer. Candidates
 * that would emit a sliver along the cut axis are skipped outright.
 */
function bestCandidateForAxis(
  w: number,
  h: number,
  axis: TileAxis,
  untiledEffective: number,
  cfg: {
    maxTiles: number;
    overlapRatio: number;
    maxEdgePx: number;
    maxImagePixels: number;
    minGain: number;
    marginalGain: number;
    minCutEdgePx: number;
  },
): TileCandidate | null {
  let best: TileCandidate | null = null;
  for (let n = 2; n <= cfg.maxTiles; n++) {
    const c = buildCandidate(w, h, axis, n, cfg.overlapRatio, cfg.maxEdgePx, cfg.maxImagePixels);
    if (c.effectiveCutEdgePx < cfg.minCutEdgePx) continue;
    if (best === null) {
      if (c.effective > untiledEffective * cfg.minGain) best = c;
    } else if (
      // Compounded, so skipping a rejected N does not let the one after it in
      // cheaply: upgrading a 2-tile plan straight to 4 must buy marginalGain².
      c.effective >= best.effective * Math.pow(cfg.marginalGain, c.tileCount - best.tileCount)
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * Pure geometry: given a RENDERED page size in px, produce the overlapping crop
 * windows. Orientation does not gate anything — the page is tiled whenever
 * tiling yields a real effective per-cell resolution gain, on whichever axis
 * yields it. Returns `{ isWide: false, tileCount: 0, windows: [], axis: 'none' }`
 * when no plan qualifies.
 *
 * `isWide` is retained under its original name because visionRead and
 * ocr.service read it, but it now means exactly "this page was tiled" — which
 * is all either of them ever used it for.
 *
 * A page is tiled only when BOTH hold:
 *
 *   1. the winning tile's effectiveScale beats the untiled fitted image's by
 *      at least minTileResolutionGain. A page already inside the megapixel
 *      budget has an untiled effectiveScale of 1 and can therefore never
 *      qualify, which is why no absolute-pixel trigger is needed any more;
 *
 *   2. the tile still measures at least minTileEffectiveEdgePx along the axis
 *      it was cut on, after the squeeze. This is the anti-sliver guard: a
 *      3024×4032 phone photo cut into four column strips reaches the model
 *      334px wide, and no amount of nominal "gain" makes that readable.
 *
 * `landscapeAspect` and `tileTriggerPx` are accepted for API compatibility and
 * are no longer consulted: they were the orientation gate that cost portrait
 * pages ~7pp of accuracy.
 */
export function planTiles(
  widthPx: number,
  heightPx: number,
  opts: TilerOptions = {},
): TilePlanEx {
  const maxEdgePx = opts.maxTileEdgePx ?? ANTHROPIC_MAX_EDGE_PX;
  const maxImagePixels = opts.maxImagePixels ?? ANTHROPIC_MAX_IMAGE_PIXELS;
  const overlapRatio = Math.min(0.5, Math.max(0, opts.overlapRatio ?? DEFAULT_OVERLAP_RATIO));
  const maxTiles = Math.max(2, Math.floor(opts.maxTiles ?? DEFAULT_MAX_TILES));
  const overviewMaxEdgePx = opts.overviewMaxEdgePx ?? ANTHROPIC_MAX_EDGE_PX;
  const minGain = Math.max(1, opts.minTileResolutionGain ?? DEFAULT_MIN_TILE_RESOLUTION_GAIN);
  const marginalGain = Math.max(1, opts.marginalTileGain ?? DEFAULT_MARGINAL_TILE_GAIN);
  const minCutEdgePx = Math.max(0, opts.minTileEffectiveEdgePx ?? DEFAULT_MIN_TILE_EFFECTIVE_EDGE_PX);
  const axisMode = opts.tileAxis ?? 'auto';

  const w = Math.max(1, Math.round(widthPx));
  const h = Math.max(1, Math.round(heightPx));
  const overviewScale = Math.min(1, overviewMaxEdgePx / Math.max(w, h));
  const untiledEffective = effectiveScale(w, h, { maxEdgePx, maxImagePixels });
  const warnings: string[] = [];

  /** The bail-out plan: one fitted whole-page image, no tiles. */
  const notTiled = (): TilePlanEx => ({
    isWide: false,
    axis: 'none',
    tileCount: 0,
    windows: [],
    tileWidthPx: 0,
    tileHeightPx: 0,
    tileLengthPx: 0,
    overlapPx: 0,
    tileScale: 1,
    overviewScale: round4(overviewScale),
    effectiveTileScale: round4(untiledEffective),
    effectiveUntiledScale: round4(untiledEffective),
    effectiveGain: 1,
    effectiveCutEdgePx: 0,
    warnings,
  });

  const cfg = {
    maxTiles,
    overlapRatio,
    maxEdgePx,
    maxImagePixels,
    minGain,
    marginalGain,
    minCutEdgePx,
  };

  const byX =
    axisMode === 'y' ? null : bestCandidateForAxis(w, h, 'x', untiledEffective, cfg);
  const byY =
    axisMode === 'x' ? null : bestCandidateForAxis(w, h, 'y', untiledEffective, cfg);

  let chosen: TileCandidate | null;
  if (byX && byY) {
    if (byX.effective > byY.effective * AXIS_TIE_TOLERANCE) chosen = byX;
    else if (byY.effective > byX.effective * AXIS_TIE_TOLERANCE) chosen = byY;
    // A tie: cut the LONG edge. Equal resolution either way, but cutting the
    // long edge leaves tiles closer to square and leaves fewer of them.
    else chosen = w >= h ? byX : byY;
  } else {
    chosen = byX ?? byY;
  }

  if (!chosen) {
    warnings.push('tile_no_resolution_gain');
    return notTiled();
  }

  // How much WE resize by. A tile already inside the edge ceiling is emitted at
  // native resolution and Anthropic applies the area squeeze — byte-for-byte
  // the path that measured 100% on landscape, deliberately untouched. Once the
  // edge ceiling forces a resize anyway, do it ONCE, ourselves, straight to the
  // size the model will see rather than to 1568 and then again inside the API.
  const edgeScale = Math.min(1, maxEdgePx / Math.max(chosen.tileWidthPx, chosen.tileHeightPx));
  let tileScale = 1;
  if (edgeScale < 1 || opts.preDownscaleToBudget === true) {
    tileScale = chosen.effective;
    if (chosen.tileWidthPx > maxEdgePx) warnings.push('tile_downscaled');
    if (chosen.tileHeightPx > maxEdgePx) warnings.push('tile_height_downscaled');
  }
  if (chosen.axis === 'y') warnings.push('tile_row_bands');

  // Step between tile leading edges. With exact arithmetic the last window's
  // trailing edge lands exactly on the page edge; rounding can overshoot by a
  // pixel, so the last window is clamped and its leading edge pulled back to
  // preserve the full tile length. A short final tile would clip the rightmost
  // money column — the single most valuable column on the page — or, on a row
  // band, the totals block.
  const along = chosen.axis === 'x' ? w : h;
  const step = chosen.tileLengthPx - overlapRatio * chosen.tileLengthPx;
  const intTileLength = Math.min(along, Math.round(chosen.tileLengthPx));
  const windows: Array<readonly [number, number]> = [];
  for (let i = 0; i < chosen.tileCount; i++) {
    let start = Math.round(i * step);
    let end = start + intTileLength;
    if (i === chosen.tileCount - 1 || end > along) {
      end = along;
      start = Math.max(0, end - intTileLength);
    }
    windows.push([start, end] as const);
  }

  return {
    isWide: true,
    axis: chosen.axis,
    tileCount: chosen.tileCount,
    windows,
    tileWidthPx: round2(chosen.tileWidthPx),
    tileHeightPx: round2(chosen.tileHeightPx),
    tileLengthPx: round2(chosen.tileLengthPx),
    overlapPx: round2(overlapRatio * chosen.tileLengthPx),
    tileScale: round4(tileScale),
    overviewScale: round4(overviewScale),
    effectiveTileScale: round4(chosen.effective),
    effectiveUntiledScale: round4(untiledEffective),
    effectiveGain: round4(chosen.effective / untiledEffective),
    effectiveCutEdgePx: Math.round(chosen.effectiveCutEdgePx),
    warnings,
  };
}

// ─── Rasterised-image tiling ─────────────────────────────────────────────

/**
 * The bail-out shape: one image, no tiling. Used whenever sharp cannot be
 * trusted with the buffer. The caller still gets something sendable, which is
 * the whole point — a degraded read beats no read.
 *
 * `bytes` MUST be the auto-oriented working buffer whenever we have one. Handing
 * back the untouched source here is how the EXIF fix used to leak: a phone photo
 * that auto-oriented and then tripped `tile_metadata_unavailable` was sent
 * sideways again, re-introducing the sideways-page finding.
 */
function fallbackPage(
  bytes: Buffer,
  pageNumber: number,
  renderScale: number,
  warnings: string[],
): TiledPageEx {
  return {
    geometry: {
      pageNumber,
      widthPx: 0,
      heightPx: 0,
      aspectRatio: 0,
      isWide: false,
      renderScale,
      deskewAngleDeg: null,
    },
    images: [
      {
        data: bytes,
        mime: sniffMime(bytes),
        role: 'overview',
        pageNumber,
        tileIndex: 0,
        tileCount: 0,
        widthPx: 0,
        heightPx: 0,
        xRange: [0, 0] as const,
        yRange: [0, 0] as const,
        tileAxis: 'none',
        sourceWidthPx: 0,
        sourceHeightPx: 0,
      },
    ],
    warnings,
  };
}

/**
 * Shared implementation. `renderScale` is stamped onto the geometry so a
 * PDF-rendered page can report the viewportScale it was rasterised at while a
 * source image reports 1.
 */
async function tileRenderedImage(
  source: Buffer,
  pageNumber: number,
  opts: TilerOptions,
  renderScale: number,
): Promise<TiledPageEx> {
  const warnings: string[] = [];

  if (!source || source.length === 0) {
    return fallbackPage(source ?? Buffer.alloc(0), pageNumber, renderScale, ['tile_empty_source']);
  }

  // Declared OUTSIDE the try so every fallback path below — including the catch
  // — returns the ORIENTED bytes rather than the raw source. See fallbackPage.
  let working = source;

  try {
    const sharp = await loadSharp();
    const jpegQuality = opts.jpegQuality ?? DEFAULT_JPEG_QUALITY;
    const maxTileEdgePx = opts.maxTileEdgePx ?? ANTHROPIC_MAX_EDGE_PX;

    // 0. EXIF ORIENTATION — FIRST, before anything else reads a dimension.
    //
    //    A phone photo is almost always stored landscape-on-sensor with an
    //    EXIF Orientation tag telling the viewer to turn it upright. sharp
    //    auto-applies that tag ONLY on an argument-less .rotate(); the moment
    //    you pass an explicit angle (which deskew does, deskew.ts:365) sharp
    //    ignores EXIF entirely, and the re-encode then strips the tag so no
    //    downstream consumer — including the model — can recover it. The
    //    page would be read sideways, and on a 4032×3024 photo it would also
    //    be sliced into strips of sideways text.
    //
    //    So: normalise here, at the top, and every dimension read after this
    //    point (deskew's ink sample, the metadata read, planTiles' geometry)
    //    sees the upright page. Only pay the re-encode when there is actually a
    //    tag to honour.
    try {
      const srcMeta = await sharp(source).metadata();
      const orientation = Number(srcMeta.orientation ?? 0);
      if (orientation > 1) {
        working = await sharp(source)
          .rotate() // argument-less = auto-orient from EXIF
          .jpeg({ quality: Math.max(jpegQuality, 95), chromaSubsampling: '4:4:4' })
          .toBuffer();
        warnings.push('exif_orientation_applied');
        logger.debug(
          { page: pageNumber, exif_orientation: orientation },
          'imageTiler: applied EXIF orientation before deskew/tiling',
        );
      }
    } catch (err) {
      // A buffer sharp cannot even read the header of will fail again below
      // and land in the fallback path; do not lose the read over it here.
      warnings.push('exif_orientation_unreadable');
      logger.debug(
        { err: (err as any)?.message ?? String(err), page: pageNumber },
        'imageTiler: could not read EXIF orientation; continuing with the raw bytes',
      );
    }

    // 1. Deskew. Must happen BEFORE the crop: cutting a tilted page into
    //    slices bakes the tilt into each slice.
    let deskewAngleDeg: number | null = null;
    if (opts.deskew !== false) {
      const dk = await deskewImage(working);
      warnings.push(...dk.warnings);
      if (dk.applied) {
        working = dk.bytes;
        deskewAngleDeg = dk.angleDeg;
      } else if (dk.method !== 'none') {
        deskewAngleDeg = 0;
      }
    }

    // 2. Re-read metadata — rotation changes the canvas size.
    const meta = await sharp(working).metadata();
    const widthPx = Number(meta.width ?? 0);
    const heightPx = Number(meta.height ?? 0);
    if (!widthPx || !heightPx) {
      return fallbackPage(working, pageNumber, renderScale, [
        ...warnings,
        'tile_metadata_unavailable',
      ]);
    }

    const plan: TilePlanEx = tilingEnabled(opts)
      ? planTiles(widthPx, heightPx, opts)
      : {
          isWide: false,
          axis: 'none',
          tileCount: 0,
          windows: [],
          tileWidthPx: 0,
          tileHeightPx: 0,
          tileLengthPx: 0,
          overlapPx: 0,
          tileScale: 1,
          overviewScale: Math.min(
            1,
            (opts.overviewMaxEdgePx ?? ANTHROPIC_MAX_EDGE_PX) / Math.max(widthPx, heightPx),
          ),
          effectiveTileScale: effectiveScale(widthPx, heightPx, {
            maxEdgePx: maxTileEdgePx,
            maxImagePixels: opts.maxImagePixels ?? ANTHROPIC_MAX_IMAGE_PIXELS,
          }),
          effectiveUntiledScale: effectiveScale(widthPx, heightPx, {
            maxEdgePx: maxTileEdgePx,
            maxImagePixels: opts.maxImagePixels ?? ANTHROPIC_MAX_IMAGE_PIXELS,
          }),
          effectiveGain: 1,
          effectiveCutEdgePx: 0,
          warnings: ['tiling_disabled'],
        };
    warnings.push(...plan.warnings);

    const geometry: PageGeometry = {
      pageNumber,
      widthPx,
      heightPx,
      aspectRatio: round4(widthPx / heightPx),
      isWide: plan.isWide,
      renderScale,
      deskewAngleDeg,
    };

    const images: TiledVisionImage[] = [];

    // 3a. Not tiled → one image fitted under the ceiling.
    if (!plan.isWide || plan.tileCount === 0) {
      const fitted: Buffer = await sharp(working)
        .resize({
          width: maxTileEdgePx,
          height: maxTileEdgePx,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: jpegQuality })
        .toBuffer();
      const fm = await sharp(fitted).metadata();
      images.push({
        data: fitted,
        mime: 'image/jpeg',
        role: 'overview',
        pageNumber,
        tileIndex: 0,
        tileCount: 0,
        widthPx: Number(fm.width ?? 0),
        heightPx: Number(fm.height ?? 0),
        xRange: [0, widthPx] as const,
        yRange: [0, heightPx] as const,
        tileAxis: 'none',
        sourceWidthPx: widthPx,
        sourceHeightPx: heightPx,
      });
      return { geometry, images, warnings };
    }

    // 3b. Tiled. Overview first — it carries header/footer/grand-total
    //     fields and gives the model a map of the page before it sees the
    //     slices out of context.
    if (opts.includeOverview !== false) {
      const overviewMaxEdgePx = opts.overviewMaxEdgePx ?? ANTHROPIC_MAX_EDGE_PX;
      const overview: Buffer = await sharp(working)
        .resize({
          width: overviewMaxEdgePx,
          height: overviewMaxEdgePx,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: jpegQuality })
        .toBuffer();
      const om = await sharp(overview).metadata();
      images.push({
        data: overview,
        mime: 'image/jpeg',
        role: 'overview',
        pageNumber,
        tileIndex: 0,
        tileCount: plan.tileCount,
        widthPx: Number(om.width ?? 0),
        heightPx: Number(om.height ?? 0),
        xRange: [0, widthPx] as const,
        yRange: [0, heightPx] as const,
        tileAxis: 'none',
        sourceWidthPx: widthPx,
        sourceHeightPx: heightPx,
      });
    }

    const axis: TileAxis = plan.axis === 'y' ? 'y' : 'x';
    for (let i = 0; i < plan.windows.length; i++) {
      const [rawStart, rawEnd] = plan.windows[i];
      const along = axis === 'x' ? widthPx : heightPx;
      const start = Math.max(0, Math.min(Math.round(rawStart), along - 1));
      const length = Math.max(1, Math.min(Math.round(rawEnd) - start, along - start));

      const left = axis === 'x' ? start : 0;
      const top = axis === 'y' ? start : 0;
      const width = axis === 'x' ? length : widthPx;
      const height = axis === 'y' ? length : heightPx;

      let pipeline = sharp(working).extract({ left, top, width, height });
      if (plan.tileScale < 1) {
        // FLOOR, not round. The window edges are integers and tileScale is
        // rounded to 4dp, so rounding to nearest can land a tile a hundred
        // pixels-squared OVER the area budget — which hands it straight back to
        // the API for a second resample and defeats the point of resizing it
        // ourselves. A pixel short costs nothing; a pixel long costs a resample.
        pipeline = pipeline.resize({
          width: Math.max(1, Math.floor(width * plan.tileScale)),
          height: Math.max(1, Math.floor(height * plan.tileScale)),
          fit: 'fill',
        });
      }
      const tile: Buffer = await pipeline.jpeg({ quality: jpegQuality }).toBuffer();
      const tm = await sharp(tile).metadata();

      images.push({
        data: tile,
        mime: 'image/jpeg',
        role: 'tile',
        pageNumber,
        tileIndex: i,
        tileCount: plan.tileCount,
        widthPx: Number(tm.width ?? 0),
        heightPx: Number(tm.height ?? 0),
        xRange: [left, left + width] as const,
        yRange: [top, top + height] as const,
        tileAxis: axis,
        sourceWidthPx: widthPx,
        sourceHeightPx: heightPx,
      });
    }

    logger.debug(
      {
        page: pageNumber,
        source_px: `${widthPx}x${heightPx}`,
        axis,
        tiles: plan.tileCount,
        tile_px: `${plan.tileWidthPx}x${plan.tileHeightPx}`,
        overlap_px: plan.overlapPx,
        tile_scale: plan.tileScale,
        effective_tile_scale: plan.effectiveTileScale,
        effective_untiled_scale: plan.effectiveUntiledScale,
        effective_gain: plan.effectiveGain,
        deskew_deg: deskewAngleDeg,
        images: images.length,
      },
      'imageTiler: page tiled for vision',
    );

    return { geometry, images, warnings };
  } catch (err) {
    logger.warn(
      { err: (err as any)?.message ?? String(err), page: pageNumber },
      'imageTiler: tiling failed; falling back to the original single image',
    );
    // `working` — NOT `source`: if the EXIF step succeeded and a later stage
    // threw, the oriented bytes are the ones that must go to the model.
    return fallbackPage(working, pageNumber, renderScale, [...warnings, 'tile_failed']);
  }
}

/**
 * Deskew (optional) then tile ONE already-rasterised image buffer.
 * pageNumber is stamped onto every emitted VisionImage. Never throws:
 * on failure returns a single-image TiledPage carrying the (auto-oriented)
 * bytes plus a warning.
 */
export async function tileImage(
  source: Buffer,
  pageNumber = 1,
  opts: TilerOptions = {},
): Promise<TiledPageEx> {
  return tileRenderedImage(source, pageNumber, opts, 1);
}

// ─── PDF tiling ──────────────────────────────────────────────────────────

/** Page sizes in PDF points, 1-based index → { widthPt, heightPt }. */
async function readPageSizes(
  pdfBytes: Buffer,
): Promise<Array<{ pageNumber: number; widthPt: number; heightPt: number }>> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const out: Array<{ pageNumber: number; widthPt: number; heightPt: number }> = [];
  const count = doc.getPageCount();
  for (let i = 0; i < count; i++) {
    const { width, height } = doc.getPage(i).getSize();
    out.push({ pageNumber: i + 1, widthPt: width, heightPt: height });
  }
  return out;
}

/**
 * Render the requested pages at `viewportScale`. Returns a 1-based
 * pageNumber → PNG buffer map so a caller can survive the converter
 * reordering or dropping a page.
 */
async function renderPdfPages(
  pdfBytes: Buffer,
  pageNumbers: number[],
  viewportScale: number,
): Promise<Map<number, Buffer>> {
  const pdfToPng = await loadPdfToPng();
  const rendered: Array<{ content: Buffer; pageNumber?: number }> = await pdfToPng(pdfBytes, {
    pagesToProcess: pageNumbers,
    viewportScale,
  });
  const map = new Map<number, Buffer>();
  rendered.forEach((p, idx) => {
    const n = Number(p?.pageNumber) || pageNumbers[idx];
    if (n && p?.content) map.set(n, p.content);
  });
  return map;
}

/**
 * Render ONE PDF page at the scale chosen by chooseViewportScale (read from
 * pdf-lib, NOT the fixed 2.0), deskew it, and tile it.
 */
export async function tilePdfPage(
  pdfBytes: Buffer,
  pageNumber: number,
  opts: TilerOptions & TilerRenderScaleOptions = {},
): Promise<TiledPageEx> {
  const pages = await tilePdf(pdfBytes, { ...opts, pages: [pageNumber], maxPages: 1 });
  if (pages.length > 0) return pages[0];
  return fallbackPage(Buffer.alloc(0), pageNumber, 0, ['pdf_page_render_failed']);
}

/**
 * Same for a page range. `pages` defaults to every page; `maxPages` caps the
 * count (default 8, mirroring the existing MAX_VISION_PAGES budget).
 */
export async function tilePdf(
  pdfBytes: Buffer,
  opts: TilerOptions & TilerRenderScaleOptions & { pages?: number[]; maxPages?: number } = {},
): Promise<TiledPageEx[]> {
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);

  let sizes: Array<{ pageNumber: number; widthPt: number; heightPt: number }>;
  try {
    sizes = await readPageSizes(pdfBytes);
  } catch (err) {
    logger.warn(
      { err: (err as any)?.message ?? String(err) },
      'imageTiler: pdf-lib could not read page sizes; cannot tile this PDF',
    );
    return [];
  }

  const byNumber = new Map(sizes.map((s) => [s.pageNumber, s]));
  const requested = (opts.pages && opts.pages.length > 0 ? opts.pages : sizes.map((s) => s.pageNumber))
    .filter((n) => byNumber.has(n))
    .slice(0, maxPages);

  if (requested.length === 0) return [];

  // Group by render scale so a mixed-orientation PDF still costs one
  // pdf-to-png-converter pass per distinct scale rather than one per page.
  const scaleFor = new Map<number, number>();
  const groups = new Map<number, number[]>();
  for (const n of requested) {
    const s = byNumber.get(n)!;
    const decision = chooseViewportScale(s.widthPt, s.heightPt, opts);
    // Round so near-identical scales share a render pass.
    const key = Math.round(decision.scale * 100) / 100;
    scaleFor.set(n, key);
    const bucket = groups.get(key);
    if (bucket) bucket.push(n);
    else groups.set(key, [n]);
  }

  const renderedPages = new Map<number, Buffer>();
  for (const [scale, nums] of groups) {
    try {
      const map = await renderPdfPages(pdfBytes, nums, scale);
      for (const [n, buf] of map) renderedPages.set(n, buf);
    } catch (err) {
      logger.warn(
        { err: (err as any)?.message ?? String(err), scale, pages: nums },
        'imageTiler: PDF render pass failed for this scale group',
      );
    }
  }

  const out: TiledPageEx[] = [];
  for (const n of requested) {
    const buf = renderedPages.get(n);
    if (!buf) {
      out.push(fallbackPage(Buffer.alloc(0), n, scaleFor.get(n) ?? 0, ['pdf_page_render_failed']));
      continue;
    }
    out.push(await tileRenderedImage(buf, n, opts, scaleFor.get(n) ?? 1));
  }
  return out;
}

// ─── Bridge + prompt helpers ─────────────────────────────────────────────

function asPageArray(pages: TiledPage | TiledPage[]): TiledPage[] {
  return Array.isArray(pages) ? pages : [pages];
}

/**
 * Flatten TiledPage(s) into bridge attachments in send order
 * (per page: overview first, then tiles in reading order). Pure.
 * The return type is structurally identical to LlmAttachment from
 * ../llm/LlmClient.js and is assignable to LlmAttachment[].
 */
export function toLlmAttachments(
  pages: TiledPage | TiledPage[],
): Array<{ kind: 'image'; data: Buffer; mime: string }> {
  const out: Array<{ kind: 'image'; data: Buffer; mime: string }> = [];
  for (const page of asPageArray(pages)) {
    for (const img of page.images) {
      out.push({ kind: 'image', data: img.data, mime: img.mime });
    }
  }
  return out;
}

/**
 * Which way a tile was cut. Reads the field this module stamps on, and falls
 * back to 'x' for a VisionImage built elsewhere (tests, older callers) — that
 * was the only shape that existed before row bands.
 */
function axisOf(img: VisionImage): TileAxis {
  const a = (img as Partial<TiledVisionImage>).tileAxis;
  return a === 'y' ? 'y' : 'x';
}

/**
 * One-paragraph description of exactly what images were sent, for injection
 * into a user prompt's context slot. Names the overview, the slice count per
 * page, the cut DIRECTION, the overlap, and the merge rule — which is different
 * for column strips and row bands, and getting it wrong is worse than saying
 * nothing: a model told "every slice shows the same rows" about a set of row
 * bands will duplicate or drop half the table.
 */
export function describeTiling(pages: TiledPage | TiledPage[]): string {
  const list = asPageArray(pages).filter((p) => p.images.length > 0);
  if (list.length === 0) return '';

  const tiled = list.filter((p) => p.geometry.isWide && p.images.some((i) => i.role === 'tile'));
  if (tiled.length === 0) {
    const n = list.reduce((acc, p) => acc + p.images.length, 0);
    return (
      `You are being sent ${n} image${n === 1 ? '' : 's'}: one whole-page image per page, ` +
      `in page order. Each image is a complete page — not a slice.`
    );
  }

  const sentences: string[] = [];
  const axesUsed = new Set<TileAxis>();
  let imageCursor = 1;

  for (const page of list) {
    const tiles = page.images.filter((i) => i.role === 'tile');
    const hasOverview = page.images.some((i) => i.role === 'overview');
    const { widthPx, heightPx, pageNumber } = page.geometry;
    const first = imageCursor;
    const last = imageCursor + page.images.length - 1;
    imageCursor = last + 1;

    if (tiles.length === 0) {
      sentences.push(
        `Image ${first} is page ${pageNumber} (${widthPx}x${heightPx}px) as a single whole-page image.`,
      );
      continue;
    }

    const axis = axisOf(tiles[0]);
    axesUsed.add(axis);
    const overlapPct = Math.round(DEFAULT_OVERLAP_RATIO * 100);
    const tileFirst = hasOverview ? first + 1 : first;
    // 'WIDE table' is the exact wording the 100%-scoring landscape prompt used;
    // left alone. Bands say 'TALL page' because portrait banding now applies to
    // every dense page, most of which are not tables at all.
    const shape = axis === 'x' ? 'a WIDE table' : 'a TALL page';
    const cut =
      axis === 'x'
        ? `FULL-RESOLUTION OVERLAPPING VERTICAL slices of the SAME page, left to right`
        : `FULL-RESOLUTION OVERLAPPING HORIZONTAL bands of the SAME page, top to bottom`;

    sentences.push(
      `Page ${pageNumber} is ${shape} (${widthPx}x${heightPx}px). You are being sent ` +
        `${page.images.length} images of it: ` +
        (hasOverview
          ? `image ${first} is a DOWNSCALED OVERVIEW of the whole page (use it for header, footer and ` +
            `grand-total fields only — its small text is not reliable), images ${tileFirst}-${last} are `
          : `images ${tileFirst}-${last} are `) +
        `${cut}, each overlapping its neighbour by about ${overlapPct}%.`,
    );
  }

  sentences.push(
    'The slices are NOT different documents and NOT different pages.',
  );

  if (axesUsed.has('x')) {
    sentences.push(
      'For the VERTICAL slices: because the cuts are vertical, every slice shows the SAME rows in the ' +
        'SAME top-to-bottom order — the Nth data row of one slice is the Nth data row of every other ' +
        'slice. Use that, plus the overlapping columns two adjacent slices share, to join a row\'s cells ' +
        'back together — a rightmost slice may not show the serial number or the description at all, and ' +
        'that is expected. A row visible in two adjacent slices is ONE row: output it exactly once.',
    );
  }

  if (axesUsed.has('y')) {
    sentences.push(
      'For the HORIZONTAL bands: each band is the FULL WIDTH of the page and carries a CONSECUTIVE ' +
        'block of rows, so a row is never split down the middle — read the bands in the order given and ' +
        'concatenate their rows. Only the FIRST band shows the column headers; the later bands have the ' +
        'SAME columns in the SAME left-to-right order, so apply that header layout to every band. ' +
        'Adjacent bands overlap, so the last few rows of one band are the first few rows of the next: ' +
        'a row that appears in two bands is ONE row, output it exactly once.',
    );
  }

  sentences.push(
    'Never invent a row, never drop one, and never shift a value from one row onto another — if the ' +
      'slices disagree on how many rows there are, count again against the slice that carries the row ' +
      'keys (the leftmost slice, or the first band).',
  );

  return sentences.join(' ');
}
