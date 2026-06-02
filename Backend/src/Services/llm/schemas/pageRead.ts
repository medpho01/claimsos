/**
 * Pipeline v2 — Stage 1: Vision-native Page Read schema.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The cross-validation of 13 fresh patients (see SYNTHESIS) confirmed that
 * the OCR-first reader is the ROOT failure (dimension D1): Tesseract garble
 * cascades into false identity flags (D2), hallucinated/empty extractions
 * (D3), date misreads (D6), and dedup failures (D9). Vision-native reading
 * removes that root — the model reads the page image directly, so
 * handwriting, rotated scans, and low-contrast photos are read correctly
 * instead of being mangled into garbage tokens.
 *
 * Stage 1 is ONE consolidated vision call per source page that emits
 * everything visible on that page:
 *   - a faithful `transcription` (the OCR replacement)
 *   - the document `doc_type` + confidence (replaces per-page classify)
 *   - a `legibility` score that drives Sonnet escalation AND loud abstention
 *   - an `identity` block of STRUCTURED ids (uhid / ipd_number), name-position
 *     aware so a signatory/witness/address name is not mistaken for the
 *     patient (E2/E3)
 *   - `facts` — clinical facts carried as field+value+verbatim-quote+confidence
 *     so the deterministic Stage 5 fusion can authority-rank them by source
 *     doc type (this is the "section facts are first-class" requirement)
 *   - `dates` — temporal facts with an explicit semantic role; EXIF/upload
 *     timestamps are NEVER read here (Stage 0 keeps them as metadata only),
 *     which is the D6 fix.
 *
 * VALIDATION PHILOSOPHY (mirrors bundleClassifierOutput + harmonisedEpisode)
 * ─────────────────────────────────────────────────────────────────────────
 * STRICT on structural shape (scores are 0..1 numbers, booleans are booleans,
 * the collections are arrays) so a malformed read is caught and re-read;
 * TOLERANT on free text (reasoning/notes/quotes are truncated, never
 * rejected) and PASSTHROUGH on unknown extras so a richer model response is
 * preserved rather than dropped. A stripNullsDeep preprocessor normalises the
 * `null`-for-missing the model habitually emits on optional fields — the same
 * fix harmonisedEpisode needed after iter2.
 *
 * The `doc_type` string is validated against the live master_options
 * candidate list at the SERVICE layer, not here — this schema only guarantees
 * a non-empty code, exactly as BundleClassifierOutputSchema does for
 * `category`.
 */

import { z } from 'zod';

// ─── Free-text + collection helpers ────────────────────────────────────────
// Truncate (never reject) free text, and cap (never reject) collection length
// so a noisy model can't bloat the payload or blow the token budget.

/** A required free-text string, truncated to `max` chars. */
function cappedString(max: number) {
  return z.preprocess(
    (v) => (typeof v === 'string' ? v.slice(0, max) : v),
    z.string(),
  );
}

/** A non-empty code-like string (e.g. doc_type), truncated to `max` chars. */
function cappedCode(max: number) {
  return z.preprocess(
    (v) => (typeof v === 'string' ? v.slice(0, max) : v),
    z.string().min(1),
  );
}

/** An array truncated to `max` entries (excess silently dropped, not rejected). */
function cappedArray<S extends z.ZodTypeAny>(schema: S, max: number) {
  return z.preprocess(
    (v) => (Array.isArray(v) ? v.slice(0, max) : v),
    z.array(schema),
  );
}

/**
 * Like cappedArray, but DROPS entries that fail the element schema instead of
 * failing the whole read. A single malformed fact/date — e.g. a model "negative
 * fact" whose fields the null-strip left in a shape the element schema can't
 * accept — must NEVER hard-fail Stage 1 and abort the entire patient. The
 * bench12 record pass proved this is not theoretical: identity pages crash the
 * reader on null-filled blood_group facts, taking the whole claim down. Excess
 * entries past `max` are dropped first, then any that don't parse.
 */
function resilientArray<S extends z.ZodTypeAny>(schema: S, max: number) {
  return z.preprocess(
    (v) =>
      Array.isArray(v)
        ? v.slice(0, max).filter((item) => schema.safeParse(item).success)
        : v,
    z.array(schema),
  );
}

// ─── Identity (E2/E3) ───────────────────────────────────────────────────────
// Structured-ID corroboration is the gate's real signal — uhid / ipd_number
// are stable across every page of a stay and would have prevented every false
// "foreign document" flag in the cross-validation had they been extracted.
// `other_names` captures names that are NOT the patient (signatory, witness,
// guardian, referring doctor, an address line) WITH their role, so the Stage 2
// gate does not mistake an OT-surgeon's signature or a street name for
// cross-patient contamination (E3).

/** A name seen on the page that is NOT the patient, tagged with where it sits. */
export const OtherNameSchema = z
  .object({
    name: cappedString(200),
    /**
     * Where/what this name is: 'signatory' | 'witness' | 'doctor' |
     * 'guardian' | 'referrer' | 'address' | 'other'. Free string (not an
     * enum) so model drift doesn't fail the parse; Stage 2 maps it.
     */
    role: cappedString(40).optional(),
  })
  .passthrough();

export const PageIdentitySchema = z
  .object({
    /** The name in the PATIENT field/header — NOT a signatory or witness. */
    patient_name: cappedString(200).optional(),
    /** Structured hospital id — the primary corroboration key for the gate. */
    uhid: cappedString(80).optional(),
    /** In-patient / admission number — secondary corroboration key. */
    ipd_number: cappedString(80).optional(),
    mrn_number: cappedString(80).optional(),
    /** String, not number — tolerates "45 Y", "6 M", "3 days". */
    age: cappedString(40).optional(),
    sex: cappedString(20).optional(),
    /** Hospital/letterhead name printed on the page. */
    hospital_name: cappedString(200).optional(),
    /** Non-patient names with their role/position on the page (E3). */
    other_names: cappedArray(OtherNameSchema, 40).optional(),
  })
  .passthrough();

export type PageIdentity = z.infer<typeof PageIdentitySchema>;

// ─── Clinical facts (evidence-bearing, authority-rankable) ──────────────────
// Each fact mirrors the DiagnosisEvidence shape already in harmonisedEpisode:
// a value PLUS a verbatim `quote` for provenance PLUS a confidence. Stage 5
// fuses these deterministically, ranking by the source page's doc_type (e.g.
// discharge summary wins for diagnosis; OT note wins for procedure/laterality).

/** A single clinical fact read off the page, with provenance + confidence. */
export const PageFactSchema = z
  .object({
    /**
     * Canonical-ish field key so Stage 5 can route without NLP, e.g.
     * 'primary_diagnosis' | 'secondary_diagnosis' | 'procedure_name' |
     * 'laterality' | 'lab_value' | 'medication' | 'implant' | 'vital' |
     * 'complaint' | 'finding' | 'other'. Free string; Stage 4/5 normalise.
     */
    field: cappedCode(60),
    /**
     * The value as read (normalised lightly by the model, e.g. "Right").
     * OPTIONAL on purpose: the model legitimately emits "negative" facts on
     * identity / non-clinical pages, e.g. {field:'blood_group', value:null,
     * confidence:0} ("looked, not present"). stripNullsDeep removes the null,
     * so a REQUIRED value here makes the whole page-read — and therefore the
     * entire patient — hard-fail Stage 1 validation on any Aadhaar page. A
     * value-less fact carries no fusible value; Stage 5 simply ignores it.
     */
    value: cappedString(600).optional(),
    /** Verbatim span the value was read from — provenance for fusion + audit. */
    quote: cappedString(400).optional(),
    /**
     * 0..1 confidence in THIS fact (distinct from page legibility). DEFAULTS to
     * 0 when absent. The model emits "negative facts" with EVERY field nulled —
     * {field:'blood_group', value:null, quote:null, confidence:null} — on
     * identity pages; stripNullsDeep then removes the null confidence, and a
     * REQUIRED confidence hard-fails the whole page-read (and the whole patient)
     * on any such Aadhaar page. bench12 crashed babbu + kilpa_devi here EVEN
     * AFTER value was made optional — same bug class, second field. A
     * 0-confidence value-less fact carries nothing fusible; Stage 5 ignores it.
     * `.default(0)` keeps the parsed output type `number` (no consumer churn).
     */
    confidence: z.number().min(0).max(1).default(0),
  })
  .passthrough();

export type PageFact = z.infer<typeof PageFactSchema>;

// ─── Dates (D6 — first-class, role-tagged, never EXIF) ──────────────────────
// Date mis-anchoring caused a 66-day LOS from one misread digit and several
// EXIF/upload timestamps used as clinical dates. Reading dates as role-tagged
// facts (and ONLY dates printed on the page, never file metadata) lets Stage 5
// pick the authoritative admission/discharge/surgery dates deterministically.

/** A date printed on the page, with its clinical role. */
export const PageDateSchema = z
  .object({
    /**
     * 'admission' | 'discharge' | 'surgery' | 'report' | 'document' | 'dob' |
     * 'visit' | 'other'. Free string; Stage 5 maps to canonical slots.
     */
    role: cappedCode(40),
    /** The date as printed (any format — downstream does best-effort parse). */
    value: cappedString(60),
    /** Verbatim span the date was read from. */
    quote: cappedString(200).optional(),
  })
  .passthrough();

export type PageDate = z.infer<typeof PageDateSchema>;

// ─── stripNullsDeep (same fix harmonisedEpisode needed) ─────────────────────
// The model emits {uhid: null, ipd_number: null, age: null} for missing
// optionals, but those fields are .optional() (not .nullable()). Normalise
// null → omitted across the whole object BEFORE the field schemas run. Array
// entries that are null are preserved.
function stripNullsDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripNullsDeep);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue; // omit
      out[k] = stripNullsDeep(v);
    }
    return out;
  }
  return value;
}

// ─── PageRead — the Stage 1 contract ────────────────────────────────────────

export const PageReadSchema = z.preprocess(
  stripNullsDeep,
  z
    .object({
      // ── Legibility + abstention (E4/E5) ──
      /**
       * 0..1 overall readability of the page image. Drives the service's
       * Haiku→Sonnet escalation (low legibility ⇒ re-read with the stronger
       * model) and Stage 2's quarantine decision. This is NOT the model's
       * self-reported answer-confidence — a page can be perfectly legible yet
       * clinically ambiguous, or crystal-clear handwriting we simply can't
       * fuse.
       */
      legibility: z.number().min(0).max(1),
      /**
       * Hard signal: false ⇒ the page could not be read with enough fidelity
       * to trust ANY field on it. Stage 2 QUARANTINES these (loud abstention,
       * E4) — it must never silently yield a vacuum a confident-wrong stale
       * doc then fills.
       */
      is_legible: z.boolean(),
      /** What specifically was hard to read (water damage, cropped, etc.). */
      legibility_notes: cappedString(500).optional(),

      // ── Document typing (replaces per-page classify) ──
      /** A doc_category code — validated against master_options at the service layer. */
      doc_type: cappedCode(120),
      doc_type_confidence: z.number().min(0).max(1),
      doc_type_reasoning: cappedString(500).optional(),
      /**
       * true for blank pages, separator sheets, or pure decoration with no
       * clinical/identity content. Lets Stage 0's coverage invariant tell a
       * legitimately-empty page apart from a dropped one (E6 soft-drop).
       */
      is_blank_or_noise: z.boolean(),

      // ── Faithful transcription (the D1 OCR replacement) ──
      /** Verbatim text the model reads off the page. May be '' for a blank page. */
      transcription: cappedString(20000),

      // ── Identity (E2/E3) ──
      identity: PageIdentitySchema,

      // ── Clinical facts + dates (evidence-bearing) ──
      facts: resilientArray(PageFactSchema, 80),
      dates: resilientArray(PageDateSchema, 30).optional(),
    })
    .passthrough(),
);

export type PageRead = z.infer<typeof PageReadSchema>;
