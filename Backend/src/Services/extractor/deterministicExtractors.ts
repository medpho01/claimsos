/**
 * Deterministic, regex-based fact extraction layer.
 *
 * Runs BEFORE the LLM call inside docExtractor.service. Some pieces of
 * data on Indian medical-claim documents have rigid, well-known formats:
 *   - Doctor council registration IDs ("MPMC Reg. No. 21274")
 *   - Aadhaar (12 digits, Verhoeff checksum)
 *   - PMJAY beneficiary IDs (~9 char alphanumeric, or 12-15 digits)
 *   - ABHA numbers (14 digits)
 *   - Indian mobile numbers (10 digits starting 6-9)
 *   - Dates / currency amounts
 *
 * The LLM is unreliable at finding these even when they're clearly
 * printed — Iter5 accuracy bench showed 0/3 doctor NMC IDs were
 * caught even though every signature stamp had one. Cheap, fast,
 * deterministic regex with format validation beats an LLM here.
 *
 * Output is ADDITIVE: structured facts are passed as a DETECTED_FACTS
 * addendum to the LLM prompt (so it can prefer them over its own
 * re-extraction) AND persisted into `extraction_confidence._deterministic_facts`
 * for downstream consumers. We do NOT replace LLM-extracted fields.
 */

import { verhoeffValid } from '../extractedFieldValidators.js';

// ─── Public types ────────────────────────────────────────────────────────

export interface DeterministicFacts {
  doctor_nmc_ids: Array<{
    value: string;
    council?: string;
    confidence: number;
    matched_text: string;
  }>;
  aadhaar_numbers: Array<{
    value: string;
    valid_checksum: boolean;
    matched_text: string;
  }>;
  pmjay_ids: Array<{ value: string; matched_text: string }>;
  abha_numbers: Array<{ value: string; matched_text: string }>;
  mobile_numbers: Array<{ value: string; matched_text: string }>;
  dates: Array<{
    iso: string;
    original: string;
    format_guess: 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'ambiguous';
  }>;
  currency_amounts: Array<{ value_inr: number; matched_text: string }>;
}

// ─── Patterns ────────────────────────────────────────────────────────────

// State / national medical councils. The first capture group is the
// council code (case-insensitive); the second is the registration
// number — usually pure digits 4-7 long, sometimes prefixed with a
// single letter (TN/MP issue letter-prefixed regs in some years).
//
// We allow noisy filler between the council name and the number
// ("Reg.", "Registration", "No.", "#", ":") so OCR variants like
// "MPMC Reg. No. 21274", "MPMC/21274", "MPMC#21274" all match. The
// number boundary requires \b on both sides so we don't gobble up
// digits inside a longer string (e.g. don't match "MPMC 12345678" as
// reg 1234567).
// Two-form match:
//   (a) <COUNCIL> [filler] [Reg/Registration] [No./Number/#] <NUMBER>
//   (b) Reg. No. <NUMBER>   — bare "Reg No"-style without an explicit
//                              council code; the council can't be
//                              determined but the registration ID is
//                              still useful evidence the LLM was missing.
// The council code is allowed to be dotted ("U.P.M.C.") since that's
// how stamps frequently render under OCR. Sequences of dots/letters are
// normalised in extractNmcIds() before being emitted.
const NMC_PATTERN_WITH_COUNCIL =
  /\b(M\.?P\.?M\.?C\.?|M\.?C\.?I\.?|N\.?M\.?C\.?|M\.?M\.?C\.?|K\.?M\.?C\.?|G\.?M\.?C\.?|T\.?N\.?M\.?C\.?|D\.?M\.?C\.?|R\.?M\.?C\.?|H\.?P\.?M\.?C\.?|M\.?S\.?M\.?C\.?|U\.?P\.?M\.?C\.?|MP\s+Medical\s+Council|Maharashtra\s+Medical\s+Council|Karnataka\s+Medical\s+Council|Delhi\s+Medical\s+Council)[\s.:#/-]*(?:Reg(?:istration)?)?[\s.:#/-]*(?:No\.?|Number|#)?[\s.:#/-]*([A-Z]?\d{3,7})\b/gi;
const NMC_PATTERN_BARE_REG =
  /\bReg(?:istration)?[\s.:#/-]*(?:No\.?|Number|#)[\s.:#/-]*([A-Z]?\d{3,7})\b/gi;

// Aadhaar — 12 digits in 4-4-4 grouping, optionally separated by
// spaces/hyphens. We DO NOT match contiguous 12 digits here because
// that pattern false-positives on PMJAY beneficiary IDs and bank
// references; printed Aadhaar is universally formatted as three
// groups of four.
const AADHAAR_PATTERN = /\b(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})\b/g;

// PMJAY Ayushman Bharat — two distinct shapes seen on real cards:
//   - Card number / family ID: 9-char uppercase alphanumeric near
//     "PMJAY"/"Ayushman" keyword (e.g. MCETESFVS, PZKE3TBTE).
//   - Beneficiary ID: 12-15 contiguous digits near "Beneficiary ID"
//     or "Ben ID" / "Beneficiary No.".
const PMJAY_ALNUM_PATTERN = /\b[A-Z][A-Z0-9]{7,11}\b/g;
const PMJAY_BEN_DIGIT_PATTERN = /\b\d{12,15}\b/g;
const PMJAY_KEYWORD_RE = /PMJAY|Ayushman\s+Bharat|Ayushman|AB-PMJAY/i;
const PMJAY_BEN_KEYWORD_RE = /Beneficiary\s*(?:ID|No|Number)|Ben\.?\s*ID/i;
const PMJAY_KEYWORD_WINDOW = 80;

// ABHA — 14 digit health ID, formatted as 4-2-4-4 with optional
// hyphens/spaces, or 14 contiguous digits.
const ABHA_KEYWORD_RE = /ABHA|Health\s+ID|PHR\s+Address/i;
const ABHA_FORMATTED_PATTERN = /\b(\d{2})[\s-]?(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})\b/g;

// Indian mobile — 10 digits starting 6/7/8/9, with optional +91 or
// 91 country prefix. \b on both sides keeps us from matching the
// middle of longer digit runs (Aadhaar, bank refs).
const MOBILE_PATTERN = /(?:^|[^\d])(\+?91[\s-]?)?([6-9]\d{9})(?=$|[^\d])/g;

// Dates. Captured forms:
//   DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY  (also DD/MM/YY, two-digit year)
//   YYYY-MM-DD  (ISO)
//   DD MMM YYYY (e.g. "12 Feb 2026")
const DATE_NUM_PATTERN = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/g;
const DATE_ISO_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DATE_MONTH_NAME_PATTERN =
  /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+(\d{2,4})\b/gi;
const MONTH_NAME_TO_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// Currency. Both prefix ("Rs. 12,345.00", "INR 12345", "₹12,345")
// and suffix ("12345/-", "12345 Rs", "12345 only") forms.
const CURRENCY_PREFIX_PATTERN =
  /(?:Rs\.?|INR|₹|Rupees)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi;
// NOTE no trailing \b — the suffix forms "12345/-", "12345 only" end in
// non-word characters where \b doesn't fire reliably. We anchor on the
// rupee marker itself instead.
const CURRENCY_SUFFIX_PATTERN =
  /\b([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:\/-|Rs\.?|INR|rupees(?:\s+only)?|\s+only)/gi;

// ─── Main entrypoint ─────────────────────────────────────────────────────

export function extractDeterministicFacts(rawText: string): DeterministicFacts {
  if (!rawText || typeof rawText !== 'string') {
    return emptyFacts();
  }

  return {
    doctor_nmc_ids: extractNmcIds(rawText),
    aadhaar_numbers: extractAadhaarNumbers(rawText),
    pmjay_ids: extractPmjayIds(rawText),
    abha_numbers: extractAbhaNumbers(rawText),
    mobile_numbers: extractMobileNumbers(rawText),
    dates: extractDates(rawText),
    currency_amounts: extractCurrencyAmounts(rawText),
  };
}

function emptyFacts(): DeterministicFacts {
  return {
    doctor_nmc_ids: [],
    aadhaar_numbers: [],
    pmjay_ids: [],
    abha_numbers: [],
    mobile_numbers: [],
    dates: [],
    currency_amounts: [],
  };
}

// ─── Individual extractors ───────────────────────────────────────────────

function normaliseCouncilCode(raw: string): string {
  // Strip dots/spaces inside acronyms ("U.P.M.C." → "UPMC"); preserve
  // word spacing on the long-form council names.
  const trimmed = raw.trim().toUpperCase();
  if (/\s+MEDICAL\s+COUNCIL/.test(trimmed)) {
    return trimmed.replace(/\s+/g, ' ');
  }
  return trimmed.replace(/[.\s]/g, '');
}

function extractNmcIds(text: string): DeterministicFacts['doctor_nmc_ids'] {
  const out: DeterministicFacts['doctor_nmc_ids'] = [];
  const seen = new Set<string>();
  // Pass 1 — explicit council code + number.
  for (const m of text.matchAll(NMC_PATTERN_WITH_COUNCIL)) {
    const council = normaliseCouncilCode(m[1] ?? '');
    const number = (m[2] ?? '').toUpperCase();
    const key = `${council}|${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Confidence: 4-digit numbers overlap with year prefixes in
    // random strings → lower confidence. 5+ digits are unambiguous.
    let confidence = 0.95;
    if (number.length === 3) confidence = 0.7;
    if (number.length === 4) confidence = 0.85;
    out.push({ value: number, council, confidence, matched_text: m[0] });
  }
  // Pass 2 — "Reg No <N>" with no council code. Lower confidence
  // since the council can't be tied to a real registry.
  for (const m of text.matchAll(NMC_PATTERN_BARE_REG)) {
    const number = (m[1] ?? '').toUpperCase();
    const key = `|${number}`;
    // Skip if this exact number was already captured with a council
    // — the council-tagged version is strictly more informative.
    let alreadyHave = false;
    for (const existing of out) {
      if (existing.value === number) {
        alreadyHave = true;
        break;
      }
    }
    if (alreadyHave) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    let confidence = 0.7;
    if (number.length === 3) confidence = 0.55;
    if (number.length === 4) confidence = 0.65;
    if (number.length >= 5) confidence = 0.8;
    out.push({ value: number, confidence, matched_text: m[0] });
  }
  return out;
}

function extractAadhaarNumbers(text: string): DeterministicFacts['aadhaar_numbers'] {
  const out: DeterministicFacts['aadhaar_numbers'] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(AADHAAR_PATTERN)) {
    const digits = `${m[1]}${m[2]}${m[3]}`;
    if (seen.has(digits)) continue;
    seen.add(digits);
    // Aadhaar can't start with 0 or 1 (UIDAI reserved).
    if (digits[0] === '0' || digits[0] === '1') continue;
    const validChecksum = verhoeffValid(digits);
    // If checksum fails, it's probably random 12-digit grouping
    // (e.g. a bank reference or a long beneficiary ID that happens
    // to be 12 chars). Drop it — false positives are worse than
    // false negatives here because the LLM still has a shot.
    if (!validChecksum) continue;
    out.push({
      value: digits,
      valid_checksum: true,
      matched_text: m[0],
    });
  }
  return out;
}

function extractPmjayIds(text: string): DeterministicFacts['pmjay_ids'] {
  const out: DeterministicFacts['pmjay_ids'] = [];
  const seen = new Set<string>();

  // Alphanumeric card IDs — only consider matches close to a PMJAY
  // keyword. A 9-char uppercase token by itself is too generic
  // (matches medical jargon abbreviations) but proximity to the
  // PMJAY/Ayushman keyword cuts the false-positive rate to zero on
  // every patient we've sampled. Examples seen in our DB include
  // MCETESFVS (all-alpha), MGBZ5LSYW, PZKE3TBTE (mixed).
  // Words that look like card IDs by length but are actually the
  // keyword itself, common scheme labels, or English words frequently
  // adjacent to the keyword in scheme letters. Skipped before the
  // keyword-window check.
  const PMJAY_TOKEN_BLOCKLIST = new Set([
    'PMJAY', 'AYUSHMAN', 'BHARAT', 'BENEFICIARY', 'ABPMJAY', 'AB',
    'NUMBER', 'CARDNUMBER', 'CARD', 'ISSUED', 'UNDER', 'NAME',
    'SCHEME', 'GOVERNMENT', 'INDIA',
  ]);
  for (const m of text.matchAll(PMJAY_ALNUM_PATTERN)) {
    const value = m[0];
    if (seen.has(value)) continue;
    // Pure digits go through the beneficiary-id path below.
    if (!/[A-Z]/.test(value)) continue;
    if (PMJAY_TOKEN_BLOCKLIST.has(value)) continue;
    // Require a PMJAY/Ayushman keyword within ±PMJAY_KEYWORD_WINDOW chars.
    const idx = m.index ?? 0;
    const window = text.slice(
      Math.max(0, idx - PMJAY_KEYWORD_WINDOW),
      idx + value.length + PMJAY_KEYWORD_WINDOW,
    );
    if (!PMJAY_KEYWORD_RE.test(window)) continue;
    seen.add(value);
    out.push({ value, matched_text: m[0] });
  }

  // Beneficiary digit IDs — 12-15 digits near a "Beneficiary"
  // keyword. We restrict by keyword proximity to avoid colliding
  // with Aadhaar (12 digits + Verhoeff) and other long digit strings.
  for (const m of text.matchAll(PMJAY_BEN_DIGIT_PATTERN)) {
    const value = m[0];
    if (seen.has(value)) continue;
    const idx = m.index ?? 0;
    const window = text.slice(
      Math.max(0, idx - PMJAY_KEYWORD_WINDOW),
      idx + value.length + PMJAY_KEYWORD_WINDOW,
    );
    if (!PMJAY_BEN_KEYWORD_RE.test(window) && !PMJAY_KEYWORD_RE.test(window)) {
      continue;
    }
    // Don't double-report something that already passed Aadhaar
    // checksum elsewhere in the doc.
    if (value.length === 12 && verhoeffValid(value)) continue;
    seen.add(value);
    out.push({ value, matched_text: m[0] });
  }

  return out;
}

function extractAbhaNumbers(text: string): DeterministicFacts['abha_numbers'] {
  const out: DeterministicFacts['abha_numbers'] = [];
  const seen = new Set<string>();
  // ABHA must be near the ABHA keyword — bare 14-digit strings show
  // up too often as Aadhaar-with-padding or bank refs.
  for (const m of text.matchAll(ABHA_FORMATTED_PATTERN)) {
    const digits = `${m[1]}${m[2]}${m[3]}${m[4]}`;
    if (digits.length !== 14) continue;
    if (seen.has(digits)) continue;
    const idx = m.index ?? 0;
    const window = text.slice(
      Math.max(0, idx - 60),
      idx + m[0].length + 60,
    );
    if (!ABHA_KEYWORD_RE.test(window)) continue;
    seen.add(digits);
    out.push({ value: digits, matched_text: m[0] });
  }
  return out;
}

function extractMobileNumbers(text: string): DeterministicFacts['mobile_numbers'] {
  const out: DeterministicFacts['mobile_numbers'] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MOBILE_PATTERN)) {
    const number = m[2]!;
    if (seen.has(number)) continue;
    seen.add(number);
    out.push({
      value: number,
      matched_text: (m[1] ?? '') + number,
    });
  }
  return out;
}

function extractDates(text: string): DeterministicFacts['dates'] {
  const out: DeterministicFacts['dates'] = [];
  const seen = new Set<string>();

  // ISO YYYY-MM-DD first — unambiguous.
  for (const m of text.matchAll(DATE_ISO_PATTERN)) {
    const y = Number.parseInt(m[1]!, 10);
    const mo = Number.parseInt(m[2]!, 10);
    const d = Number.parseInt(m[3]!, 10);
    if (!isValidYmd(y, mo, d)) continue;
    const iso = `${pad4(y)}-${pad2(mo)}-${pad2(d)}`;
    if (seen.has(iso)) continue;
    seen.add(iso);
    out.push({ iso, original: m[0], format_guess: 'YYYY-MM-DD' });
  }

  // Numeric DD/MM/YYYY (or MM/DD/YYYY).
  for (const m of text.matchAll(DATE_NUM_PATTERN)) {
    const a = Number.parseInt(m[1]!, 10);
    const b = Number.parseInt(m[2]!, 10);
    let y = Number.parseInt(m[3]!, 10);
    if (m[3]!.length === 2) {
      // 2-digit year — assume 20xx for 00-79, 19xx for 80-99.
      y = y < 80 ? 2000 + y : 1900 + y;
    }
    // Decide which interpretation.
    let format_guess: DeterministicFacts['dates'][number]['format_guess'];
    let day = a;
    let month = b;
    if (a > 12 && b <= 12) {
      // Definitely DD/MM.
      format_guess = 'DD/MM/YYYY';
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      format_guess = 'MM/DD/YYYY';
      day = b;
      month = a;
    } else if (a <= 12 && b <= 12) {
      // Both plausible as day or month. Default to DD/MM (Indian
      // convention dominates in this codebase) but flag as ambiguous
      // so the harmoniser can use admission_date as a tie-breaker.
      format_guess = 'ambiguous';
      day = a;
      month = b;
    } else {
      // Both > 12 — nonsense.
      continue;
    }
    if (!isValidYmd(y, month, day)) continue;
    const iso = `${pad4(y)}-${pad2(month)}-${pad2(day)}`;
    if (seen.has(iso + ':' + m[0])) continue;
    seen.add(iso + ':' + m[0]);
    out.push({ iso, original: m[0], format_guess });
  }

  // Month-name dates.
  for (const m of text.matchAll(DATE_MONTH_NAME_PATTERN)) {
    const d = Number.parseInt(m[1]!, 10);
    const monthName = m[2]!.toLowerCase();
    const mo = MONTH_NAME_TO_NUM[monthName];
    if (!mo) continue;
    let y = Number.parseInt(m[3]!, 10);
    if (m[3]!.length === 2) y = y < 80 ? 2000 + y : 1900 + y;
    if (!isValidYmd(y, mo, d)) continue;
    const iso = `${pad4(y)}-${pad2(mo)}-${pad2(d)}`;
    if (seen.has(iso + ':' + m[0])) continue;
    seen.add(iso + ':' + m[0]);
    out.push({ iso, original: m[0], format_guess: 'DD/MM/YYYY' });
  }

  return out;
}

function extractCurrencyAmounts(text: string): DeterministicFacts['currency_amounts'] {
  const out: DeterministicFacts['currency_amounts'] = [];
  const seen = new Set<string>();
  const consume = (raw: string, matched: string) => {
    const num = Number.parseFloat(raw.replace(/,/g, ''));
    if (!Number.isFinite(num) || num <= 0) return;
    const key = `${num}|${matched}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ value_inr: num, matched_text: matched });
  };
  for (const m of text.matchAll(CURRENCY_PREFIX_PATTERN)) {
    consume(m[1]!, m[0]);
  }
  for (const m of text.matchAll(CURRENCY_SUFFIX_PATTERN)) {
    consume(m[1]!, m[0]);
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  if (y < 1900 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Calendar correctness — JS Date rolls over invalid days, so we
  // reconstruct and compare.
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
function pad4(n: number): string {
  return n.toString().padStart(4, '0');
}

// ─── Prompt formatter ────────────────────────────────────────────────────

/**
 * Render a DETECTED_FACTS block for inclusion in the docExtractor
 * user prompt. Returns an empty string when there are no facts so
 * the prompt doesn't render a useless heading.
 */
export function formatDeterministicFactsForPrompt(
  facts: DeterministicFacts,
): string {
  const lines: string[] = [];
  for (const a of facts.aadhaar_numbers) {
    lines.push(
      `- Aadhaar: ${a.value} (Verhoeff checksum ${a.valid_checksum ? 'valid' : 'INVALID'})`,
    );
  }
  for (const d of facts.doctor_nmc_ids) {
    lines.push(`- Doctor council reg: ${d.council ?? ''} ${d.value}`.trim());
  }
  for (const p of facts.pmjay_ids) {
    lines.push(`- PMJAY/Ayushman ID: ${p.value}`);
  }
  for (const a of facts.abha_numbers) {
    lines.push(`- ABHA: ${a.value}`);
  }
  for (const m of facts.mobile_numbers) {
    lines.push(`- Mobile: ${m.value}`);
  }
  for (const dt of facts.dates) {
    const tag = dt.format_guess === 'ambiguous' ? ' (DD/MM vs MM/DD ambiguous)' : '';
    lines.push(`- Date: ${dt.iso} (from "${dt.original}")${tag}`);
  }
  for (const c of facts.currency_amounts) {
    lines.push(`- Amount: INR ${c.value_inr} (from "${c.matched_text}")`);
  }
  if (lines.length === 0) return '';
  return `DETECTED_FACTS (regex-validated, treat as high-confidence ground truth — prefer these values over your own re-extraction when they correspond to the same field):
${lines.join('\n')}

`;
}
