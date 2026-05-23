/**
 * Email Intelligence — Zod schemas (Sprint 4, Wave 2C)
 *
 * Typed shapes for the LLM bridge's classify + extract calls on inbound
 * insurer emails. Mirrors:
 *
 *   - master_options(category='insurer_outcome') for the category enum
 *   - master_options(category='deficiency_type') for QueryExtraction
 *   - master_options(category='deduction_reason') for RejectionExtraction
 *
 * The schemas are intentionally narrow: every shape that lands in
 * email_intelligence_drafts.extracted_payload was first parsed by one of
 * these. The dispatcher / draft writer never sees raw model output.
 *
 * ISO-date string validation uses a YYYY-MM-DD regex rather than
 * z.string().date() because the SDK Zod version pinned in this repo
 * predates that helper. Keep both in sync if Zod is bumped.
 */

import { z } from 'zod';

// ─── Catalog literals (kept in sync with master_options seeds) ────────────
//
// We duplicate these here rather than reading them from the DB at module
// load time because (a) the Zod schemas need them at type-check time and
// (b) the LLM bridge runs in worker processes that shouldn't reach into
// the master_options table on every call. A future cleanup wires a CI
// check that asserts these arrays equal the master_options seed.

export const INSURER_OUTCOME_CATEGORIES = [
  'approved',
  'partially_approved',
  'queried',
  'rejected',
  'enhancement_approved',
  'enhancement_partial',
  'follow_up',
  'withdrawn',
  // Escape hatches — not in master_options. The reviewer picks the real
  // outcome at apply time.
  'other',
  'unknown',
] as const;

export const DEFICIENCY_TYPES = [
  'missing_consent',
  'missing_diagnosis_summary',
  'missing_procedure_estimate',
  'missing_icp',
  'missing_implant_invoice',
  'missing_final_bill',
  'diagnosis_mismatch',
  'icd_unspecified',
  'document_illegible',
  'signature_missing',
  'date_inconsistency',
] as const;

export const DEDUCTION_REASONS = [
  'non_payable_item',
  'room_rent_cap',
  'sublimit_breached',
  'copay_applied',
  'outside_package',
  'pre_existing_condition',
  'waiting_period',
  'capping_applied',
] as const;

export type InsurerOutcomeCategory = (typeof INSURER_OUTCOME_CATEGORIES)[number];
export type DeficiencyType = (typeof DEFICIENCY_TYPES)[number];
export type DeductionReason = (typeof DEDUCTION_REASONS)[number];

// ─── Shared building blocks ───────────────────────────────────────────────

// ISO date — YYYY-MM-DD. We accept date-only because insurer letters
// rarely carry times (validity windows, deadlines). The string regex is
// intentional: it surfaces a Zod error rather than swallowing junk like
// '2026-13-32'.
const isoDateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: 'expected ISO date YYYY-MM-DD',
});

const nonNegInr = z.number().nonnegative();

// ─── Classification schema ────────────────────────────────────────────────
//
// The LLM bridge's `classify` path uses LlmClassifyOpts.categories (a
// readonly string[]); this Zod schema is consumed by the service when it
// rolls its own extract-then-validate flow against the same prompt
// version. Both forms must agree.
export const EmailClassification = z.object({
  category: z.enum(INSURER_OUTCOME_CATEGORIES),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type EmailClassification = z.infer<typeof EmailClassification>;

// ─── ApprovalExtraction ───────────────────────────────────────────────────
// Used for: approved, partially_approved, enhancement_approved, enhancement_partial.
//
// All fields nullable because real-world insurer letters are inconsistent.
// notes catches anything the model thinks is salient but doesn't fit the
// other slots ("approved subject to TPA verification of consent").
export const ApprovalExtraction = z.object({
  amount_inr: nonNegInr.nullable(),
  room_category: z.string().nullable(),
  validity_from: isoDateOnly.nullable(),
  validity_to: isoDateOnly.nullable(),
  notes: z.string().nullable(),
});
export type ApprovalExtraction = z.infer<typeof ApprovalExtraction>;

// ─── QueryExtraction ──────────────────────────────────────────────────────
// Used for: queried, follow_up.
//
// `queries` is at least one item — by definition a query letter raises
// something. `deficiency_type` is nullable because the insurer's wording
// doesn't always map cleanly to our catalog; the reviewer can pick at
// apply time and the correction lands in email_intelligence_corrections.
export const QueryExtraction = z.object({
  queries: z
    .array(
      z.object({
        description: z.string(),
        deficiency_type: z.enum(DEFICIENCY_TYPES).nullable(),
        doc_requested: z.string().nullable(),
        deadline: isoDateOnly.nullable(),
      })
    )
    .min(1),
  severity: z.enum(['low', 'medium', 'high']),
});
export type QueryExtraction = z.infer<typeof QueryExtraction>;

// ─── RejectionExtraction ──────────────────────────────────────────────────
// Used for: rejected, withdrawn.
//
// `reasons` is the free-text narrative the insurer gave (often multiple
// paragraphs). `deduction_breakdown` is the structured per-line view —
// only populated for partial-rejection letters that itemise; full
// rejections leave it empty. .default([]) lets the model emit
// `deduction_breakdown: null/undefined` without breaking validation.
export const RejectionExtraction = z.object({
  reasons: z.array(z.string()).min(1),
  deduction_breakdown: z
    .array(
      z.object({
        reason: z.enum(DEDUCTION_REASONS),
        amount_inr: nonNegInr,
        description: z.string().nullable(),
      })
    )
    .default([]),
  appeal_allowed: z.boolean(),
  finality_note: z.string().nullable(),
});
export type RejectionExtraction = z.infer<typeof RejectionExtraction>;

// ─── Category routing ─────────────────────────────────────────────────────
// Convenience map used by the service to pick the right extraction schema
// based on the classifier's category. Exported so tests don't have to
// duplicate the branching logic.
export const EXTRACTION_SCHEMA_BY_CATEGORY: Partial<
  Record<InsurerOutcomeCategory, z.ZodTypeAny>
> = {
  approved: ApprovalExtraction,
  partially_approved: ApprovalExtraction,
  enhancement_approved: ApprovalExtraction,
  enhancement_partial: ApprovalExtraction,
  queried: QueryExtraction,
  follow_up: QueryExtraction,
  rejected: RejectionExtraction,
  withdrawn: RejectionExtraction,
  // 'other' and 'unknown' deliberately omitted — the service stores an
  // empty payload and routes to the human reviewer.
};

export type ExtractionPayload =
  | ApprovalExtraction
  | QueryExtraction
  | RejectionExtraction
  | null;
