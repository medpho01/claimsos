/**
 * Claim Dossier Projector
 *
 * Pure event-folding logic for hospital.claim_dossiers. Given a current
 * ClaimDossier value and a submission_events row, return the next ClaimDossier
 * value. No I/O, no side effects, no DB access — this is the math that the
 * Bull worker (`Workers/claimDossierProjector.queue.ts`) and the rebuild
 * routine in `claimDossier.service.ts` both call.
 *
 * Keeping the fold pure means:
 *   - We can unit-test every event kind in isolation against a known input.
 *   - `rebuildFromEvents` is literally `events.reduce(applyEvent, blank)`.
 *   - Re-applying the same event is a no-op (`applyEvent` is idempotent w.r.t.
 *     event.id — see "Idempotency" below).
 *
 * Idempotency
 * -----------
 * Every list-mutating handler dedupes on event.id (or on the natural key of
 * the embedded object — e.g. doc_section_id, query_id) so that re-applying the
 * same event a second time does not double-add. The worker layer ALSO short-
 * circuits via last_event_at, but defence-in-depth at the projector level is
 * cheap and prevents drift if the worker's timestamp check is bypassed (e.g.
 * during a full rebuild).
 *
 * Vocabulary
 * ----------
 * Event kinds below mirror the Wave 1 canonical vocabulary being defined in
 * `Services/events/eventTypes.ts` by Lane A. We reference the strings directly
 * so this module can be merged independently — when that file lands the typed
 * union can be imported and the runtime switch tightened.
 */

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface PatientSummary {
  name?: string | null;
  uhid?: string | null;
  room?: string | null;
  primary_diagnosis?: string | null;
  procedure?: string | null;
}

export interface ClaimAmounts {
  claimed?: number | null;
  pre_auth_approved?: number | null;
  enhancement_approved?: number | null;
  final_approved?: number | null;
  deducted?: number | null;
}

export interface EventsSummaryEntry {
  event_id: string;
  kind: string;
  at: string; // ISO timestamp
  actor?: string | null;
  salient?: Record<string, unknown> | null;
}

export interface InboundEmailEntry {
  event_id: string;
  inbound_id?: string | null;
  at: string;
  subject?: string | null;
  matched?: boolean;
  match_confidence?: number | null;
}

export interface OutboundSubmissionEntry {
  event_id: string;
  email_outbound_id?: string | null;
  status: 'drafted' | 'queued' | 'sent' | 'failed';
  at: string;
  failure_reason?: string | null;
}

export interface ActiveQuery {
  query_id: string;
  raised_at: string;
  raised_by?: string | null;
  question?: string | null;
  deficiency_type?: string | null;
}

export interface PendingAction {
  action_id: string;
  kind: string;
  dispatched_at: string;
  target?: string | null;
  payload?: Record<string, unknown>;
}

export interface AiDraftPending {
  draft_id: string;
  kind: string; // e.g. 'reply_to_query', 'enhancement_request'
  created_at: string;
  preview?: string | null;
}

export interface DocSufficiencyPerStage {
  [stageCode: string]: {
    required: string[];
    present: string[];
    missing: string[];
  };
}

export interface ClaimDossier {
  claim_id: string;
  last_event_id: string | null;
  last_event_at: Date | null;
  version: number;
  current_stage: string | null;
  current_panel_id: string | null;
  current_insurer_id: string | null;
  patient_summary: PatientSummary | null;
  amounts: ClaimAmounts | null;
  doc_sections_by_category: Record<string, string[]> | null;
  doc_sufficiency_per_stage: DocSufficiencyPerStage | null;
  events_summary: EventsSummaryEntry[];
  inbound_emails: InboundEmailEntry[];
  outbound_submissions: OutboundSubmissionEntry[];
  active_queries: ActiveQuery[];
  pending_actions: PendingAction[];
  active_adjudication: Record<string, unknown> | null;
  ai_drafts_pending: AiDraftPending[];
  matched_kb_patterns: string[];
  case_embedding_state: 'fresh' | 'stale' | 'pending' | null;
  closed_at: Date | null;
  closure_outcome: 'settled' | 'rejected' | 'withdrawn' | null;
  retrospective_summary: Record<string, unknown> | null;
  updated_at: Date;
}

export interface SubmissionEventRow {
  id: string;
  kind: string;            // alias for event_type — projector uses 'kind'
  payload: Record<string, any>;
  actor?: string | null;
  created_at: Date;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

export function blankDossier(claim_id: string): ClaimDossier {
  return {
    claim_id,
    last_event_id: null,
    last_event_at: null,
    version: 0,
    current_stage: null,
    current_panel_id: null,
    current_insurer_id: null,
    patient_summary: null,
    amounts: null,
    doc_sections_by_category: null,
    doc_sufficiency_per_stage: null,
    events_summary: [],
    inbound_emails: [],
    outbound_submissions: [],
    active_queries: [],
    pending_actions: [],
    active_adjudication: null,
    ai_drafts_pending: [],
    matched_kb_patterns: [],
    case_embedding_state: null,
    closed_at: null,
    closure_outcome: null,
    retrospective_summary: null,
    updated_at: new Date(0),
  };
}

function isoOf(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function appendUniqueByEventId<T extends { event_id: string }>(
  list: T[],
  next: T
): T[] {
  if (list.some((e) => e.event_id === next.event_id)) return list;
  return [...list, next];
}

function appendSummary(
  dossier: ClaimDossier,
  event: SubmissionEventRow,
  salient?: Record<string, unknown>
): EventsSummaryEntry[] {
  const entry: EventsSummaryEntry = {
    event_id: event.id,
    kind: event.kind,
    at: isoOf(event.created_at),
    actor: event.actor ?? null,
    salient: salient ?? null,
  };
  return appendUniqueByEventId(dossier.events_summary, entry);
}

function bumpMeta(
  dossier: ClaimDossier,
  event: SubmissionEventRow
): Pick<ClaimDossier, 'last_event_id' | 'last_event_at' | 'version' | 'updated_at'> {
  return {
    last_event_id: event.id,
    last_event_at: event.created_at,
    version: dossier.version + 1,
    updated_at: new Date(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// applyEvent — the fold
// ────────────────────────────────────────────────────────────────────────────

export function applyEvent(
  dossier: ClaimDossier,
  event: SubmissionEventRow
): ClaimDossier {
  // Idempotency short-circuit: same event.id already folded ⇒ no-op.
  if (dossier.last_event_id === event.id) return dossier;
  // Out-of-order safety: event older than last folded ⇒ also no-op. Callers
  // should sort by created_at, but defensive.
  if (
    dossier.last_event_at &&
    new Date(event.created_at).getTime() < dossier.last_event_at.getTime()
  ) {
    return dossier;
  }

  const p = event.payload ?? {};

  switch (event.kind) {
    // ─── Lifecycle ────────────────────────────────────────────────────────
    case 'claim_created': {
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        current_stage: p.initial_stage ?? dossier.current_stage,
        current_panel_id: p.panel_id ?? dossier.current_panel_id,
        current_insurer_id: p.insurer_id ?? dossier.current_insurer_id,
        patient_summary: p.patient_summary ?? dossier.patient_summary,
        amounts:
          p.amounts ??
          (p.claimed != null
            ? { ...(dossier.amounts ?? {}), claimed: p.claimed }
            : dossier.amounts),
        events_summary: appendSummary(dossier, event, {
          initial_stage: p.initial_stage ?? null,
        }),
      };
    }

    // Accept both the new canonical kind ('stage_transitioned' from
    // eventDispatcher, payload {before_stage, after_stage}) and the legacy
    // 'stage_changed' kind from recordIpdStageChange (payload {from, to}).
    // Resolution: prefer the canonical keys, fall back to legacy keys.
    case 'stage_transitioned':
    case 'stage_changed': {
      const beforeStage = (p.before_stage ?? p.from) ?? null;
      const afterStage = (p.after_stage ?? p.to) ?? null;
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        current_stage: afterStage ?? dossier.current_stage,
        events_summary: appendSummary(dossier, event, {
          before_stage: beforeStage,
          after_stage: afterStage,
          triggered_by: p.triggered_by ?? null,
          was_reversal: p.was_reversal ?? null,
        }),
      };
    }

    case 'claim_closed': {
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        closed_at: event.created_at,
        closure_outcome: (p.outcome ?? null) as ClaimDossier['closure_outcome'],
        retrospective_summary: p.retrospective_summary ?? p.summary ?? null,
        events_summary: appendSummary(dossier, event, {
          outcome: p.outcome ?? null,
        }),
      };
    }

    // ─── Documents ────────────────────────────────────────────────────────
    case 'doc_uploaded': {
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        events_summary: appendSummary(dossier, event, {
          doc_id: p.doc_id ?? null,
          file_name: p.file_name ?? null,
        }),
      };
    }

    case 'doc_segmented': {
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        events_summary: appendSummary(dossier, event, {
          doc_id: p.doc_id ?? null,
          section_count: p.section_count ?? null,
        }),
      };
    }

    case 'section_classified': {
      const category: string | undefined = p.category;
      const section_id: string | undefined = p.section_id;
      let bucket = dossier.doc_sections_by_category ?? {};
      if (category && section_id) {
        const existing = bucket[category] ?? [];
        if (!existing.includes(section_id)) {
          bucket = { ...bucket, [category]: [...existing, section_id] };
        }
      }
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        doc_sections_by_category: bucket,
        events_summary: appendSummary(dossier, event, {
          category: category ?? null,
          section_id: section_id ?? null,
        }),
      };
    }

    case 'section_extracted': {
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        events_summary: appendSummary(dossier, event, {
          section_id: p.section_id ?? null,
          field_count: p.field_count ?? null,
        }),
      };
    }

    // ─── Inbound emails ───────────────────────────────────────────────────
    case 'inbound_email_received':
    case 'inbound_email_matched': {
      const entry: InboundEmailEntry = {
        event_id: event.id,
        inbound_id: p.inbound_id ?? null,
        at: isoOf(event.created_at),
        subject: p.subject ?? null,
        matched: event.kind === 'inbound_email_matched',
        match_confidence: p.confidence ?? null,
      };
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        inbound_emails: appendUniqueByEventId(dossier.inbound_emails, entry),
        events_summary: appendSummary(dossier, event, {
          inbound_id: p.inbound_id ?? null,
        }),
      };
    }

    // ─── AI drafts ────────────────────────────────────────────────────────
    case 'ai_draft_created': {
      if (!p.draft_id) {
        return {
          ...dossier,
          ...bumpMeta(dossier, event),
          events_summary: appendSummary(dossier, event, { malformed: true }),
        };
      }
      const draft: AiDraftPending = {
        draft_id: p.draft_id,
        kind: p.kind ?? 'unspecified',
        created_at: isoOf(event.created_at),
        preview: p.preview ?? null,
      };
      const already = dossier.ai_drafts_pending.some(
        (d) => d.draft_id === draft.draft_id
      );
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        ai_drafts_pending: already
          ? dossier.ai_drafts_pending
          : [...dossier.ai_drafts_pending, draft],
        events_summary: appendSummary(dossier, event, {
          draft_id: draft.draft_id,
          kind: draft.kind,
        }),
      };
    }

    case 'ai_draft_applied':
    case 'ai_draft_rejected': {
      const draftId: string | undefined = p.draft_id;
      const next = draftId
        ? dossier.ai_drafts_pending.filter((d) => d.draft_id !== draftId)
        : dossier.ai_drafts_pending;
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        ai_drafts_pending: next,
        events_summary: appendSummary(dossier, event, {
          draft_id: draftId ?? null,
        }),
      };
    }

    // ─── Outbound submissions ─────────────────────────────────────────────
    case 'submission_drafted':
    case 'submission_queued':
    case 'submission_sent':
    case 'submission_failed': {
      const statusFromKind: OutboundSubmissionEntry['status'] = event.kind
        .replace('submission_', '') as OutboundSubmissionEntry['status'];
      const entry: OutboundSubmissionEntry = {
        event_id: event.id,
        email_outbound_id: p.email_outbound_id ?? null,
        status: statusFromKind,
        at: isoOf(event.created_at),
        failure_reason: p.failure_reason ?? null,
      };
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        outbound_submissions: appendUniqueByEventId(
          dossier.outbound_submissions,
          entry
        ),
        events_summary: appendSummary(dossier, event, {
          status: statusFromKind,
        }),
      };
    }

    // ─── Open queries ─────────────────────────────────────────────────────
    case 'query_raised': {
      if (!p.query_id) {
        return {
          ...dossier,
          ...bumpMeta(dossier, event),
          events_summary: appendSummary(dossier, event, { malformed: true }),
        };
      }
      const q: ActiveQuery = {
        query_id: p.query_id,
        raised_at: isoOf(event.created_at),
        raised_by: p.raised_by ?? event.actor ?? null,
        question: p.question ?? null,
        deficiency_type: p.deficiency_type ?? null,
      };
      const already = dossier.active_queries.some(
        (x) => x.query_id === q.query_id
      );
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        active_queries: already
          ? dossier.active_queries
          : [...dossier.active_queries, q],
        events_summary: appendSummary(dossier, event, {
          query_id: q.query_id,
          deficiency_type: q.deficiency_type,
        }),
      };
    }

    case 'query_resolved': {
      const qid: string | undefined = p.query_id;
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        active_queries: qid
          ? dossier.active_queries.filter((x) => x.query_id !== qid)
          : dossier.active_queries,
        events_summary: appendSummary(dossier, event, { query_id: qid ?? null }),
      };
    }

    // ─── Adjudication ─────────────────────────────────────────────────────
    case 'adjudication_run': {
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        active_adjudication: p.report ?? p ?? null,
        matched_kb_patterns:
          Array.isArray(p.matched_kb_patterns)
            ? Array.from(new Set([...dossier.matched_kb_patterns, ...p.matched_kb_patterns]))
            : dossier.matched_kb_patterns,
        events_summary: appendSummary(dossier, event, {
          verdict: p.verdict ?? null,
          confidence: p.confidence ?? null,
        }),
      };
    }

    // ─── Claim actions (RPA / portal dispatch) ────────────────────────────
    case 'claim_action_dispatched': {
      if (!p.action_id) {
        return {
          ...dossier,
          ...bumpMeta(dossier, event),
          events_summary: appendSummary(dossier, event, { malformed: true }),
        };
      }
      const action: PendingAction = {
        action_id: p.action_id,
        kind: p.kind ?? 'unspecified',
        dispatched_at: isoOf(event.created_at),
        target: p.target ?? null,
        payload: p.payload ?? null,
      };
      const already = dossier.pending_actions.some(
        (a) => a.action_id === action.action_id
      );
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        pending_actions: already
          ? dossier.pending_actions
          : [...dossier.pending_actions, action],
        events_summary: appendSummary(dossier, event, {
          action_id: action.action_id,
          kind: action.kind,
        }),
      };
    }

    case 'claim_action_acked':
    case 'claim_action_declined': {
      const aid: string | undefined = p.action_id;
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        pending_actions: aid
          ? dossier.pending_actions.filter((a) => a.action_id !== aid)
          : dossier.pending_actions,
        events_summary: appendSummary(dossier, event, {
          action_id: aid ?? null,
          result: event.kind === 'claim_action_acked' ? 'acked' : 'declined',
        }),
      };
    }

    // ─── Unknown ──────────────────────────────────────────────────────────
    default: {
      return {
        ...dossier,
        ...bumpMeta(dossier, event),
        events_summary: appendSummary(dossier, event, {
          warning: `unknown_event_kind:${event.kind}`,
        }),
      };
    }
  }
}
