/**
 * Sprint 2 — Event Schema Extensions
 *
 * Single source of truth for the *typed* event kinds the Intelligence Layer
 * dispatches into hospital.submission_events.kind. Each kind has a Zod
 * schema describing the shape of `payload` that the dispatcher validates
 * before insert; an invalid payload throws InvalidEventPayloadError before
 * any I/O happens.
 *
 * This file is pure: no DB, no LLM, no I/O. Safe to import from anywhere
 * (controllers, services, tests, the FE if we ever share the constants).
 *
 * Legacy note: hospital.submission_events still has an `event_type` column
 * (migration 027) with a smaller open enum used by the existing
 * submissionEvents.service.ts. The new dispatcher writes into the `kind`
 * column (migration 030) using the constants below; the two coexist until
 * a later sprint backfills and drops the old column.
 */

import { z } from 'zod';

// ─── EventKind enumeration ────────────────────────────────────────────────
// Kept as a `as const` tuple so EventKind is a precise union *and* we can
// iterate the values at runtime (for tests, dispatcher self-check, etc.).
export const EVENT_KINDS = [
  // ── claim lifecycle ────────────────────────────────────────────────────
  'claim_created',
  'claim_closed',

  // ── documents ──────────────────────────────────────────────────────────
  'doc_uploaded',
  'doc_segmented',
  'section_classified',
  'section_extracted',
  'section_corrected',

  // ── emails (inbound) ───────────────────────────────────────────────────
  'inbound_email_received',
  'inbound_email_matched',
  'inbound_email_unmatched',

  // ── AI drafts ──────────────────────────────────────────────────────────
  'ai_draft_created',
  'ai_draft_applied',
  'ai_draft_rejected',

  // ── stage ──────────────────────────────────────────────────────────────
  'stage_transitioned',

  // ── submission pipeline ────────────────────────────────────────────────
  'submission_drafted',
  'submission_queued',
  'submission_sent',
  'submission_failed',

  // ── queries (insurer deficiencies) ─────────────────────────────────────
  'query_raised',
  'query_resolved',

  // ── adjudication ───────────────────────────────────────────────────────
  'adjudication_run',

  // ── actions (whatsapp, in-app, approval) ───────────────────────────────
  'claim_action_dispatched',
  'claim_action_acked',
  'claim_action_declined',

  // ── harmonisation (Wave 7) ─────────────────────────────────────────────
  // 'claim_harmonised'    — a fresh canonical medical_episode.v2 has been
  //                          generated (or refreshed) for the claim.
  // 'harmonisation_corrected' — a human applied a correction to one JSONPath
  //                          on the canonical episode.
  'claim_harmonised',
  'harmonisation_corrected',

  // ── Wave 8 — rules engine v2 overrides ─────────────────────────────────
  // 'rule_override' fires when an operator overrides a v2 rule evaluation
  // (mark_passed / mark_skipped / accept_deduction). Consumed by the Wave
  // 10 correction-to-KB pipeline to mine rule_overreach patterns.
  'rule_override',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

// ─── Shared building blocks ───────────────────────────────────────────────
// `z.unknown()` for "we don't constrain the shape but the field is required";
// `z.any().optional()` for free-form optional bags.
const uuid = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });
const nonEmpty = z.string().min(1);

// ─── Per-kind payload schemas ─────────────────────────────────────────────
// Each schema describes ONLY the event-specific payload. Common fields
// (claim_id, hospital_id, actor_user_id, idempotency_key, correlation_id)
// live on the dispatcher input, not in payload.

const ClaimCreatedPayload = z.object({
  initial_stage: nonEmpty,
});

const ClaimClosedPayload = z.object({
  final_stage: nonEmpty,
  reason: z.string().optional(),
});

const DocUploadedPayload = z.object({
  document_id: uuid,
  doc_count_pages: z.number().int().nonnegative(),
  uploaded_by: nonEmpty,
});

const DocSegmentedPayload = z.object({
  document_id: uuid,
  section_ids: z.array(uuid),
  segmenter_version: nonEmpty,
});

const SectionClassifiedPayload = z.object({
  section_id: uuid,
  category: nonEmpty,
  confidence: z.number().min(0).max(1),
  classifier_version: nonEmpty,
});

const SectionExtractedPayload = z.object({
  section_id: uuid,
  extraction_id: uuid,
  confidence: z.number().min(0).max(1),
  extractor_version: nonEmpty,
});

const SectionCorrectedPayload = z.object({
  section_id: uuid,
  action: z.enum(['split', 'merge', 'reclassify']),
  before: z.unknown(),
  after: z.unknown(),
  corrected_by: nonEmpty,
});

const InboundEmailReceivedPayload = z.object({
  email_id: uuid,
  sender: nonEmpty,
  subject: z.string(),
  matched: z.boolean(),
});

const InboundEmailMatchedPayload = z.object({
  email_id: uuid,
  claim_id: uuid,
  match_strategy: nonEmpty,
});

const InboundEmailUnmatchedPayload = z.object({
  email_id: uuid,
  reason: nonEmpty,
});

const AiDraftCreatedPayload = z.object({
  draft_id: uuid,
  kind: nonEmpty,
  confidence: z.number().min(0).max(1),
  llm_provider: nonEmpty,
  llm_model: nonEmpty,
  tokens_used: z.number().int().nonnegative(),
  cost_inr: z.number().nonnegative(),
});

const AiDraftAppliedPayload = z.object({
  draft_id: uuid,
  applied_by: nonEmpty,
  field_overrides: z.unknown(),
});

const AiDraftRejectedPayload = z.object({
  draft_id: uuid,
  rejected_by: nonEmpty,
  reason: nonEmpty,
});

const StageTransitionedPayload = z.object({
  transition_id: uuid,
  before_stage: z.string().nullable(),
  after_stage: nonEmpty,
  triggered_by: z.enum([
    'human',
    'ai_suggestion',
    'inbound_email',
    'submission_sent',
    'timeout',
  ]),
  triggering_event_id: uuid.nullable(),
  was_reversal: z.boolean(),
});

const SubmissionDraftedPayload = z.object({
  submission_id: uuid,
  draft_kind: nonEmpty,
  attachments_count: z.number().int().nonnegative(),
});

const SubmissionQueuedPayload = z.object({
  submission_id: uuid,
  interface_id: uuid,
});

const SubmissionSentPayload = z.object({
  submission_id: uuid,
  interface_id: uuid,
  message_id: nonEmpty,
});

const SubmissionFailedPayload = z.object({
  submission_id: uuid,
  error: nonEmpty,
});

const QueryRaisedPayload = z.object({
  query_id: uuid,
  deficiency_type: nonEmpty,
  raised_at: isoDate,
  deadline: isoDate.nullable(),
});

const QueryResolvedPayload = z.object({
  query_id: uuid,
  resolved_at: isoDate,
  resolved_by: nonEmpty,
  resolution_doc_section_id: uuid.nullable(),
});

const AdjudicationRunPayload = z.object({
  report_id: uuid,
  target_stage: nonEmpty,
  readiness: z.number().min(0).max(1),
  blocking_gaps_count: z.number().int().nonnegative(),
  warnings_count: z.number().int().nonnegative(),
});

const ClaimActionDispatchedPayload = z.object({
  action_id: uuid,
  action_kind: nonEmpty,
  target: nonEmpty,
  payload_summary: z.string(),
});

const ClaimActionAckedPayload = z.object({
  action_id: uuid,
  acked_by: nonEmpty,
  response: z.unknown(),
});

const ClaimActionDeclinedPayload = z.object({
  action_id: uuid,
  declined_by: nonEmpty,
  reason: nonEmpty,
});

// ─── Wave 7 — Harmonisation ──────────────────────────────────────────────
// claim_harmonised fires when the harmoniser successfully writes a fresh
// medical_episode.v2 instance to hospital.claim_harmonised_episodes. The
// payload is intentionally small — consumers re-read the row when they
// need the full episode JSON.
const ClaimHarmonisedPayload = z.object({
  dossier_state_hash: nonEmpty,
  cost_inr: z.number().nonnegative(),
  tokens_used: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1).nullable(),
});

// harmonisation_corrected fires per human override on the canonical
// episode. json_path is the JSONPath the human edited; ai_value /
// human_value are the before/after blobs. Consumers (the learning loop
// in a future wave) read these to mine "AI emits X but humans always
// correct to Y" patterns.
const HarmonisationCorrectedPayload = z.object({
  json_path: nonEmpty,
  ai_value: z.unknown().nullable(),
  human_value: z.unknown(),
  corrected_by: nonEmpty,
});

// rule_override fires whenever a human overrides a rules-v2 evaluation. The
// payload mirrors the columns of hospital.rule_overrides — consumers (the
// Wave 10 miner) read the rule_id + action to mine rule_overreach patterns.
const RuleOverridePayload = z.object({
  rule_set_id: nonEmpty,
  rule_id: nonEmpty,
  action: z.enum(['mark_passed', 'mark_skipped', 'accept_deduction']),
  reason: nonEmpty,
  overridden_by: nonEmpty,
});

// ─── Consolidated map ─────────────────────────────────────────────────────
// `satisfies` here is intentional: we want both (a) the precise per-key
// schema types preserved (so EventPayload<K> stays narrow) and (b) the
// compile-time guarantee that we covered every EventKind.
export const EVENT_PAYLOAD_SCHEMAS = {
  claim_created: ClaimCreatedPayload,
  claim_closed: ClaimClosedPayload,

  doc_uploaded: DocUploadedPayload,
  doc_segmented: DocSegmentedPayload,
  section_classified: SectionClassifiedPayload,
  section_extracted: SectionExtractedPayload,
  section_corrected: SectionCorrectedPayload,

  inbound_email_received: InboundEmailReceivedPayload,
  inbound_email_matched: InboundEmailMatchedPayload,
  inbound_email_unmatched: InboundEmailUnmatchedPayload,

  ai_draft_created: AiDraftCreatedPayload,
  ai_draft_applied: AiDraftAppliedPayload,
  ai_draft_rejected: AiDraftRejectedPayload,

  stage_transitioned: StageTransitionedPayload,

  submission_drafted: SubmissionDraftedPayload,
  submission_queued: SubmissionQueuedPayload,
  submission_sent: SubmissionSentPayload,
  submission_failed: SubmissionFailedPayload,

  query_raised: QueryRaisedPayload,
  query_resolved: QueryResolvedPayload,

  adjudication_run: AdjudicationRunPayload,

  claim_action_dispatched: ClaimActionDispatchedPayload,
  claim_action_acked: ClaimActionAckedPayload,
  claim_action_declined: ClaimActionDeclinedPayload,

  claim_harmonised: ClaimHarmonisedPayload,
  harmonisation_corrected: HarmonisationCorrectedPayload,

  rule_override: RuleOverridePayload,
} as const satisfies Record<EventKind, z.ZodTypeAny>;

// Narrow helper for "payload of kind K" — preferred over `any` at call sites.
export type EventPayload<K extends EventKind> = z.infer<
  (typeof EVENT_PAYLOAD_SCHEMAS)[K]
>;

/**
 * Compile-time check: every EventKind has a schema entry. If a new kind is
 * added to EVENT_KINDS without a schema, this assignment fails to type-check.
 */
const _exhaustivenessCheck: Record<EventKind, z.ZodTypeAny> =
  EVENT_PAYLOAD_SCHEMAS;
void _exhaustivenessCheck;
