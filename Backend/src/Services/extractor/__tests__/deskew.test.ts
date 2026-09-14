/**
 * Deskew tests — a real round trip through sharp, no network.
 *
 * Run: npx tsx --test src/Services/extractor/__tests__/deskew.test.ts
 *
 * The load-bearing assertion is the round trip: take a page of text-like
 * bars, tilt it by a known small angle, and check the detector recovers that
 * angle. A detector that is merely "plausible" is worse than none — it would
 * rotate clean pages for no reason — so the blank-page case (must NOT apply
 * a correction) is asserted just as hard.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectSkewAngle, deskewImage } from '../deskew.js';

// ── fixtures ────────────────────────────────────────────────────────────

async function sharpLib(): Promise<any> {
  const mod: any = await import('sharp');
  return mod?.default ?? mod;
}

/**
 * A page of "text": dark bars with word-like gaps, on white. Projection
 * profile of this is a sharp comb, which is exactly what real text produces.
 */
async function textLikePage(width = 1600, height = 1100): Promise<Buffer> {
  const sharp = await sharpLib();
  const marks: string[] = [];
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 80; y < height - 80; y += 46) {
    let x = 80;
    while (x < width - 120) {
      const w = 40 + Math.floor(rnd() * 160);
      marks.push(`<rect x="${x}" y="${y}" width="${w}" height="14" fill="#111111"/>`);
      x += w + 18 + Math.floor(rnd() * 14);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${marks.join('')}</svg>`;
  return sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
}

async function blankPage(width = 1200, height = 900): Promise<Buffer> {
  const sharp = await sharpLib();
  return sharp({
    create: { width, height, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
}

/** sharp.rotate() is CLOCKWISE for positive angles — see deskew.ts's header. */
async function rotateBy(bytes: Buffer, deg: number): Promise<Buffer> {
  const sharp = await sharpLib();
  return sharp(bytes).rotate(deg, { background: '#ffffff' }).png().toBuffer();
}

// ── detectSkewAngle ─────────────────────────────────────────────────────

describe('detectSkewAngle', () => {
  it('recovers a +1.2 degree clockwise tilt within 0.3 degrees', async () => {
    const tilted = await rotateBy(await textLikePage(), 1.2);
    const d = await detectSkewAngle(tilted);
    assert.equal(d.method, 'projection_profile');
    assert.ok(
      Math.abs(d.angleDeg - 1.2) <= 0.3,
      `expected ~+1.2 deg, got ${d.angleDeg} (confidence ${d.confidence})`,
    );
    assert.ok(d.confidence > 0.02, `confidence too low: ${d.confidence}`);
  });

  it('recovers a counter-clockwise tilt with the opposite sign', async () => {
    const tilted = await rotateBy(await textLikePage(), -2.1);
    const d = await detectSkewAngle(tilted);
    assert.ok(
      Math.abs(d.angleDeg + 2.1) <= 0.3,
      `expected ~-2.1 deg, got ${d.angleDeg} (confidence ${d.confidence})`,
    );
  });

  it('reports ~0 on a square page', async () => {
    const d = await detectSkewAngle(await textLikePage());
    assert.ok(Math.abs(d.angleDeg) <= 0.25, `expected ~0 deg, got ${d.angleDeg}`);
  });

  it('refuses to guess on a blank page', async () => {
    const d = await detectSkewAngle(await blankPage());
    assert.equal(d.method, 'none');
    assert.equal(d.angleDeg, 0);
    assert.equal(d.confidence, 0);
  });

  it('never throws on garbage bytes', async () => {
    const d = await detectSkewAngle(Buffer.from('not an image at all'));
    assert.equal(d.method, 'none');
    assert.equal(d.angleDeg, 0);
  });
});

// ── deskewImage ─────────────────────────────────────────────────────────

describe('deskewImage', () => {
  it('applies the NEGATIVE of the detected angle and squares the page up', async () => {
    const tilted = await rotateBy(await textLikePage(), 1.2);
    const res = await deskewImage(tilted);

    assert.equal(res.applied, true);
    assert.ok(Math.abs(res.detectedAngleDeg - 1.2) <= 0.3);
    assert.equal(res.angleDeg, -res.detectedAngleDeg, 'correction must be the negation');
    assert.notEqual(res.bytes, tilted, 'corrected bytes must be a new buffer');

    // The whole point: re-measuring the corrected page finds no skew left.
    const after = await detectSkewAngle(res.bytes);
    assert.ok(
      Math.abs(after.angleDeg) <= 0.3,
      `residual skew after correction: ${after.angleDeg} deg`,
    );
  });

  it('leaves a blank page untouched', async () => {
    const blank = await blankPage();
    const res = await deskewImage(blank);
    assert.equal(res.applied, false);
    assert.equal(res.angleDeg, 0);
    assert.equal(res.bytes, blank, 'must return the SAME buffer, not a re-encode');
  });

  it('leaves an already-square page untouched (below minAngleDeg)', async () => {
    const square = await textLikePage();
    const res = await deskewImage(square);
    assert.equal(res.applied, false);
    assert.equal(res.bytes, square);
  });

  it('honours EXTRACT_DESKEW_ENABLED=0', async () => {
    const tilted = await rotateBy(await textLikePage(), 1.2);
    const prev = process.env.EXTRACT_DESKEW_ENABLED;
    process.env.EXTRACT_DESKEW_ENABLED = '0';
    try {
      const res = await deskewImage(tilted);
      assert.equal(res.applied, false);
      assert.equal(res.bytes, tilted);
      assert.deepEqual(res.warnings, ['deskew_disabled']);
    } finally {
      if (prev === undefined) delete process.env.EXTRACT_DESKEW_ENABLED;
      else process.env.EXTRACT_DESKEW_ENABLED = prev;
    }
  });

  it('never throws on garbage bytes', async () => {
    const junk = Buffer.from('not an image at all');
    const res = await deskewImage(junk);
    assert.equal(res.applied, false);
    assert.equal(res.bytes, junk);
  });

  it('never throws on an empty buffer', async () => {
    const res = await deskewImage(Buffer.alloc(0));
    assert.equal(res.applied, false);
    assert.deepEqual(res.warnings, ['deskew_empty_input']);
  });
});
