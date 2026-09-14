/**
 * Shared types for the vision-first document engine.
 *
 * Type-only module — no runtime code, no imports. Everything here is part of
 * the frozen contract consumed by ocr.service.ts and docExtractor.service.ts
 * via `./extractor/index.js`.
 *
 * The vocabulary in one paragraph: a *page* is rasterised once at an
 * aspect-aware DPI (see imageTiler.chooseViewportScale), deskewed, and then
 * cut into N horizontal *tiles* that overlap their neighbours. Every tile is
 * small enough that Anthropic does NOT downscale it (long edge ≤ 1568px), so
 * the money column keeps its native resolution. A single downscaled
 * *overview* of the whole page is sent first to carry header/footer/total
 * fields and give the model global context.
 */

/** MIME types Anthropic's image content block accepts. */
export type VisionImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

/** One image block destined for a Claude vision call. */
export interface VisionImage {
  data: Buffer;
  mime: VisionImageMime;
  /** 'overview' = downscaled whole page (sent first). 'tile' = native-res horizontal slice. */
  role: 'overview' | 'tile';
  /** 1-based page number within the source document. */
  pageNumber: number;
  /** 0-based left-to-right index among the tiles of this page. 0 for an overview. */
  tileIndex: number;
  /** Number of TILES for this page (excludes the overview). 0 when the page was not tiled. */
  tileCount: number;
  widthPx: number;
  heightPx: number;
  /** Horizontal crop window [left, right) in rendered source pixels. Overview = [0, sourceWidthPx]. */
  xRange: readonly [number, number];
  sourceWidthPx: number;
  sourceHeightPx: number;
}

export interface PageGeometry {
  pageNumber: number;
  /** Rendered page size BEFORE cropping, after deskew. */
  widthPx: number;
  heightPx: number;
  /** widthPx / heightPx. */
  aspectRatio: number;
  /** True when the page tripped the landscape/wide heuristic and was tiled. */
  isWide: boolean;
  /** viewportScale actually passed to pdf-to-png-converter. 1 for source images. */
  renderScale: number;
  /**
   * Correction angle applied in degrees. null when deskew did not run.
   *
   * Sign convention (see deskew.ts): this is the angle handed to
   * `sharp.rotate()`, which rotates CLOCKWISE for positive values. A page
   * whose text slopes down-to-the-right is corrected with a NEGATIVE angle.
   */
  deskewAngleDeg: number | null;
}

export interface TiledPage {
  geometry: PageGeometry;
  /** Overview first (when present), then tiles left-to-right. Single-element for a non-wide page. */
  images: VisionImage[];
  warnings: string[];
}

export interface TileOptions {
  /** width/height above which a page is treated as wide. Default 1.3. */
  landscapeAspect?: number;
  /**
   * Minimum absolute rendered width for tiling, ANDed with landscapeAspect —
   * NOT an independent trigger. A page must be both genuinely landscape and
   * this wide before it is sliced. Default 1600.
   */
  tileTriggerPx?: number;
  /**
   * Tiling is abandoned unless a tile's effective scale beats the untiled
   * fitted scale by at least this factor. Guards against paying 3–4× the
   * images for the same resolution on a tall page. Default 1.1.
   */
  minTileResolutionGain?: number;
  /** Hard per-image edge ceiling — above this Anthropic downscales. Default 1568. */
  maxTileEdgePx?: number;
  /** Fraction of a tile's width that overlaps its neighbour. Default 0.16. */
  overlapRatio?: number;
  /** Maximum tiles per page. Default 4. */
  maxTiles?: number;
  /** Emit the downscaled full-page overview image. Default true. */
  includeOverview?: boolean;
  /** Long-edge ceiling for the overview image. Default 1568. */
  overviewMaxEdgePx?: number;
  /** Run deskew before tiling. Default true (respects EXTRACT_DESKEW_ENABLED). */
  deskew?: boolean;
  /** JPEG quality for emitted tiles. Default 92. */
  jpegQuality?: number;
  /** Force-disable tiling; emits a single fitted image per page. Default false (respects EXTRACT_TILING_ENABLED). */
  disableTiling?: boolean;
}

export interface RenderScaleOptions {
  /** For WIDE pages: target rendered SHORT edge in px. Default 1500. */
  targetTileShortEdgePx?: number;
  /** For NON-WIDE pages: target rendered LONG edge in px. Default 1568. */
  targetSingleLongEdgePx?: number;
  /** Clamp. Defaults 1.5 and 6.0. */
  minScale?: number;
  maxScale?: number;
  /** Default 1.3. */
  landscapeAspect?: number;
}

export interface RenderScaleDecision {
  scale: number;
  isWide: boolean;
  expectedWidthPx: number;
  expectedHeightPx: number;
}

export interface TilePlan {
  isWide: boolean;
  /** 0 when the page is not tiled. */
  tileCount: number;
  /** [left, right) windows in rendered source pixels, left-to-right. Empty when not tiled. */
  windows: Array<readonly [number, number]>;
  /** Uniform tile width in source px before any safety downscale. */
  tileWidthPx: number;
  /** Overlap between adjacent tiles in source px. */
  overlapPx: number;
  /** <1 only when even maxTiles tiles exceed maxTileEdgePx and a safety downscale is required. */
  tileScale: number;
  /** Scale applied to produce the overview image. */
  overviewScale: number;
  warnings: string[];
}
