import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateEpisode,
  validateLabValue,
  validateLengthOfStay,
  LOW_CONFIDENCE_ABSTAIN,
} from '../validators.service.js';
import { FusedEpisode, FusedField } from '../fusion.service.js';
import { CanonicalField } from '../types.js';

/**
 * Tests for the Stage 6 value-level validators + loud abstention.
 *
 * Run: docker exec hospital_worker_dev npx tsx --test \
 *        src/Services/pipelineV2/__tests__/validators.test.ts
 *
 * Asserts: a physically-impossible lab is caught as a decimal shift WITH the
 * corrected value; a genuinely-high enzyme (no hard bound) is NOT false-
 * flagged; negative + implausible LOS abstain; a Left↔Right laterality
 * conflict abstains (wrong-side guard); a diagnosis with no authoritative
 * source abstains (D3 partner); a clean episode passes.
 */

function ff(field: CanonicalField, value: string, over: Partial<FusedField> = {}): FusedField {
  return {
    field,
    value,
    sourceDocType: over.sourceDocType ?? 'discharge_summary',
    sourcePageId: over.sourcePageId ?? 'pg-1',
    quote: over.quote,
    confidence: over.confidence ?? 0.9,
    authorityRank: over.authorityRank ?? 0,
    fromAuthoritativeSource: over.fromAuthoritativeSource ?? true,
    contested: over.contested ?? false,
    candidates: over.candidates ?? [],
  };
}

function episode(over: Partial<FusedEpisode> = {}): FusedEpisode {
  return {
    secondary_diagnosis: [],
    medications: [],
    implants: [],
    lab_values: [],
    vitals: [],
    complaints: [],
    findings: [],
    allergies: [],
    anaesthesia: [],
    conflicts: [],
    ...over,
  };
}

describe('Stage 6 — validators', () => {
  it('catches a decimal-shift lab (pH 70.2 → 7.02) and abstains with a fix', () => {
    const issue = validateLabValue('pH 70.2');
    assert.ok(issue);
    assert.equal(issue!.code, 'decimal_shift');
    assert.equal(issue!.severity, 'abstain');
    assert.match(issue!.suggested ?? '', /7\.02/);
  });

  it('catches Hb 140 as a decimal shift (→ 14)', () => {
    const issue = validateLabValue('Hemoglobin 140 g/L');
    assert.ok(issue);
    assert.equal(issue!.code, 'decimal_shift');
    assert.match(issue!.suggested ?? '', /\b14\b/);
  });

  it('does NOT false-flag a genuinely high liver enzyme (no hard bound)', () => {
    // SGPT/SGOT can truly reach 1000s in acute hepatitis — not in the table,
    // so the validator must stay silent rather than invent a decimal shift.
    assert.equal(validateLabValue('SGPT 1234 U/L'), null);
    assert.equal(validateLabValue('SGOT: 980'), null);
  });

  it('passes an in-range lab silently', () => {
    assert.equal(validateLabValue('pH 7.36'), null);
    assert.equal(validateLabValue('Serum K 4.2 mmol/L'), null);
  });

  it('does NOT flag a normal fever printed in Fahrenheit', () => {
    // A normal fever (~38 °C) reads ~100–101 °F — these must NOT trip the
    // Celsius [30,45] bound and emit a spurious lab_out_of_range.
    assert.equal(validateLabValue('Temperature 100.5°F'), null);
    assert.equal(validateLabValue('Temp 98.6 F'), null);
    // A high but real fever in Fahrenheit (104 °F = 40 °C) is still valid.
    assert.equal(validateLabValue('Temperature 104 F'), null);
  });

  it('still treats a low Celsius temperature as Celsius', () => {
    assert.equal(validateLabValue('Temperature 38.5'), null, 'normal Celsius fever is valid');
    assert.equal(validateLabValue('Temp 36.8°C'), null, 'normal Celsius temp is valid');
  });

  it('catches a decimal-shifted Celsius temperature (385 → 38.5)', () => {
    const issue = validateLabValue('Temperature 385');
    assert.ok(issue);
    assert.equal(issue!.code, 'decimal_shift');
    assert.match(issue!.suggested ?? '', /38\.5/);
  });

  it('still flags a genuinely impossible temperature', () => {
    // 200 is neither a valid °F (>113) nor recoverable by a power-of-ten shift
    // into the Celsius range, so it stays flagged out of range.
    const issue = validateLabValue('Temperature 200');
    assert.ok(issue);
    assert.equal(issue!.code, 'lab_out_of_range');
  });

  it('does not mistake an unrelated F-bearing word for Fahrenheit', () => {
    // "Temperature 38.5 (febrile)" is Celsius — the F in "febrile" must not flip
    // it to the Fahrenheit window. 38.5 is in [30,45] °C, so it stays valid.
    assert.equal(validateLabValue('Temperature 38.5 (febrile)'), null);
  });

  it('abstains on negative length of stay (discharge before admission)', () => {
    const issue = validateLengthOfStay(ff('admission_date', '15/02/2026'), ff('discharge_date', '12/02/2026'));
    assert.ok(issue);
    assert.equal(issue!.code, 'negative_los');
    assert.equal(issue!.severity, 'abstain');
  });

  it('abstains on an implausibly long stay, warns on a merely-long one', () => {
    const impossible = validateLengthOfStay(ff('admission_date', '01/01/2025'), ff('discharge_date', '01/06/2026'));
    assert.equal(impossible!.severity, 'abstain');
    const long = validateLengthOfStay(ff('admission_date', '01/01/2026'), ff('discharge_date', '01/06/2026'));
    assert.equal(long!.severity, 'warn');
  });

  it('a normal LOS produces no issue', () => {
    assert.equal(validateLengthOfStay(ff('admission_date', '12/02/2026'), ff('discharge_date', '15/02/2026')), null);
  });

  it('abstains on a Left↔Right laterality conflict (wrong-side guard)', () => {
    const ep = episode({
      laterality: ff('laterality', 'Right', {
        contested: true,
        candidates: [
          { value: 'Right', sourceDocType: 'ot_notes', sourcePageId: 'O', confidence: 0.9, authorityRank: 0 },
          { value: 'Left', sourceDocType: 'discharge_summary', sourcePageId: 'D', confidence: 0.9, authorityRank: 5 },
        ],
      }),
    });
    const report = validateEpisode(ep);
    assert.equal(report.mustAbstain, true);
    assert.ok(report.abstainedFields.includes('laterality'));
    assert.ok(report.issues.some((i) => i.code === 'laterality_conflict'));
  });

  it('abstains on a diagnosis with no authoritative source (D3 partner rule)', () => {
    const ep = episode({
      primary_diagnosis: ff('primary_diagnosis', 'Viral fever', {
        sourceDocType: 'others',
        fromAuthoritativeSource: false,
        confidence: 0.95,
      }),
    });
    const report = validateEpisode(ep);
    assert.equal(report.mustAbstain, true);
    assert.ok(report.issues.some((i) => i.code === 'diagnosis_no_authority'));
  });

  it('harmonises-with-a-flag when no authoritative diagnosis source exists in the bundle', () => {
    // Real "Sunil Kori" case: diagnosis read from `admission_notes` (not in the
    // authority list — the list uses `admission_form`), and the bundle contained
    // ONLY admission_notes + others. With no discharge/OT/clinical source to
    // protect, this must DOWNGRADE to a warn, not hard-abstain.
    const ep = episode({
      primary_diagnosis: ff('primary_diagnosis', 'Acute gastroenteritis', {
        sourceDocType: 'admission_notes',
        fromAuthoritativeSource: false,
        confidence: 0.85,
      }),
      presentDocTypes: ['admission_notes', 'others'],
    });
    const report = validateEpisode(ep);
    assert.equal(report.mustAbstain, false, 'no authority in bundle → flag, not block');
    const issue = report.issues.find((i) => i.code === 'diagnosis_no_authority');
    assert.ok(issue, 'a diagnosis_no_authority issue is still emitted');
    assert.equal(issue!.severity, 'warn');
  });

  it('still abstains when an authoritative source IS present but the winner came from elsewhere (D3 preserved)', () => {
    const ep = episode({
      primary_diagnosis: ff('primary_diagnosis', 'Viral fever', {
        sourceDocType: 'others',
        fromAuthoritativeSource: false,
        confidence: 0.95,
      }),
      presentDocTypes: ['discharge_summary', 'others'],
    });
    const report = validateEpisode(ep);
    assert.equal(report.mustAbstain, true, 'an authoritative source exists → D3 abstain holds');
    assert.ok(report.issues.some((i) => i.code === 'diagnosis_no_authority' && i.severity === 'abstain'));
  });

  it('abstains on a low-confidence diagnosis even from an authoritative source', () => {
    const ep = episode({
      primary_diagnosis: ff('primary_diagnosis', 'Sepsis', {
        fromAuthoritativeSource: true,
        confidence: LOW_CONFIDENCE_ABSTAIN - 0.1,
      }),
    });
    const report = validateEpisode(ep);
    assert.ok(report.issues.some((i) => i.code === 'low_confidence'));
  });

  it('a clean episode does not abstain', () => {
    const ep = episode({
      primary_diagnosis: ff('primary_diagnosis', 'Acute MI', { confidence: 0.9 }),
      laterality: ff('laterality', 'Right', { contested: false }),
      admission_date: ff('admission_date', '12/02/2026'),
      discharge_date: ff('discharge_date', '18/02/2026'),
      lab_values: [ff('lab_value', 'pH 7.36'), ff('lab_value', 'SGPT 1234')],
    });
    const report = validateEpisode(ep);
    assert.equal(report.mustAbstain, false);
    assert.deepEqual(report.abstainedFields, []);
  });
});
