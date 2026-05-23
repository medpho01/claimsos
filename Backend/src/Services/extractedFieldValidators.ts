/**
 * Extracted-field validators — post-extraction sanity checks against
 * known field invariants. Run by the doc extractor after the LLM returns
 * structured data; when a value fails its invariant, we down-weight the
 * field's confidence so the UI flags it for human review.
 *
 * Why post-extraction instead of inside the LLM call:
 *   - Some invariants are computational (Verhoeff checksum on Aadhaar
 *     numbers, Luhn on credit cards, GSTIN check-digit). Asking the LLM
 *     to verify these is unreliable — they'd need to do the math
 *     inline, and Tesseract's digit OCR errors (9↔0, 6↔0, 5↔S) are
 *     exactly the cases where the LLM should defer to a deterministic
 *     check, not its own arithmetic.
 *   - Invariants are stable across documents and don't belong in
 *     prompts (which we want short).
 *
 * What we don't do here:
 *   - Cross-field validation (e.g. "DOB must be earlier than discharge
 *     date"). That's the rules-engine layer's job.
 *   - Authoritative lookups (e.g. hitting a UIDAI API to verify an
 *     Aadhaar exists). Out of scope; PCI/PII-regulated.
 *
 * Registry pattern: validators are keyed by (doc_category, field_key) so
 * we can iterate per-extraction and only run the ones that apply. New
 * validators are added by exporting a function and registering it here.
 */

import { logger } from '../Utils/logger.js';

export interface FieldValidationResult {
  /** True when the value is consistent with the field's invariant. */
  valid: boolean;
  /** Short machine-readable reason code (e.g. 'verhoeff_failed', 'wrong_length'). */
  reason?: string;
  /** Optional normalised form (whitespace-stripped, etc.) the caller may persist instead. */
  normalisedValue?: string;
}

/** Function shape every validator implements. */
export type FieldValidator = (value: unknown) => FieldValidationResult;

// ─── Aadhaar: 12-digit + Verhoeff checksum ────────────────────────────────

/**
 * Verhoeff multiplication table d.
 * Reference: https://en.wikipedia.org/wiki/Verhoeff_algorithm
 */
const VERHOEFF_D: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

/** Permutation table p. */
const VERHOEFF_P: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Returns true if the given digit string passes Verhoeff. */
export function verhoeffValid(digits: string): boolean {
  let c = 0;
  // Digits are processed right-to-left.
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    const d = Number.parseInt(reversed[i]!, 10);
    if (!Number.isInteger(d) || d < 0 || d > 9) return false;
    c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![d]!]!;
  }
  return c === 0;
}

/**
 * Aadhaar number validator. Returns valid + Verhoeff-checked when the
 * string is exactly 12 digits AND passes the checksum. Strips spaces /
 * hyphens before validating so "6978 2591 6544" and "6978-2591-6544"
 * both work. Aadhaar numbers also cannot start with 0 or 1 — those are
 * reserved by UIDAI — so we reject those too.
 */
export const validateAadhaarNumber: FieldValidator = (value) => {
  if (typeof value !== 'string') {
    return { valid: false, reason: 'not_string' };
  }
  const stripped = value.replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(stripped)) {
    return { valid: false, reason: 'wrong_length_or_chars' };
  }
  if (stripped[0] === '0' || stripped[0] === '1') {
    return { valid: false, reason: 'reserved_leading_digit' };
  }
  if (!verhoeffValid(stripped)) {
    return { valid: false, reason: 'verhoeff_failed', normalisedValue: stripped };
  }
  return { valid: true, normalisedValue: stripped };
};

// ─── PIN code: 6 digits ──────────────────────────────────────────────────
export const validatePinCode: FieldValidator = (value) => {
  if (typeof value !== 'string') return { valid: false, reason: 'not_string' };
  const stripped = value.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(stripped)) {
    return { valid: false, reason: 'wrong_length' };
  }
  // First digit ∈ [1..8] per India Post spec.
  if (stripped[0] === '0' || stripped[0] === '9') {
    return { valid: false, reason: 'invalid_pin_zone' };
  }
  return { valid: true, normalisedValue: stripped };
};

// ─── Registry ────────────────────────────────────────────────────────────

/**
 * (doc_category, field_key) → validator. When a category isn't listed,
 * no validation runs (treat as passing).
 */
const REGISTRY: Record<string, FieldValidator | undefined> = {
  'aadhaar_front:aadhaar_number': validateAadhaarNumber,
  'aadhaar_card:aadhaar_number': validateAadhaarNumber,
  'aadhaar_card:pin_code': validatePinCode,
  'ration_card:pin_code': validatePinCode,
};

/**
 * Validate every applicable field on a single extraction. Returns a map
 * of `{ field_key: result }` for fields that HAVE a validator (omitted
 * fields had no registered validator and should be treated as passing).
 */
export function validateExtractedFields(
  docCategory: string,
  fields: Record<string, unknown>,
): Record<string, FieldValidationResult> {
  const results: Record<string, FieldValidationResult> = {};
  for (const [fieldKey, value] of Object.entries(fields)) {
    const validator = REGISTRY[`${docCategory}:${fieldKey}`];
    if (!validator) continue;
    try {
      results[fieldKey] = validator(value);
    } catch (err) {
      logger.warn(
        { err: (err as any)?.message ?? String(err), docCategory, fieldKey },
        'extractedFieldValidators: validator threw; treating field as valid',
      );
    }
  }
  return results;
}
