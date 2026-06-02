import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dedupPages } from '../dedup.service.js';
import { PipelinePage, DerivedPage } from '../types.js';
import { PageRead } from '../../llm/schemas/pageRead.js';

/**
 * Tests for the Stage 3 vision-led cross-container dedup.
 *
 * Run: docker exec hospital_worker_dev npx tsx --test \
 *        src/Services/pipelineV2/__tests__/dedup.test.ts
 *
 * Hashes are 64-hex-char (256-bit) strings with controlled Hamming distances
 * (default threshold = 16 bits). Asserts: near-identical renders collapse to
 * one representative; the MOST LEGIBLE render is kept; visually different pages
 * stay separate; a dHash disagreement blocks a false merge when requireBoth;
 * pages with no pHash are each kept (un-deduplicable).
 */

// 256-bit hashes (64 hex chars). Set-bit count from all-zero = Hamming distance.
const H_ZERO = '0'.repeat(64);
const H_4BITS = '0'.repeat(63) + 'f'; // 4 set bits → distance 4 from zero (a near-dup)
const H_20BITS = '0'.repeat(59) + 'fffff'; // 20 set bits → distance 20 (> 16, a different page)
const H_ONES = 'f'.repeat(64); // 256 bits → clearly different

let seq = 0;
function page(
  phash: string | undefined,
  opts: { dhash?: string; legibility?: number; isLegible?: boolean; pageId?: string; sourceDocId?: string } = {},
): PipelinePage {
  seq += 1;
  const derived: DerivedPage = {
    id: opts.pageId ?? `pg-${seq}`,
    sourceDocId: opts.sourceDocId ?? `src-${seq}`,
    pageIndex: 1,
    transform: 'pdf_render',
    s3Key: `derived/pg-${seq}.jpg`,
    mime: 'image/jpeg',
    phash,
    dhash: opts.dhash,
  };
  const read: PageRead = {
    legibility: opts.legibility ?? 0.9,
    is_legible: opts.isLegible ?? true,
    doc_type: 'discharge_slip',
    doc_type_confidence: 0.9,
    is_blank_or_noise: false,
    transcription: '...',
    identity: {},
    facts: [],
  };
  return { page: derived, read };
}

describe('Stage 3 — dedup', () => {
  it('collapses near-identical renders into one cluster', () => {
    const r = dedupPages([
      page(H_ZERO, { dhash: H_ZERO, pageId: 'A' }),
      page(H_4BITS, { dhash: H_4BITS, pageId: 'B' }), // 4 bits from A → duplicate
    ]);
    assert.equal(r.clusters.length, 1);
    assert.equal(r.keepPageIds.length, 1);
    assert.equal(r.duplicatePageIds.length, 1);
  });

  it('keeps the MOST LEGIBLE render as the representative', () => {
    const r = dedupPages([
      page(H_ZERO, { dhash: H_ZERO, pageId: 'BLUR', legibility: 0.55 }),
      page(H_4BITS, { dhash: H_4BITS, pageId: 'SHARP', legibility: 0.97 }),
    ]);
    assert.equal(r.keepPageIds[0], 'SHARP');
    assert.equal(r.duplicateOf['BLUR'], 'SHARP');
  });

  it('does NOT merge visually different pages', () => {
    const r = dedupPages([
      page(H_ZERO, { dhash: H_ZERO, pageId: 'A' }),
      page(H_20BITS, { dhash: H_20BITS, pageId: 'B' }), // 20 bits → above threshold
      page(H_ONES, { dhash: H_ONES, pageId: 'C' }),
    ]);
    assert.equal(r.clusters.length, 3);
    assert.equal(r.duplicatePageIds.length, 0);
  });

  it('cross-container: same page in two different source docs is deduped', () => {
    const r = dedupPages([
      page(H_ZERO, { dhash: H_ZERO, pageId: 'inFullPdf', sourceDocId: 'full.pdf' }),
      page(H_4BITS, { dhash: H_4BITS, pageId: 'standalone', sourceDocId: 'discharge.pdf' }),
    ]);
    assert.equal(r.clusters.length, 1, 'a duplicate spanning two containers collapses to one');
  });

  it('requireBoth: a dHash disagreement blocks a false pHash merge', () => {
    const r = dedupPages(
      [
        page(H_ZERO, { dhash: H_ZERO, pageId: 'A' }),
        page(H_4BITS, { dhash: H_ONES, pageId: 'B' }), // pHash near, dHash far
      ],
      { requireBoth: true },
    );
    assert.equal(r.clusters.length, 2, 'dHash veto prevents the merge');
  });

  it('pages without a pHash are each kept (un-deduplicable)', () => {
    const r = dedupPages([
      page(undefined, { pageId: 'A' }),
      page(undefined, { pageId: 'B' }),
    ]);
    assert.equal(r.clusters.length, 2);
    assert.equal(r.keepPageIds.length, 2);
    assert.equal(r.duplicatePageIds.length, 0);
  });

  it('three-way near-duplicate chain collapses to a single cluster', () => {
    const r = dedupPages([
      page(H_ZERO, { dhash: H_ZERO, pageId: 'A', legibility: 0.8 }),
      page(H_4BITS, { dhash: H_4BITS, pageId: 'B', legibility: 0.95 }),
      page('0'.repeat(62) + 'ff', { dhash: '0'.repeat(62) + 'ff', pageId: 'C', legibility: 0.7 }), // 8 bits
    ]);
    assert.equal(r.clusters.length, 1);
    assert.equal(r.clusters[0].size, 3);
    assert.equal(r.keepPageIds[0], 'B', 'most legible of the three');
  });
});
