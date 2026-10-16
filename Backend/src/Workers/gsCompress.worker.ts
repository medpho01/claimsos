import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs';

const execPromise = promisify(exec);

/**
 * PDF compression for claim documents.
 *
 * WHY THE CEILING IS NOT ONE NUMBER
 * The PM-JAY portal rejects uploads above 1 MB, so documents filed there have
 * to fit. No other insurer or TPA we file with imposes that limit, and every
 * one of them was being squeezed to the same 900 KB anyway — paying PM-JAY's
 * price without PM-JAY's reason.
 *
 * WHY THE LADDER STARTS GENTLE
 * Every rung used to be Ghostscript's `/screen` preset, which targets 72-dpi
 * on-screen viewing. The first attempt at a document was therefore already
 * near the bottom of the quality range, and the only way out was further down.
 *
 * These files are not read on screen and then discarded. They are OCR'd, run
 * through document extraction, and filed as the evidence behind a claim — and
 * a lot of them are faint dot-matrix bills and handwritten notes, the hardest
 * case for OCR there is. Resolution matters more than JPEG quality for that:
 * 150 dpi is roughly the floor at which small print survives, and 300 dpi is
 * comfortable.
 *
 * So the ladder now starts at near-lossless and stops at the FIRST rung that
 * fits. A document that fits at 300 dpi is stored at 300 dpi. Only a file that
 * refuses to fit is pushed down, and only as far as it has to go.
 */

/** PM-JAY's portal cap is 1 MB. Aim under it — the portal is not explicit
 *  about whether it means 1,000,000 or 1,048,576, and a rejected upload costs
 *  a round trip with the hospital. */
export const PMJAY_MAX_BYTES = 950_000;

/** Everything else. 2 MB with the same margin. */
export const STANDARD_MAX_BYTES = 1_900_000;

/**
 * Which ceiling applies, from a panel's `code`.
 *
 * Pure and exported so the decision is testable and lives in one place rather
 * than being re-derived at each upload path.
 */
export function isPmjayPanel(panelCode: string | null | undefined): boolean {
  return (panelCode ?? '').trim().toUpperCase() === 'PMJAY';
}

export function targetBytesForPanelCode(panelCode: string | null | undefined): number {
  return isPmjayPanel(panelCode) ? PMJAY_MAX_BYTES : STANDARD_MAX_BYTES;
}

interface Rung {
  preset: string;
  dpi: number;
  /** JPEG quality for the re-encoded images inside the PDF. */
  q: number;
}

/**
 * Gentlest first. The first rung that lands under the ceiling wins, so quality
 * is only ever given up to the extent the ceiling demands it.
 *
 * Everything down to and including the 150-dpi rung stays at or above the
 * resolution where small print survives OCR. Past that marker the rungs trade
 * legibility for size, and are only reachable under a HARD cap.
 */
const LADDER: Rung[] = [
  { preset: '/prepress', dpi: 300, q: 92 }, // effectively a re-wrap for most text PDFs
  { preset: '/ebook',    dpi: 300, q: 85 },
  { preset: '/ebook',    dpi: 200, q: 80 },
  { preset: '/ebook',    dpi: 150, q: 72 },
  { preset: '/screen',   dpi: 150, q: 60 }, // ── OCR floor ──
  { preset: '/screen',   dpi: 100, q: 45 },
  { preset: '/screen',   dpi: 72,  q: 40 },
  { preset: '/screen',   dpi: 45,  q: 30 },
  { preset: '/screen',   dpi: 30,  q: 30 }, // genuinely bad, but filable
];

/** Rungs at or above this index degrade past the OCR floor. */
const BELOW_OCR_FLOOR_FROM = 5;

/**
 * Compress `inputPath` to at most `targetBytes`, writing to `outputPath`.
 *
 * Returns the path the caller should use. A file already under the ceiling is
 * returned UNTOUCHED — re-encoding a document that does not need it is pure
 * quality loss, and the old code's 900 KB skip was the one part of this worth
 * keeping.
 */
export const compressWithGS = async (
  inputPath: string,
  outputPath: string,
  targetBytes: number = STANDARD_MAX_BYTES,
  /**
   * Whether the ceiling MUST be met.
   *
   * PM-JAY's portal rejects an oversized upload outright, so a document that
   * will not fit is a document that cannot be filed — there, a badly degraded
   * file beats no file, and the ladder is allowed past the OCR floor.
   *
   * Every other insurer's 2 MB is a target, not a gate. Nothing rejects a
   * larger file, so degrading a claim document past legibility to hit a number
   * nobody enforces is a straight loss. There the ladder stops at the floor and
   * keeps the best legible version, even if it is over.
   */
  hardCap: boolean = false,
): Promise<string> => {
  const gsCommand = os.platform() === 'win32' ? 'gswin64c' : 'gs';
  const absoluteInput = path.resolve(inputPath);
  const absoluteOutput = path.resolve(outputPath);

  if (!fs.existsSync(absoluteInput)) return absoluteInput;

  const originalSize = fs.statSync(absoluteInput).size;
  if (originalSize <= targetBytes) return absoluteInput;

  // Track the smallest result seen, so a file that never reaches the ceiling
  // still returns the best attempt rather than whichever rung happened to run
  // last.
  let best: { path: string; size: number } | null = null;

  const rungs = hardCap ? LADDER : LADDER.slice(0, BELOW_OCR_FLOOR_FROM);

  for (const rung of rungs) {
    const command = `${gsCommand} -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 \
      -dPDFSETTINGS=${rung.preset} -dNOPAUSE -dQUIET -dBATCH \
      -dColorImageResolution=${rung.dpi} -dGrayImageResolution=${rung.dpi} -dMonoImageResolution=${rung.dpi} \
      -dDownsampleColorImages=true -dDownsampleGrayImages=true -dDownsampleMonoImages=true \
      -dAutoFilterColorImages=false -dColorImageFilter=/DCTEncode \
      -dJPEGQ=${rung.q} \
      -dEmbedAllFonts=true -dSubsetFonts=true -dCompressFonts=true \
      -sOutputFile="${absoluteOutput}" "${absoluteInput}"`;

    try {
      await execPromise(command);
      if (!fs.existsSync(absoluteOutput)) continue;

      const size = fs.statSync(absoluteOutput).size;

      // First rung that fits is the highest quality that fits. Stop here.
      if (size <= targetBytes) return absoluteOutput;

      if (!best || size < best.size) best = { path: absoluteOutput, size };
    } catch (err) {
      console.error(`[gsCompress] rung ${rung.preset}@${rung.dpi} failed:`, err);
    }
  }

  // Nothing reached the ceiling. Hand back the smallest we managed, but only
  // if it actually beat the original — otherwise the caller would replace a
  // good file with a degraded one of the same size.
  //
  // The old code returned the output path unconditionally, even when every
  // Ghostscript invocation had failed and no such file existed.
  if (best && best.size < originalSize) {
    console.warn(
      `[gsCompress] could not reach ${targetBytes}B${hardCap ? ' (HARD CAP)' : ''}; ` +
      `returning best effort ${best.size}B (original ${originalSize}B)`,
    );
    return best.path;
  }

  // Nothing beat the original. Hand back the untouched file rather than
  // replacing it with a same-size, lower-quality copy.
  console.warn(
    `[gsCompress] no rung improved on ${originalSize}B; keeping the original` +
    `${hardCap ? ' — this file will be REJECTED by the PM-JAY portal' : ''}`,
  );
  return absoluteInput;
};
