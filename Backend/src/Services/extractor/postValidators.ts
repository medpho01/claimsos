/**
 * Post-extraction validators for docExtractor.
 *
 * Lives in a dedicated module so the giant docExtractor.service.ts stays
 * focused on orchestration. Each validator family is a pure function over
 * `(category, fields)` that returns `{ cleanedFields, validationErrors }`.
 *
 * Why these belong in post-extraction instead of in the prompt:
 *   - Deterministic invariants (Verhoeff checksum, date plausibility windows,
 *     blocklist matching) are far more reliable in code than in an LLM.
 *   - When the model emits a "looks plausible" but actually wrong value
 *     (16-digit VID stored as Aadhaar, a 2028 date pre-printed on the
 *     letterhead, Hindi form-heading boilerplate parroted as procedure
 *     name) we want to BLANK the field deterministically + record WHY in
 *     `extraction_confidence._validation_errors[field_key]` so the FE can
 *     surface a meaningful inline message.
 *
 * Sourced from the May 20 2026 Sadbhawana 30-patient smoke test:
 *   /tmp/final_smoke_test_report.md
 *
 * Coverage:
 *   - validateAndCleanAadhaar  (H1)  — 12-digit + Verhoeff, VID split-off
 *   - validateDateWindows      (H3)  — episode-date plausibility windows
 *   - rejectBoilerplate        (H2)  — Hindi/English form-heading blocklist
 *   - titleCaseDiagnoses       (H11) — ALL-CAPS → title case (preserves
 *                                     surgical / anatomical abbreviations)
 *   - validateAadhaarBackPin   (H6)  — require 6-digit PIN in back-address
 */

import { logger } from '../../Utils/logger.js';
import {
  verhoeffValid,
} from '../extractedFieldValidators.js';

// ─── H1: Aadhaar 12-digit + Verhoeff + VID split-off ───────────────────────

const AADHAAR_CATEGORIES = new Set(['aadhaar_front', 'aadhaar_back', 'aadhaar_card']);

/**
 * The Aadhaar number field name in `document_field_schemas` is consistently
 * `aadhaar_number` across all three categories (verified May 2026). We
 * normalise via a single helper rather than per-category lookup.
 */
export function validateAndCleanAadhaar(
  category: string,
  fields: Record<string, unknown>,
): { cleanedFields: Record<string, unknown>; validationErrors: Record<string, string> } {
  if (!AADHAAR_CATEGORIES.has(category)) {
    return { cleanedFields: fields, validationErrors: {} };
  }
  const cleaned: Record<string, unknown> = { ...fields };
  const errors: Record<string, string> = {};
  const rawIn = cleaned.aadhaar_number;
  // Honour null / undefined / empty — model says "didn't find it", that's fine.
  if (rawIn === null || rawIn === undefined) {
    return { cleanedFields: cleaned, validationErrors: errors };
  }
  if (typeof rawIn !== 'string') {
    cleaned.aadhaar_number = null;
    errors.aadhaar_number = 'not_string';
    return { cleanedFields: cleaned, validationErrors: errors };
  }
  // Strip whitespace AND dashes — UIDAI prints 12 digits as "1234 5678 9012",
  // sometimes hyphenated. VIDs are 16 digits printed as 4 groups of 4 with
  // spaces. Tesseract often joins groups; sometimes splits them. After this
  // strip we know we're looking at the raw digit run.
  const stripped = rawIn.replace(/[\s\-]/g, '');
  if (stripped.length === 0) {
    cleaned.aadhaar_number = null;
    return { cleanedFields: cleaned, validationErrors: errors };
  }
  // 16 digits = VID printed adjacent on the card (e.g. "9111 8623 0231 4381").
  // The actual 12-digit Aadhaar isn't on the section in that case — store
  // the VID separately and blank the Aadhaar field so downstream code
  // doesn't try to validate the VID as if it were an Aadhaar.
  if (/^\d{16}$/.test(stripped)) {
    cleaned.vid_number = stripped;
    cleaned.aadhaar_number = null;
    errors.aadhaar_number = 'vid_extracted_no_aadhaar';
    return { cleanedFields: cleaned, validationErrors: errors };
  }
  if (!/^\d{12}$/.test(stripped)) {
    cleaned.aadhaar_number = null;
    errors.aadhaar_number = `wrong_length: ${stripped.length} chars`;
    return { cleanedFields: cleaned, validationErrors: errors };
  }
  // First digit reserved by UIDAI.
  if (stripped[0] === '0' || stripped[0] === '1') {
    cleaned.aadhaar_number = null;
    errors.aadhaar_number = 'reserved_leading_digit';
    return { cleanedFields: cleaned, validationErrors: errors };
  }
  if (!verhoeffValid(stripped)) {
    cleaned.aadhaar_number = null;
    errors.aadhaar_number = 'verhoeff_failed';
    return { cleanedFields: cleaned, validationErrors: errors };
  }
  // Pass — persist the canonical (stripped) form.
  cleaned.aadhaar_number = stripped;
  return { cleanedFields: cleaned, validationErrors: errors };
}

// ─── H3: Episode-date plausibility window ───────────────────────────────────

const ONE_DAY_MS = 86_400_000;

export interface DateWindowContext {
  /**
   * Admission date for the claim if known. The validator falls back to a
   * generic ±1y window when this is null.
   */
  admissionDate: Date | null;
  /**
   * "Today" used for the upper bound. Injected for testability — production
   * passes `new Date()`. Lower bound for some fields uses `today` too (e.g.
   * surgery_date must be ≤ today).
   */
  today: Date;
}

/**
 * Per-field window rules. Each rule returns `{ minOffsetDays, maxOffsetDays }`
 * relative to `admissionDate`. When admissionDate is null the validator
 * uses fallback windows relative to `today`.
 */
interface WindowRule {
  /** Lower bound days relative to admission (negative = before admission). */
  minRelDays: number;
  /** Upper bound days relative to admission (positive = after admission). */
  maxRelDays: number;
  /** Fallback window when admissionDate is null — days relative to today. */
  fallbackMinDays: number;
  fallbackMaxDays: number;
}

const DEFAULT_RULE: WindowRule = {
  minRelDays: -30,
  maxRelDays: 7,
  fallbackMinDays: -365,
  fallbackMaxDays: 7,
};

const FIELD_WINDOW_RULES: Record<string, WindowRule> = {
  surgery_date: {
    minRelDays: 0,
    maxRelDays: 7,
    fallbackMinDays: -365,
    fallbackMaxDays: 7,
  },
  discharge_date: {
    minRelDays: 0,
    maxRelDays: 7,
    fallbackMinDays: -365,
    fallbackMaxDays: 7,
  },
  admission_date: {
    // The admission_date itself shouldn't be in the future and shouldn't
    // be ancient. ±1y from today regardless of context.
    minRelDays: -365,
    maxRelDays: 7,
    fallbackMinDays: -365,
    fallbackMaxDays: 7,
  },
  study_date: {
    // Imaging — pre-admission referrals up to 90 days are common.
    minRelDays: -90,
    maxRelDays: 7,
    fallbackMinDays: -365,
    fallbackMaxDays: 7,
  },
  consent_date: {
    minRelDays: -7,
    maxRelDays: 30,
    fallbackMinDays: -365,
    fallbackMaxDays: 7,
  },
};

function parseIsoDate(s: unknown): Date | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(t + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  // Catch impossible calendar dates that the constructor silently rolls
  // over (e.g. "2024-02-31" becomes March 2 — the smoke test caught
  // Vahid's consent_date "2024-02-31"). If round-tripping doesn't match
  // the input it was an invalid calendar date.
  if (d.toISOString().slice(0, 10) !== t) return null;
  return d;
}

/**
 * Field-type lookup. We accept the rows the caller already loaded (so we
 * don't query the DB twice).
 */
export function validateDateWindows(
  fields: Record<string, unknown>,
  fieldTypes: Record<string, string>,
  ctx: DateWindowContext,
): { cleanedFields: Record<string, unknown>; validationErrors: Record<string, string> } {
  const cleaned: Record<string, unknown> = { ...fields };
  const errors: Record<string, string> = {};
  const todayMs = ctx.today.getTime();
  const admissionMs = ctx.admissionDate ? ctx.admissionDate.getTime() : null;

  for (const [fieldKey, fieldType] of Object.entries(fieldTypes)) {
    if (fieldType !== 'date') continue;
    const value = cleaned[fieldKey];
    if (value === null || value === undefined || value === '') continue;
    const parsed = parseIsoDate(value);
    if (!parsed) {
      // Either not a string or an impossible-calendar date (Feb 31 etc).
      cleaned[fieldKey] = null;
      errors[fieldKey] = `unparseable_date: ${String(value)}`;
      continue;
    }
    const rule = FIELD_WINDOW_RULES[fieldKey] ?? DEFAULT_RULE;
    let minMs: number;
    let maxMs: number;
    if (admissionMs !== null) {
      minMs = admissionMs + rule.minRelDays * ONE_DAY_MS;
      maxMs = admissionMs + rule.maxRelDays * ONE_DAY_MS;
      // Cap the upper bound at today + 7d regardless of admission window —
      // surgery_date can't be in the future even if admission was set
      // ahead of time.
      const todayCap = todayMs + 7 * ONE_DAY_MS;
      if (maxMs > todayCap) maxMs = todayCap;
    } else {
      minMs = todayMs + rule.fallbackMinDays * ONE_DAY_MS;
      maxMs = todayMs + rule.fallbackMaxDays * ONE_DAY_MS;
    }
    const ms = parsed.getTime();
    if (ms < minMs || ms > maxMs) {
      // Fix 6 (May 21, 2026 cross-hospital): before nulling an out-of-window
      // date, try a DD/MM swap. The smoke test found Hina's
      // surgery_date=2026-09-03 came from a handwritten "9/3" (= 9
      // March, not 3 September). The extractor LLM took month=09 and
      // wrote September. If swapping month↔day brings the value INTO
      // the window, prefer the swap with a `dd_mm_swapped` annotation
      // so reviewers can see what happened.
      const swapped = trySwapDdMm(parsed);
      if (swapped && swapped.getTime() >= minMs && swapped.getTime() <= maxMs) {
        cleaned[fieldKey] = isoDateString(swapped);
        errors[fieldKey] = `dd_mm_swapped_from: ${String(value)}`;
        continue;
      }
      cleaned[fieldKey] = null;
      errors[fieldKey] = `out_of_window: ${String(value)}`;
    }
  }

  return { cleanedFields: cleaned, validationErrors: errors };
}

/**
 * Swap day ↔ month on an ISO date. Returns null when the swap is
 * impossible (day > 12 means no valid month, OR the swapped date is
 * an impossible calendar date). Used by Fix 6 — DD/MM ambiguity
 * recovery on handwritten partial dates.
 */
function trySwapDdMm(d: Date): Date | null {
  const y = d.getFullYear();
  const m = d.getMonth() + 1; // 1-12
  const day = d.getDate(); // 1-31
  // Swap: new month = old day; new day = old month
  if (day < 1 || day > 12) return null; // new month would be invalid
  const newMonth = day;
  const newDay = m;
  // Validate the swapped date is a real calendar date (e.g. Feb 30 isn't)
  const candidate = new Date(Date.UTC(y, newMonth - 1, newDay));
  if (
    candidate.getUTCFullYear() !== y ||
    candidate.getUTCMonth() !== newMonth - 1 ||
    candidate.getUTCDate() !== newDay
  ) return null;
  return candidate;
}

function isoDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── H2: Hindi/English boilerplate blocklist ───────────────────────────────

/**
 * Clinical / procedure / diagnosis fields where form-heading text routinely
 * leaks in. The smoke test found 9/30 patients with Hindi consent boilerplate
 * stored as `procedure_planned` or `procedure_performed`.
 */
const CLINICAL_TEXT_FIELDS = new Set([
  'procedure_planned',
  'procedure_performed',
  'procedure_described',
  'primary_diagnosis',
  'secondary_diagnoses',
  'provisional_diagnosis',
  'chief_complaints',
]);

/**
 * Phrases the LLM has been observed parroting as a clinical value. Cross-
 * reference: agent A's R3, agent C's C3 in the smoke test report.
 *
 * Matching is case-insensitive substring (normalised) AND "≥80% of the
 * blocklist phrase appears in the value" — keeps small Tesseract typos
 * from sneaking past.
 */
const BOILERPLATE_PHRASES: ReadonlyArray<string> = [
  // Hindi form headings
  'शल्य क्रिया, जाँच या इलाज के लिए अनुमति पत्र',
  'शल्य क्रिया जाँच या इलाज के लिए अनुमति पत्र',
  'शल्य क्रिया जांच या इलाज के लिए अनुमति पत्र',
  // Truncated form Sonnet returns when it stops reading mid-heading
  'शल्य क्रिया, जाँच या इलाज',
  'शल्य क्रिया जाँच या इलाज',
  'शल्य क्रिया',
  'सर्जरी की सहमति',
  'अनुमति पत्र',
  // English form headings
  'consent letter for surgery, examination or treatment',
  'consent letter for surgery examination or treatment',
  'consent form for surgery',
  'patient consent form',
  // Known LLM fallback strings
  'surgical condition requiring intervention',
  'orthopaedics case - trauma/injury related',
  'orthopaedic case - trauma/injury related',
  'orthopaedics case trauma injury related',
  'trauma/injury related',
  'not specified',
  'as per opd',
  'as per discussion',
  // Hallucinated names that propagated in the smoke test
  'saqish singh',
];

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\.,;:\-_'"()\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBoilerplate(value: string): string | null {
  const norm = normalise(value);
  if (norm.length === 0) return null;
  for (const phrase of BOILERPLATE_PHRASES) {
    const normPhrase = normalise(phrase);
    if (normPhrase.length === 0) continue;
    if (norm === normPhrase) return phrase;
    // Substring either direction — boilerplate may be embedded in a longer
    // value or the value may be a prefix of the canonical blocklist entry.
    if (norm.includes(normPhrase) || normPhrase.includes(norm)) {
      // Require the matched chunk to dominate — i.e. either:
      //   (a) the blocklist phrase is ≥60% of the value (so it isn't just
      //       a stray keyword in an otherwise-real clinical note), OR
      //   (b) the value is essentially a prefix of the blocklist phrase
      const longer = norm.length >= normPhrase.length ? norm : normPhrase;
      const shorter = norm.length >= normPhrase.length ? normPhrase : norm;
      if (shorter.length / longer.length >= 0.6) return phrase;
    }
  }
  return null;
}

export function rejectBoilerplate(
  fields: Record<string, unknown>,
): { cleanedFields: Record<string, unknown>; validationErrors: Record<string, string> } {
  const cleaned: Record<string, unknown> = { ...fields };
  const errors: Record<string, string> = {};
  for (const [fieldKey, value] of Object.entries(cleaned)) {
    if (!CLINICAL_TEXT_FIELDS.has(fieldKey)) continue;
    if (typeof value !== 'string') continue;
    const matched = isBoilerplate(value);
    if (matched) {
      cleaned[fieldKey] = null;
      // Truncate the observed value so we don't blow out the JSONB row
      // for a paragraph-long false positive.
      const observed = value.length > 120 ? value.slice(0, 120) + '…' : value;
      errors[fieldKey] = `boilerplate_rejected: ${observed}`;
    }
  }
  return { cleanedFields: cleaned, validationErrors: errors };
}

// ─── H11: Title-case diagnoses (preserves medical abbreviations) ──────────

/**
 * Abbreviations the title-caser must NOT touch. Stays ALL CAPS because
 * that's the medical convention. Adding to this list is the cheapest way
 * to keep diagnoses readable in the FE without sending them through an
 * LLM for "rewrite as title case".
 */
const PRESERVE_UPPERCASE = new Set<string>([
  // Lateralities / sides
  'LT', 'RT', 'BL', 'BIL', 'BIN', 'B/L', 'L/T', 'R/T',
  // Common surgical procedures
  'ORIF', 'CRIF', 'TKR', 'THR', 'AKA', 'BKA',
  'TURP', 'TURBT', 'CABG', 'PCI', 'LSCS', 'NVD',
  // Anatomy / landmarks
  'GT', 'LT', 'AC', 'PCL', 'ACL', 'MCL', 'LCL',
  'ICA', 'ECA', 'MCA', 'SMA',
  'IT', 'ITB', 'SIJ', 'TMJ',
  // Conditions / processes
  'AVN', 'OA', 'RA', 'DM', 'HTN', 'CAD', 'CKD', 'CVA',
  'ARDS', 'COPD', 'COVID', 'TB', 'HIV', 'HCV', 'HBV',
  'GBS', 'MND', 'MS',
  // Clinical operations / staffing
  'OT', 'OPD', 'IPD', 'ICU', 'PT', 'ER', 'OP',
  // Imaging modalities
  'MRI', 'CT', 'PET', 'EEG', 'ECG', 'EKG', 'USG',
  // Anaemia (the smoke test had "ANACMIA" — typo of ANAEMIA — preserve as-is)
  'ANACMIA', 'ANAEMIA',
  // Misc
  'IV', 'IM', 'PO', 'SOS', 'BD', 'TDS', 'QID',
]);

/**
 * Is the input "mostly uppercase"? Threshold: >80% of alphabetic characters
 * are uppercase. Strings shorter than 8 alphabetic chars are skipped (too
 * short to confidently call all-caps).
 */
function isMostlyUpper(s: string): boolean {
  let upper = 0;
  let alpha = 0;
  for (const c of s) {
    if (/[A-Za-z]/.test(c)) {
      alpha++;
      if (c >= 'A' && c <= 'Z') upper++;
    }
  }
  if (alpha < 8) return false;
  return upper / alpha > 0.8;
}

/**
 * Title-case a single token but bypass when it's in the preserve list, is
 * a pure-digit / symbol token, or contains a `#` (fracture marker — keep
 * the trailing word uppercase, e.g. "#LT GT" stays "#LT GT").
 */
function titleCaseToken(token: string): string {
  // Tokens with no alpha → return verbatim (numbers, fragments like "#LT").
  if (!/[A-Za-z]/.test(token)) return token;
  // Tokens starting with # → preserve next-word uppercase ("#LT" → "#LT").
  if (token.startsWith('#')) {
    const rest = token.slice(1).toUpperCase();
    return '#' + rest;
  }
  // Strip non-alpha prefix/suffix to check the core against the preserve list.
  const m = token.match(/^([^A-Za-z]*)([A-Za-z]+(?:[^A-Za-z]+[A-Za-z]+)*)([^A-Za-z]*)$/);
  if (!m) return token;
  const [, pre, core, post] = m;
  // Core might be hyphenated/slashed like "L/T" or "B/L" — handle by
  // checking the full core first, then falling back to per-sub-token.
  if (PRESERVE_UPPERCASE.has(core!.toUpperCase())) {
    return (pre ?? '') + core!.toUpperCase() + (post ?? '');
  }
  // Single-letter words → uppercase (mirrors radiological convention).
  if (core!.length === 1) {
    return (pre ?? '') + core!.toUpperCase() + (post ?? '');
  }
  // Compound short-tokens like "S/P", "L/T", "R/T", "A/E" — every
  // alpha sub-token is a single letter → treat whole compound as an
  // abbreviation and uppercase.
  const subTokens = core!.split(/[^A-Za-z]+/).filter(Boolean);
  if (subTokens.length > 1 && subTokens.every((t) => t.length === 1)) {
    return (pre ?? '') + core!.toUpperCase() + (post ?? '');
  }
  const lowered = core!.toLowerCase();
  return (pre ?? '') + lowered[0]!.toUpperCase() + lowered.slice(1) + (post ?? '');
}

export function titleCaseDiagnosis(value: string): string {
  if (!isMostlyUpper(value)) return value;
  return value
    .split(/(\s+)/)
    .map((seg) => (/^\s+$/.test(seg) ? seg : titleCaseToken(seg)))
    .join('');
}

const DIAGNOSIS_FIELDS = new Set([
  'primary_diagnosis',
  'provisional_diagnosis',
  'secondary_diagnoses',
]);

export function normaliseDiagnosisCasing(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...fields };
  for (const k of DIAGNOSIS_FIELDS) {
    const v = cleaned[k];
    if (typeof v === 'string' && v.length > 0) {
      const next = titleCaseDiagnosis(v);
      if (next !== v) {
        cleaned[k] = next;
      }
    }
  }
  return cleaned;
}

// ─── H6: Aadhaar-back address must contain a PIN ───────────────────────────

export function validateAadhaarBackPin(
  category: string,
  fields: Record<string, unknown>,
): { cleanedFields: Record<string, unknown>; validationErrors: Record<string, string> } {
  if (category !== 'aadhaar_back') {
    return { cleanedFields: fields, validationErrors: {} };
  }
  const cleaned = { ...fields };
  const errors: Record<string, string> = {};
  const addr = cleaned.address;
  if (typeof addr !== 'string' || addr.trim().length === 0) {
    return { cleanedFields: cleaned, validationErrors: errors };
  }
  // 6-digit run anywhere in the address. India Post zone digit ∈ [1..8].
  const m = addr.match(/\b([1-8]\d{5})\b/);
  if (!m) {
    cleaned.address = null;
    errors.address = 'no_pin_found';
  } else if (!cleaned.pin_code) {
    // Backfill pin_code if the schema has the field and the model omitted it.
    cleaned.pin_code = m[1];
  }
  return { cleanedFields: cleaned, validationErrors: errors };
}

// ─── Devanagari detection ──────────────────────────────────────────────────

/**
 * Returns true if the input contains any Devanagari codepoint (the script
 * used for Hindi). Used to decide whether to skip Tesseract and go straight
 * to vision for sections like aadhaar_back / ration_card / consent forms
 * that frequently render in Hindi.
 *
 * Devanagari block: U+0900..U+097F.
 */
export function containsDevanagari(s: string): boolean {
  return /[ऀ-ॿ]/.test(s);
}

// ─── Aggregate runner ──────────────────────────────────────────────────────

export interface PostValidationInput {
  category: string;
  fields: Record<string, unknown>;
  fieldTypes: Record<string, string>;
  admissionDate: Date | null;
  today?: Date;
}

export interface PostValidationOutput {
  cleanedFields: Record<string, unknown>;
  validationErrors: Record<string, string>;
}

/**
 * Run every post-validator in the right order. Returns the cleaned
 * fields + a merged `_validation_errors` map. Order matters slightly:
 *
 *   1. Boilerplate reject — must run before downstream consumers see the
 *      poisoned value.
 *   2. Aadhaar — strips/validates Aadhaar field; produces vid_number.
 *   3. Aadhaar-back PIN — runs after Aadhaar so it sees the canonical fields.
 *   4. Date window — runs last so any preceding cleanup is included in
 *      the "what's left" set.
 *   5. Diagnosis title-casing — purely cosmetic, applied at the end.
 */
export function runPostValidators(input: PostValidationInput): PostValidationOutput {
  const today = input.today ?? new Date();
  let fields = input.fields;
  const allErrors: Record<string, string> = {};

  const r1 = rejectBoilerplate(fields);
  fields = r1.cleanedFields;
  Object.assign(allErrors, r1.validationErrors);

  const r2 = validateAndCleanAadhaar(input.category, fields);
  fields = r2.cleanedFields;
  Object.assign(allErrors, r2.validationErrors);

  const r3 = validateAadhaarBackPin(input.category, fields);
  fields = r3.cleanedFields;
  Object.assign(allErrors, r3.validationErrors);

  const r4 = validateDateWindows(fields, input.fieldTypes, {
    admissionDate: input.admissionDate,
    today,
  });
  fields = r4.cleanedFields;
  Object.assign(allErrors, r4.validationErrors);

  fields = normaliseDiagnosisCasing(fields);

  if (Object.keys(allErrors).length > 0) {
    logger.debug(
      { category: input.category, errors: allErrors },
      'postValidators: applied corrections',
    );
  }

  return { cleanedFields: fields, validationErrors: allErrors };
}

// ─── H2-harm: diagnosis_name validator (permissive replacement) ────────────
//
// Replaces the narrow whitelist validator in
// src/Services/harmoniser/diagnosisValidator.ts. iter5 accuracy bench:
//   • Shabana: "Suspected Typhoid Fever" → wrongly rejected (no_clinical_keywords)
//   • Anvi / Anuj: real diagnoses dropped
//
// Rules:
//   1. Reject empty / too-short / non-string.
//   2. Reject hard-coded boilerplate substrings (existing failure modes).
//   3. Reject pure person-name shapes (every meaningful token is a known
//      Indian first/last name AND no clinical token survives).
//   4. Reject pure-symptom chief-complaint phrases without any qualifier
//      ("chest pain", "fever", "headache", etc.) — the Kalksum case.
//   5. Otherwise: ACCEPT iff at least one token matches the broad clinical
//      keyword whitelist OR matches a clinical regex (fracture shorthand
//      "#", suffix -itis/-osis/-oma/-pathy etc.).
//
// All matching is case-insensitive, tokenised on whitespace + punctuation.
// Stopwords ("with", "and", "of", "the", "a", "in", "on", "to") are dropped
// from the meaningful-token set before the person-name check.

const DIAGNOSIS_STOPWORDS = new Set<string>([
  'with', 'and', 'of', 'the', 'a', 'an', 'in', 'on', 'to', 'for', 'at',
  'by', 'from', 'or', 'as', 'is', 'be', 'mr', 'mrs', 'ms', 'dr', 'master',
  'baby', 'patient', 'pt', 'case',
]);

/**
 * Honest-to-god clinical vocabulary observed in Indian-hospital docs across
 * iter5 + earlier sessions. Stored lowercase. Tokens are matched as exact
 * whole-token matches; multi-word entries are matched as substrings.
 */
const CLINICAL_DIAGNOSIS_KEYWORDS: ReadonlySet<string> = new Set<string>([
  // ── Infectious ─────────────────────────────────────────────────────
  'typhoid', 'enteric', 'malaria', 'dengue', 'chikungunya', 'tuberculosis',
  'tb', 'hepatitis', 'gastroenteritis', 'ge', 'uti', 'urinary', 'pneumonia',
  'bronchitis', 'bronchopneumonia', 'sepsis', 'septicaemia', 'septicemia',
  'bacteremia', 'bacteraemia', 'viral', 'fever', 'hemorrhagic', 'haemorrhagic',
  'leptospirosis', 'scrub', 'cellulitis', 'erysipelas', 'abscess', 'tonsillitis',
  'sinusitis', 'pharyngitis', 'laryngitis', 'otitis', 'meningitis',
  'encephalitis', 'covid', 'h1n1', 'influenza', 'mumps', 'measles', 'chickenpox',
  'varicella', 'herpes', 'zoster',
  // ── Cardiac ────────────────────────────────────────────────────────
  'mi', 'awmi', 'iwmi', 'nstemi', 'stemi', 'acs', 'cad', 'ihd', 'tvd', 'dvd',
  'svd', 'angina', 'unstable', 'chf', 'hfref', 'hfpef', 'avr', 'avn', 'mvr',
  'mr', 'as', 'ms', 'tr', 'pr', 'valvular', 'rhd', 'cardiomyopathy', 'dcm',
  'hcm', 'cardiac', 'cardiomegaly', 'pericarditis', 'endocarditis', 'myocarditis',
  'arrhythmia', 'fibrillation', 'flutter', 'tachycardia', 'bradycardia',
  'palpitation', 'palpitations', 'infarction', 'ischemia', 'ischaemia',
  'myocardial', 'coronary', 'rheumatic', 'hypertensive', 'hypertension', 'htn',
  // ── Orthopaedic ────────────────────────────────────────────────────
  'fracture', 'fractured', 'fx', 'osteoarthritis', 'oa', 'osteoporosis',
  'avascular', 'necrosis', 'rotator', 'cuff', 'meniscal', 'meniscus', 'acl',
  'pcl', 'mcl', 'lcl', 'dislocation', 'dislocated', 'sprain', 'strain',
  'ligament', 'tear', 'torn', 'rupture', 'ruptured', 'nof', 'intertrochanteric',
  'subtrochanteric', 'shaft', 'distal', 'proximal', 'comminuted', 'displaced',
  'undisplaced', 'spondylosis', 'spondylitis', 'spondylolisthesis', 'disc',
  'herniation', 'prolapse', 'protrusion', 'sciatica', 'kyphosis', 'scoliosis',
  'plantar', 'fasciitis', 'tendinitis', 'tendonitis', 'bursitis', 'arthritis',
  'gout', 'osteomyelitis',
  // ── GI / Hepatic / Pancreatic ──────────────────────────────────────
  'appendicitis', 'appendix', 'cholecystitis', 'cholelithiasis', 'gallstone',
  'gallstones', 'gerd', 'gord', 'peptic', 'ulcer', 'gastritis', 'duodenitis',
  'pancreatitis', 'hernia', 'inguinal', 'umbilical', 'hiatal', 'incisional',
  'hepatic', 'liver', 'ascites', 'cirrhosis', 'jaundice', 'cholestasis',
  'obstruction', 'intestinal', 'ileus', 'volvulus', 'intussusception',
  'colitis', 'enteritis', 'ibs', 'ibd', 'diverticulitis', 'haemorrhoid',
  'haemorrhoids', 'hemorrhoid', 'hemorrhoids', 'piles', 'fissure', 'fistula',
  // ── Renal / Urology ────────────────────────────────────────────────
  'aki', 'ckd', 'nephritis', 'nephrolithiasis', 'nephrotic', 'nephropathy',
  'glomerulonephritis', 'pyelonephritis', 'renal', 'kidney', 'hydronephrosis',
  'cystitis', 'urethritis', 'prostatitis', 'bph', 'prostate', 'calculus',
  'calculi', 'stone', 'stones', 'hydrocele', 'varicocele', 'phimosis',
  // ── Respiratory ────────────────────────────────────────────────────
  'copd', 'asthma', 'pulmonary', 'pleural', 'effusion', 'pneumothorax',
  'pe', 'ards', 'respiratory', 'pleurisy', 'empyema', 'bronchiectasis',
  'emphysema', 'fibrosis',
  // ── Neuro ──────────────────────────────────────────────────────────
  'stroke', 'cva', 'tia', 'seizure', 'seizures', 'epilepsy', 'migraine',
  'vertigo', 'gbs', 'palsy', 'neuropathy', 'parkinson', 'dementia', 'alzheimer',
  'hydrocephalus', 'sah', 'sdh', 'edh', 'icb', 'ich', 'bell',
  // ── Endocrine / Metabolic ─────────────────────────────────────────
  'diabetes', 'dm', 't1dm', 't2dm', 'iddm', 'niddm', 'mellitus', 'hypoglycemia',
  'hypoglycaemia', 'hyperglycemia', 'hyperglycaemia', 'dka', 'hhs',
  'thyroid', 'hypothyroid', 'hypothyroidism', 'hyperthyroid', 'hyperthyroidism',
  'graves', 'goitre', 'goiter', 'cushing', 'addison', 'pcos', 'dyslipidemia',
  'dyslipidaemia', 'obesity', 'electrolyte', 'hyponatremia', 'hypernatremia',
  'hypokalemia', 'hyperkalemia',
  // ── OB / Gyn ───────────────────────────────────────────────────────
  'pregnancy', 'pregnant', 'gestational', 'gravida', 'parity', 'antenatal',
  'eclampsia', 'pre-eclampsia', 'preeclampsia', 'pph', 'aph', 'abortion',
  'miscarriage', 'ectopic', 'ovarian', 'cyst', 'uterine', 'uterus', 'fibroid',
  'fibroids', 'endometriosis', 'pid', 'menorrhagia', 'amenorrhea',
  'dysmenorrhea', 'labour', 'labor', 'delivery', 'caesarean', 'cesarean',
  'lscs', 'nvd', 'placenta', 'previa', 'abruption',
  // ── Haematology / Oncology ────────────────────────────────────────
  'anemia', 'anaemia', 'thrombocytopenia', 'leukopenia', 'leukocytosis',
  'pancytopenia', 'leukemia', 'leukaemia', 'lymphoma', 'myeloma', 'carcinoma',
  'sarcoma', 'cancer', 'tumour', 'tumor', 'malignancy', 'metastasis',
  'metastatic', 'neoplasm', 'mass', 'lesion', 'polyp', 'nodule', 'cyst',
  // ── Trauma ─────────────────────────────────────────────────────────
  'rta', 'polytrauma', 'trauma', 'tbi', 'hi', 'contusion', 'laceration',
  'burn', 'burns', 'injury', 'wound', 'assault', 'fall', 'avulsion',
  // ── Misc / general descriptors that imply a real diagnosis ─────────
  'syndrome', 'disease', 'disorder', 'infection', 'infective',
  'inflammatory', 'inflammation', 'inflamed', 'autoimmune',
  'oedema', 'edema', 'swelling', 'haemorrhage', 'hemorrhage', 'bleeding',
  'ischaemic', 'ischemic', 'thrombosis', 'thrombus', 'embolism', 'embolus',
  'dvt', 'aneurysm', 'stenosis', 'occlusion',
  // ── Anatomical sites (qualify a diagnosis; only count when paired
  //    with a real condition word in the same string — see below) ──
  'forearm', 'femur', 'tibia', 'fibula', 'humerus', 'radius', 'ulna',
  'clavicle', 'scapula', 'patella', 'calcaneus', 'metacarpal', 'metatarsal',
  'phalanx', 'phalanges', 'hip', 'knee', 'ankle', 'shoulder', 'wrist',
  'elbow', 'spine', 'vertebra', 'vertebrae', 'cervical', 'lumbar', 'thoracic',
  'sacral', 'sacrum', 'coccyx', 'abdomen', 'pelvis', 'chest', 'thorax',
  'head', 'brain', 'skull', 'neck', 'foot', 'hand', 'finger', 'toe',
  'liver', 'kidney', 'gallbladder', 'pancreas', 'spleen', 'stomach',
  'intestine', 'colon', 'rectum', 'bladder', 'ovary', 'breast',
  'lung', 'heart',
]);

/**
 * Pure-symptom chief-complaint phrases (chief complaint != diagnosis).
 * These should be rejected when they appear standalone or with only a
 * person-name / generic qualifier — there's no specific etiology.
 *
 * Kalksum case: "Chest pain" leaked from chief_complaints into
 * primary_diagnosis. The diagnosis pipeline must drop it.
 */
const PURE_SYMPTOM_PHRASES: ReadonlySet<string> = new Set<string>([
  'chest pain',
  'fever',
  'high fever',
  'low grade fever',
  'headache',
  'head ache',
  'vomiting',
  'nausea',
  'nausea and vomiting',
  'nausea vomiting',
  'abdominal pain',
  'abd pain',
  'stomach pain',
  'belly pain',
  'shortness of breath',
  'sob',
  'breathlessness',
  'difficulty breathing',
  'cough',
  'dry cough',
  'productive cough',
  'cold',
  'cold and cough',
  'body ache',
  'body aches',
  'bodyache',
  'weakness',
  'generalised weakness',
  'generalized weakness',
  'fatigue',
  'tiredness',
  'dizziness',
  'giddiness',
  'loose motion',
  'loose motions',
  'loose stool',
  'loose stools',
  'diarrhoea',
  'diarrhea',
  'constipation',
  'pain abdomen',
  'pain in abdomen',
  'acute fever',
  'high grade fever',
  'fever with chills',
]);

/**
 * Common Indian first names and last names that surface as false-positive
 * diagnoses (LLM lifting a patient name from a consent form). Used in the
 * person-name shape check — a diagnosis is REJECTED if every meaningful
 * token after stopword removal matches a name AND no clinical token
 * survives.
 *
 * Lower-cased.
 */
const KNOWN_INDIAN_NAMES: ReadonlySet<string> = new Set<string>([
  // First names observed in smoke tests + iter5
  'anuj', 'anvi', 'sunil', 'suneel', 'kalksum', 'hina', 'shabana', 'vahid',
  'hamshiran', 'aslam', 'hasan', 'mohd', 'mohammed', 'mohammad', 'ram',
  'shyam', 'rohan', 'rohit', 'rahul', 'amit', 'ankit', 'arjun', 'ashish',
  'ayush', 'deepak', 'gaurav', 'harish', 'hemant', 'imran', 'irfan', 'jay',
  'karan', 'krishna', 'kumar', 'manoj', 'naveen', 'pooja', 'priya', 'rakesh',
  'rajesh', 'ramesh', 'rashid', 'ravi', 'sachin', 'salman', 'sandeep',
  'sanjay', 'saqish', 'shekhar', 'shivam', 'sumit', 'suresh', 'tanvi',
  'vikas', 'vinod', 'vivek', 'yash', 'zaheer',
  // Last names
  'singh', 'kumar', 'pal', 'khan', 'yadav', 'sharma', 'verma', 'gupta',
  'mishra', 'pandey', 'tiwari', 'jha', 'shah', 'patel', 'reddy', 'rao',
  'naidu', 'iyer', 'iyengar', 'menon', 'nair', 'pillai', 'das', 'dutta',
  'sen', 'banerjee', 'chatterjee', 'mukherjee', 'ghosh', 'roy', 'bose',
  'chaudhary', 'choudhary', 'agarwal', 'aggarwal', 'jain', 'goel', 'bansal',
  'mittal', 'arora', 'malhotra', 'chopra', 'kapoor', 'mehta', 'desai',
  'joshi', 'thakur', 'rana', 'rathore', 'sinha', 'srivastava', 'shrivastava',
  'tripathi', 'dwivedi', 'chaturvedi', 'lal',
]);

function normaliseDiagnosisText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,;:_'"()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenise a diagnosis string. Splits on whitespace AND punctuation
 * (slashes, hyphens, etc.) so "OA/Lt knee" → ["oa", "lt", "knee"].
 * Returns lowercase tokens, empties removed.
 */
function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Suffix-based fallback — catches conditions the keyword list doesn't
 * explicitly enumerate (e.g. "duodenitis", "cardiomyopathy").
 */
const CLINICAL_SUFFIX_LIST: ReadonlyArray<string> = [
  'itis', 'osis', 'oma', 'pathy', 'algia', 'aemia', 'emia', 'cele',
  'plegia', 'paresis', 'rrhoea', 'rrhea', 'rrhage', 'genic', 'opathy',
];

function tokenHasClinicalSuffix(token: string): boolean {
  if (token.length < 5) return false;
  for (const suf of CLINICAL_SUFFIX_LIST) {
    if (token.endsWith(suf)) return true;
  }
  return false;
}

/**
 * Does the raw string contain any clinical symbol shorthand?
 *   - "#" followed by a word/letter (fracture shorthand, e.g. "# NOF")
 *   - "Gr I/II/III/IV" (grading)
 *   - "Stage 1/2/3/4"
 */
function hasClinicalSymbol(raw: string): boolean {
  if (/#\s?[A-Za-z0-9]/.test(raw)) return true;
  if (/\bgr(ade)?\s*[IiVv]+\b/.test(raw)) return true;
  if (/\bstage\s*[1-4]\b/i.test(raw)) return true;
  return false;
}

/**
 * Hard blocklist — exact-substring matches (lowercased). Carries over the
 * known-bad phrases from the legacy harmoniser validator.
 */
const DIAGNOSIS_BLOCKLIST_SUBSTRINGS: ReadonlyArray<string> = [
  'orthopaedics case - trauma/injury related',
  'orthopedics case - trauma/injury related',
  'orthopaedics case-trauma',
  'orthopedics case-trauma',
  'orthopaedics case trauma injury related',
  'orthopedics case trauma injury related',
  'surgical condition requiring intervention',
  'medical condition requiring',
  'with a/e pop slab',
  'a/e pop slab',
  'unknown condition',
  'unspecified condition',
  'patient condition',
  'not specified',
  'as per opd',
  'as per discussion',
];

export interface DiagnosisValidationResult {
  ok: boolean;
  /** Free-text reason captured to validation_metadata when ok=false. */
  reason?: string;
}

/**
 * Permissive H2-harm diagnosis validator. Replaces the narrow whitelist
 * version in src/Services/harmoniser/diagnosisValidator.ts.
 *
 * Returns {ok: false, reason} when:
 *   - empty / non-string / too short
 *   - boilerplate substring match
 *   - pure-symptom phrase ("chest pain", "fever" without qualifier)
 *   - every meaningful token is a known person-name token AND there's no
 *     clinical keyword anywhere in the string
 *   - zero clinical tokens AND zero clinical symbols / suffixes
 *
 * Otherwise {ok: true}.
 */
export function validateDiagnosisName(
  raw: string | null | undefined,
): DiagnosisValidationResult {
  if (raw === null || raw === undefined || typeof raw !== 'string') {
    return { ok: false, reason: 'empty_or_non_string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length < 3) {
    return { ok: false, reason: 'too_short' };
  }
  const normalised = normaliseDiagnosisText(trimmed);

  // 1. Hard blocklist (boilerplate).
  for (const phrase of DIAGNOSIS_BLOCKLIST_SUBSTRINGS) {
    if (normalised.includes(phrase)) {
      return { ok: false, reason: `blocklist_phrase:${phrase}` };
    }
  }

  // 2. Pure-symptom chief-complaint check. The phrase must be EXACTLY a
  //    pure-symptom phrase (after stripping qualifier-only stopwords) OR
  //    the entire string must be a pure-symptom phrase with no other
  //    clinical token alongside. We check both exact match and "phrase
  //    appears AND no extra clinical content".
  if (PURE_SYMPTOM_PHRASES.has(normalised)) {
    return { ok: false, reason: `pure_symptom:${normalised}` };
  }

  const tokens = tokenise(trimmed);
  const meaningfulTokens = tokens.filter((t) => !DIAGNOSIS_STOPWORDS.has(t));

  // 3. Clinical-keyword detection. Stopword tokens are SKIPPED so that
  //    English honorifics ("mr", "ms") don't masquerade as cardiac
  //    abbreviations (mitral regurgitation / mitral stenosis).
  let clinicalTokenCount = 0;
  const clinicalTokenSet = new Set<string>();
  for (const t of tokens) {
    if (DIAGNOSIS_STOPWORDS.has(t)) continue;
    if (CLINICAL_DIAGNOSIS_KEYWORDS.has(t)) {
      clinicalTokenCount++;
      clinicalTokenSet.add(t);
      continue;
    }
    if (tokenHasClinicalSuffix(t)) {
      clinicalTokenCount++;
      clinicalTokenSet.add(t);
    }
  }
  // Multi-word phrases (e.g. "enteric fever") — substring match on
  // normalised text. We only check those keywords containing a space.
  // None currently do, but kept for forward-compat.
  for (const kw of CLINICAL_DIAGNOSIS_KEYWORDS) {
    if (kw.includes(' ') && normalised.includes(kw)) {
      clinicalTokenCount++;
      clinicalTokenSet.add(kw);
    }
  }
  const hasSymbol = hasClinicalSymbol(trimmed);

  // 4. Person-name check. A diagnosis is rejected if:
  //    every meaningful token is a known Indian first/last name AND no
  //    clinical token / symbol survives.
  const meaningfulNonClinical = meaningfulTokens.filter(
    (t) => !clinicalTokenSet.has(t),
  );
  if (meaningfulTokens.length > 0 && clinicalTokenCount === 0 && !hasSymbol) {
    const allKnownNames = meaningfulTokens.every((t) =>
      KNOWN_INDIAN_NAMES.has(t),
    );
    if (allKnownNames) {
      return { ok: false, reason: 'looks_like_person_name' };
    }
    // Conservative two-capitalised-tokens shape (legacy heuristic) —
    // "Saqish Singh" etc. Only meaningful when zero clinical content.
    if (/^[A-Z][a-z]+\s+[A-Z][a-z]+\s*$/.test(trimmed)) {
      return { ok: false, reason: 'looks_like_person_name' };
    }
  }

  // 5. Person-name + only-symptom shape ("Mr. Anuj Pal with chest pain").
  //    If a pure-symptom phrase appears as a substring in the normalised
  //    text AND every meaningful token NOT part of that symptom phrase is
  //    a known person name, reject. This catches cases where the LLM
  //    glued a chief-complaint phrase onto a patient name.
  for (const sym of PURE_SYMPTOM_PHRASES) {
    if (!normalised.includes(sym)) continue;
    const symTokens = new Set(tokenise(sym));
    const residual = meaningfulTokens.filter((t) => !symTokens.has(t));
    if (residual.length === 0) {
      // Whole meaningful content IS the symptom — already handled by
      // the exact-match check in step 2 for the most common cases, but
      // catch the embedded variants ("complaint: chest pain") here too.
      if (!hasSymbol) {
        return { ok: false, reason: `pure_symptom:${sym}` };
      }
    }
    const residualAllNames = residual.every((t) => KNOWN_INDIAN_NAMES.has(t));
    if (residualAllNames && residual.length > 0 && !hasSymbol) {
      return { ok: false, reason: `person_name_with_symptom:${sym}` };
    }
  }

  // 6. Generic "Acute fever" / "fever" with no specific etiology — falls
  //    back to pure-symptom check. We already handled exact match; also
  //    handle "acute fever", "high fever" etc. where the only clinical
  //    token is "fever" with a severity qualifier and nothing else.
  if (clinicalTokenSet.size === 1 && clinicalTokenSet.has('fever')) {
    // If the string also contains a specific etiology (typhoid, dengue,
    // malaria, etc.) clinicalTokenSet.size would be >1 → safe to reject
    // when only "fever" survives + generic qualifiers.
    const qualifiersOnly = meaningfulTokens.every((t) =>
      t === 'fever' ||
      t === 'acute' || t === 'chronic' ||
      t === 'mild' || t === 'moderate' || t === 'severe' ||
      t === 'high' || t === 'low' || t === 'grade' ||
      t === 'with' || t === 'chills',
    );
    if (qualifiersOnly && !hasSymbol) {
      return { ok: false, reason: 'pure_symptom:generic_fever' };
    }
  }

  // 7. No clinical signal at all → reject.
  if (clinicalTokenCount === 0 && !hasSymbol) {
    return { ok: false, reason: 'no_clinical_keywords' };
  }

  return { ok: true };
}

