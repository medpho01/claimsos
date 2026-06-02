import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractSectionFacts, normalizeLaterality } from '../extraction.service.js';
import { PipelinePage, DerivedPage } from '../types.js';
import { PageRead } from '../../llm/schemas/pageRead.js';

/**
 * Tests for the Stage 4 type-conditioned extraction (deterministic refinement).
 *
 * Run: docker exec hospital_worker_dev npx tsx --test \
 *        src/Services/pipelineV2/__tests__/extraction.test.ts
 *
 * Asserts: facts route to canonical slots with provenance (sourceDocType +
 * pageId); laterality is canonicalised; role-tagged dates become date slots
 * (report/visit dates are dropped); a `complaint` is NEVER promoted to a
 * diagnosis (the D3 guard); quarantined and blank pages contribute nothing.
 */

let seq = 0;
function page(
  facts: PageRead['facts'],
  opts: {
    docType?: string;
    dates?: PageRead['dates'];
    legibility?: number;
    blank?: boolean;
    pageId?: string;
  } = {},
): PipelinePage {
  seq += 1;
  const derived: DerivedPage = {
    id: opts.pageId ?? `pg-${seq}`,
    sourceDocId: `src-${seq}`,
    pageIndex: 1,
    transform: 'pdf_render',
    s3Key: `derived/pg-${seq}.jpg`,
    mime: 'image/jpeg',
  };
  const read: PageRead = {
    legibility: opts.legibility ?? 0.95,
    is_legible: true,
    doc_type: opts.docType ?? 'discharge_slip',
    doc_type_confidence: 0.9,
    is_blank_or_noise: opts.blank ?? false,
    transcription: '...',
    identity: {},
    facts,
    dates: opts.dates,
  };
  return { page: derived, read };
}

describe('Stage 4 — extraction', () => {
  it('routes facts to canonical slots and stamps provenance', () => {
    const facts = extractSectionFacts([
      page(
        [
          { field: 'primary_diagnosis', value: 'Right inguinal hernia', quote: 'Final Dx: Rt. Inguinal Hernia', confidence: 0.96 },
          { field: 'procedure_name', value: 'Hernioplasty', confidence: 0.94 },
        ],
        { docType: 'discharge_summary', pageId: 'P1' },
      ),
    ]);
    assert.equal(facts.length, 2);
    const dx = facts.find((f) => f.field === 'primary_diagnosis')!;
    assert.equal(dx.sourceDocType, 'discharge_summary');
    assert.equal(dx.sourcePageId, 'P1');
    assert.equal(dx.confidence, 0.96);
    assert.equal(dx.quote, 'Final Dx: Rt. Inguinal Hernia');
    assert.equal(dx.pageLegibility, 0.95);
  });

  it('canonicalises laterality from chart shorthand', () => {
    const facts = extractSectionFacts([
      page([{ field: 'laterality', value: 'Rt.', confidence: 0.9 }], { docType: 'ot_notes' }),
    ]);
    assert.equal(facts[0].field, 'laterality');
    assert.equal(facts[0].value, 'Right');
  });

  it('NEVER promotes a chief complaint to a diagnosis (D3 guard)', () => {
    const facts = extractSectionFacts([
      page([{ field: 'complaint', value: 'chest pain', confidence: 0.4 }], { docType: 'opd_notes' }),
    ]);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].field, 'complaint', 'a symptom stays a complaint, never primary_diagnosis');
  });

  it('maps role-tagged dates to date slots and drops non-episode roles', () => {
    const facts = extractSectionFacts([
      page([], {
        docType: 'discharge_summary',
        legibility: 0.8,
        dates: [
          { role: 'admission', value: '12/02/2026', quote: 'DOA 12/02/2026' },
          { role: 'discharge', value: '15/02/2026' },
          { role: 'surgery', value: '13/02/2026' },
          { role: 'report', value: '14/02/2026' }, // not an episode slot → dropped
        ],
      }),
    ]);
    const fields = facts.map((f) => f.field).sort();
    assert.deepEqual(fields, ['admission_date', 'discharge_date', 'surgery_date']);
    const adm = facts.find((f) => f.field === 'admission_date')!;
    assert.equal(adm.value, '12/02/2026');
    assert.equal(adm.confidence, 0.8, 'a date inherits the page legibility as its confidence');
  });

  it('recovers an admission date from a visit date on an admission-notes page (Shabana)', () => {
    // Shabana's only admission date was a `visit` date on an admission_notes
    // page with no admission-role date — the fallback must surface it.
    const facts = extractSectionFacts([
      page([], {
        docType: 'admission_notes',
        legibility: 0.9,
        dates: [{ role: 'visit', value: '3/2/26' }],
      }),
    ]);
    const adm = facts.find((f) => f.field === 'admission_date');
    assert.ok(adm, 'a visit date on an admission page becomes an admission_date');
    assert.equal(adm!.value, '3/2/26');
    assert.equal(adm!.rawField, 'visit(fallback)');
  });

  it('prefers the document date over a visit date in the admission fallback (Sunil)', () => {
    // Sunil's real admission date was a `document` date alongside garbage
    // `visit` dates; the document fallback must outrank the visit fallback.
    const facts = extractSectionFacts([
      page([], {
        docType: 'admission_notes',
        legibility: 0.9,
        dates: [
          { role: 'document', value: '20/02/2026' },
          { role: 'visit', value: '22/09/24' },
        ],
      }),
    ]);
    const docFb = facts.find((f) => f.field === 'admission_date' && f.rawField === 'document(fallback)');
    assert.ok(docFb, 'the document date is recovered as an admission_date');
    assert.equal(docFb!.value, '20/02/2026');
    const visitFb = facts.find((f) => f.field === 'admission_date' && f.rawField === 'visit(fallback)');
    if (visitFb) {
      assert.ok(
        docFb!.confidence > visitFb!.confidence,
        'document fallback outranks visit fallback',
      );
    }
  });

  it('NEVER turns a report date into an admission date on a lab/investigations page', () => {
    // The whole safety point: only admission-bearing doc types get the fallback.
    const facts = extractSectionFacts([
      page([], {
        docType: 'lab_report',
        legibility: 0.9,
        dates: [{ role: 'report', value: '14/02/2026' }],
      }),
    ]);
    assert.equal(
      facts.find((f) => f.field === 'admission_date'),
      undefined,
      'a report date on a lab page is never promoted to an admission date',
    );
  });

  it('a real admission date is still emitted and the fallback does not suppress it', () => {
    const facts = extractSectionFacts([
      page([], {
        docType: 'admission_notes',
        legibility: 0.9,
        dates: [
          { role: 'admission', value: '12/02/2026' },
          { role: 'visit', value: '01/01/2020' },
        ],
      }),
    ]);
    const adms = facts.filter((f) => f.field === 'admission_date');
    assert.equal(adms.length, 1, 'only the real admission date is emitted (no fallback)');
    assert.equal(adms[0].value, '12/02/2026');
    assert.equal(adms[0].rawField, 'admission', 'the real admission-role date, not a fallback');
  });

  it('drops facts from quarantined and blank/noise pages', () => {
    const facts = extractSectionFacts(
      [
        page([{ field: 'primary_diagnosis', value: 'Sepsis', confidence: 0.9 }], { pageId: 'KEEP' }),
        page([{ field: 'primary_diagnosis', value: 'FOREIGN', confidence: 0.9 }], { pageId: 'BAD' }),
        page([{ field: 'finding', value: 'nothing', confidence: 0.5 }], { pageId: 'BLANK', blank: true }),
      ],
      { excludePageIds: new Set(['BAD']) },
    );
    assert.equal(facts.length, 1);
    assert.equal(facts[0].value, 'Sepsis');
    assert.equal(facts[0].sourcePageId, 'KEEP');
  });

  it('routes model-drift synonyms and falls back to "other" for unknowns', () => {
    const facts = extractSectionFacts([
      page(
        [
          { field: 'final_diagnosis', value: 'AMI', confidence: 0.9 },
          { field: 'operation', value: 'CABG', confidence: 0.9 },
          { field: 'random_unmapped_key', value: 'x', confidence: 0.5 },
        ],
        { docType: 'discharge_summary' },
      ),
    ]);
    assert.equal(facts.find((f) => f.value === 'AMI')!.field, 'primary_diagnosis');
    assert.equal(facts.find((f) => f.value === 'CABG')!.field, 'procedure_name');
    assert.equal(facts.find((f) => f.value === 'x')!.field, 'other');
  });

  it('normalizeLaterality handles the common shorthands', () => {
    assert.equal(normalizeLaterality('Rt.'), 'Right');
    assert.equal(normalizeLaterality('(L)'), 'Left');
    assert.equal(normalizeLaterality('B/L'), 'Bilateral');
    assert.equal(normalizeLaterality('bilateral'), 'Bilateral');
    assert.equal(normalizeLaterality('LEFT'), 'Left');
    // Unrecognised → returned trimmed, not guessed.
    assert.equal(normalizeLaterality('midline'), 'midline');
  });
});
