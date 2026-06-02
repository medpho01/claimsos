/**
 * Pipeline v2 — Stage 4: Type-conditioned extraction.
 *
 * A DETERMINISTIC refinement of the Stage-1 reads. Stage 1 already did the
 * expensive part (reading the page image and emitting facts + role-tagged
 * dates with verbatim quotes and per-fact confidence). Stage 4 does NOT call
 * an LLM — it routes each Stage-1 fact into a canonical slot, lightly
 * normalises the value, and stamps it with the provenance Stage 5 needs to
 * authority-rank: the source page's doc_type, the page id, and the page
 * legibility.
 *
 * Why a separate stage instead of folding this into Stage 1: routing + value
 * normalisation is cheap, deterministic, and tweak-heavy. Keeping it out of the
 * (cached, expensive) vision prompt means we can iterate the canonical
 * vocabulary and the laterality/date normalisers for free — no re-read, no
 * spend — and re-run over the recorded corpus instantly.
 *
 * THE D3 GUARD lives partly here: chief complaints arrive from Stage 1 tagged
 * `complaint`, and this stage keeps them as `complaint` — it NEVER promotes a
 * symptom into `primary_diagnosis`. Combined with Stage 5's authority ranking
 * (discharge documents win the diagnosis), that closes the inverted
 * diagnosis-source failure: "chest pain" can no longer masquerade as the
 * primary diagnosis.
 */

import { PipelinePage, SectionFact, CanonicalField } from './types.js';

/**
 * Map a Stage-1 fact `field` (or a synonym the model drifted to) onto a
 * canonical slot. Unknown fields fall through to 'other' (preserved, never
 * dropped). Note `complaint` and `finding` are kept as themselves — they are
 * deliberately NOT diagnoses.
 */
const FIELD_ROUTING: Record<string, CanonicalField> = {
  // 1:1 with the Stage-1 vocab
  primary_diagnosis: 'primary_diagnosis',
  secondary_diagnosis: 'secondary_diagnosis',
  procedure_name: 'procedure_name',
  laterality: 'laterality',
  lab_value: 'lab_value',
  medication: 'medication',
  implant: 'implant',
  vital: 'vital',
  complaint: 'complaint',
  finding: 'finding',
  allergy: 'allergy',
  anaesthesia: 'anaesthesia',
  blood_group: 'blood_group',
  policy_number: 'policy_number',
  insurer_name: 'insurer_name',
  bill_total: 'bill_total',
  // common model-drift synonyms
  diagnosis: 'primary_diagnosis',
  final_diagnosis: 'primary_diagnosis',
  provisional_diagnosis: 'secondary_diagnosis',
  procedure: 'procedure_name',
  operation: 'procedure_name',
  surgery: 'procedure_name',
  side: 'laterality',
  lab: 'lab_value',
  lab_result: 'lab_value',
  investigation: 'lab_value',
  drug: 'medication',
  medicine: 'medication',
  prosthesis: 'implant',
  prosthesis_used: 'implant',
  bloodgroup: 'blood_group',
  policy: 'policy_number',
  insurer: 'insurer_name',
  bill: 'bill_total',
  bill_amount: 'bill_total',
};

/** Map a Stage-1 date `role` to a canonical date slot, or null to skip it. */
const DATE_ROLE_ROUTING: Record<string, CanonicalField | null> = {
  admission: 'admission_date',
  discharge: 'discharge_date',
  surgery: 'surgery_date',
  dob: 'date_of_birth',
  // report/visit/document/other dates are not authoritative episode dates —
  // they are retained on the page transcription but not fused as slots.
  report: null,
  visit: null,
  document: null,
  other: null,
};

/**
 * Doc types where a `document`/`visit` date may CONSERVATIVELY stand in for a
 * missing `admission` date. The bug: a short admission's only admission date is
 * often printed as a `document` date (e.g. "20/02/2026") or a `visit` date
 * (e.g. "3/2/26") on an admission-notes page that carries NO `admission`-role
 * date — so it was dropped entirely. We ONLY apply this on admission-bearing
 * doc types: an investigations/lab page's `report` date must NEVER become an
 * admission date (that safety property is the whole point of gating by doc type).
 */
const ADMISSION_DATE_FALLBACK_DOCS = new Set([
  'admission_notes',
  'admission_form',
  'icp',
  'treatment_sheet',
]);

/**
 * Confidence multipliers for the admission-date fallback, applied to the page
 * legibility. A `document` date is a stronger admission proxy than a `visit`
 * date, and BOTH are kept below a real `admission`-role date's confidence (which
 * uses the full legibility, factor 1.0) so any genuine admission date always
 * outranks a fallback in Stage-5 fusion.
 */
const ADMISSION_FALLBACK_DOCUMENT_WEIGHT = 0.6;
const ADMISSION_FALLBACK_VISIT_WEIGHT = 0.45;

export interface ExtractOptions {
  /** Page ids to exclude entirely (e.g. Stage-2 quarantined pages). */
  excludePageIds?: ReadonlySet<string>;
  /** Include blank/noise pages' facts. Default false (they carry none anyway). */
  includeBlankNoise?: boolean;
}

/**
 * Refine Stage-1 reads into canonical-shaped SectionFacts.
 *
 * @param pages — Stage-1-read pages (quarantined pages should be excluded via
 *   `excludePageIds`, OR simply not passed in).
 * @returns a flat array of SectionFacts, each provenance-stamped for fusion.
 */
export function extractSectionFacts(
  pages: PipelinePage[],
  options: ExtractOptions = {},
): SectionFact[] {
  const exclude = options.excludePageIds ?? new Set<string>();
  const out: SectionFact[] = [];

  for (const p of pages) {
    if (exclude.has(p.page.id)) continue;
    if (p.read.is_blank_or_noise && !options.includeBlankNoise) continue;

    const docType = p.read.doc_type;
    const pageId = p.page.id;
    const pageLegibility = p.read.legibility;

    // ── Clinical/administrative facts ──
    for (const f of p.read.facts ?? []) {
      const rawField = String(f.field ?? '').trim();
      const field = FIELD_ROUTING[rawField.toLowerCase()] ?? 'other';
      const value = normalizeValue(field, String(f.value ?? ''));
      if (value.length === 0) continue;
      out.push({
        field,
        rawField,
        value,
        quote: f.quote,
        confidence: clamp01(typeof f.confidence === 'number' ? f.confidence : 0),
        sourceDocType: docType,
        sourcePageId: pageId,
        pageLegibility,
      });
    }

    // ── Role-tagged dates → canonical date slots ──
    const dates = p.read.dates ?? [];
    let hasAdmissionDate = false;
    for (const d of dates) {
      const role = String(d.role ?? '').toLowerCase();
      const field = DATE_ROLE_ROUTING[role];
      if (role === 'admission') hasAdmissionDate = true;
      if (!field) continue;
      const value = String(d.value ?? '').trim();
      if (value.length === 0) continue;
      out.push({
        field,
        rawField: role,
        value,
        quote: d.quote,
        // PageDate carries no per-date confidence; a date is only as trustworthy
        // as the page it was read from, so legibility is the proxy here.
        confidence: pageLegibility,
        sourceDocType: docType,
        sourcePageId: pageId,
        pageLegibility,
      });
    }

    // ── Admission-date fallback (doc-type gated, reduced confidence) ──
    // On an admission-bearing page with NO admission-role date, recover the
    // admission date from a `document` date (preferred) or else a `visit` date,
    // at reduced confidence so any real admission date always wins in fusion.
    // Deliberately NOT applied to `report`/`other` roles or any non-admission
    // doc type, so a lab/investigations page's report date is never promoted.
    if (ADMISSION_DATE_FALLBACK_DOCS.has(docType) && !hasAdmissionDate) {
      const pick = (wantRole: string) =>
        dates.find((d) => String(d.role ?? '').toLowerCase() === wantRole && String(d.value ?? '').trim().length > 0);
      const documentDate = pick('document');
      const visitDate = pick('visit');
      const chosen = documentDate
        ? { d: documentDate, weight: ADMISSION_FALLBACK_DOCUMENT_WEIGHT, raw: 'document(fallback)' }
        : visitDate
          ? { d: visitDate, weight: ADMISSION_FALLBACK_VISIT_WEIGHT, raw: 'visit(fallback)' }
          : null;
      if (chosen) {
        out.push({
          field: 'admission_date',
          rawField: chosen.raw,
          value: String(chosen.d.value ?? '').trim(),
          quote: chosen.d.quote,
          confidence: clamp01(pageLegibility * chosen.weight),
          sourceDocType: docType,
          sourcePageId: pageId,
          pageLegibility,
        });
      }
    }
  }

  return out;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Light, slot-specific value normalisation. */
function normalizeValue(field: CanonicalField, raw: string): string {
  const v = raw.replace(/\s+/g, ' ').trim();
  if (field === 'laterality') return normalizeLaterality(v);
  return v;
}

/**
 * Canonicalise laterality to 'Left' | 'Right' | 'Bilateral' from the many
 * shorthands a chart uses (Rt., R, (R), Lt, L, B/L, bilat). Anything we can't
 * confidently map is returned trimmed — Stage 6's value validator decides what
 * to do with an unrecognised laterality rather than this stage guessing.
 */
export function normalizeLaterality(raw: string): string {
  const s = raw.toLowerCase().replace(/[().]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(bilateral|bilat|b\s*\/?\s*l|both)\b/.test(s)) return 'Bilateral';
  const isRight = /\b(right|rt|r)\b/.test(s);
  const isLeft = /\b(left|lt|l)\b/.test(s);
  if (isRight && isLeft) return 'Bilateral';
  if (isRight) return 'Right';
  if (isLeft) return 'Left';
  return raw.trim();
}
