/**
 * Perceptual hashing utilities — pHash (DCT-based) + dHash (gradient-based).
 * ─────────────────────────────────────────────────────────────────────────
 * Used to detect "same visual content embedded in different containers" —
 * e.g., the same Aadhar JPEG embedded inside three separate PDF uploads
 * that have different file-level sha256 and different OCR text (Tesseract
 * is non-deterministic across runs). The two previous dedup layers
 * (file sha256, OCR text-hash) miss this case; pHash + dHash catch it.
 *
 * Output: 256-bit hex strings (64 hex chars). 256-bit precision matches
 * the Python `imagehash` reference (hash_size=16) we validated against
 * Vahid's documents — 64-bit pHash (default in most JS libs) had too high
 * a false-positive rate on different X-rays of similar anatomy.
 *
 * Why both pHash AND dHash:
 *   - pHash (DCT of low-frequency coefficients) is robust to scale,
 *     compression, and minor color shifts. False positive pattern: blocky
 *     uniform regions can collide.
 *   - dHash (left-to-right pixel-gradient sign) is robust to brightness
 *     and contrast changes. False positive pattern: images with the same
 *     gradient direction but different content.
 *   - Requiring BOTH to match (Hamming ≤ 16 / 256 on each) cuts the
 *     individual false positive rates to near-zero in practice.
 *
 * Performance: each hash is ~30-50ms on a typical PDF page. The bundle
 * classifier already renders pages, so the marginal cost over the
 * existing pipeline is just the hash math — not the render.
 */

// sharp's CJS export shape requires either esModuleInterop OR a namespace
// import. The rest of the codebase doesn't enable esModuleInterop, so we
// use a namespace import + access default through it. Tested working
// against sharp 0.34.
import * as sharpNs from 'sharp';
const sharp: typeof import('sharp') = (sharpNs as any).default ?? (sharpNs as any);

/** Hash output is 16x16 = 256 bits → 64-char hex string. */
export const PHASH_SIZE = 16;
/** Default Hamming distance threshold for "same image" (≤ 6.25% bit diff). */
export const DEFAULT_HAMMING_THRESHOLD = 16;

// ─── pHash — DCT-based, robust to scale / compression ─────────────────────
//
// Algorithm (256-bit variant):
//   1. Resize to 4*PHASH_SIZE square, greyscale (so 64x64 for hash_size=16)
//   2. Compute 2-D DCT (we do a simple separable variant — slow but
//      correct)
//   3. Keep top-left PHASH_SIZE x PHASH_SIZE DCT coefficients (low-freq)
//   4. Compute median (excluding DC component at [0,0])
//   5. Bit string: each coefficient > median → 1, else 0
//   6. Pack into hex
//
// We do this in pure TS instead of pulling in a DCT npm dep — the matrix
// is small (16x16=256 coefficients on a 64x64 input) so even naive O(n²)
// DCT runs in a few ms.

/**
 * Compute the 256-bit perceptual hash of an image buffer.
 *
 * @param imageBuffer  raw image bytes (any sharp-supported format: PNG/JPEG/WEBP/TIFF/...)
 * @returns 64-char hex string
 */
export async function computePhash(imageBuffer: Buffer): Promise<string> {
  // 1. Downscale to 4N x 4N greyscale, raw pixels.
  const size = PHASH_SIZE * 4; // 64 for default
  const { data } = await sharp(imageBuffer)
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.cubic })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 2. Convert to 2-D float matrix.
  const m: number[][] = Array.from({ length: size }, () => new Array(size));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      m[y]![x] = data[y * size + x]!;
    }
  }

  // 3. 2-D DCT-II (separable). Cache the cosine basis for the columns we
  //    actually keep (only top-left PHASH_SIZE × PHASH_SIZE matters).
  const cosCache: number[][] = [];
  for (let k = 0; k < PHASH_SIZE; k++) {
    cosCache[k] = [];
    for (let n = 0; n < size; n++) {
      cosCache[k]![n] = Math.cos((Math.PI * (2 * n + 1) * k) / (2 * size));
    }
  }

  // Row DCT (we only need first PHASH_SIZE coefficients per row).
  const rowDct: number[][] = Array.from(
    { length: size },
    () => new Array(PHASH_SIZE).fill(0),
  );
  for (let y = 0; y < size; y++) {
    const row = m[y]!;
    for (let k = 0; k < PHASH_SIZE; k++) {
      let sum = 0;
      const cos = cosCache[k]!;
      for (let n = 0; n < size; n++) {
        sum += row[n]! * cos[n]!;
      }
      rowDct[y]![k] = sum;
    }
  }

  // Column DCT on the row-DCT'd matrix (again, only first PHASH_SIZE).
  const colDct: number[][] = Array.from(
    { length: PHASH_SIZE },
    () => new Array(PHASH_SIZE).fill(0),
  );
  for (let k = 0; k < PHASH_SIZE; k++) {
    const cos = cosCache[k]!;
    for (let j = 0; j < PHASH_SIZE; j++) {
      let sum = 0;
      for (let n = 0; n < size; n++) {
        sum += rowDct[n]![j]! * cos[n]!;
      }
      colDct[k]![j] = sum;
    }
  }

  // 4. Median of low-freq coefficients, excluding the DC (huge magnitude).
  const flat: number[] = [];
  for (let i = 0; i < PHASH_SIZE; i++) {
    for (let j = 0; j < PHASH_SIZE; j++) {
      if (i === 0 && j === 0) continue;
      flat.push(colDct[i]![j]!);
    }
  }
  flat.sort((a, b) => a - b);
  const median = flat[Math.floor(flat.length / 2)]!;

  // 5. Bit string.
  const bits: number[] = [];
  for (let i = 0; i < PHASH_SIZE; i++) {
    for (let j = 0; j < PHASH_SIZE; j++) {
      bits.push(colDct[i]![j]! > median ? 1 : 0);
    }
  }

  return bitsToHex(bits);
}

// ─── dHash — gradient-based, robust to brightness/contrast ────────────────
//
// Algorithm (256-bit variant):
//   1. Resize to (PHASH_SIZE+1) x PHASH_SIZE greyscale  (17x16 by default)
//   2. For each row, compare adjacent pixels: left > right → 1, else 0
//   3. Pack into hex

/**
 * Compute the 256-bit difference hash of an image buffer.
 *
 * @param imageBuffer  raw image bytes
 * @returns 64-char hex string
 */
export async function computeDhash(imageBuffer: Buffer): Promise<string> {
  const w = PHASH_SIZE + 1; // 17
  const h = PHASH_SIZE; // 16
  const { data } = await sharp(imageBuffer)
    .resize(w, h, { fit: 'fill', kernel: sharp.kernel.cubic })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bits: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const left = data[y * w + x]!;
      const right = data[y * w + x + 1]!;
      bits.push(left > right ? 1 : 0);
    }
  }
  return bitsToHex(bits);
}

// ─── Hamming distance ──────────────────────────────────────────────────────

/**
 * Hamming distance between two hex-encoded hashes of equal length.
 * Returns the number of differing bits (0..256 for 256-bit hashes).
 */
export function hammingDistance(hexA: string, hexB: string): number {
  if (hexA.length !== hexB.length) {
    throw new Error(
      `hammingDistance: length mismatch (${hexA.length} vs ${hexB.length})`,
    );
  }
  let dist = 0;
  for (let i = 0; i < hexA.length; i += 8) {
    // Compare 32-bit chunks (8 hex chars) for speed.
    const chunkA = parseInt(hexA.substr(i, 8), 16) >>> 0;
    const chunkB = parseInt(hexB.substr(i, 8), 16) >>> 0;
    let x = chunkA ^ chunkB;
    // Brian Kernighan popcount
    while (x) {
      x &= x - 1;
      dist++;
    }
  }
  return dist;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function bitsToHex(bits: number[]): string {
  // Pad to multiple of 4 (should already be 256 → 64 hex chars).
  while (bits.length % 4) bits.push(0);
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble =
      (bits[i]! << 3) | (bits[i + 1]! << 2) | (bits[i + 2]! << 1) | bits[i + 3]!;
    hex += nibble.toString(16);
  }
  return hex;
}
