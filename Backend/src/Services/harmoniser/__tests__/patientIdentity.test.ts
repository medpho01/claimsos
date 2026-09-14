/**
 * Hard-identifier identity checks.
 *
 * Regression cover for production claim e54c89c0 (2026-09-14): the patient's
 * bundle contained his WIFE's Aadhaar card, and it was listed as SUPPORTING
 * his identity at confidence 1.0 with uncertain:false.
 *
 * Cause: clustering compares names via `distinctiveToken`, which reduces a
 * name to its single longest token. "K Srikanth Rao" and "Kala Srikanth" both
 * reduce to "srikanth", so the distance was 0.0 and they were the same person.
 *
 * The fix must separate two things that name distance CANNOT separate:
 *   - benign Indian name variation (initials, word order, transliteration) —
 *     "K Srikanth Rao" and "Shrikantha Rao" really are one person;
 *   - a genuinely different human who happens to share a patronymic.
 * Hard identifiers (Aadhaar number, gender) are the discriminators; the tests
 * below pin BOTH directions, because a fix that flags the spouse by making
 * name matching stricter would break every legitimate claim.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractHardIdentity,
  hardIdentityConflict,
  findCanonicalPatient,
  normalisedNameDistance,
} from '../patientIdentity.js';

type Section = Parameters<typeof findCanonicalPatient>[0][number];

function section(
  section_id: string,
  category: string,
  extracted_fields: Record<string, unknown>,
): Section {
  return { section_id, category, extracted_fields } as Section;
}

// The real documents from claim e54c89c0.
const PATIENT_FRONT = section('S_front', 'aadhaar_front', {
  full_name: 'K Srikanth Rao',
  gender: 'M',
  aadhaar_number: '334603247720',
});
const SPOUSE_CARD = section('S_card', 'aadhaar_card', {
  holder_name: 'Kala Srikanth',
  gender: 'female',
  aadhaar_number: '878773290597',
  address: 'W/O R Srikanth Rao, NO 11/7, 3RD CROSS 1ST MAIN NAGAPPA STREET',
});
const SEED = 'Shrikantha Rao';

describe('patientIdentity — the name collapse that caused the bug', () => {
  it('confirms name distance alone CANNOT tell the spouse apart', () => {
    // Documents the root cause. If this ever stops being ~0, the clustering
    // changed and the hard-identifier guard may deserve re-tuning.
    const d = normalisedNameDistance('K Srikanth Rao', 'Kala Srikanth');
    assert.ok(d < 0.3, `expected a near-zero distance, got ${d}`);
  });
});

describe('extractHardIdentity', () => {
  it('parses aadhaar, gender and the S/O relationship prefix', () => {
    const h = extractHardIdentity({
      full_name: 'K Srikanth Rao',
      gender: 'M',
      aadhaar_number: '3346 0324 7720',
      address: 'S/O V Krishnaji Rao, NO 11/7 GROUND FLOOR',
    });
    assert.equal(h.aadhaar, '334603247720');
    assert.equal(h.gender, 'M');
    assert.equal(h.relation, 'S/O');
  });

  it('normalises the two different gender vocabularies to one', () => {
    // aadhaar_front emits M/F/O (migration 048); aadhaar_card emits
    // male/female/other (059). Skew must not read as disagreement.
    assert.equal(extractHardIdentity({ gender: 'M' }).gender, 'M');
    assert.equal(extractHardIdentity({ gender: 'male' }).gender, 'M');
    assert.equal(extractHardIdentity({ gender: 'female' }).gender, 'F');
    assert.equal(extractHardIdentity({ gender: 'other' }).gender, null);
    assert.equal(extractHardIdentity({}).gender, null);
  });

  it('rejects an unparseable aadhaar rather than guessing', () => {
    assert.equal(extractHardIdentity({ aadhaar_number: '3346 0324' }).aadhaar, null);
    assert.equal(extractHardIdentity({ aadhaar_number: 'XXXX' }).aadhaar, null);
  });

  it('parses W/O from the spouse card', () => {
    assert.equal(extractHardIdentity(SPOUSE_CARD.extracted_fields as any).relation, 'W/O');
  });
});

describe('hardIdentityConflict — must NOT fire (benign variation)', () => {
  const patient = extractHardIdentity(PATIENT_FRONT.extracted_fields as any);

  it('same aadhaar, same gender', () => {
    assert.equal(hardIdentityConflict(patient, { ...patient }), null);
  });

  it('aadhaar OCR drift of one digit is one number misread, not two people', () => {
    const drifted = { ...patient, aadhaar: '334603247726' };
    assert.equal(hardIdentityConflict(patient, drifted), null);
  });

  it('gender absent on one side is insufficient evidence, not disagreement', () => {
    assert.equal(hardIdentityConflict(patient, { ...patient, gender: null }), null);
  });

  it('relationship prefix alone never triggers a conflict', () => {
    assert.equal(
      hardIdentityConflict(
        { aadhaar: null, gender: null, relation: 'S/O' },
        { aadhaar: null, gender: null, relation: 'W/O' },
      ),
      null,
    );
  });
});

describe('hardIdentityConflict — must fire', () => {
  it('flags a different aadhaar number', () => {
    const c = hardIdentityConflict(
      { aadhaar: '334603247720', gender: null, relation: null },
      { aadhaar: '878773290597', gender: null, relation: null },
    );
    assert.equal(c?.kind, 'aadhaar_number');
  });

  it('flags an explicit M vs F disagreement even with no aadhaar', () => {
    const c = hardIdentityConflict(
      { aadhaar: null, gender: 'M', relation: null },
      { aadhaar: null, gender: 'F', relation: null },
    );
    assert.equal(c?.kind, 'gender');
  });
});

describe('findCanonicalPatient — the e54c89c0 bundle', () => {
  it("evicts the spouse's card from supporting evidence and flags it", () => {
    const r = findCanonicalPatient([PATIENT_FRONT, SPOUSE_CARD], SEED);
    assert.ok(r, 'expected a canonical patient');
    assert.deepEqual(r!.supporting_section_ids, ['S_front']);
    assert.deepEqual(r!.conflicting_section_ids, ['S_card']);
    assert.equal(r!.uncertain, true);
    assert.ok(r!.confidence < 1, `expected confidence < 1, got ${r!.confidence}`);
    assert.ok(
      r!.hard_conflicts.some((h) => h.conflict.kind === 'aadhaar_number'),
      'expected the differing aadhaar to be reported',
    );
  });

  it('leaves a genuine same-person bundle completely untouched', () => {
    // The false-positive guard. Initials, word order and transliteration all
    // differ, exactly as they do across real Indian ID documents — but the
    // aadhaar and gender agree, so this must behave as it always has.
    const front = section('A', 'aadhaar_front', {
      full_name: 'K Srikanth Rao',
      gender: 'M',
      aadhaar_number: '334603247720',
    });
    const card = section('B', 'aadhaar_card', {
      holder_name: 'SRIKANTHA RAO K',
      gender: 'male',
      aadhaar_number: '3346 0324 7720',
    });
    const r = findCanonicalPatient([front, card], SEED);
    assert.ok(r);
    assert.equal(r!.conflicting_section_ids.length, 0);
    assert.deepEqual(r!.supporting_section_ids.sort(), ['A', 'B']);
    assert.equal(r!.uncertain, false);
    assert.equal(r!.confidence, 1);
  });

  it('does not judge what it cannot measure (no hard identifiers present)', () => {
    const a = section('A', 'discharge_summary', { patient_name: 'Shrikantha Rao' });
    const b = section('B', 'final_bill', { patient_name: 'Shrikantha Rao K' });
    const r = findCanonicalPatient([a, b], SEED);
    assert.ok(r);
    assert.equal(r!.conflicting_section_ids.length, 0);
    assert.equal(r!.hard_conflicts.length, 0);
  });
});
