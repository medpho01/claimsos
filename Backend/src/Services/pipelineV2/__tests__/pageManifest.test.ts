import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildManifest, computeCoverage } from '../pageManifest.service.js';
import { SourceDocRef, DerivedPage } from '../types.js';

/**
 * Tests for the Stage 0 page manifest + content-coverage invariant (E6).
 *
 * Run: docker exec hospital_worker_dev npx tsx --test \
 *        src/Services/pipelineV2/__tests__/pageManifest.test.ts
 *
 * Asserts the E6 soft-drop is caught loudly: coverage is measured against
 * Layer-A sources, a source that under-renders fails the gate WITH its
 * shortfall enumerated, an orphan render (no declared source) fails the gate,
 * over-rendering does NOT false-fail, and the manifest builder de-dups sources
 * so a doubled source row can't inflate the denominator.
 */

function src(sourceDocId: string, expectedPages: number, fileName?: string): SourceDocRef {
  return { sourceDocId, expectedPages, fileName };
}

let seq = 0;
function render(sourceDocId: string, pageIndex = 1): DerivedPage {
  seq += 1;
  return {
    id: `pg-${seq}`,
    sourceDocId,
    pageIndex,
    transform: 'pdf_render',
    s3Key: `derived/pg-${seq}.jpg`,
    mime: 'image/jpeg',
  };
}

/** Convenience: N renders of one source, page indices 1..N. */
function renders(sourceDocId: string, n: number): DerivedPage[] {
  return Array.from({ length: n }, (_, i) => render(sourceDocId, i + 1));
}

describe('Stage 0 — coverage invariant', () => {
  it('passes when every source rendered its expected page count', () => {
    const manifest = buildManifest(
      'claim-1',
      [src('A', 3, 'full.pdf'), src('B', 1, 'discharge.jpg')],
      [...renders('A', 3), ...renders('B', 1)],
    );
    const cov = computeCoverage(manifest);
    assert.equal(cov.ok, true);
    assert.equal(cov.totalSources, 2);
    assert.equal(cov.totalExpectedPages, 4);
    assert.equal(cov.totalRenderedPages, 4);
    assert.deepEqual(cov.missing, []);
    assert.deepEqual(cov.orphanSourceDocIds, []);
  });

  it('FAILS on a soft-drop and enumerates the shortfall (E6)', () => {
    const manifest = buildManifest(
      'claim-2',
      [src('A', 5, 'full.pdf')],
      renders('A', 2), // 3 pages silently dropped
    );
    const cov = computeCoverage(manifest);
    assert.equal(cov.ok, false);
    assert.equal(cov.missing.length, 1);
    assert.equal(cov.missing[0].sourceDocId, 'A');
    assert.equal(cov.missing[0].expectedPages, 5);
    assert.equal(cov.missing[0].renderedPages, 2);
    assert.equal(cov.missing[0].fileName, 'full.pdf');
  });

  it('FAILS when a source rendered zero pages', () => {
    const manifest = buildManifest(
      'claim-3',
      [src('A', 2), src('B', 1)],
      renders('A', 2), // B rendered nothing
    );
    const cov = computeCoverage(manifest);
    assert.equal(cov.ok, false);
    assert.equal(cov.missing.length, 1);
    assert.equal(cov.missing[0].sourceDocId, 'B');
    assert.equal(cov.missing[0].renderedPages, 0);
  });

  it('FAILS on an orphan render (a render with no declared source)', () => {
    const manifest = buildManifest(
      'claim-4',
      [src('A', 1)],
      [render('A', 1), render('GHOST', 1)], // GHOST is not a declared source
    );
    const cov = computeCoverage(manifest);
    assert.equal(cov.ok, false);
    assert.deepEqual(cov.orphanSourceDocIds, ['GHOST']);
    assert.deepEqual(cov.missing, []); // A is fully covered; only the orphan fails it
    assert.equal(cov.totalRenderedPages, 2); // orphans still count as rendered
  });

  it('does NOT false-fail when a source over-renders', () => {
    // expectedPages 2 but 3 rendered — a duplicate render is Stage 3's concern,
    // not a missing page. Coverage must stay green.
    const manifest = buildManifest('claim-5', [src('A', 2)], renders('A', 3));
    const cov = computeCoverage(manifest);
    assert.equal(cov.ok, true);
    assert.deepEqual(cov.missing, []);
  });

  it('enumerates every under-rendered source, sorted', () => {
    const manifest = buildManifest(
      'claim-6',
      [src('C', 4), src('A', 3), src('B', 2)],
      [...renders('C', 1), ...renders('A', 3), ...renders('B', 1)], // C short, B short, A ok
    );
    const cov = computeCoverage(manifest);
    assert.equal(cov.ok, false);
    assert.deepEqual(cov.missing.map((m) => m.sourceDocId), ['B', 'C']); // sorted
  });

  it('de-dups sources by id so a doubled row cannot inflate the denominator', () => {
    const manifest = buildManifest(
      'claim-7',
      [src('A', 2), src('A', 2)], // same upload listed twice
      renders('A', 2),
    );
    assert.equal(manifest.sources.length, 1);
    const cov = computeCoverage(manifest);
    assert.equal(cov.totalSources, 1);
    assert.equal(cov.totalExpectedPages, 2);
    assert.equal(cov.ok, true);
  });

  it('treats an empty manifest as vacuously covered (zero sources, zero renders)', () => {
    const cov = computeCoverage(buildManifest('claim-8', [], []));
    assert.equal(cov.ok, true);
    assert.equal(cov.totalSources, 0);
    assert.equal(cov.totalExpectedPages, 0);
    assert.equal(cov.totalRenderedPages, 0);
  });
});
