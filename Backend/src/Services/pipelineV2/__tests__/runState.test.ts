import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRunState, RunSignal, SignalKind } from '../runState.service.js';
import { CoverageReport, PipelinePage, DerivedPage } from '../types.js';
import { IdentityGateResult } from '../identityGate.service.js';
import { ValidationReport } from '../validators.service.js';
import { DedupResult } from '../dedup.service.js';
import { PageRead } from '../../llm/schemas/pageRead.js';

/**
 * Tests for the Stage 7 run-SIGNALS report.
 *
 * Run: docker exec hospital_worker_dev npx tsx --test \
 *        src/Services/pipelineV2/__tests__/runState.test.ts
 *
 * Asserts the interpret-don't-adjudicate boundary: Stage 7 raises ADVISORY
 * signals (foreign pages removed, multiple identities, possible contamination,
 * coverage gaps, low-confidence fields) and rolls up cost + counts. It has NO
 * veto — no signal ever blocks harmonisation; that decision is the rules
 * layer's. A clean run raises zero signals.
 */

// ── builders: each returns a CLEAN value; tests override the one gate they exercise.

function coverage(over: Partial<CoverageReport> = {}): CoverageReport {
  return {
    ok: true,
    totalSources: 3,
    totalExpectedPages: 10,
    totalRenderedPages: 10,
    missing: [],
    orphanSourceDocIds: [],
    ...over,
  };
}

function identity(over: Partial<IdentityGateResult> = {}): IdentityGateResult {
  return {
    dominantUhid: 'UHID123',
    dominantIpdNumber: 'IPD456',
    distinctUhids: ['UHID123'],
    distinctIpdNumbers: ['IPD456'],
    verdicts: [],
    quarantinedPageIds: [],
    reviewPageIds: [],
    coherent: true,
    episodeWindow: { admissionDay: 100, dischargeDay: 105 },
    ...over,
  };
}

function validation(over: Partial<ValidationReport> = {}): ValidationReport {
  return { issues: [], mustAbstain: false, abstainedFields: [], ...over };
}

function dedup(over: Partial<DedupResult> = {}): DedupResult {
  return { clusters: [], keepPageIds: [], duplicatePageIds: [], duplicateOf: {}, ...over };
}

let seq = 0;
function page(costInr: number | undefined, over: { pageId?: string; sourceDocId?: string } = {}): PipelinePage {
  seq += 1;
  const derived: DerivedPage = {
    id: over.pageId ?? `pg-${seq}`,
    sourceDocId: over.sourceDocId ?? `src-${seq}`,
    pageIndex: 1,
    transform: 'pdf_render',
    s3Key: `derived/pg-${seq}.jpg`,
    mime: 'image/jpeg',
  };
  const read: PageRead = {
    legibility: 0.9,
    is_legible: true,
    doc_type: 'discharge_summary',
    doc_type_confidence: 0.9,
    is_blank_or_noise: false,
    transcription: '...',
    identity: {},
    facts: [],
  };
  return { page: derived, read, costInr };
}

/** Find the single signal of a kind (or undefined). */
function sig(signals: RunSignal[], kind: SignalKind): RunSignal | undefined {
  return signals.find((s) => s.kind === kind);
}

describe('Stage 7 — run signals report (non-blocking)', () => {
  it('a fully-clean run raises NO signals', () => {
    const rs = evaluateRunState({
      coverage: coverage(),
      identity: identity(),
      validation: validation(),
      pages: [page(1), page(1)],
    });
    assert.equal(rs.signals.length, 0);
    // The report carries cost + counts even with no signals.
    assert.equal(rs.counts.pagesRendered, 2);
  });

  it('a coverage shortfall raises a coverage_gap WARN (does not block)', () => {
    const rs = evaluateRunState({
      coverage: coverage({
        ok: false,
        totalRenderedPages: 7,
        missing: [{ sourceDocId: 'src-1', expectedPages: 5, renderedPages: 2 }],
      }),
      identity: identity(),
      validation: validation(),
      pages: [page(0.5)],
    });
    const s = sig(rs.signals, 'coverage_gap');
    assert.ok(s);
    assert.equal(s!.severity, 'warn');
    assert.match(s!.reason, /3 page\(s\) missing/); // 5 expected − 2 rendered
    // It is the ONLY signal — nothing else fired, and nothing blocks.
    assert.equal(rs.signals.length, 1);
  });

  it('a foreign-patient page raises foreign_pages_removed INFO with the page ids', () => {
    const rs = evaluateRunState({
      coverage: coverage(),
      identity: identity({
        coherent: false,
        quarantinedPageIds: ['pgX'],
        distinctUhids: ['UHID123', 'UHID999'],
      }),
      validation: validation(),
      pages: [page(0.5)],
    });
    const removed = sig(rs.signals, 'foreign_pages_removed');
    assert.ok(removed);
    assert.equal(removed!.severity, 'info'); // removing a foreign page is CORRECT interpretation
    assert.deepEqual(removed!.pageIds, ['pgX']);
    // A genuinely mixed, incoherent bundle ALSO warns about the distinct ids.
    const multi = sig(rs.signals, 'multiple_identities');
    assert.ok(multi);
    assert.equal(multi!.severity, 'warn');
    assert.match(multi!.reason, /distinct uhids/);
  });

  it('multiple_identities does NOT fire when the gate judged the bundle coherent', () => {
    // Two distinct ids but coherent (e.g. OCR variants the gate reconciled) ⇒ benign.
    const rs = evaluateRunState({
      coverage: coverage(),
      identity: identity({ coherent: true, distinctIpdNumbers: ['IPD456', 'IPD457'] }),
      validation: validation(),
      pages: [page(0.5)],
    });
    assert.equal(sig(rs.signals, 'multiple_identities'), undefined);
    assert.equal(rs.signals.length, 0);
  });

  it('episode-outlier (review) pages raise possible_contamination WARN with the page ids', () => {
    const rs = evaluateRunState({
      coverage: coverage(),
      identity: identity({ reviewPageIds: ['pgOut1', 'pgOut2'] }),
      validation: validation(),
      pages: [page(0.5)],
    });
    const s = sig(rs.signals, 'possible_contamination');
    assert.ok(s);
    assert.equal(s!.severity, 'warn');
    assert.deepEqual(s!.pageIds, ['pgOut1', 'pgOut2']);
    assert.match(s!.reason, /different episode/);
  });

  it('abstained values raise low_confidence_field WARN carrying the field names', () => {
    const rs = evaluateRunState({
      coverage: coverage(),
      identity: identity(),
      validation: validation({ mustAbstain: true, abstainedFields: ['laterality', 'lab_value'] }),
      pages: [page(0.5)],
    });
    const s = sig(rs.signals, 'low_confidence_field');
    assert.ok(s);
    assert.equal(s!.severity, 'warn');
    assert.deepEqual(s!.fields, ['laterality', 'lab_value']);
  });

  it('every problem at once raises every signal — and STILL never blocks', () => {
    const rs = evaluateRunState({
      coverage: coverage({
        ok: false,
        totalRenderedPages: 8,
        missing: [{ sourceDocId: 'src-1', expectedPages: 4, renderedPages: 2 }],
      }),
      identity: identity({
        coherent: false,
        quarantinedPageIds: ['pgX'],
        reviewPageIds: ['pgOut'],
        distinctUhids: ['UHID123', 'UHID999'],
      }),
      validation: validation({ mustAbstain: true, abstainedFields: ['laterality'] }),
      pages: [page(0.5)],
    });
    const kinds = rs.signals.map((s) => s.kind).sort();
    assert.deepEqual(kinds, [
      'coverage_gap',
      'foreign_pages_removed',
      'low_confidence_field',
      'multiple_identities',
      'possible_contamination',
    ]);
    // No veto exists: the report is just signals + cost + counts.
    assert.ok(!('canHarmonise' in rs));
    assert.ok(!('status' in rs));
  });

  it('rolls up the REAL run cost from per-page INR', () => {
    const rs = evaluateRunState({
      coverage: coverage(),
      identity: identity(),
      validation: validation(),
      pages: [page(1.5), page(2.25), page(0)],
    });
    assert.equal(rs.cost.totalInr, 3.75);
    assert.equal(rs.cost.fullyReplayed, false);
  });

  it('rounds floating-point cost noise to 2 dp', () => {
    const rs = evaluateRunState({
      coverage: coverage(),
      identity: identity(),
      validation: validation(),
      pages: [page(0.1), page(0.2)], // 0.1 + 0.2 = 0.30000000000000004
    });
    assert.equal(rs.cost.totalInr, 0.3);
  });

  it('reports a fully-replayed run as zero-cost', () => {
    const rs = evaluateRunState({
      coverage: coverage(),
      identity: identity(),
      validation: validation(),
      pages: [page(0), page(0), page(0)],
    });
    assert.equal(rs.cost.totalInr, 0);
    assert.equal(rs.cost.fullyReplayed, true);
  });

  it('rolls up counts from dedup + identity', () => {
    const rs = evaluateRunState({
      coverage: coverage({ totalSources: 4 }),
      identity: identity({ quarantinedPageIds: ['q1'], reviewPageIds: ['r1', 'r2'] }),
      validation: validation(),
      dedup: dedup({ keepPageIds: ['a', 'b'], duplicatePageIds: ['c'] }),
      pages: [page(1), page(1), page(1)],
    });
    assert.equal(rs.counts.sources, 4);
    assert.equal(rs.counts.pagesRendered, 3);
    assert.equal(rs.counts.pagesKept, 2); // from dedup
    assert.equal(rs.counts.duplicates, 1);
    assert.equal(rs.counts.quarantined, 1);
    assert.equal(rs.counts.review, 2);
  });

  it('without dedup, pagesKept falls back to all rendered pages', () => {
    const rs = evaluateRunState({
      coverage: coverage(),
      identity: identity(),
      validation: validation(),
      pages: [page(1), page(1)],
    });
    assert.equal(rs.counts.pagesKept, 2);
    assert.equal(rs.counts.duplicates, 0);
  });
});
