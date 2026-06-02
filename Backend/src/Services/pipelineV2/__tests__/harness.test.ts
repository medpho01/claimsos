import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PipelinePage, DerivedPage, SourceDocRef } from '../types.js';
import { PageRead } from '../../llm/schemas/pageRead.js';
import { runClaim } from '../harness/runner.js';
import { parseManifest } from '../harness/corpus.js';
import { ClaimGroundTruth } from '../harness/groundTruth.js';
import {
  scoreClaim,
  scoreCorpus,
  matchField,
  normalizeForMatch,
} from '../harness/scorer.js';
import { assertReplaySafe } from '../harness/readBridge.js';

/**
 * Tests for the Pipeline v2 offline harness (#108).
 *
 * Run: docker exec hospital_worker_dev npx tsx --test \
 *        src/Services/pipelineV2/__tests__/harness.test.ts
 *
 * The harness is pure except for the spend-guarded read bridge, so these tests
 * exercise the real value chain WITHOUT any LLM call:
 *   • parseManifest — the corpus MANIFEST.txt reader.
 *   • matchField    — the scorer's tolerant text/date/laterality matchers.
 *   • runClaim → scoreClaim/scoreCorpus over hand-built Stage-1 reads:
 *       a clean claim scores 100% and raises NO signals;
 *       a foreign-id page is excluded → foreign_pages_removed signal, q=1;
 *       a cross-container duplicate is deduped, not double-counted;
 *       a coverage shortfall raises a coverage_gap signal.
 *   • assertReplaySafe — the guard that makes an accidental live spend impossible.
 */

// ── fixture builders ────────────────────────────────────────────────────────

let seq = 0;
function page(
  identity: PageRead['identity'],
  opts: {
    facts?: PageRead['facts'];
    dates?: PageRead['dates'];
    docType?: string;
    legibility?: number;
    pageId?: string;
    sourceDocId?: string;
    phash?: string;
    dhash?: string;
  } = {},
): PipelinePage {
  seq += 1;
  const derived: DerivedPage = {
    id: opts.pageId ?? `pg-${seq}`,
    sourceDocId: opts.sourceDocId ?? `src-${seq}`,
    pageIndex: 1,
    transform: 'pdf_render',
    s3Key: `derived/pg-${seq}.jpg`,
    mime: 'image/jpeg',
    phash: opts.phash,
    dhash: opts.dhash,
  };
  const read: PageRead = {
    legibility: opts.legibility ?? 0.95,
    is_legible: true,
    doc_type: opts.docType ?? 'discharge_summary',
    doc_type_confidence: 0.9,
    is_blank_or_noise: false,
    transcription: '...',
    identity,
    facts: opts.facts ?? [],
    dates: opts.dates,
  };
  return { page: derived, read };
}

function src(sourceDocId: string, expectedPages: number): SourceDocRef {
  return { sourceDocId, expectedPages };
}

/** A clean single-page discharge summary with a full, authoritative episode. */
function cleanDischargePage(sourceDocId = 'discharge.pdf', pageId = 'D1'): PipelinePage {
  return page(
    { uhid: '23730', patient_name: 'Vahid' },
    {
      sourceDocId,
      pageId,
      docType: 'discharge_summary',
      facts: [
        { field: 'primary_diagnosis', value: 'Inguinal Hernia', confidence: 0.9 },
        { field: 'procedure_name', value: 'Hernioplasty (mesh repair)', confidence: 0.9 },
        { field: 'laterality', value: 'Rt.', confidence: 0.9 },
      ],
      dates: [
        { role: 'admission', value: '12/02/2026' },
        { role: 'discharge', value: '15/02/2026' },
        { role: 'surgery', value: '13/02/2026' },
      ],
    },
  );
}

const VAHID_GT: ClaimGroundTruth = {
  patient: 'Vahid',
  primary_diagnosis: 'Inguinal hernia',
  procedure_name: 'Hernioplasty',
  laterality: 'Right',
  admission_date: '12/02/2026',
  discharge_date: '15/02/2026',
  surgery_date: '13/02/2026',
  expectedQuarantinedPages: 0,
};

// ── corpus.parseManifest ──────────────────────────────────────────────────────

describe('harness — corpus.parseManifest', () => {
  it('parses claimId/slug/name/hospital and skips blanks + comments', () => {
    const rows = parseManifest(
      [
        '# header comment',
        '',
        '05cf88cb-aaaa  vahid  Vahid  CityHospital',
        '   ',
        'b2-id   qamruddin   Qamruddin',
        'too-few-columns',
      ].join('\n'),
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      claimId: '05cf88cb-aaaa',
      slug: 'vahid',
      name: 'Vahid',
      hospital: 'CityHospital',
    });
    assert.equal(rows[1].claimId, 'b2-id');
    assert.equal(rows[1].slug, 'qamruddin');
    assert.equal(rows[1].hospital, undefined);
  });
});

// ── scorer.matchField ─────────────────────────────────────────────────────────

describe('harness — scorer.matchField', () => {
  it('text: exact-normalised and substring (4+ chars) match; trivial overlap does not', () => {
    assert.equal(matchField('primary_diagnosis', 'Inguinal hernia', 'INGUINAL  HERNIA'), true);
    assert.equal(matchField('procedure_name', 'Hernioplasty', 'Hernioplasty (mesh repair)'), true);
    assert.equal(matchField('primary_diagnosis', 'Appendicitis', 'Inguinal hernia'), false);
    // a 1–3 char overlap must NOT count as a hit
    assert.equal(matchField('primary_diagnosis', 'CA', 'Carcinoma of breast'), false);
  });

  it('date: matches across separators/formats by clinical day', () => {
    assert.equal(matchField('admission_date', '12/02/2026', '12-02-2026'), true);
    assert.equal(matchField('admission_date', '12/02/2026', '12 Feb 2026'), true);
    assert.equal(matchField('discharge_date', '12/02/2026', '13/02/2026'), false);
  });

  it('laterality: normalises shorthand before comparing', () => {
    assert.equal(matchField('laterality', 'Right', 'Rt.'), true);
    assert.equal(matchField('laterality', 'Right', '(R)'), true);
    assert.equal(matchField('laterality', 'Right', 'Left'), false);
  });

  it('normalizeForMatch strips punctuation and collapses whitespace', () => {
    assert.equal(normalizeForMatch('  Inguinal-Hernia, (Rt.) '), 'inguinal hernia rt');
  });
});

// ── runClaim → scoreClaim / scoreCorpus ───────────────────────────────────────

describe('harness — runClaim + scoring', () => {
  it('a clean claim scores 100% on fields and raises NO signals', () => {
    const result = runClaim({
      claimId: 'claim-clean',
      sources: [src('discharge.pdf', 1)],
      pages: [cleanDischargePage()],
    });
    assert.equal(result.runState.signals.length, 0);

    const score = scoreClaim('claim-clean', VAHID_GT, result);
    assert.equal(score.scoredFields, 6);
    assert.equal(score.fieldHits, 6, JSON.stringify(score.fields, null, 2));
    assert.equal(score.fieldAccuracy, 1);
    assert.equal(score.quarantineHit, true);
  });

  it('a foreign-id page is excluded → foreign_pages_removed signal, q=1', () => {
    const result = runClaim({
      claimId: 'claim-foreign',
      sources: [src('discharge.pdf', 1), src('foreign.pdf', 1)],
      pages: [
        cleanDischargePage('discharge.pdf', 'D1'),
        // a DIFFERENT patient's page (conflicting structured uhid)
        page(
          { uhid: '99999', patient_name: 'Ramesh Patel' },
          { sourceDocId: 'foreign.pdf', pageId: 'F1', docType: 'discharge_summary' },
        ),
      ],
    });
    assert.equal(result.identity.quarantinedPageIds.length, 1);
    assert.ok(result.excludedPageIds.includes('F1'), 'foreign page is excluded from fusion');
    // The exclusion is surfaced as an advisory signal pointing at the page — not a block.
    const removed = result.runState.signals.find((s) => s.kind === 'foreign_pages_removed');
    assert.ok(removed, 'foreign_pages_removed signal raised');
    assert.equal(removed!.severity, 'info');
    assert.ok(removed!.pageIds.includes('F1'));

    const gt: ClaimGroundTruth = {
      patient: 'Vahid',
      expectedQuarantinedPages: 1,
    };
    const score = scoreClaim('claim-foreign', gt, result);
    assert.equal(score.quarantineHit, true);
  });

  it('a cross-container duplicate is deduped, not double-counted', () => {
    const H_ZERO = '0'.repeat(64);
    const H_4BITS = '0'.repeat(63) + 'f'; // 4 bits from zero → a near-duplicate
    const result = runClaim({
      claimId: 'claim-dup',
      sources: [src('full.pdf', 1), src('standalone.pdf', 1)],
      pages: [
        page(
          { uhid: '23730' },
          { sourceDocId: 'full.pdf', pageId: 'inFull', phash: H_ZERO, dhash: H_ZERO, legibility: 0.97 },
        ),
        page(
          { uhid: '23730' },
          { sourceDocId: 'standalone.pdf', pageId: 'standalone', phash: H_4BITS, dhash: H_4BITS, legibility: 0.6 },
        ),
      ],
    });
    assert.equal(result.dedup.clusters.length, 1, 'the duplicate collapses to one cluster');
    assert.equal(result.dedup.duplicatePageIds.length, 1);
    // the blurrier render is the one dropped from fusion
    assert.ok(result.excludedPageIds.includes('standalone'));
    assert.equal(result.runState.counts.pagesKept, 1);
    assert.equal(result.runState.counts.duplicates, 1);
  });

  it('a coverage shortfall raises a coverage_gap signal (E6 soft-drop caught)', () => {
    const result = runClaim({
      claimId: 'claim-gap',
      // the source declared 3 pages but only 1 was rendered/read
      sources: [src('discharge.pdf', 3)],
      pages: [cleanDischargePage()],
    });
    assert.equal(result.coverage.ok, false);
    const gap = result.runState.signals.find((s) => s.kind === 'coverage_gap');
    assert.ok(gap, 'coverage_gap signal raised');
    assert.equal(gap!.severity, 'warn');
  });

  it('scoreCorpus aggregates field hits across claims', () => {
    const clean = scoreClaim(
      'c1',
      VAHID_GT,
      runClaim({ claimId: 'c1', sources: [src('d.pdf', 1)], pages: [cleanDischargePage('d.pdf', 'X1')] }),
    );
    // a claim that pins a field the pipeline never produces → a recorded miss
    const missGt: ClaimGroundTruth = { patient: 'Empty', primary_diagnosis: 'Something' };
    const miss = scoreClaim(
      'c2',
      missGt,
      runClaim({
        claimId: 'c2',
        sources: [src('blank.pdf', 1)],
        pages: [page({ uhid: '111' }, { sourceDocId: 'blank.pdf', pageId: 'B1' })],
      }),
    );
    assert.equal(miss.fieldHits, 0);
    assert.equal(miss.fields[0].actual, undefined);

    const corpus = scoreCorpus([clean, miss]);
    assert.equal(corpus.claims, 2);
    assert.equal(corpus.scoredClaims, 2);
    assert.equal(corpus.totalScoredFields, 7); // 6 + 1
    assert.equal(corpus.totalFieldHits, 6);
    const dx = corpus.byField.find((b) => b.field === 'primary_diagnosis')!;
    assert.equal(dx.scored, 2);
    assert.equal(dx.hits, 1);
    // only the clean claim pinned an expected page-exclusion count
    assert.equal(corpus.quarantineScored, 1);
    assert.equal(corpus.quarantineHits, 1);
  });
});

// ── readBridge.assertReplaySafe (the spend guard) ─────────────────────────────

describe('harness — readBridge spend guard', () => {
  it('allows replay mode', () => {
    assert.doesNotThrow(() => assertReplaySafe({ LLM_REPLAY_MODE: 'replay' }));
  });

  it('refuses live / unset mode', () => {
    assert.throws(() => assertReplaySafe({}), /refusing to run in 'live'/);
    assert.throws(() => assertReplaySafe({ LLM_REPLAY_MODE: 'live' }), /refusing to run/);
  });

  it('refuses record mode unless explicitly authorised', () => {
    assert.throws(
      () => assertReplaySafe({ LLM_REPLAY_MODE: 'record' }),
      /HARNESS_ALLOW_RECORD=1/,
    );
    assert.doesNotThrow(() =>
      assertReplaySafe({ LLM_REPLAY_MODE: 'record', HARNESS_ALLOW_RECORD: '1' }),
    );
  });
});
