/**
 * Unit tests for the deterministic regex extractor.
 *
 * Uses Node's built-in `node:test` runner (same convention as the
 * sibling test files under src/Services/__tests__/). Run with:
 *
 *   npx tsx --test src/Services/extractor/__tests__/deterministicExtractors.test.ts
 *
 * Each pattern gets at least one positive and one negative case.
 * Negative cases are the failure modes we actually saw in the Iter5
 * accuracy bench / Sadbhawana smoke test — random 12-digit strings
 * masquerading as Aadhaar, mid-string digit runs that look like
 * mobiles, etc.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractDeterministicFacts,
  formatDeterministicFactsForPrompt,
} from '../deterministicExtractors.js';

// ─── Doctor NMC / MPMC registration ──────────────────────────────────────

test('NMC: matches "MPMC Reg. No. 21274" signature stamp', () => {
  const facts = extractDeterministicFacts(
    'Dr. Anil Sharma, MBBS, MS Orth\nMPMC Reg. No. 21274',
  );
  assert.equal(facts.doctor_nmc_ids.length, 1);
  assert.equal(facts.doctor_nmc_ids[0]!.council, 'MPMC');
  assert.equal(facts.doctor_nmc_ids[0]!.value, '21274');
});

test('NMC: matches "Reg No 68274" and "Reg. No. 66610" forms across councils', () => {
  const facts = extractDeterministicFacts(
    'Dr. P. Mehta\nMMC Reg No 68274\nDr. K. Nair\nKMC Reg. No. 66610',
  );
  const codes = facts.doctor_nmc_ids.map((d) => `${d.council}:${d.value}`).sort();
  assert.deepEqual(codes, ['KMC:66610', 'MMC:68274']);
});

test('NMC: does NOT match the council code embedded inside an unrelated string', () => {
  const facts = extractDeterministicFacts(
    'MyPersonalMedicalChart MPMC: not a reg number context here',
  );
  // "MPMC: not" has no digits within range — should yield nothing.
  assert.equal(facts.doctor_nmc_ids.length, 0);
});

// ─── Aadhaar — Verhoeff checksum gating ──────────────────────────────────

test('Aadhaar: accepts a real 12-digit number with valid Verhoeff', () => {
  // 676766078854 was pulled from the live DB and passes Verhoeff.
  const facts = extractDeterministicFacts(
    'Aadhaar No: 6767 6607 8854\nIssued by UIDAI',
  );
  assert.equal(facts.aadhaar_numbers.length, 1);
  assert.equal(facts.aadhaar_numbers[0]!.value, '676766078854');
  assert.equal(facts.aadhaar_numbers[0]!.valid_checksum, true);
});

test('Aadhaar: rejects a random 12-digit string that fails Verhoeff', () => {
  // 1234 5678 9012 — pure sequential, fails Verhoeff.
  const facts = extractDeterministicFacts('Random number: 1234 5678 9012');
  assert.equal(
    facts.aadhaar_numbers.length,
    0,
    'random 12-digit strings must not be reported as Aadhaar',
  );
});

test('Aadhaar: rejects numbers starting with 0 or 1 (UIDAI reserved)', () => {
  const facts = extractDeterministicFacts('Aadhaar: 0676 6607 8854');
  assert.equal(facts.aadhaar_numbers.length, 0);
});

// ─── PMJAY ───────────────────────────────────────────────────────────────

test('PMJAY: matches a 9-char alphanumeric card ID near "PMJAY" keyword', () => {
  const facts = extractDeterministicFacts(
    'PMJAY card number: MCETESFVS\nIssued under Ayushman Bharat',
  );
  const values = facts.pmjay_ids.map((p) => p.value);
  assert.ok(values.includes('MCETESFVS'), `expected MCETESFVS in ${JSON.stringify(values)}`);
});

test('PMJAY: ignores a 9-char alphanumeric that has no PMJAY context', () => {
  const facts = extractDeterministicFacts(
    'Lorem ipsum MCETESFVS dolor sit amet — unrelated context.',
  );
  assert.equal(facts.pmjay_ids.length, 0);
});

test('PMJAY: matches long-digit beneficiary IDs near Beneficiary keyword', () => {
  const facts = extractDeterministicFacts(
    'Beneficiary ID: 91516120237677\nName: Hina',
  );
  assert.ok(facts.pmjay_ids.some((p) => p.value === '91516120237677'));
});

// ─── ABHA ────────────────────────────────────────────────────────────────

test('ABHA: matches 14-digit health ID near ABHA keyword', () => {
  const facts = extractDeterministicFacts(
    'ABHA Number: 91-1234-5678-9012\nName: Test Patient',
  );
  assert.ok(facts.abha_numbers.some((a) => a.value === '91123456789012'));
});

test('ABHA: ignores 14-digit run with no ABHA context', () => {
  const facts = extractDeterministicFacts('Just some 12 3456 7890 1234 digits here');
  assert.equal(facts.abha_numbers.length, 0);
});

// ─── Mobile ──────────────────────────────────────────────────────────────

test('Mobile: matches 10-digit number starting 9 with +91 prefix', () => {
  const facts = extractDeterministicFacts(
    'Contact: +91 9340646614 or call us\n',
  );
  assert.ok(facts.mobile_numbers.some((m) => m.value === '9340646614'));
});

test('Mobile: rejects 10-digit number starting with 5 (not an Indian mobile)', () => {
  const facts = extractDeterministicFacts('Ref code: 5012345678');
  assert.equal(
    facts.mobile_numbers.length,
    0,
    'Indian mobiles must start 6-9',
  );
});

// ─── Dates ───────────────────────────────────────────────────────────────

test('Date: "12/2/26" with both DD and MM ≤ 12 is flagged ambiguous', () => {
  const facts = extractDeterministicFacts('Admitted on 12/2/26');
  assert.equal(facts.dates.length, 1);
  assert.equal(facts.dates[0]!.format_guess, 'ambiguous');
  // Default ordering DD/MM (Indian convention) → 2026-02-12.
  assert.equal(facts.dates[0]!.iso, '2026-02-12');
});

test('Date: "25/03/2026" is unambiguously DD/MM/YYYY', () => {
  const facts = extractDeterministicFacts('Discharged on 25/03/2026');
  assert.equal(facts.dates.length, 1);
  assert.equal(facts.dates[0]!.format_guess, 'DD/MM/YYYY');
  assert.equal(facts.dates[0]!.iso, '2026-03-25');
});

test('Date: rejects an impossible date like 32/13/2026', () => {
  const facts = extractDeterministicFacts('Random: 32/13/2026');
  assert.equal(facts.dates.length, 0);
});

test('Date: matches ISO 2026-02-12', () => {
  const facts = extractDeterministicFacts('event: 2026-02-12');
  assert.equal(facts.dates.length, 1);
  assert.equal(facts.dates[0]!.format_guess, 'YYYY-MM-DD');
  assert.equal(facts.dates[0]!.iso, '2026-02-12');
});

test('Date: matches "12 Feb 2026" month-name form', () => {
  const facts = extractDeterministicFacts('Surgery date: 12 Feb 2026');
  assert.ok(facts.dates.some((d) => d.iso === '2026-02-12'));
});

// ─── Currency ────────────────────────────────────────────────────────────

test('Currency: matches "Rs. 12,345.00" prefix form', () => {
  const facts = extractDeterministicFacts('Total bill amount: Rs. 12,345.00');
  assert.ok(facts.currency_amounts.some((c) => c.value_inr === 12345));
});

test('Currency: matches "12345/-" suffix form', () => {
  const facts = extractDeterministicFacts('Charges 12345/- for surgery');
  assert.ok(facts.currency_amounts.some((c) => c.value_inr === 12345));
});

test('Currency: does NOT match a plain integer with no rupee marker', () => {
  const facts = extractDeterministicFacts('Patient age 45 years');
  assert.equal(facts.currency_amounts.length, 0);
});

// ─── Empty / edge inputs ─────────────────────────────────────────────────

test('returns empty facts for empty/non-string input', () => {
  const facts = extractDeterministicFacts('');
  assert.equal(facts.aadhaar_numbers.length, 0);
  assert.equal(facts.doctor_nmc_ids.length, 0);
  // @ts-expect-error — verifying defensive null check
  const facts2 = extractDeterministicFacts(null);
  assert.equal(facts2.aadhaar_numbers.length, 0);
});

// ─── Prompt formatter ────────────────────────────────────────────────────

test('formatDeterministicFactsForPrompt renders a DETECTED_FACTS block', () => {
  const facts = extractDeterministicFacts(
    'Dr. A. Mehta MPMC Reg. No. 21274\nAadhaar: 6767 6607 8854\nMobile: 9340646614',
  );
  const block = formatDeterministicFactsForPrompt(facts);
  assert.match(block, /DETECTED_FACTS/);
  assert.match(block, /MPMC 21274/);
  assert.match(block, /676766078854/);
  assert.match(block, /9340646614/);
});

test('formatDeterministicFactsForPrompt returns empty string when no facts', () => {
  const facts = extractDeterministicFacts('nothing structured here.');
  assert.equal(formatDeterministicFactsForPrompt(facts), '');
});

// ─── Combined real-world signature stamp ─────────────────────────────────

test('combined: catches MPMC reg on a realistic stamp blob', () => {
  // Simulated OCR of a doctor's signature stamp at the foot of an
  // OT note — the exact case Iter5 missed 3/3 times.
  const ocrBlob = `
    Dr. Anil R. Sharma
    MBBS, MS (Ortho), DNB
    Consultant Orthopaedic Surgeon
    Reg No: MPMC 21274
    Mob: +91 9876543210
  `;
  const facts = extractDeterministicFacts(ocrBlob);
  assert.equal(facts.doctor_nmc_ids.length, 1);
  assert.equal(facts.doctor_nmc_ids[0]!.value, '21274');
  assert.equal(facts.doctor_nmc_ids[0]!.council, 'MPMC');
  assert.ok(facts.mobile_numbers.some((m) => m.value === '9876543210'));
});
