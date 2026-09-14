/**
 * Unit tests for the H2-harm permissive diagnosis-name validator.
 *
 * Runner: node:test (matches the rest of Backend). Execute with:
 *   npx tsx --test src/Services/extractor/__tests__/postValidators.test.ts
 *
 * Covers the iter5 accuracy-bench regressions and the original
 * person-name / boilerplate / chief-complaint protections.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateDiagnosisName } from '../postValidators.js';

describe('validateDiagnosisName — permissive accepts', () => {
  it('accepts "Suspected Typhoid Fever" (Shabana iter5 regression)', () => {
    const r = validateDiagnosisName('Suspected Typhoid Fever');
    assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  });

  it('accepts "AWMI"', () => {
    const r = validateDiagnosisName('AWMI');
    assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  });

  it('accepts "Acute MI with TVD"', () => {
    const r = validateDiagnosisName('Acute MI with TVD');
    assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  });

  it('accepts "# Both bone forearm" (fracture shorthand)', () => {
    const r = validateDiagnosisName('# Both bone forearm');
    assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  });

  it('accepts "OA Lt knee Grade III"', () => {
    const r = validateDiagnosisName('OA Lt knee Grade III');
    assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  });

  it('accepts "Distal radius fracture right"', () => {
    const r = validateDiagnosisName('Distal radius fracture right');
    assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  });

  it('accepts "Dengue hemorrhagic fever"', () => {
    const r = validateDiagnosisName('Dengue hemorrhagic fever');
    assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  });

  it('accepts "T2DM with hypertension"', () => {
    const r = validateDiagnosisName('T2DM with hypertension');
    assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  });

  it('accepts "Acute appendicitis"', () => {
    const r = validateDiagnosisName('Acute appendicitis');
    assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  });

  it('accepts "Lower respiratory tract infection"', () => {
    const r = validateDiagnosisName('Lower respiratory tract infection');
    assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
  });
});

describe('validateDiagnosisName — pure-symptom rejects', () => {
  it('rejects "Chest pain" (Kalksum case)', () => {
    const r = validateDiagnosisName('Chest pain');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /pure_symptom/);
  });

  it('rejects "Acute fever" (generic, no etiology)', () => {
    const r = validateDiagnosisName('Acute fever');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /pure_symptom/);
  });

  it('rejects bare "Fever"', () => {
    const r = validateDiagnosisName('Fever');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /pure_symptom/);
  });

  it('rejects "Headache"', () => {
    const r = validateDiagnosisName('Headache');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /pure_symptom/);
  });

  it('rejects "Abdominal pain"', () => {
    const r = validateDiagnosisName('Abdominal pain');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /pure_symptom/);
  });

  it('rejects "Cough"', () => {
    const r = validateDiagnosisName('Cough');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /pure_symptom/);
  });
});

describe('validateDiagnosisName — boilerplate rejects', () => {
  it('rejects "Orthopaedics case - trauma/injury related"', () => {
    const r = validateDiagnosisName('Orthopaedics case - trauma/injury related');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /blocklist_phrase/);
  });

  it('rejects "Surgical condition requiring intervention"', () => {
    const r = validateDiagnosisName('Surgical condition requiring intervention');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /blocklist_phrase/);
  });

  it('rejects "Not specified"', () => {
    const r = validateDiagnosisName('Not specified');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /blocklist_phrase/);
  });
});

describe('validateDiagnosisName — person-name rejects', () => {
  it('rejects "Mr. Anuj Pal"', () => {
    const r = validateDiagnosisName('Mr. Anuj Pal');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /person_name|looks_like_person_name/);
  });

  it('rejects "Mr. Anuj Pal with chest pain" (name + chief complaint)', () => {
    const r = validateDiagnosisName('Mr. Anuj Pal with chest pain');
    assert.equal(r.ok, false, `expected reject, got ok=true`);
    assert.match(r.reason ?? '', /person_name_with_symptom|pure_symptom/);
  });

  it('rejects "Saqish Singh"', () => {
    const r = validateDiagnosisName('Saqish Singh');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /person_name|looks_like_person_name/);
  });

  it('rejects "Sunil Yadav"', () => {
    const r = validateDiagnosisName('Sunil Yadav');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /person_name|looks_like_person_name/);
  });
});

describe('validateDiagnosisName — empty / degenerate', () => {
  it('rejects null', () => {
    const r = validateDiagnosisName(null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty_or_non_string');
  });

  it('rejects undefined', () => {
    const r = validateDiagnosisName(undefined);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty_or_non_string');
  });

  it('rejects empty string', () => {
    const r = validateDiagnosisName('');
    assert.equal(r.ok, false);
  });

  it('rejects 2-char strings', () => {
    const r = validateDiagnosisName('Hi');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'too_short');
  });

  it('rejects garbage with no clinical content', () => {
    const r = validateDiagnosisName('lorem ipsum dolor');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_clinical_keywords');
  });
});

/**
 * Specialty vocabulary — regression cover for the 2026-09-14 production
 * failure on claim e54c89c0 (iDrishti Channapatna, an EYE hospital).
 *
 * "Left Eye Posterior Polar Cataract" was rejected as `no_clinical_keywords`,
 * its diagnosis nulled and the episode docked 0.25 completeness. Cause: this
 * list was rebuilt from the iter5 bench (ortho / general medicine / cardiac)
 * and dropped the ophthalmology terms the previous validator had carried at
 * Services/harmoniser/diagnosisValidator.ts:144. Cataract/IOL is that
 * customer's highest-volume procedure, so the modal claim was failing.
 */
describe('validateDiagnosisName — specialty vocabulary', () => {
  const ACCEPTS: ReadonlyArray<[string, string]> = [
    ['ophthalmology', 'Left Eye Posterior Polar Cataract'],
    ['ophthalmology', 'Immature Senile Cataract Right Eye'],
    ['ophthalmology', 'Mature Cataract Both Eyes'],
    ['ophthalmology', 'Pseudophakia'],
    ['ophthalmology', 'Aphakia'],
    ['ophthalmology', 'Retinal Detachment Left Eye'],
    ['ophthalmology', 'Pterygium Right Eye'],
    ['ophthalmology', 'Age Related Macular Degeneration'],
    ['ophthalmology', 'Refractive Error Both Eyes'],
    ['ophthalmology', 'Posterior Capsular Opacification'],
    ['ent', 'Deviated Nasal Septum'],
    ['ent', 'Sensorineural Hearing Loss'],
    ['ent', 'Adenoid Hypertrophy'],
    ['urology', 'Benign Prostatic Hyperplasia'],
    ['urology', 'Undescended Testis'],
    ['obstetrics', 'Breech Presentation'],
    ['obstetrics', 'Twin Gestation'],
    ['obstetrics', 'Oligohydramnios'],
    ['general medicine', 'Hypotension'],
  ];

  for (const [specialty, name] of ACCEPTS) {
    it(`accepts ${specialty}: "${name}"`, () => {
      const r = validateDiagnosisName(name);
      assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
    });
  }

  // Secondary defect: postValidators.ts:985 labels ANY two title-cased words
  // with no keyword hit as a person name, so reviewers triaging these saw
  // real diagnoses reported as hallucinated patient names. Restoring the
  // vocabulary makes a clinical token survive, so the regex stops firing.
  for (const name of ['Pilonidal Sinus', 'Psoriasis Vulgaris']) {
    it(`accepts "${name}" and does NOT call it a person name`, () => {
      const r = validateDiagnosisName(name);
      assert.equal(r.ok, true, `expected ok=true, got reason=${r.reason}`);
      assert.notEqual(r.reason, 'looks_like_person_name');
    });
  }
});

/**
 * The vocabulary expansion must not reopen the hole the validator exists to
 * plug. These are the four named production hallucinations from the 30-patient
 * Sadbhawana smoke test (see Services/harmoniser/diagnosisValidator.ts:5-18),
 * re-asserted against the EXPANDED list.
 */
describe('validateDiagnosisName — hallucination guards survive the expansion', () => {
  const REJECTS: ReadonlyArray<string> = [
    'Saqish Singh',                                 // patient name off a consent form
    'Orthopaedics case - trauma/injury related',    // LLM generic fallback
    'Surgical condition requiring intervention',    // LLM generic fallback
    'WITH A/E POP SLAB',                            // fragment of treatment text
    'Patient seen in OPD',                          // free-text fragment
    'lorem ipsum',
  ];

  for (const name of REJECTS) {
    it(`still rejects "${name}"`, () => {
      const r = validateDiagnosisName(name);
      assert.equal(r.ok, false, `expected rejection, but "${name}" was accepted`);
    });
  }
});
