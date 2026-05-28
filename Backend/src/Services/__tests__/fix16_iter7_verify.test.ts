/**
 * Fix 16 verification — run the promoteDatesFromSectionsIntoEpisode
 * logic against the actual iter7 5-patient JSON dumps stashed at
 * /tmp/iter7/<slug>/ai/{harmonised,sections}.json.
 *
 * Runner: node:test via tsx (matches actionEngine.test.ts convention).
 *
 *   npx tsx --test src/Services/__tests__/fix16_iter7_verify.test.ts
 *
 * If /tmp/iter7 is absent (clean machine, post-cleanup), the iter7
 * tests are skipped — this is local-bench scaffolding, not CI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { normaliseToIsoDate, HarmonisationService } from '../harmonisation.service.js';

const ITER7 = '/tmp/iter7';
const PATIENTS = ['anuj', 'sunil', 'shabana', 'kalksum', 'vahadur'] as const;

function loadIter7(slug: string): { episode: any; sections: any[] } | null {
  const harmPath = path.join(ITER7, slug, 'ai', 'harmonised.json');
  const secPath  = path.join(ITER7, slug, 'ai', 'sections.json');
  if (!fs.existsSync(harmPath) || !fs.existsSync(secPath)) return null;
  const harm = JSON.parse(fs.readFileSync(harmPath, 'utf8'));
  const sectionsRaw = JSON.parse(fs.readFileSync(secPath, 'utf8')) ?? [];
  if (!harm?.episode) return null;
  const mapped = sectionsRaw.map((s: any) => ({
    section_id: s.id,
    document_id: s.document_id,
    document_filename: null,
    document_s3_key: null,
    category: s.category,
    classifier_confidence: s.classification_confidence,
    page_start: s.page_start,
    page_end: s.page_end,
    title: null,
    status: s.status,
    extracted_fields: s.extracted_fields,
    extraction_confidence: s.extraction_confidence,
  }));
  return { episode: harm.episode, sections: mapped };
}

describe('Fix 16 — normaliseToIsoDate', () => {
  const cases: Array<[string, string | null]> = [
    ['2026-03-13',                     '2026-03-13'],
    ['2026-03-13T17:30:00+05:30',      '2026-03-13'],
    ['20/02/2026',                     '2026-02-20'],
    ['12-03-26',                       '2026-03-12'],
    ['31.01.2026',                     '2026-01-31'],
    ['12 Mar 2026',                    '2026-03-12'],
    ['3 Feb 2026',                     '2026-02-03'],
    ['',                               null],
    ['not a date',                     null],
    ['32/13/2026',                     null],
    // MM/DD/YYYY recovery when first field > 12 and second <= 12
    ['13/02/2026',                     '2026-02-13'],
  ];
  for (const [input, expected] of cases) {
    it(`normaliseToIsoDate(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      assert.equal(normaliseToIsoDate(input), expected);
    });
  }
});

describe('Fix 16 — iter7 regression against frozen captures', () => {
  for (const slug of PATIENTS) {
    it(`${slug}: promotion populates at least one date slot`, () => {
      const loaded = loadIter7(slug);
      if (!loaded) {
        console.log(`[Fix16][${slug}] skipped (no /tmp/iter7 data)`);
        return;
      }
      const { episode, sections } = loaded;
      const preAdmit   = episode?.stay_summary?.admission_datetime;
      const preDisch   = episode?.stay_summary?.discharge_datetime;
      const preSurgery = Array.isArray(episode.clinical_timeline)
        ? episode.clinical_timeline.flatMap((p: any) =>
            (p?.procedures_performed ?? []).map((pp: any) => pp?.performed_at))
        : [];
      const preAnySurgery = preSurgery.some((x: any) => x);

      const svc = new HarmonisationService() as any;
      svc.promoteDatesFromSectionsIntoEpisode(episode, sections);

      const postAdmit   = episode?.stay_summary?.admission_datetime;
      const postDisch   = episode?.stay_summary?.discharge_datetime;
      const postSurgery = Array.isArray(episode.clinical_timeline)
        ? episode.clinical_timeline.flatMap((p: any) =>
            (p?.procedures_performed ?? []).map((pp: any) => pp?.performed_at))
        : [];
      const postAnySurgery = postSurgery.some((x: any) => x);

      console.log(`[Fix16][${slug}] admit  ${preAdmit ?? 'null'} -> ${postAdmit ?? 'null'}`);
      console.log(`[Fix16][${slug}] disch  ${preDisch ?? 'null'} -> ${postDisch ?? 'null'}`);
      console.log(`[Fix16][${slug}] surg?  ${preAnySurgery} -> ${postAnySurgery}`);

      const filled =
        (!preAdmit && !!postAdmit) ||
        (!preDisch && !!postDisch) ||
        (!preAnySurgery && postAnySurgery);
      assert.equal(filled, true, `expected ${slug} to gain at least one date slot`);
    });
  }

  it('never overwrites an LLM-emitted admission_datetime', () => {
    const loaded = loadIter7('vahadur');
    if (!loaded) return;
    const { episode, sections } = loaded;
    episode.stay_summary = { admission_datetime: '2099-12-31T00:00:00Z' };
    const svc = new HarmonisationService() as any;
    svc.promoteDatesFromSectionsIntoEpisode(episode, sections);
    assert.equal(episode.stay_summary.admission_datetime, '2099-12-31T00:00:00Z');
  });
});
