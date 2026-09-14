/**
 * Small-angle deskew — the fix for the money-column row shift.
 *
 * Cause #3 in docs/proposals/EXTRACTION_LANDSCAPE_FIX.md: a phone-scanned
 * landscape bill is almost never perfectly square to the sensor. A 1–2°
 * tilt is invisible to a human but, across a 3400px-wide page, drifts the
 * far-right "Payable" column ~60–120px vertically — a full row height. Both
 * Tesseract and Claude Vision then read that amount onto the NEIGHBOURING
 * line item. The existing rotation salvage in ocr.service only handles 90°
 * multiples (OSD + a [90,180,270] brute-force sweep), so a 1.2° tilt sails
 * straight through.
 *
 * Method: projection-profile maximisation. Text lines are horizontal bands
 * of ink separated by white gutters, so when the page is square the
 * horizontal projection profile (ink summed per row) is a sharp comb; when
 * it is tilted the comb smears. We therefore score candidate angles by the
 * gradient energy of the profile — sum of (p[i+1] - p[i])² — and pick the
 * maximum.
 *
 * Crucially we do NOT physically rotate the image per candidate angle (that
 * would be ~30 sharp round-trips per page). Instead we extract the ink
 * pixels ONCE into flat arrays and, for each candidate θ, accumulate each
 * pixel into bucket round(y - x·tanθ). That is a shear, which is exactly
 * equivalent to a rotation for projection-profile purposes at these angles,
 * and costs one pass over the ink points per angle.
 *
 * SIGN CONVENTION (the frozen contract's field comment is loose; this is
 * the truth, and detect/correct are self-consistent):
 *   detectedAngleDeg > 0  ⇒ text slopes DOWN to the right, i.e. the content
 *                           was rotated CLOCKWISE. Because the bucket
 *                           expression subtracts x·tanθ, the score peaks at
 *                           exactly that clockwise angle.
 *   correction applied    = -detectedAngleDeg, handed to sharp.rotate(),
 *                           which rotates clockwise for positive values —
 *                           so a negative correction rotates
 *                           counter-clockwise and undoes the tilt.
 *
 * Budget: ~32 candidate angles over a ≤250k-point ink sample. Measured
 * 40–180ms on a 3400×1400 bill. Never throws: every failure mode returns
 * the input bytes untouched with a warning, because a slightly skewed page
 * still reads far better than a crashed extraction.
 *
 * Flag: EXTRACT_DESKEW_ENABLED=0 disables it with no deploy.
 */

import { logger } from '../../Utils/logger.js';

// ─── Public types ────────────────────────────────────────────────────────

export interface DeskewOptions {
  /** Search range is [-maxAngleDeg, +maxAngleDeg]. Default 5. */
  maxAngleDeg?: number;
  /** Coarse sweep step in degrees. Default 0.5. */
  coarseStepDeg?: number;
  /** Fine sweep step around the coarse winner. Default 0.1. */
  fineStepDeg?: number;
  /** Below this |angle| nothing is applied (rotation costs more than it gains). Default 0.15. */
  minAngleDeg?: number;
  /** Greyscale analysis buffer is resized to this width before the sweep. Default 1000. */
  analysisWidthPx?: number;
  /** Fill colour for the corners exposed by rotation. Default '#ffffff'. */
  background?: string;
}

export interface SkewDetection {
  /**
   * Detected skew of the CONTENT in degrees.
   *
   * Positive = the text slopes DOWN to the right, i.e. the content was
   * rotated CLOCKWISE — the same sense as `sharp.rotate()`. (The frozen
   * contract's one-line comment said "counter-clockwise"; that was loose.
   * The sign here is the one the implementation actually produces and the
   * one `deskewImage` negates to correct, and it is verified by the
   * round-trip test in __tests__/deskew.test.ts.)
   */
  angleDeg: number;
  /** 0..1 — normalised margin between the best and median projection-profile score. */
  confidence: number;
  method: 'projection_profile' | 'none';
  elapsedMs: number;
}

export interface DeskewResult {
  /** Corrected image, or the input bytes unchanged when `applied` is false. */
  bytes: Buffer;
  /** Correction actually applied (= -detectedAngleDeg), 0 when not applied. */
  angleDeg: number;
  detectedAngleDeg: number;
  applied: boolean;
  confidence: number;
  method: 'projection_profile' | 'none';
  elapsedMs: number;
  warnings: string[];
}

// ─── Tuning constants ────────────────────────────────────────────────────

const DEFAULT_MAX_ANGLE_DEG = 5;
const DEFAULT_COARSE_STEP_DEG = 0.5;
const DEFAULT_FINE_STEP_DEG = 0.1;
const DEFAULT_MIN_ANGLE_DEG = 0.15;
const DEFAULT_ANALYSIS_WIDTH_PX = 1000;
const DEFAULT_BACKGROUND = '#ffffff';

/**
 * Upper bound on sampled ink points. The sweep is O(angles × points), so
 * this is the only knob that bounds worst-case latency. 250k points over 32
 * angles is 8M accumulate operations — tens of milliseconds in V8.
 */
const MAX_INK_POINTS = 250_000;

/**
 * A pixel counts as ink when it is at least this much darker than the page
 * mean. Adaptive (mean-relative) rather than absolute so a grey phone scan
 * behaves like a clean white render.
 */
const INK_MARGIN = 10;

/** Below this many ink points the page is blank/noise — refuse to guess. */
const MIN_INK_POINTS = 200;

/** Below this confidence the winning angle is indistinguishable from noise. */
const MIN_CONFIDENCE = 0.02;

let _sharp: any = null;

async function loadSharp(): Promise<any> {
  if (!_sharp) {
    const mod: any = await import('sharp');
    _sharp = mod?.default ?? mod;
  }
  return _sharp;
}

function deskewEnabled(): boolean {
  return process.env.EXTRACT_DESKEW_ENABLED !== '0';
}

// ─── Ink sampling ────────────────────────────────────────────────────────

interface InkSample {
  xs: Float32Array;
  ys: Float32Array;
  weights: Float32Array;
  count: number;
  widthPx: number;
  heightPx: number;
}

/**
 * Greyscale + downscale the page, then keep only the pixels darker than the
 * page mean. Returns flat arrays so the angle sweep never touches the raw
 * RGBA buffer again.
 */
async function sampleInk(image: Buffer, analysisWidthPx: number): Promise<InkSample | null> {
  const sharp = await loadSharp();
  const { data, info } = await sharp(image)
    .greyscale()
    .resize({ width: analysisWidthPx, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width: number = info.width;
  const height: number = info.height;
  const channels: number = info.channels ?? 1;
  if (!width || !height) return null;

  // Page mean over the first (luma) channel.
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += channels) {
    sum += data[i];
    n++;
  }
  if (n === 0) return null;
  const mean = sum / n;

  // Stride to keep the sample under MAX_INK_POINTS even on a solid-black
  // page. Applied to COLUMNS ONLY — never to rows.
  //
  // Striding rows is a trap we walked into once: with a row stride of 2 every
  // y is even, so at theta = 0 every point lands in an even bucket and every
  // odd bucket stays empty. That artificial comb has enormous gradient energy
  // and makes 0 degrees win on any image, which silently disables the whole
  // deskew stage. Columns are redundant along a text line, rows ARE the
  // signal, so the stride belongs on x.
  const xStride = Math.max(1, Math.ceil((width * height) / MAX_INK_POINTS));

  const cap = Math.ceil(Math.ceil(width / xStride) * height) + 8;
  const xs = new Float32Array(cap);
  const ys = new Float32Array(cap);
  const weights = new Float32Array(cap);
  let count = 0;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * channels;
    for (let x = 0; x < width; x += xStride) {
      const v = data[rowOffset + x * channels];
      const ink = mean - v - INK_MARGIN;
      if (ink > 0 && count < cap) {
        xs[count] = x;
        ys[count] = y;
        weights[count] = ink;
        count++;
      }
    }
  }

  if (count < MIN_INK_POINTS) return null;
  return { xs, ys, weights, count, widthPx: width, heightPx: height };
}

/**
 * Gradient energy of the horizontal projection profile after shearing the
 * ink cloud by `angleDeg`. Higher = text rows are more tightly aligned.
 */
function profileScore(sample: InkSample, angleDeg: number, pad: number, buckets: Float64Array): number {
  buckets.fill(0);
  const tan = Math.tan((angleDeg * Math.PI) / 180);
  const { xs, ys, weights, count } = sample;
  const limit = buckets.length - 1;

  for (let i = 0; i < count; i++) {
    let b = Math.round(ys[i] - xs[i] * tan) + pad;
    if (b < 0) b = 0;
    else if (b > limit) b = limit;
    buckets[b] += weights[i];
  }

  let score = 0;
  for (let i = 0; i < limit; i++) {
    const d = buckets[i + 1] - buckets[i];
    score += d * d;
  }
  return score;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Estimate small-angle skew by maximising the variance of the horizontal
 * projection profile over candidate angles (coarse sweep then fine sweep).
 * Never throws: on any sharp failure returns { angleDeg: 0, confidence: 0, method: 'none' }.
 */
export async function detectSkewAngle(
  image: Buffer,
  opts: DeskewOptions = {},
): Promise<SkewDetection> {
  const started = Date.now();
  const maxAngleDeg = Math.abs(opts.maxAngleDeg ?? DEFAULT_MAX_ANGLE_DEG);
  const coarseStepDeg = Math.abs(opts.coarseStepDeg ?? DEFAULT_COARSE_STEP_DEG) || DEFAULT_COARSE_STEP_DEG;
  const fineStepDeg = Math.abs(opts.fineStepDeg ?? DEFAULT_FINE_STEP_DEG) || DEFAULT_FINE_STEP_DEG;
  const analysisWidthPx = Math.max(200, opts.analysisWidthPx ?? DEFAULT_ANALYSIS_WIDTH_PX);

  const none: SkewDetection = {
    angleDeg: 0,
    confidence: 0,
    method: 'none',
    elapsedMs: 0,
  };

  try {
    if (!image || image.length === 0) return { ...none, elapsedMs: Date.now() - started };

    const sample = await sampleInk(image, analysisWidthPx);
    if (!sample) return { ...none, elapsedMs: Date.now() - started };

    // Bucket space must hold every sheared y. The shear moves a point by at
    // most width·tan(maxAngle) in either direction.
    const pad = Math.ceil(sample.widthPx * Math.tan((maxAngleDeg * Math.PI) / 180)) + 2;
    const buckets = new Float64Array(sample.heightPx + 2 * pad + 1);

    const scoreAt = (deg: number) => profileScore(sample, deg, pad, buckets);

    // Coarse sweep across the whole range.
    const coarseScores: number[] = [];
    let bestAngle = 0;
    let bestScore = -Infinity;
    for (let a = -maxAngleDeg; a <= maxAngleDeg + 1e-9; a += coarseStepDeg) {
      const deg = Math.round(a * 1000) / 1000;
      const s = scoreAt(deg);
      coarseScores.push(s);
      if (s > bestScore) {
        bestScore = s;
        bestAngle = deg;
      }
    }

    // Fine sweep in the winning coarse bucket.
    const lo = Math.max(-maxAngleDeg, bestAngle - coarseStepDeg);
    const hi = Math.min(maxAngleDeg, bestAngle + coarseStepDeg);
    for (let a = lo; a <= hi + 1e-9; a += fineStepDeg) {
      const deg = Math.round(a * 1000) / 1000;
      const s = scoreAt(deg);
      if (s > bestScore) {
        bestScore = s;
        bestAngle = deg;
      }
    }

    const med = median(coarseScores);
    const denom = bestScore || 1;
    const confidence = Math.min(1, Math.max(0, (bestScore - med) / denom));

    return {
      angleDeg: Math.round(bestAngle * 100) / 100,
      confidence: Math.round(confidence * 10000) / 10000,
      method: 'projection_profile',
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    logger.warn(
      { err: (err as any)?.message ?? String(err) },
      'deskew: skew detection failed; treating page as square',
    );
    return { ...none, elapsedMs: Date.now() - started };
  }
}

/**
 * Detect and correct skew. Never throws — on failure returns the input bytes
 * with applied=false and a warning. Honours EXTRACT_DESKEW_ENABLED !== '0'.
 */
export async function deskewImage(
  image: Buffer,
  opts: DeskewOptions = {},
): Promise<DeskewResult> {
  const started = Date.now();
  const minAngleDeg = Math.abs(opts.minAngleDeg ?? DEFAULT_MIN_ANGLE_DEG);
  const background = opts.background ?? DEFAULT_BACKGROUND;

  const untouched = (
    warnings: string[],
    detection?: SkewDetection,
  ): DeskewResult => ({
    bytes: image,
    angleDeg: 0,
    detectedAngleDeg: detection?.angleDeg ?? 0,
    applied: false,
    confidence: detection?.confidence ?? 0,
    method: detection?.method ?? 'none',
    elapsedMs: Date.now() - started,
    warnings,
  });

  if (!deskewEnabled()) return untouched(['deskew_disabled']);
  if (!image || image.length === 0) return untouched(['deskew_empty_input']);

  try {
    const detection = await detectSkewAngle(image, opts);

    if (detection.method === 'none') return untouched([], detection);
    if (detection.confidence < MIN_CONFIDENCE) return untouched(['deskew_low_confidence'], detection);
    if (Math.abs(detection.angleDeg) < minAngleDeg) return untouched([], detection);

    const correction = -detection.angleDeg;
    const sharp = await loadSharp();
    const rotated: Buffer = await sharp(image).rotate(correction, { background }).toBuffer();

    logger.debug(
      {
        detected_deg: detection.angleDeg,
        correction_deg: correction,
        confidence: detection.confidence,
        elapsed_ms: Date.now() - started,
      },
      'deskew: applied small-angle correction',
    );

    return {
      bytes: rotated,
      angleDeg: correction,
      detectedAngleDeg: detection.angleDeg,
      applied: true,
      confidence: detection.confidence,
      method: detection.method,
      elapsedMs: Date.now() - started,
      warnings: [],
    };
  } catch (err) {
    logger.warn(
      { err: (err as any)?.message ?? String(err) },
      'deskew: correction failed; returning original bytes',
    );
    return untouched(['deskew_failed']);
  }
}
