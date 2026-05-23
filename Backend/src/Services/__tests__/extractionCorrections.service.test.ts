/**
 * ExtractionCorrectionsService unit tests.
 *
 * Runner: node:test. Run with:
 *
 *   npx tsx --test src/Services/__tests__/extractionCorrections.service.test.ts
 *
 * Pool is a small in-memory stand-in keyed off SQL fragments. We assert:
 *   - record/list round-trip (INSERT param shape, SELECT WHERE claim_id)
 *   - systemic-error grouping pulls only (hospital,field) pairs with >3
 *   - different field paths don't collapse into one group
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ExtractionCorrectionsService } from '../extractionCorrections.service.js';

// ─── In-memory mock pool ──────────────────────────────────────────────────

interface CorrectionRecord {
  id: string;
  claim_id: string;
  hospital_id: string;
  target_kind: string;
  section_id: string | null;
  field_path: string;
  ai_value: unknown;
  corrected_value: unknown;
  reason: string | null;
  reviewer_id: string | null;
  reviewed_at: Date;
  superseded_at: Date | null;
  superseded_by: string | null;
}

function makeMockPool() {
  const store: CorrectionRecord[] = [];
  let idCounter = 0;

  const nextId = () => {
    idCounter += 1;
    const hex = idCounter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  };

  const parseJsonbParam = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    return v;
  };

  const query = async (sql: string, params: unknown[] = []): Promise<any> => {
    if (sql.includes('INSERT INTO hospital.extraction_corrections')) {
      const id = nextId();
      const rec: CorrectionRecord = {
        id,
        claim_id: params[0] as string,
        hospital_id: params[1] as string,
        target_kind: params[2] as string,
        section_id: (params[3] as string) ?? null,
        field_path: params[4] as string,
        ai_value: parseJsonbParam(params[5]),
        corrected_value: parseJsonbParam(params[6]),
        reason: (params[7] as string) ?? null,
        reviewer_id: (params[8] as string) ?? null,
        reviewed_at: new Date(),
        superseded_at: null,
        superseded_by: null,
      };
      store.push(rec);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (
      sql.includes('FROM hospital.extraction_corrections') &&
      sql.includes('WHERE claim_id = $1') &&
      !sql.includes('GROUP BY')
    ) {
      const claimId = params[0] as string;
      const rows = store
        .filter((r) => r.claim_id === claimId)
        .sort((a, b) => b.reviewed_at.getTime() - a.reviewed_at.getTime());
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('GROUP BY hospital_id, field_path')) {
      // systemic errors query — params: [hospital_id?, limit]
      let hospitalFilter: string | undefined;
      if (params.length === 2) {
        hospitalFilter = params[0] as string;
      }
      const groups = new Map<
        string,
        { hospital_id: string; field_path: string; rows: CorrectionRecord[] }
      >();
      for (const r of store) {
        if (r.superseded_at) continue;
        if (hospitalFilter && r.hospital_id !== hospitalFilter) continue;
        const key = `${r.hospital_id}|${r.field_path}`;
        const g = groups.get(key) ?? {
          hospital_id: r.hospital_id,
          field_path: r.field_path,
          rows: [],
        };
        g.rows.push(r);
        groups.set(key, g);
      }
      const out = Array.from(groups.values())
        .filter((g) => g.rows.length > 3)
        .sort((a, b) => b.rows.length - a.rows.length)
        .map((g) => ({
          hospital_id: g.hospital_id,
          field_path: g.field_path,
          correction_count: g.rows.length,
          recent_examples: g.rows
            .sort(
              (a, b) => b.reviewed_at.getTime() - a.reviewed_at.getTime(),
            )
            .slice(0, 3)
            .map((r) => ({
              ai_value: r.ai_value,
              corrected_value: r.corrected_value,
              reviewed_at: r.reviewed_at,
            })),
        }));
      return { rows: out, rowCount: out.length };
    }

    return { rows: [], rowCount: 0 };
  };

  return { query: query as any, _store: store };
}

// ─── Fixture ids ──────────────────────────────────────────────────────────

const CLAIM_1 = '11111111-1111-4111-8111-111111111111';
const CLAIM_2 = '11111111-1111-4111-8111-222222222222';
const HOSP_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOSP_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb';
const REVIEWER_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// ─── Tests ────────────────────────────────────────────────────────────────

describe('ExtractionCorrectionsService — recordCorrection / listForClaim', () => {
  it('round-trips all fields including JSONB ai_value and corrected_value', async () => {
    const mock = makeMockPool();
    const svc = new ExtractionCorrectionsService(mock as any);

    const out = await svc.recordCorrection({
      claim_id: CLAIM_1,
      hospital_id: HOSP_1,
      target_kind: 'section_extracted_field',
      section_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      field_path: 'patient_context.first_name',
      ai_value: { first_name: 'Jhon' },
      corrected_value: { first_name: 'John' },
      reason: 'misspelled by OCR',
      reviewer_id: REVIEWER_1,
    });
    assert.ok(out.id);

    const rows = await svc.listForClaim(CLAIM_1);
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.claim_id, CLAIM_1);
    assert.equal(r.hospital_id, HOSP_1);
    assert.equal(r.target_kind, 'section_extracted_field');
    assert.equal(r.section_id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    assert.equal(r.field_path, 'patient_context.first_name');
    assert.deepEqual(r.ai_value, { first_name: 'Jhon' });
    assert.deepEqual(r.corrected_value, { first_name: 'John' });
    assert.equal(r.reason, 'misspelled by OCR');
    assert.equal(r.reviewer_id, REVIEWER_1);
  });

  it('handles undefined ai_value (collapses to null) and missing optionals', async () => {
    const mock = makeMockPool();
    const svc = new ExtractionCorrectionsService(mock as any);

    await svc.recordCorrection({
      claim_id: CLAIM_1,
      hospital_id: HOSP_1,
      target_kind: 'foreign_document_flag',
      field_path: 'is_foreign',
      ai_value: undefined,
      corrected_value: true,
    });

    const rows = await svc.listForClaim(CLAIM_1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ai_value, null);
    assert.equal(rows[0]!.corrected_value, true);
    assert.equal(rows[0]!.section_id, null);
    assert.equal(rows[0]!.reason, null);
    assert.equal(rows[0]!.reviewer_id, null);
  });
});

describe('ExtractionCorrectionsService — listSystemicErrors', () => {
  it('returns (hospital, field) pairs only when correction count exceeds 3', async () => {
    const mock = makeMockPool();
    const svc = new ExtractionCorrectionsService(mock as any);

    // 5 corrections to the same (hospital, field) — should surface.
    for (let i = 0; i < 5; i++) {
      await svc.recordCorrection({
        claim_id: CLAIM_1,
        hospital_id: HOSP_1,
        target_kind: 'section_extracted_field',
        field_path: 'diagnosis.primary_diagnosis.diagnosis_name',
        ai_value: { diagnosis_name: `wrong-${i}` },
        corrected_value: { diagnosis_name: `right-${i}` },
      });
    }

    const systemic = await svc.listSystemicErrors();
    assert.equal(systemic.length, 1);
    assert.equal(systemic[0]!.hospital_id, HOSP_1);
    assert.equal(
      systemic[0]!.field_path,
      'diagnosis.primary_diagnosis.diagnosis_name',
    );
    assert.equal(systemic[0]!.correction_count, 5);
    assert.equal(systemic[0]!.recent_examples.length, 3);
  });

  it('does not surface pairs with <= 3 corrections', async () => {
    const mock = makeMockPool();
    const svc = new ExtractionCorrectionsService(mock as any);

    for (let i = 0; i < 3; i++) {
      await svc.recordCorrection({
        claim_id: CLAIM_1,
        hospital_id: HOSP_1,
        target_kind: 'section_extracted_field',
        field_path: 'patient_context.first_name',
        ai_value: { first_name: `wrong-${i}` },
        corrected_value: { first_name: `right-${i}` },
      });
    }
    const systemic = await svc.listSystemicErrors();
    assert.equal(systemic.length, 0);
  });

  it('does not collapse different field paths into one group (no false positives)', async () => {
    const mock = makeMockPool();
    const svc = new ExtractionCorrectionsService(mock as any);

    // 4 different field paths under the same hospital → each gets 1
    // correction → no group should reach the > 3 threshold.
    const fields = [
      'patient_context.first_name',
      'patient_context.last_name',
      'diagnosis.primary_diagnosis.diagnosis_name',
      'admission.admission_date',
    ];
    for (const f of fields) {
      await svc.recordCorrection({
        claim_id: CLAIM_1,
        hospital_id: HOSP_1,
        target_kind: 'section_extracted_field',
        field_path: f,
        ai_value: { v: 'ai' },
        corrected_value: { v: 'human' },
      });
    }

    const systemic = await svc.listSystemicErrors();
    assert.equal(
      systemic.length,
      0,
      'distinct field_paths must not collapse into one group',
    );
  });

  it('filters by hospital_id when provided', async () => {
    const mock = makeMockPool();
    const svc = new ExtractionCorrectionsService(mock as any);

    // 5 for HOSP_1, 5 for HOSP_2 — different field for each hospital.
    for (let i = 0; i < 5; i++) {
      await svc.recordCorrection({
        claim_id: CLAIM_1,
        hospital_id: HOSP_1,
        target_kind: 'section_extracted_field',
        field_path: 'patient_context.first_name',
        ai_value: { v: `a-${i}` },
        corrected_value: { v: `b-${i}` },
      });
      await svc.recordCorrection({
        claim_id: CLAIM_2,
        hospital_id: HOSP_2,
        target_kind: 'section_extracted_field',
        field_path: 'diagnosis.primary_diagnosis.diagnosis_name',
        ai_value: { v: `a-${i}` },
        corrected_value: { v: `b-${i}` },
      });
    }

    const onlyHosp1 = await svc.listSystemicErrors(HOSP_1);
    assert.equal(onlyHosp1.length, 1);
    assert.equal(onlyHosp1[0]!.hospital_id, HOSP_1);

    const both = await svc.listSystemicErrors();
    assert.equal(both.length, 2);
  });
});
