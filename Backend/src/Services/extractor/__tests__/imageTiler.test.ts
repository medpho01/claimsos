/**
 * Tiler tests — pure geometry plus real sharp round-trips.
 *
 * Run: npx tsx --test src/Services/extractor/__tests__/imageTiler.test.ts
 *
 * NO network, NO LLM. planTiles, chooseViewportScale and effectiveScale are
 * pure functions, which is exactly why the tiling math lives in them rather
 * than inline in the render loop — the numbers that decide whether Anthropic
 * downscales our money column are the numbers most worth asserting on.
 *
 * The pivot these tests encode: the binding constraint is the ~1.15 MEGAPIXEL
 * area budget, NOT the 1568px long edge. Under the old edge-only model a
 * portrait page "could not gain from tiling" and was never cut; measured, that
 * rule was costing ~7pp of accuracy on a dense A4. Several assertions below
 * therefore invert what the previous suite asserted, and say why.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANTHROPIC_MAX_EDGE_PX,
  ANTHROPIC_MAX_IMAGE_PIXELS,
  chooseViewportScale,
  describeTiling,
  effectiveScale,
  planTiles,
  tileImage,
  toLlmAttachments,
} from '../imageTiler.js';

// ── fixture helpers ─────────────────────────────────────────────────────

/**
 * A synthetic "table": horizontal dark bars on white. Enough structure for
 * sharp to crop and for deskew to have something to measure, cheap enough to
 * build in a unit test.
 */
async function barsImage(width = 3400, height = 1400): Promise<Buffer> {
  const sharpMod: any = await import('sharp');
  const sharp = sharpMod?.default ?? sharpMod;
  const bars: string[] = [];
  for (let y = 60; y < height - 60; y += 70) {
    bars.push(`<rect x="40" y="${y}" width="${width - 80}" height="22" fill="#111111"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${bars.join('')}</svg>`;
  return sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
}

/**
 * The same bars, written as a JPEG carrying an EXIF Orientation tag. This is
 * what a phone hands us: the sensor stores the frame landscape and the tag
 * says "turn it upright". Orientation 6 = rotate 90° clockwise to display.
 */
async function exifRotatedImage(
  width = 1800,
  height = 1200,
  orientation = 6,
): Promise<Buffer> {
  const sharpMod: any = await import('sharp');
  const sharp = sharpMod?.default ?? sharpMod;
  const base = await barsImage(width, height);
  return sharp(base).jpeg({ quality: 95 }).withMetadata({ orientation }).toBuffer();
}

async function sizeOf(buf: Buffer): Promise<{ width: number; height: number; orientation?: number }> {
  const sharpMod: any = await import('sharp');
  const sharp = sharpMod?.default ?? sharpMod;
  const m = await sharp(buf).metadata();
  return { width: Number(m.width ?? 0), height: Number(m.height ?? 0), orientation: m.orientation };
}

// ── effectiveScale ──────────────────────────────────────────────────────

describe('effectiveScale', () => {
  it('reproduces the measured count_tokens squeezes — area, not long edge', () => {
    // Every one of these is at or under the 1568px long edge, so the old
    // edge-only model said "no downscale". The API says otherwise.
    assert.ok(Math.abs(effectiveScale(1176, 1568) - 0.79) < 0.01, `${effectiveScale(1176, 1568)}`);
    assert.ok(Math.abs(effectiveScale(1278, 1459) - 0.785) < 0.01, `${effectiveScale(1278, 1459)}`);
    assert.ok(Math.abs(effectiveScale(1135, 1568) - 0.81) < 0.02, `${effectiveScale(1135, 1568)}`);

    // The shipped LANDSCAPE tile is downscaled too — landscape only reaches
    // 100% because a short page has resolution to spare.
    assert.ok(effectiveScale(1269, 1400) < 0.81);
  });

  it('leaves an image inside the budget completely alone', () => {
    // 610x1568 = 0.96MP: under the area budget and under the edge ceiling.
    assert.equal(effectiveScale(610, 1568), 1);
    assert.equal(effectiveScale(400, 400), 1, 'we never upscale');
  });

  it('is the tighter of the edge cap and the area cap', () => {
    // A long thin strip is edge-limited, not area-limited.
    assert.ok(Math.abs(effectiveScale(200, 6000) - 1568 / 6000) < 1e-9);
    // A near-square page is area-limited well before the edge bites.
    const s = effectiveScale(1500, 1500);
    assert.ok(Math.abs(s - Math.sqrt(ANTHROPIC_MAX_IMAGE_PIXELS / (1500 * 1500))) < 1e-9);
    assert.ok(s < 1568 / 1500);
  });

  it('honours an overridden budget', () => {
    assert.equal(effectiveScale(2000, 2000, { maxImagePixels: 4_000_000, maxEdgePx: 4000 }), 1);
  });
});

// ── chooseViewportScale ─────────────────────────────────────────────────

describe('chooseViewportScale', () => {
  it('targets the SHORT edge at 1500px for a landscape A4', () => {
    // 842x595pt landscape. 1500/595 = 2.521 — well above the fixed 2.0 the
    // old code used, and it is the ROWS (short edge) being resolved.
    const d = chooseViewportScale(842, 595);
    assert.equal(d.isWide, true);
    assert.ok(Math.abs(d.scale - 2.521) < 0.01, `expected ~2.52, got ${d.scale}`);
    assert.ok(Math.abs(d.expectedHeightPx - 1500) <= 2, `short edge ${d.expectedHeightPx}`);
  });

  it('now targets the SHORT edge on a PORTRAIT A4 too', () => {
    // The old rule pinned a portrait page's LONG edge to 1568, rendering
    // 1108x1568 — which capped what any tiling plan could recover, because a
    // band of that render tops out at 1108 effective px of width. At 1500x2123
    // the same page bands to ~1476. Same page, a third more resolution on the
    // money column, for one cheap render.
    const d = chooseViewportScale(595, 842);
    assert.equal(d.isWide, false);
    assert.ok(Math.abs(d.expectedWidthPx - 1500) <= 2, `short edge ${d.expectedWidthPx}`);
    assert.ok(d.expectedHeightPx > ANTHROPIC_MAX_EDGE_PX, 'deliberately past the old ceiling');

    const bands = planTiles(d.expectedWidthPx, d.expectedHeightPx);
    const old = planTiles(1108, 1568);
    assert.ok(
      bands.effectiveTileScale * bands.tileWidthPx > old.effectiveTileScale * old.tileWidthPx,
      'the new render must leave the tiler more to spend, not less',
    );
  });

  it('clamps to [minScale, maxScale] and survives a corrupt page size', () => {
    // A huge poster-size page would otherwise ask for a sub-1 scale.
    const big = chooseViewportScale(4000, 3000);
    assert.equal(big.scale, 1.5);
    // pdf-lib reporting 0 must not produce NaN — fall back to A4 portrait.
    const broken = chooseViewportScale(0, 0);
    assert.ok(Number.isFinite(broken.scale) && broken.scale > 0);
    assert.equal(broken.isWide, false);
  });

  it('clamps the LONG edge so a freak aspect ratio cannot render a poster', () => {
    // 200x3000pt: a short-edge-only rule would ask for 7.5x and render
    // 1500x22500. The long-edge clamp holds it to 5000px.
    const d = chooseViewportScale(200, 3000, { maxRenderLongEdgePx: 5000 });
    assert.ok(d.expectedHeightPx <= 5001, `long edge ${d.expectedHeightPx}`);
  });
});

// ── planTiles: the proven landscape path must not move ───────────────────

describe('planTiles — landscape (the proven 100% path)', () => {
  it('splits a 3400x1400 bill into 3 overlapping vertical tiles', () => {
    const plan = planTiles(3400, 1400);
    assert.equal(plan.isWide, true);
    assert.equal(plan.axis, 'x', 'a wide bill is cut into column strips');
    assert.equal(plan.tileCount, 3);
    assert.equal(plan.tileScale, 1, 'tiles are emitted at native resolution');

    // tileWidth = 3400 / (3 - 0.16*2) = 1268.66
    assert.ok(Math.abs(plan.tileWidthPx - 1268.66) < 1, `tileWidth ${plan.tileWidthPx}`);
    assert.ok(Math.abs(plan.overlapPx - 202.99) < 1, `overlap ${plan.overlapPx}`);

    for (const [left, right] of plan.windows) {
      assert.ok(right - left <= ANTHROPIC_MAX_EDGE_PX, `tile width ${right - left} breaches ceiling`);
      assert.ok(left >= 0 && right <= 3400);
    }

    // Adjacent tiles really do overlap by ~16% of a tile.
    for (let i = 1; i < plan.windows.length; i++) {
      const overlap = plan.windows[i - 1][1] - plan.windows[i][0];
      assert.ok(Math.abs(overlap - plan.overlapPx) < 2, `gap/overlap between ${i - 1} and ${i}: ${overlap}`);
    }
  });

  it('stops at 3 tiles: the 4th buys 15%, under the 20% marginal floor', () => {
    // THE KNIFE EDGE. On a page limited purely by area, going from n to n+1
    // tiles multiplies effective scale by sqrt((n+1-0.16n)/(n-0.16(n-1))):
    // 1.207 for 2→3 (accepted) and 1.146 for 3→4 (rejected). The 1.2 marginal
    // floor sits between them ON PURPOSE. If you retune overlapRatio or
    // marginalTileGain and this test fails, you have either started shredding
    // the proven landscape plan into 4 tiles or stopped banding dense portrait
    // pages at 3 — read the module docblock before "fixing" it.
    const plan = planTiles(3400, 1400);
    assert.equal(plan.tileCount, 3);

    const fourth = effectiveScale(3400 / (4 - 0.16 * 3), 1400);
    assert.ok(fourth > plan.effectiveTileScale, 'a 4th tile IS sharper…');
    assert.ok(fourth / plan.effectiveTileScale < 1.2, '…but not by enough to pay for it');
  });

  it('reports the real effective gain, not the edge-only fiction', () => {
    const plan = planTiles(3400, 1400);
    // Old model: tileScale 1 vs untiled 1568/3400 = 0.46 → a "2.2x gain".
    // Real model: the tile is squeezed to 0.805 and the page to 0.461.
    assert.ok(Math.abs(plan.effectiveTileScale - 0.805) < 0.01, `${plan.effectiveTileScale}`);
    assert.ok(Math.abs(plan.effectiveUntiledScale - 0.461) < 0.01, `${plan.effectiveUntiledScale}`);
    assert.ok(Math.abs(plan.effectiveGain - 1.745) < 0.02, `${plan.effectiveGain}`);
  });

  it('keeps the 3424x1459 variant on exactly the shipped geometry', () => {
    const plan = planTiles(3424, 1459);
    assert.equal(plan.axis, 'x');
    assert.equal(plan.tileCount, 3);
    assert.equal(plan.tileScale, 1);
    // The tile the briefing measured at 0.785: 1278x1459.
    assert.ok(Math.abs(plan.tileWidthPx - 1277.6) < 1, `${plan.tileWidthPx}`);
    assert.ok(Math.abs(plan.effectiveTileScale - 0.785) < 0.01, `${plan.effectiveTileScale}`);
  });

  it('still tiles a landscape phone photo, and sharper than one fitted image', () => {
    const photo = planTiles(4032, 3024);
    assert.equal(photo.axis, 'x');
    assert.ok(photo.effectiveTileScale > photo.effectiveUntiledScale * 1.1);
    assert.ok(photo.effectiveGain > 1.5, `gain ${photo.effectiveGain}`);
  });

  it('never emits a short final tile', () => {
    // A short last tile would clip the rightmost money column — the single
    // most valuable column on an itemised bill.
    for (const w of [2600, 3000, 3400, 3777, 4096]) {
      const plan = planTiles(w, 1400);
      assert.equal(plan.axis, 'x', `width ${w}: expected column strips`);
      const widths = plan.windows.map(([l, r]) => r - l);
      const first = widths[0];
      for (const width of widths) {
        assert.ok(Math.abs(width - first) <= 1, `width ${w}: uneven tiles ${widths.join(',')}`);
      }
      assert.equal(plan.windows[plan.windows.length - 1][1], w, `width ${w}: last tile must reach the right edge`);
      assert.equal(plan.windows[0][0], 0, `width ${w}: first tile must start at 0`);
    }
  });

  it('falls back to a safety downscale when even maxTiles cannot clear the ceiling', () => {
    // 12000px wide: 4 tiles at r=0.16 are 3409px each — still over 1568.
    const plan = planTiles(12000, 1400);
    assert.equal(plan.tileCount, 4, 'capped by maxTiles');
    assert.ok(plan.tileScale < 1, `expected a safety downscale, got ${plan.tileScale}`);
    assert.ok(plan.warnings.includes('tile_downscaled'));
    assert.ok(plan.tileWidthPx * plan.tileScale <= ANTHROPIC_MAX_EDGE_PX + 1);
  });

  it('downscales when the tile HEIGHT would breach the ceiling', () => {
    // A tall wide page: column strips are full-page-height, so height is the
    // axis that trips the resize.
    const plan = planTiles(3400, 2400);
    assert.equal(plan.axis, 'x');
    assert.ok(plan.tileScale < 1, `expected a height downscale, got ${plan.tileScale}`);
    assert.ok(plan.warnings.includes('tile_height_downscaled'));
    assert.ok(2400 * plan.tileScale <= ANTHROPIC_MAX_EDGE_PX + 1);
  });

  it('computes an overview scale that fits the long edge under the ceiling', () => {
    const plan = planTiles(3400, 1400);
    assert.ok(Math.abs(3400 * plan.overviewScale - ANTHROPIC_MAX_EDGE_PX) < 2);
  });
});

// ── planTiles: portrait, the ~7pp that was being left on the table ───────

describe('planTiles — portrait (the MP-aware fix)', () => {
  it('BANDS a 40-row A4 portrait that the old orientation rule refused to tile', () => {
    // 2541x3551 is the page measured at 88.46% — below the 99% floor — because
    // "don't tile portrait" sent it as one image squeezed by 0.357. It is not
    // wide, it never will be, and it still has a 1.6x resolution gain sitting
    // in it.
    const plan = planTiles(2541, 3551);
    assert.equal(plan.isWide, true, 'isWide now means "was tiled", and it must be');
    assert.equal(plan.axis, 'y', 'a tall page gains from ROW BANDS, not column strips');
    assert.equal(plan.tileCount, 3);
    assert.ok(Math.abs(plan.effectiveUntiledScale - 0.357) < 0.005, `${plan.effectiveUntiledScale}`);
    assert.ok(plan.effectiveGain > 1.6, `gain ${plan.effectiveGain}`);
    assert.ok(plan.warnings.includes('tile_row_bands'));

    // Bands are the FULL page width; only the row axis is cut.
    assert.equal(plan.tileWidthPx, 2541);
    assert.ok(plan.tileHeightPx < 1400, `band height ${plan.tileHeightPx}`);

    // Windows walk top to bottom, overlap, and cover the page exactly.
    assert.equal(plan.windows[0][0], 0);
    assert.equal(plan.windows[plan.windows.length - 1][1], 3551);
    for (let i = 1; i < plan.windows.length; i++) {
      assert.ok(plan.windows[i][0] > plan.windows[i - 1][0], 'bands must ascend');
      assert.ok(plan.windows[i][0] < plan.windows[i - 1][1], 'adjacent bands must overlap');
      const overlap = plan.windows[i - 1][1] - plan.windows[i][0];
      assert.ok(Math.abs(overlap - plan.overlapPx) < 2, `overlap ${overlap} vs ${plan.overlapPx}`);
    }
  });

  it('beats the vertical-strip emulation it replaces', () => {
    // The pre-fix emulation cut the same page into 610x1568 strips and scored
    // 95.31% against the shipped 88.46%. Row bands carry ~32% more linear
    // resolution than those strips, and the strips are now rejected outright
    // as slivers.
    const bands = planTiles(2541, 3551);
    const strips = planTiles(2541, 3551, { tileAxis: 'x' });
    assert.equal(strips.tileCount, 0, 'column strips of an A4 are slivers');
    assert.ok(strips.warnings.includes('tile_no_resolution_gain'));

    const stripEffective = effectiveScale(2541 / (2 - 0.16), 3551);
    assert.ok(
      bands.effectiveTileScale > stripEffective * 1.25,
      `bands ${bands.effectiveTileScale} vs strips ${stripEffective}`,
    );
  });

  it('bands an A4 300dpi scan too', () => {
    const a4 = planTiles(2480, 3508);
    assert.equal(a4.axis, 'y');
    assert.equal(a4.tileCount, 3);
    assert.ok(a4.effectiveGain > 1.6);
  });

  it('does NOT shred a 3024x4032 phone photo into useless slivers', () => {
    // The old suite asserted this page must never be tiled. That was the right
    // instinct against the WRONG plan: four 859px column strips reach the model
    // 334px wide — unreadable in every one of them. The anti-sliver floor kills
    // exactly that plan. What the page does get is full-width row bands, which
    // is a real 1.6x gain and not a sliver in any dimension.
    const slivers = planTiles(3024, 4032, { tileAxis: 'x' });
    assert.equal(slivers.tileCount, 0, 'column strips of a portrait photo are slivers');
    assert.ok(slivers.warnings.includes('tile_no_resolution_gain'));

    const plan = planTiles(3024, 4032);
    assert.equal(plan.axis, 'y');
    assert.equal(plan.tileWidthPx, 3024, 'bands keep the full page width');
    assert.ok(plan.tileCount <= 4, 'tile count stays capped');
    assert.ok(plan.effectiveCutEdgePx >= 700, `cut edge ${plan.effectiveCutEdgePx} is a sliver`);
    assert.ok(plan.effectiveGain > 1.5);
  });

  it('enforces the minimum effective cut edge on every plan it emits', () => {
    for (const [w, h] of [
      [3400, 1400],
      [2541, 3551],
      [3024, 4032],
      [4032, 3024],
      [12000, 1400],
      [3400, 2400],
      [600, 4000],
    ] as Array<[number, number]>) {
      const plan = planTiles(w, h);
      if (plan.tileCount === 0) continue;
      assert.ok(
        plan.effectiveCutEdgePx >= 700,
        `${w}x${h}: cut edge ${plan.effectiveCutEdgePx} below the sliver floor`,
      );
    }
  });

  it('bands a narrow tall receipt rather than refusing over the width floor', () => {
    // 600px wide: no absolute-width trigger would ever fire, and the page is
    // still squeezed to 0.39 as one image.
    const plan = planTiles(600, 4000);
    assert.equal(plan.axis, 'y');
    assert.ok(plan.effectiveGain > 2, `gain ${plan.effectiveGain}`);
  });
});

// ── planTiles: the guards ───────────────────────────────────────────────

describe('planTiles — guards', () => {
  it('does not tile a page that is already inside the megapixel budget', () => {
    // 900x1200 = 1.08MP. Its untiled effective scale is 1, so no tile can
    // possibly be sharper — the math self-guards, no pixel trigger needed.
    const plan = planTiles(900, 1200);
    assert.equal(plan.isWide, false);
    assert.equal(plan.axis, 'none');
    assert.equal(plan.tileCount, 0);
    assert.deepEqual(plan.windows, []);
    assert.equal(plan.tileScale, 1);
    assert.equal(plan.effectiveUntiledScale, 1);
    assert.ok(plan.warnings.includes('tile_no_resolution_gain'));
  });

  it('respects an explicitly raised gain floor', () => {
    // 1700x1300 gains 1.36x from two column strips — genuinely worth it under
    // the real model (the old edge-only model scored this at 1.08 and refused).
    const tiled = planTiles(1700, 1300);
    assert.equal(tiled.tileCount, 2);
    assert.ok(Math.abs(tiled.effectiveGain - 1.357) < 0.02, `${tiled.effectiveGain}`);

    // Ask for 1.5x and the same page is not worth cutting.
    const strict = planTiles(1700, 1300, { minTileResolutionGain: 1.5 });
    assert.equal(strict.tileCount, 0);
    assert.ok(strict.warnings.includes('tile_no_resolution_gain'));
  });

  it('honours maxTiles as a hard cap', () => {
    const two = planTiles(12000, 1400, { maxTiles: 2 });
    assert.equal(two.tileCount, 2);
    assert.equal(two.windows.length, 2);
  });

  it('breaks a near-tie by cutting the LONG edge', () => {
    // 1800x1600: both axes measure within 1% of each other. Cutting the long
    // edge leaves tiles closer to square.
    const wide = planTiles(1800, 1600);
    assert.equal(wide.axis, 'x');
    const tall = planTiles(1600, 1800);
    assert.equal(tall.axis, 'y');
  });

  it('lets a caller force an axis', () => {
    // 1800x1600 picks column strips on its own; forced the other way it still
    // finds a legitimate band plan, just a slightly duller one.
    assert.equal(planTiles(1800, 1600).axis, 'x');
    const forced = planTiles(1800, 1600, { tileAxis: 'y' });
    assert.equal(forced.axis, 'y');
    assert.equal(forced.tileWidthPx, 1800, 'bands keep the full width');
    assert.ok(forced.effectiveGain > 1.1);
  });

  it('finds NO band plan for a wide page — the page width pins the edge scale', () => {
    // Cutting rows off a 3400px-wide page leaves every band 3400px wide, so the
    // 1568px edge cap holds the scale at exactly the untiled 0.461 no matter how
    // many bands you make. Zero gain, N times the images. The gain guard sees
    // that without being told anything about orientation.
    const forced = planTiles(3400, 1400, { tileAxis: 'y' });
    assert.equal(forced.axis, 'none');
    assert.equal(forced.tileCount, 0);
    assert.ok(forced.warnings.includes('tile_no_resolution_gain'));
    assert.ok(
      Math.abs(effectiveScale(3400, 1400 / 1.84) - forced.effectiveUntiledScale) < 0.001,
      'a band of a wide page is no sharper than the whole page',
    );
  });
});

// ── tileImage (real sharp) ──────────────────────────────────────────────

describe('tileImage', () => {
  it('emits the overview first, then tiles left to right, with correct metadata', async () => {
    const src = await barsImage(3400, 1400);
    const page = await tileImage(src, 3, { deskew: false });

    assert.equal(page.geometry.pageNumber, 3);
    assert.equal(page.geometry.isWide, true);
    assert.equal(page.geometry.renderScale, 1, 'a source image is not re-rendered');
    assert.equal(page.geometry.deskewAngleDeg, null, 'deskew was disabled');
    assert.equal(page.images.length, 4, 'overview + 3 tiles');

    const [overview, ...tiles] = page.images;
    assert.equal(overview.role, 'overview');
    assert.equal(overview.tileIndex, 0);
    assert.equal(overview.tileCount, 3);
    assert.equal(overview.tileAxis, 'none');
    assert.deepEqual([...overview.xRange], [0, 3400]);
    assert.ok(
      Math.max(overview.widthPx, overview.heightPx) <= ANTHROPIC_MAX_EDGE_PX,
      'overview must fit under the ceiling',
    );

    tiles.forEach((t, i) => {
      assert.equal(t.role, 'tile');
      assert.equal(t.tileAxis, 'x');
      assert.equal(t.tileIndex, i, 'tiles must be in left-to-right order');
      assert.equal(t.tileCount, 3);
      assert.equal(t.pageNumber, 3);
      assert.equal(t.mime, 'image/jpeg');
      assert.equal(t.sourceWidthPx, 3400);
      assert.equal(t.sourceHeightPx, 1400);
      assert.deepEqual([...t.yRange], [0, 1400], 'a column strip is full page height');
      assert.ok(t.data.length > 0);
      assert.ok(
        Math.max(t.widthPx, t.heightPx) <= ANTHROPIC_MAX_EDGE_PX,
        `tile ${i} is ${t.widthPx}x${t.heightPx} — over the edge ceiling`,
      );
      assert.equal(t.xRange[1] - t.xRange[0], t.widthPx, 'no safety downscale expected here');
    });

    // Tiles ascend and together cover the whole page.
    assert.equal(tiles[0].xRange[0], 0);
    assert.equal(tiles[tiles.length - 1].xRange[1], 3400);
    for (let i = 1; i < tiles.length; i++) {
      assert.ok(tiles[i].xRange[0] > tiles[i - 1].xRange[0]);
      assert.ok(tiles[i].xRange[0] < tiles[i - 1].xRange[1], 'adjacent tiles must overlap');
    }

    // DELIBERATE: these tiles are over the area budget (1269x1400 = 1.78MP) and
    // Anthropic applies the remaining squeeze itself. That is byte-for-byte the
    // path that measured 100.00%, so we do not pre-resample it.
    assert.ok(tiles[0].widthPx * tiles[0].heightPx > ANTHROPIC_MAX_IMAGE_PIXELS);
  });

  it('emits full-width ROW BANDS for a dense portrait page', async () => {
    const src = await barsImage(1600, 2400);
    const page = await tileImage(src, 2, { deskew: false });

    assert.equal(page.geometry.isWide, true, 'a banded page reports as tiled');
    assert.equal(page.images.length, 4, 'overview + 3 bands');
    assert.ok(page.warnings.includes('tile_row_bands'));

    const bands = page.images.filter((i) => i.role === 'tile');
    assert.equal(bands.length, 3);
    bands.forEach((b, i) => {
      assert.equal(b.tileAxis, 'y');
      assert.equal(b.tileIndex, i, 'bands must be in top-to-bottom order');
      assert.deepEqual([...b.xRange], [0, 1600], 'a band is the full page width');
      assert.ok(b.widthPx > b.heightPx, 'a band is wider than it is tall');
      assert.ok(Math.max(b.widthPx, b.heightPx) <= ANTHROPIC_MAX_EDGE_PX);
      // Because the edge ceiling forced a resize anyway, we resampled ONCE,
      // straight to the size the model will see — no second squeeze inside the
      // API, no double blur.
      assert.ok(
        b.widthPx * b.heightPx <= ANTHROPIC_MAX_IMAGE_PIXELS,
        `band ${i} is ${b.widthPx}x${b.heightPx} — the API would resample it again`,
      );
    });

    assert.equal(bands[0].yRange[0], 0);
    assert.equal(bands[bands.length - 1].yRange[1], 2400);
    for (let i = 1; i < bands.length; i++) {
      assert.ok(bands[i].yRange[0] > bands[i - 1].yRange[0]);
      assert.ok(bands[i].yRange[0] < bands[i - 1].yRange[1], 'adjacent bands must overlap');
    }
  });

  it('emits a single fitted image for a page inside the budget', async () => {
    const src = await barsImage(900, 1200);
    const page = await tileImage(src, 1, { deskew: false });
    assert.equal(page.geometry.isWide, false);
    assert.equal(page.images.length, 1);
    assert.equal(page.images[0].role, 'overview');
    assert.equal(page.images[0].tileCount, 0);
    assert.equal(page.images[0].tileAxis, 'none');
    assert.ok(Math.max(page.images[0].widthPx, page.images[0].heightPx) <= ANTHROPIC_MAX_EDGE_PX);
    assert.ok(page.warnings.includes('tile_no_resolution_gain'));
  });

  it('applies EXIF orientation before measuring, deskewing or tiling', async () => {
    // Stored 1800x1200 (landscape on the sensor) with Orientation=6, which
    // means the upright page is 1200x1800 — PORTRAIT. If the tag is dropped,
    // every dimension downstream is wrong and the page is read sideways.
    const src = await exifRotatedImage(1800, 1200, 6);
    const page = await tileImage(src, 1, { deskew: false });

    assert.equal(page.geometry.widthPx, 1200, 'EXIF orientation must be applied before metadata');
    assert.equal(page.geometry.heightPx, 1800);
    assert.ok(page.warnings.includes('exif_orientation_applied'));
    // And having been measured upright, it is banded — not sliced as if it
    // were the 1800x1200 landscape page the file claims to be.
    assert.equal(page.images.filter((i) => i.role === 'tile')[0]?.tileAxis, 'y');
  });

  it('keeps the EXIF fix on the tile_failed fallback path', async () => {
    // THE LEAK THIS TEST EXISTS FOR: both fallback paths used to return the
    // ORIGINAL source bytes, so a phone photo that auto-oriented and then
    // tripped a later failure was sent to the model sideways again.
    // An invalid jpegQuality survives the EXIF re-encode (which clamps to >=95)
    // and then throws inside the tile/fit encode — exactly the shape of a
    // late failure after a successful orientation.
    const src = await exifRotatedImage(1800, 1200, 6);
    const before = await sizeOf(src);
    assert.equal(before.width, 1800, 'the stored frame really is landscape-on-sensor');
    assert.equal(before.orientation, 6);

    const page = await tileImage(src, 4, { deskew: false, jpegQuality: -5 });
    assert.ok(page.warnings.includes('exif_orientation_applied'));
    assert.ok(page.warnings.includes('tile_failed'), `warnings: ${page.warnings.join(',')}`);
    assert.equal(page.images.length, 1);
    assert.equal(page.images[0].pageNumber, 4);

    const out = await sizeOf(page.images[0].data);
    assert.equal(out.width, 1200, 'the fallback must carry the UPRIGHT bytes, not the source');
    assert.equal(out.height, 1800);
    assert.ok(!out.orientation || out.orientation === 1, 'and they must need no further rotation');
  });

  it('leaves an image with no EXIF orientation untouched and unwarned', async () => {
    const src = await barsImage(3400, 1400);
    const page = await tileImage(src, 1, { deskew: false });
    assert.equal(page.geometry.widthPx, 3400);
    assert.equal(page.geometry.heightPx, 1400);
    assert.ok(!page.warnings.includes('exif_orientation_applied'));
  });

  it('honours disableTiling by sending one fitted image', async () => {
    const src = await barsImage(3400, 1400);
    const page = await tileImage(src, 1, { deskew: false, disableTiling: true });
    assert.equal(page.images.length, 1);
    assert.equal(page.geometry.isWide, false);
    assert.ok(page.warnings.includes('tiling_disabled'));
  });

  it('never throws on a corrupt buffer — returns the bytes with a warning', async () => {
    const page = await tileImage(Buffer.from('this is not an image'), 2, { deskew: false });
    assert.equal(page.images.length, 1);
    assert.equal(page.geometry.pageNumber, 2);
    assert.ok(page.warnings.includes('tile_failed') || page.warnings.includes('tile_metadata_unavailable'));
  });

  it('never throws on an empty buffer', async () => {
    const page = await tileImage(Buffer.alloc(0), 1);
    assert.equal(page.images.length, 1);
    assert.ok(page.warnings.includes('tile_empty_source'));
  });
});

// ── bridge + prompt helpers ─────────────────────────────────────────────

describe('toLlmAttachments / describeTiling', () => {
  it('flattens pages into attachments in send order', async () => {
    const src = await barsImage(3400, 1400);
    const page = await tileImage(src, 1, { deskew: false });
    const atts = toLlmAttachments(page);
    assert.equal(atts.length, page.images.length);
    atts.forEach((a, i) => {
      assert.equal(a.kind, 'image');
      assert.equal(a.mime, page.images[i].mime);
      assert.ok(Buffer.isBuffer(a.data));
    });
    // Array form must match the single-page form.
    assert.equal(toLlmAttachments([page]).length, atts.length);
  });

  it('describes VERTICAL slices with the same-rows merge rule', async () => {
    const src = await barsImage(3400, 1400);
    const page = await tileImage(src, 1, { deskew: false });
    const text = describeTiling(page);
    assert.match(text, /WIDE table \(3400x1400px\)/);
    assert.match(text, /DOWNSCALED OVERVIEW/);
    assert.match(text, /OVERLAPPING VERTICAL slices/);
    assert.match(text, /16%/);
    assert.match(text, /exactly once/i);
    assert.match(text, /SAME rows in the SAME top-to-bottom order/);
    assert.doesNotMatch(text, /HORIZONTAL bands/);
  });

  it('describes HORIZONTAL bands with the concatenate-and-reuse-headers rule', async () => {
    // Telling a model that row bands "all show the same rows" would make it
    // duplicate or drop half the table — the merge rule MUST follow the axis.
    const src = await barsImage(1600, 2400);
    const page = await tileImage(src, 1, { deskew: false });
    const text = describeTiling(page);
    assert.match(text, /TALL page \(1600x2400px\)/);
    assert.match(text, /OVERLAPPING HORIZONTAL bands/);
    assert.match(text, /FULL WIDTH/);
    assert.match(text, /FIRST band shows the column headers/);
    assert.match(text, /exactly once/i);
    assert.doesNotMatch(text, /SAME rows in the SAME top-to-bottom order/);
  });

  it('carries both merge rules when a document mixes axes', async () => {
    const wide = await tileImage(await barsImage(3400, 1400), 1, { deskew: false });
    const tall = await tileImage(await barsImage(1600, 2400), 2, { deskew: false });
    const text = describeTiling([wide, tall]);
    assert.match(text, /VERTICAL slices/);
    assert.match(text, /HORIZONTAL bands/);
    assert.match(text, /For the VERTICAL slices:/);
    assert.match(text, /For the HORIZONTAL bands:/);
  });

  it('says "whole-page image" when nothing was tiled', async () => {
    const src = await barsImage(900, 1200);
    const page = await tileImage(src, 1, { deskew: false });
    const text = describeTiling(page);
    assert.match(text, /whole-page image/);
    assert.doesNotMatch(text, /OVERLAPPING/);
  });

  it('defaults an axis-less VisionImage to vertical slices', () => {
    // Callers built against the pre-row-band shape (docExtractor's tests, for
    // one) hand us tiles with no tileAxis. They were all column strips.
    const page: any = {
      geometry: { pageNumber: 1, widthPx: 3400, heightPx: 1400, aspectRatio: 2.43, isWide: true, renderScale: 1, deskewAngleDeg: null },
      images: [
        { data: Buffer.alloc(1), mime: 'image/jpeg', role: 'overview', pageNumber: 1, tileIndex: 0, tileCount: 2, widthPx: 1568, heightPx: 646, xRange: [0, 3400], sourceWidthPx: 3400, sourceHeightPx: 1400 },
        { data: Buffer.alloc(1), mime: 'image/jpeg', role: 'tile', pageNumber: 1, tileIndex: 0, tileCount: 2, widthPx: 1269, heightPx: 1400, xRange: [0, 1269], sourceWidthPx: 3400, sourceHeightPx: 1400 },
      ],
      warnings: [],
    };
    const text = describeTiling(page);
    assert.match(text, /VERTICAL slices/);
    assert.doesNotMatch(text, /HORIZONTAL bands/);
  });

  it('returns an empty string when there is nothing to describe', () => {
    assert.equal(describeTiling([]), '');
  });
});
