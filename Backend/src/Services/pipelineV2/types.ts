/**
 * Pipeline v2 — shared inter-stage data model.
 *
 * Every v2 stage is a DETERMINISTIC pure function over these types (the only
 * LLM call in the whole pipeline is Stage 1's vision read). Keeping the data
 * model in one place lets Stages 2-7 be unit-tested with hand-built fixtures —
 * no LLM spend, no DB, no S3 — which is the whole point of the redesign's
 * cost-control posture.
 *
 * TWO-LAYER ARTIFACT MODEL (the hard requirement)
 * ───────────────────────────────────────────────
 * Layer A = the immutable patient UPLOAD (`ipd_doc`). It is the coverage
 *   denominator and the ONLY thing that is ever a dedup peer or "a document".
 * Layer B = a DERIVED render (`derived_page`): a PDF page rasterised to PNG, a
 *   webp re-encoded to JPEG, etc. A derived page is NEVER counted as a
 *   document, NEVER an `ipd_doc` dedup peer, and is lineage-linked back to its
 *   source via (sourceDocId, pageIndex, transform). Stage 1 reads Layer-B
 *   images; coverage (Stage 0) is always measured against Layer A.
 */

import { PageRead } from '../llm/schemas/pageRead.js';

// ─── Layer B: a derived page render ─────────────────────────────────────────

/**
 * One rasterised/normalised page produced from a Layer-A source upload. This
 * is the unit Stage 1 actually reads. It is provenance-linked to its source
 * upload but is explicitly NOT a document in its own right.
 */
export interface DerivedPage {
  /** `derived_page.id` (uuid). Stable id used as provenance everywhere downstream. */
  id: string;
  /** The Layer-A `ipd_doc.id` this page was rendered from (lineage). */
  sourceDocId: string;
  /** 1-based page index WITHIN the source document. */
  pageIndex: number;
  /**
   * How this render was produced — part of the lineage key. e.g.
   * 'pdf_render' | 'webp_to_jpg' | 'heic_to_jpg' | 'identity' (already an image).
   */
  transform: string;
  /** Layer-B object key — a SEPARATE S3 prefix from `ipd_doc.s3_key`. */
  s3Key: string;
  /** MIME of the render, e.g. 'image/jpeg' | 'image/png'. */
  mime: string;
  /** sha256 of the render bytes — exact-duplicate key (distinct from perceptual). */
  sha256?: string;
  /** Perceptual hash of the render (hex) — near-duplicate key for Stage 3. */
  phash?: string;
  /** Difference hash of the render (hex) — corroborates phash in Stage 3. */
  dhash?: string;
}

/**
 * A derived page paired with its Stage-1 structured vision read. This is the
 * primary currency flowing through Stages 2-7.
 */
export interface PipelinePage {
  page: DerivedPage;
  read: PageRead;
  /** INR billed for THIS page's read(s) (0 on a fully-replayed run). */
  costInr?: number;
  /** Tier of the read that produced `read` ('cheap' | 'premium'). */
  tier?: 'cheap' | 'premium';
}

// ─── Stage 0: page manifest + coverage invariant (E6) ───────────────────────

/** A Layer-A source upload, with how many pages we expected to render from it. */
export interface SourceDocRef {
  /** `ipd_doc.id`. */
  sourceDocId: string;
  fileName?: string;
  mime?: string;
  /**
   * Pages we EXPECTED to derive from this source (PDF page count; 1 for a
   * single image). The coverage check compares this against pages actually
   * rendered so a silently-dropped page (E6 soft-drop) is caught loudly.
   */
  expectedPages: number;
}

/** The full set of Layer-B pages derived for a claim, with their sources. */
export interface PageManifest {
  claimId: string;
  sources: SourceDocRef[];
  pages: DerivedPage[];
}

/** Result of the Stage-0 content-coverage invariant. */
export interface CoverageReport {
  /** true ⇔ every source contributed at least its expected page count. */
  ok: boolean;
  totalSources: number;
  totalExpectedPages: number;
  totalRenderedPages: number;
  /** Sources whose rendered page count fell short — the soft-drop signal (E6). */
  missing: {
    sourceDocId: string;
    fileName?: string;
    expectedPages: number;
    renderedPages: number;
  }[];
  /** Sources that appear in `pages` but not in `sources` — orphan renders. */
  orphanSourceDocIds: string[];
}

// ─── Stage 4 output: canonical-shaped facts with provenance ─────────────────

/**
 * The closed set of canonical slots Stage 4 routes Stage-1 facts into and
 * Stage 5 fuses. Kept deliberately small and aligned with
 * harmonisedEpisode.ts so fusion output drops straight into the canonical
 * episode without an NLP step.
 */
export type CanonicalField =
  | 'primary_diagnosis'
  | 'secondary_diagnosis'
  | 'procedure_name'
  | 'laterality'
  | 'admission_date'
  | 'discharge_date'
  | 'surgery_date'
  | 'date_of_birth'
  | 'lab_value'
  | 'medication'
  | 'implant'
  | 'vital'
  | 'allergy'
  | 'anaesthesia'
  | 'blood_group'
  | 'policy_number'
  | 'insurer_name'
  | 'bill_total'
  | 'complaint'
  | 'finding'
  | 'other';

/**
 * A Stage-1 fact (or role-tagged date) routed to a canonical slot and stamped
 * with the provenance Stage 5 needs to authority-rank: the source page's
 * doc_type, the page id, and the page legibility.
 */
export interface SectionFact {
  /** Canonical slot this fact was routed to. */
  field: CanonicalField;
  /** The original Stage-1 `fact.field` (or date `role`) before routing. */
  rawField: string;
  /** The value as read (lightly normalised, e.g. laterality → 'Left'). */
  value: string;
  /** Verbatim provenance span from the page, when present. */
  quote?: string;
  /** 0..1 confidence in THIS fact (from Stage 1; distinct from page legibility). */
  confidence: number;
  /** doc_type of the source page — the PRIMARY authority key for fusion. */
  sourceDocType: string;
  /** `DerivedPage.id` this fact was read from — provenance for audit. */
  sourcePageId: string;
  /** Legibility of the source page — a secondary trust input to fusion. */
  pageLegibility: number;
}

// ─── Authority ranking — the D3 fix lives here ──────────────────────────────

/**
 * For each canonical field, the doc_type codes in order from MOST to LEAST
 * authoritative. Stage 5 picks the fact whose `sourceDocType` ranks highest
 * (lowest index); a doc_type not listed gets the lowest priority. Ties are
 * then broken by confidence × legibility.
 *
 * THIS IS THE D3 FIX. The legacy reader's inverted rule treated discharge
 * documents and admission notes as NOT-valid diagnosis sources, so a stale
 * "others" page or an OPD chief-complaint could outrank the discharge
 * summary's Final Diagnosis. Here discharge documents are the AUTHORITY for
 * the final diagnosis, OT notes are the authority for procedure + laterality,
 * and OPD/chief-complaint material is ranked last (and — crucially — Stage 1
 * tags chief complaints as `complaint`, not `primary_diagnosis`, so they never
 * even enter this contest).
 *
 * Codes are the live `doc_category` values from master_options (the same set
 * the legacy harmoniser routes on).
 */
export const FIELD_AUTHORITY: Record<CanonicalField, readonly string[]> = {
  // Final diagnosis: the discharge document wins. Admission/OT/progress notes
  // are valid corroboration but lower authority; OPD notes rank last.
  primary_diagnosis: [
    'discharge_summary',
    'discharge_slip',
    'surgical_discharge_slip',
    'ot_notes',
    'ot_notes_and_photos',
    'progress_notes',
    'icp',
    'treatment_sheet',
    'admission_form',
    'opd_notes',
  ],
  secondary_diagnosis: [
    'discharge_summary',
    'discharge_slip',
    'surgical_discharge_slip',
    'progress_notes',
    'icp',
    'treatment_sheet',
    'admission_form',
    'opd_notes',
  ],
  // Procedure + laterality: the operating surgeon's note is the authority.
  procedure_name: [
    'ot_notes',
    'ot_notes_and_photos',
    'surgical_checklist',
    'surgical_discharge_slip',
    'discharge_summary',
    'discharge_slip',
    'anaesthesia_fitness_reports',
  ],
  laterality: [
    'ot_notes',
    'ot_notes_and_photos',
    'surgical_checklist',
    'imaging_report',
    'surgical_discharge_slip',
    'discharge_summary',
    'discharge_slip',
  ],
  // Dates: the discharge summary carries the authoritative DOA/DOD; the OT
  // note carries the authoritative surgery date.
  admission_date: [
    'discharge_summary',
    'discharge_slip',
    'surgical_discharge_slip',
    'admission_form',
    'icp',
    'treatment_sheet',
    'progress_notes',
  ],
  discharge_date: [
    'discharge_summary',
    'discharge_slip',
    'surgical_discharge_slip',
    'bill',
    'financial_document',
  ],
  surgery_date: [
    'ot_notes',
    'ot_notes_and_photos',
    'surgical_checklist',
    'surgical_discharge_slip',
    'discharge_summary',
    'discharge_slip',
  ],
  date_of_birth: ['aadhaar_front', 'aadhaar_back', 'identity_document', 'discharge_summary', 'admission_form'],
  // Investigations: the lab/imaging report is the authority for its own values.
  lab_value: ['blood_test_reports', 'lab_report', 'investigation_report', 'discharge_summary'],
  medication: ['treatment_sheet', 'discharge_summary', 'discharge_slip', 'progress_notes', 'ot_notes'],
  implant: ['ot_notes', 'ot_notes_and_photos', 'surgical_checklist', 'bill', 'discharge_summary'],
  vital: ['treatment_sheet', 'progress_notes', 'icp', 'admission_form'],
  allergy: ['admission_form', 'icp', 'treatment_sheet', 'discharge_summary'],
  anaesthesia: ['ot_notes', 'anaesthesia_fitness_reports', 'anaesthesia_consent', 'surgical_checklist'],
  blood_group: ['blood_test_reports', 'lab_report', 'admission_form', 'discharge_summary'],
  // Administrative.
  policy_number: ['policy_document', 'insurance_card', 'pmjay_letter', 'bill'],
  insurer_name: ['policy_document', 'insurance_card', 'pmjay_letter', 'bill'],
  bill_total: ['bill', 'financial_document', 'package_breakup', 'discharge_summary'],
  // Non-authoritative slots — kept for completeness; never fused as truth.
  complaint: ['admission_form', 'opd_notes', 'icp', 'progress_notes'],
  finding: ['ot_notes', 'imaging_report', 'discharge_summary', 'progress_notes'],
  other: [],
};

/**
 * Lowest priority a doc_type can have for a field (assigned when the doc_type
 * is not in the field's authority list). Exported so Stage 5 and its tests
 * share one definition.
 */
export const UNRANKED_AUTHORITY = Number.MAX_SAFE_INTEGER;

/**
 * Authority rank of `docType` for `field` — lower is more authoritative. A
 * doc_type absent from the list returns UNRANKED_AUTHORITY.
 */
export function authorityRank(field: CanonicalField, docType: string): number {
  const list = FIELD_AUTHORITY[field] ?? [];
  const idx = list.indexOf(docType);
  return idx === -1 ? UNRANKED_AUTHORITY : idx;
}
