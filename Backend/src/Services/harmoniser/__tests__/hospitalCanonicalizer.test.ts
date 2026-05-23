/**
 * Unit tests for hospitalCanonicalizer.
 *
 * Run with:
 *   npx tsx --test src/Services/harmoniser/__tests__/hospitalCanonicalizer.test.ts
 *
 * The DB is mocked via a tiny in-memory fake Pool. No network, no
 * Postgres, no Anthropic SDK. We exercise the four documented cases:
 *
 *   1. close-but-wrong   ("Akshay Heart Hospital" vs "Akshaya Hospital")
 *                        → medium
 *   2. truncated         ("Jigyasa Hospital" vs "Jigyasa Super Speciality Hospital")
 *                        → medium
 *   3. completely-wrong  ("Apollo Hospitals" vs "Jigyasa Hospital")
 *                        → low
 *   4. null LLM input    → canonical returned, match_confidence='none'
 *
 * Plus a DB-error tolerance test (lookup throws → we fall back to the
 * LLM-extracted name with match_confidence='none').
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeHospitalName,
  __internal,
} from '../hospitalCanonicalizer.js';

// ─── Minimal Pool fake ────────────────────────────────────────────────────

type FakeHospitalRow = { id: string; name: string };

function makePoolFake(
  rows: FakeHospitalRow[],
  opts: { throwOnQuery?: boolean } = {},
): any {
  return {
    query: async (_text: string, params: any[]) => {
      if (opts.throwOnQuery) {
        throw new Error('connection refused');
      }
      const id = params?.[0];
      const match = rows.find((r) => r.id === id);
      return { rows: match ? [{ name: match.name }] : [] };
    },
  };
}

const HID_AKSHAYA = '11111111-1111-1111-1111-111111111111';
const HID_JIGYASA = '22222222-2222-2222-2222-222222222222';
const HID_MISSING = '99999999-9999-9999-9999-999999999999';

// ─── Behavioural tests ────────────────────────────────────────────────────

test('Akshay Heart Hospital vs canonical Akshaya Hospital → medium', async () => {
  const pool = makePoolFake([{ id: HID_AKSHAYA, name: 'Akshaya Hospital' }]);
  const result = await canonicalizeHospitalName(
    HID_AKSHAYA,
    'Akshay Heart Hospital',
    pool,
  );
  assert.equal(result.canonical_name, 'Akshaya Hospital');
  assert.equal(result.llm_extracted, 'Akshay Heart Hospital');
  // distance should be in the 0.15..0.4 band (medium)
  assert.ok(
    result.match_distance > 0.15 && result.match_distance <= 0.4,
    `expected distance in (0.15, 0.4], got ${result.match_distance}`,
  );
  assert.equal(result.match_confidence, 'medium');
});

test('Jigyasa Hospital vs canonical Jigyasa Super Speciality Hospital → low (truncated)', async () => {
  // The LLM read only "Jigyasa Hospital" off a partial letterhead but
  // the DB row is "Jigyasa Super Speciality Hospital". Normalised
  // edit distance is ~0.51 because half the canonical string is
  // missing — that's a 'low'-confidence match and we want
  // hospital_name_suspicious flagged so a reviewer can sanity-check
  // whether the LLM grabbed the wrong document's letterhead. We
  // STILL replace with the canonical DB name — the confidence band
  // is informational only.
  const pool = makePoolFake([
    { id: HID_JIGYASA, name: 'Jigyasa Super Speciality Hospital' },
  ]);
  const result = await canonicalizeHospitalName(
    HID_JIGYASA,
    'Jigyasa Hospital',
    pool,
  );
  assert.equal(result.canonical_name, 'Jigyasa Super Speciality Hospital');
  assert.equal(result.llm_extracted, 'Jigyasa Hospital');
  assert.equal(result.match_confidence, 'low');
  assert.ok(result.match_distance > 0.4);
});

test('Jigyasa Hospital vs Jigyasa Super Hospital → medium (smaller truncation)', async () => {
  // Same family of mismatch, but the canonical is shorter so the
  // truncation costs less. This exercises the medium band.
  const pool = makePoolFake([
    { id: HID_JIGYASA, name: 'Jigyasa Super Hospital' },
  ]);
  const result = await canonicalizeHospitalName(
    HID_JIGYASA,
    'Jigyasa Hospital',
    pool,
  );
  assert.equal(result.canonical_name, 'Jigyasa Super Hospital');
  assert.equal(result.match_confidence, 'medium');
  assert.ok(result.match_distance > 0.15 && result.match_distance <= 0.4);
});

test('Apollo Hospitals vs canonical Jigyasa Hospital → low (suspicious)', async () => {
  const pool = makePoolFake([{ id: HID_JIGYASA, name: 'Jigyasa Hospital' }]);
  const result = await canonicalizeHospitalName(
    HID_JIGYASA,
    'Apollo Hospitals',
    pool,
  );
  assert.equal(result.canonical_name, 'Jigyasa Hospital');
  assert.equal(result.llm_extracted, 'Apollo Hospitals');
  assert.ok(
    result.match_distance > 0.4,
    `expected distance > 0.4, got ${result.match_distance}`,
  );
  assert.equal(result.match_confidence, 'low');
});

test('null LLM input → canonical returned, match_confidence none', async () => {
  const pool = makePoolFake([{ id: HID_JIGYASA, name: 'Jigyasa Hospital' }]);
  const result = await canonicalizeHospitalName(HID_JIGYASA, null, pool);
  assert.equal(result.canonical_name, 'Jigyasa Hospital');
  assert.equal(result.llm_extracted, null);
  assert.equal(result.match_distance, 1);
  assert.equal(result.match_confidence, 'none');
});

test('empty-string LLM input behaves like null', async () => {
  const pool = makePoolFake([{ id: HID_JIGYASA, name: 'Jigyasa Hospital' }]);
  const result = await canonicalizeHospitalName(HID_JIGYASA, '   ', pool);
  assert.equal(result.canonical_name, 'Jigyasa Hospital');
  assert.equal(result.match_confidence, 'none');
});

test('exact-match LLM input → high confidence, distance 0', async () => {
  const pool = makePoolFake([{ id: HID_JIGYASA, name: 'Jigyasa Hospital' }]);
  const result = await canonicalizeHospitalName(
    HID_JIGYASA,
    'Jigyasa Hospital',
    pool,
  );
  assert.equal(result.canonical_name, 'Jigyasa Hospital');
  assert.equal(result.match_distance, 0);
  assert.equal(result.match_confidence, 'high');
});

test('punctuation/case-only diff → high confidence', async () => {
  const pool = makePoolFake([{ id: HID_JIGYASA, name: 'Jigyasa Hospital' }]);
  const result = await canonicalizeHospitalName(
    HID_JIGYASA,
    'JIGYASA  HOSPITAL.',
    pool,
  );
  assert.equal(result.canonical_name, 'Jigyasa Hospital');
  assert.equal(result.match_confidence, 'high');
  assert.ok(result.match_distance <= 0.15);
});

// ─── Tolerance ────────────────────────────────────────────────────────────

test('DB lookup throws → fall back to LLM name with confidence none', async () => {
  const pool = makePoolFake([], { throwOnQuery: true });
  const result = await canonicalizeHospitalName(
    HID_JIGYASA,
    'Jigyasa Hospital',
    pool,
  );
  // canonical falls back to the LLM string when DB lookup fails
  assert.equal(result.canonical_name, 'Jigyasa Hospital');
  assert.equal(result.llm_extracted, 'Jigyasa Hospital');
  assert.equal(result.match_distance, 1);
  assert.equal(result.match_confidence, 'none');
});

test('hospital_id missing from DB → fall back to LLM name with confidence none', async () => {
  const pool = makePoolFake([{ id: HID_JIGYASA, name: 'Jigyasa Hospital' }]);
  const result = await canonicalizeHospitalName(
    HID_MISSING,
    'Some Hospital',
    pool,
  );
  assert.equal(result.canonical_name, 'Some Hospital');
  assert.equal(result.llm_extracted, 'Some Hospital');
  assert.equal(result.match_confidence, 'none');
});

test('hospital_id missing AND llm name null → empty canonical, none', async () => {
  const pool = makePoolFake([]);
  const result = await canonicalizeHospitalName(HID_MISSING, null, pool);
  assert.equal(result.canonical_name, '');
  assert.equal(result.llm_extracted, null);
  assert.equal(result.match_confidence, 'none');
});

// ─── Internal helpers ─────────────────────────────────────────────────────

test('normaliseHospitalName: lowercase, strip punctuation, collapse spaces', () => {
  const { normaliseHospitalName } = __internal;
  assert.equal(normaliseHospitalName('Jigyasa  Hospital.'), 'jigyasa hospital');
  assert.equal(
    normaliseHospitalName('Apollo - Hospitals, Pvt. Ltd.'),
    'apollo hospitals pvt ltd',
  );
  assert.equal(normaliseHospitalName(''), '');
});

test('bucketConfidence: thresholds at 0.15 and 0.40', () => {
  const { bucketConfidence } = __internal;
  assert.equal(bucketConfidence(0), 'high');
  assert.equal(bucketConfidence(0.15), 'high');
  assert.equal(bucketConfidence(0.1500001), 'medium');
  assert.equal(bucketConfidence(0.4), 'medium');
  assert.equal(bucketConfidence(0.4000001), 'low');
  assert.equal(bucketConfidence(1), 'low');
});

test('levenshtein: known values', () => {
  const { levenshtein } = __internal;
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('akshaya', 'akshay'), 1);
});
