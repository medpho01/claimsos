import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fuseEpisode } from '../fusion.service.js';
import { SectionFact, CanonicalField } from '../types.js';

/**
 * Tests for the Stage 5 authority-ranked deterministic fusion (the keystone).
 *
 * Run: docker exec hospital_worker_dev npx tsx --test \
 *        src/Services/pipelineV2/__tests__/fusion.test.ts
 *
 * The load-bearing properties:
 *  - discharge document WINS the final diagnosis over a stale/unranked page
 *    (the D3 fix — discharge is the authority, not "invalid");
 *  - the OT note WINS procedure + laterality over the discharge summary
 *    (the laterality-inversion fix);
 *  - agreement across sources raises confidence; competing values mark the
 *    slot contested and are retained for review;
 *  - multi-value slots collapse to distinct values;
 *  - selection is deterministic.
 */

let seq = 0;
function fact(
  field: CanonicalField,
  value: string,
  sourceDocType: string,
  opts: { confidence?: number; legibility?: number; pageId?: string; quote?: string } = {},
): SectionFact {
  seq += 1;
  return {
    field,
    rawField: field,
    value,
    quote: opts.quote,
    confidence: opts.confidence ?? 0.9,
    sourceDocType,
    sourcePageId: opts.pageId ?? `pg-${seq}`,
    pageLegibility: opts.legibility ?? 0.95,
  };
}

describe('Stage 5 — fusion', () => {
  it('discharge summary WINS the diagnosis over an unranked "others" page (D3 fix)', () => {
    const ep = fuseEpisode([
      // A high-confidence wrong diagnosis on an unranked page...
      fact('primary_diagnosis', 'Viral fever', 'others', { confidence: 0.99, pageId: 'A' }),
      // ...loses to a lower-confidence diagnosis on the discharge summary.
      fact('primary_diagnosis', 'Acute MI', 'discharge_summary', { confidence: 0.8, pageId: 'B' }),
    ]);
    assert.ok(ep.primary_diagnosis);
    assert.equal(ep.primary_diagnosis!.value, 'Acute MI');
    assert.equal(ep.primary_diagnosis!.sourceDocType, 'discharge_summary');
    assert.equal(ep.primary_diagnosis!.fromAuthoritativeSource, true);
    assert.equal(ep.primary_diagnosis!.contested, true, 'two distinct values competed');
  });

  it('OT note WINS laterality over the discharge summary (inversion fix)', () => {
    const ep = fuseEpisode([
      fact('laterality', 'Left', 'discharge_summary', { confidence: 0.95, pageId: 'D' }),
      fact('laterality', 'Right', 'ot_notes', { confidence: 0.9, pageId: 'O' }),
    ]);
    assert.equal(ep.laterality!.value, 'Right');
    assert.equal(ep.laterality!.sourceDocType, 'ot_notes');
    // The discharge value is retained as a losing candidate for audit.
    assert.ok(ep.laterality!.candidates.some((c) => c.value === 'Left'));
  });

  it('procedure_name comes from the OT note over the discharge summary', () => {
    const ep = fuseEpisode([
      fact('procedure_name', 'Hernia repair', 'discharge_summary', { pageId: 'D' }),
      fact('procedure_name', 'Lap. mesh hernioplasty', 'ot_notes', { pageId: 'O' }),
    ]);
    assert.equal(ep.procedure_name!.sourceDocType, 'ot_notes');
    assert.equal(ep.procedure_name!.value, 'Lap. mesh hernioplasty');
  });

  it('agreement across sources raises fused confidence (corroboration)', () => {
    const single = fuseEpisode([
      fact('primary_diagnosis', 'Sepsis', 'discharge_summary', { confidence: 0.8, legibility: 1, pageId: 'A' }),
    ]);
    const triple = fuseEpisode([
      fact('primary_diagnosis', 'Sepsis', 'discharge_summary', { confidence: 0.8, legibility: 1, pageId: 'A' }),
      fact('primary_diagnosis', 'Sepsis', 'discharge_slip', { confidence: 0.8, legibility: 1, pageId: 'B' }),
      fact('primary_diagnosis', 'Sepsis', 'progress_notes', { confidence: 0.8, legibility: 1, pageId: 'C' }),
    ]);
    assert.ok(
      triple.primary_diagnosis!.confidence > single.primary_diagnosis!.confidence,
      'three agreeing sources beat one',
    );
    assert.equal(triple.primary_diagnosis!.contested, false, 'agreement is not a conflict');
  });

  it('within the same authority tier, confidence × legibility breaks the tie', () => {
    const ep = fuseEpisode([
      fact('primary_diagnosis', 'Dengue', 'discharge_summary', { confidence: 0.6, legibility: 0.9, pageId: 'A' }),
      fact('primary_diagnosis', 'Malaria', 'discharge_summary', { confidence: 0.95, legibility: 0.95, pageId: 'B' }),
    ]);
    assert.equal(ep.primary_diagnosis!.value, 'Malaria', 'higher conf×legibility wins within a tier');
  });

  it('an unranked-only slot still fuses but flags fromAuthoritativeSource=false', () => {
    const ep = fuseEpisode([
      fact('primary_diagnosis', 'Unknown', 'others', { pageId: 'A' }),
    ]);
    assert.ok(ep.primary_diagnosis);
    assert.equal(ep.primary_diagnosis!.fromAuthoritativeSource, false);
  });

  it('contested single-value slots are recorded in conflicts[]', () => {
    const ep = fuseEpisode([
      fact('admission_date', '12/02/2026', 'discharge_summary', { pageId: 'A' }),
      fact('admission_date', '21/02/2026', 'admission_form', { pageId: 'B' }),
    ]);
    assert.equal(ep.admission_date!.value, '12/02/2026', 'discharge summary is the date authority');
    const conflict = ep.conflicts.find((c) => c.field === 'admission_date');
    assert.ok(conflict, 'the date disagreement is surfaced');
    assert.equal(conflict!.values.length, 2);
  });

  // ── equal-authority DATE era tie-break (the Sunil Kori regression) ─────────

  it('equal-authority date: an era-outlier misread loses to the in-window date even at higher confidence (Sunil regression)', () => {
    // Sunil Kori, claim 687f1f2a…: three equal-authority admission_date reads.
    // The misread '20/01/2020' had the HIGHEST raw confidence (0.372) and used to
    // win by 0.04 over the CORRECT '20/02/2026' (0.33), fusing admission_date six
    // years early. The third read '22/09/24' (0.279) corroborates the recent era
    // (within 2y of 2026), so '20/01/2020' is a lone 6-year outlier and is demoted
    // below the in-window candidates; confidence then picks 2026 among survivors.
    const ep = fuseEpisode([
      fact('admission_date', '20/01/2020', 'admission_notes', { confidence: 0.372, pageId: 'A' }),
      fact('admission_date', '20/02/2026', 'admission_notes', { confidence: 0.33, pageId: 'B' }),
      fact('admission_date', '22/09/24', 'admission_notes', { confidence: 0.279, pageId: 'C' }),
    ]);
    assert.equal(ep.admission_date!.value, '20/02/2026', 'in-window date beats the higher-confidence era outlier');
    assert.equal(ep.admission_date!.contested, true, 'the disagreement is still surfaced for review');
    // The outlier is retained as a losing candidate for the review queue / audit.
    assert.ok(ep.admission_date!.candidates.some((c) => c.value === '20/01/2020'));
  });

  it('cross-field dates establish the era: a higher-confidence admission misread is demoted when discharge + surgery agree', () => {
    const ep = fuseEpisode([
      // Admission misread 6 years early, but with the highest confidence…
      fact('admission_date', '12/02/2020', 'admission_notes', { confidence: 0.9, pageId: 'A' }),
      // …vs the correct admission, lower confidence.
      fact('admission_date', '12/02/2026', 'admission_notes', { confidence: 0.6, pageId: 'B' }),
      // Discharge + surgery corroborate the 2026 era → the reference cluster.
      fact('discharge_date', '15/02/2026', 'discharge_summary', { pageId: 'C' }),
      fact('surgery_date', '13/02/2026', 'ot_notes', { pageId: 'D' }),
    ]);
    assert.equal(ep.admission_date!.value, '12/02/2026', 'episode-era admission wins over the stale misread');
  });

  it('conservatism: with NO corroborating date cluster, the era tie-break is inert and confidence decides', () => {
    // Two admission reads, six years apart, nothing else to corroborate either
    // era. There is no trustworthy reference, so we must NOT invent an outlier —
    // the higher-confidence read wins exactly as it did before this rule existed.
    const ep = fuseEpisode([
      fact('admission_date', '20/01/2020', 'admission_notes', { confidence: 0.7, pageId: 'A' }),
      fact('admission_date', '20/02/2026', 'admission_notes', { confidence: 0.5, pageId: 'B' }),
    ]);
    assert.equal(ep.admission_date!.value, '20/01/2020', 'no reference cluster ⇒ highest confidence wins (unchanged)');
  });

  it('date_of_birth is never judged against the episode window (a DOB legitimately precedes admission by decades)', () => {
    const ep = fuseEpisode([
      // A clear 2026 episode era…
      fact('admission_date', '12/02/2026', 'admission_notes', { confidence: 0.8, pageId: 'A' }),
      fact('discharge_date', '15/02/2026', 'discharge_summary', { pageId: 'B' }),
      // …and a 1980 DOB (46y before the episode) that must NOT be demoted, plus a
      // same-era junk DOB that must NOT be rescued just for being in-window.
      fact('date_of_birth', '01/01/1980', 'admission_notes', { confidence: 0.9, pageId: 'C' }),
      fact('date_of_birth', '01/01/2026', 'others', { confidence: 0.4, pageId: 'D' }),
    ]);
    assert.equal(ep.date_of_birth!.value, '01/01/1980', 'DOB fuses by confidence, untouched by the episode-window rule');
  });

  it('multi-value slots collapse to distinct values, strongest first', () => {
    const ep = fuseEpisode([
      fact('medication', 'Augmentin', 'treatment_sheet', { confidence: 0.9, pageId: 'A' }),
      fact('medication', 'Augmentin', 'discharge_summary', { confidence: 0.9, pageId: 'B' }), // dup value
      fact('medication', 'Pan-40', 'treatment_sheet', { confidence: 0.7, pageId: 'C' }),
      fact('secondary_diagnosis', 'Type 2 DM', 'discharge_summary', { pageId: 'D' }),
    ]);
    assert.equal(ep.medications.length, 2, 'Augmentin de-duplicated across two sources');
    assert.equal(ep.medications[0].value, 'Augmentin', 'higher-confidence item leads');
    assert.equal(ep.secondary_diagnosis.length, 1);
    assert.equal(ep.secondary_diagnosis[0].value, 'Type 2 DM');
  });

  it('an empty fact set yields an empty episode (no throw)', () => {
    const ep = fuseEpisode([]);
    assert.equal(ep.primary_diagnosis, undefined);
    assert.deepEqual(ep.medications, []);
    assert.deepEqual(ep.conflicts, []);
    assert.deepEqual(ep.presentDocTypes, [], 'no facts → no present doc types');
  });

  it('records the DISTINCT doc types present across all fused facts', () => {
    const ep = fuseEpisode([
      fact('primary_diagnosis', 'Acute MI', 'discharge_summary', { pageId: 'A' }),
      fact('medication', 'Aspirin', 'treatment_sheet', { pageId: 'B' }),
      fact('medication', 'Aspirin', 'discharge_summary', { pageId: 'C' }), // dup doc type
      fact('finding', 'ST elevation', 'progress_notes', { pageId: 'D' }),
    ]);
    assert.ok(ep.presentDocTypes);
    assert.deepEqual(
      [...ep.presentDocTypes!].sort(),
      ['discharge_summary', 'progress_notes', 'treatment_sheet'],
      'distinct sourceDocTypes across ALL facts, de-duplicated',
    );
  });
});
