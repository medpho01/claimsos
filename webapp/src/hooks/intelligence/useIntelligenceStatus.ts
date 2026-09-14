/**
 * useIntelligenceStatus — polls the per-claim AI pipeline status endpoint
 * so the Claim AI Summary page can render a live "Analyzing…" banner +
 * ETA + auto-refresh data hooks when async work completes.
 *
 * Polling cadence (three regimes, in priority order):
 *   1. run.status === 'paused'  → SLOW poll (>= 10s). A paused run produces
 *      no progress and the server-side recompute is a documented no-op, so
 *      a 3.5s poll would be pure noise. We still poll, because the pause can
 *      be lifted from another tab/operator and the card must un-stick itself.
 *   2. is_pending === true      → normal poll (`pollIntervalMs`, 3500ms).
 *   3. otherwise                → idle; the caller invalidates the dependent
 *      hooks (harmonised episode, rules v2, audit trail) on the pending→idle
 *      edge.
 */

import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

/** Mirrors the backend run state machine (contract §A.2). */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'superseded';

export type RunPauseReason = 'user_requested' | 'cost_consent_required';

export type RunEndReason =
  | 'completed'
  | 'budget_declined'
  | 'user_cancelled'
  | 'unreadable_pages'
  | 'orchestrator_error'
  | 'superseded';

/** Why a page could not be read. Frozen at five members (contract §C.1). */
export type UnreadableReason =
  | 'vision_failed'
  | 'cost_budget'
  | 'latency_budget'
  | 'page_budget'
  | 'render_failed';

/**
 * The `run` block of GET /intelligence/status. Everything below the
 * `pause_reason` line is new in the cost-consent / pause-resume round; the
 * fields above it are the pre-existing run cursor and are unchanged.
 *
 * Every new field is optional-by-convention on the wire (an older backend
 * simply omits them), so render defensively: `?? null`, never `!`.
 */
export interface IntelligenceRunStatus {
  id: string;
  status: RunStatus;
  phase: string | null;
  total_docs: number;
  docs_completed: number;
  docs_failed: number;
  triggered_at: string | null;
  finished_at: string | null;
  error: string | null;
  // ── cost consent / pause-resume ──
  pause_reason?: RunPauseReason | null;
  paused_at?: string | null;
  approved_budget_inr?: number | null;
  /** Live run spend. Present while running AND after a pause. */
  spend_so_far_inr?: number | null;
  /** Frozen at the moment of the pause — the number the decision was made on. */
  spend_at_pause_inr?: number | null;
  projected_remaining_inr?: number | null;
  /** ceil(projected_remaining * 1.25 / 10) * 10 — the primary CTA's number. */
  suggested_additional_budget_inr?: number | null;
  resume_count?: number;
  end_reason?: RunEndReason | null;
  can_pause?: boolean;
  can_resume?: boolean;
  can_cancel?: boolean;
}

/**
 * Compact unreadable-pages roll-up carried on /status. The full grouping
 * (per document, with page ranges and suggested actions) lives behind
 * GET /intelligence/runs/:runId/unreadable — see useUnreadableSummary.
 */
export interface IntelligenceUnreadableRollup {
  pages_total: number;
  documents_affected: number;
  by_reason: Record<UnreadableReason, number>;
  decision_required: boolean;
}

export interface IntelligenceStatus {
  claim_id: string;
  sections: {
    total: number;
    classified: number;
    extracted: number;
  };
  segmenter: { pending: boolean };
  harmoniser: {
    status: 'fresh' | 'stale' | 'pending' | 'failed' | 'absent';
    generated_at: string | null;
    cost_inr: number | null;
    error_message: string | null;
  };
  adjudication: {
    latest_at: string | null;
    readiness_score: number | null;
    recommended_action: string | null;
  };
  rules_v2: {
    latest_at: string | null;
    total: number;
    failed: number;
    skipped: number;
    rule_set_id: string | null;
  };
  /**
   * The current (or most recent) run cursor. Optional for backward compat
   * with a backend that predates the run table.
   */
  run?: IntelligenceRunStatus | null;
  /** Optional — absent when the backend predates unreadable-page tracking. */
  unreadable?: IntelligenceUnreadableRollup | null;
  is_pending: boolean;
  pending_components: string[];
  eta_seconds: number | null;
  /**
   * True when the claim has pending work but no section has been touched
   * in the last ~60s — the queue is genuinely stuck and the in-service
   * orphan detector / reconciler is the path back to progress. The
   * eta_seconds in this state reflects the healer's horizon, not active
   * flow. UI can show a "still working — auto-healing" message instead
   * of an "almost done" affordance.
   *
   * Optional (?) for backward compat with the prior BE; treat undefined
   * as `false` when rendering.
   *
   * NOTE: a PAUSED run is not stalled. Check `run.status === 'paused'`
   * first — a pause is a deliberate parked state, and showing the
   * auto-healing copy over it would be a lie.
   */
  is_stalled?: boolean;
  last_updated_at: string;
}

/** Minimum poll cadence while a run is parked in `paused`. */
export const PAUSED_POLL_INTERVAL_MS = 10_000;

/** A paused run is halted, not finished — it still owns the surface. */
export function isRunPaused(s: IntelligenceStatus | null | undefined): boolean {
  return s?.run?.status === 'paused';
}

/** Terminal per contract §A.2 — nothing further will happen on its own. */
export function isRunTerminal(status: RunStatus | null | undefined): boolean {
  return (
    status === 'succeeded' ||
    status === 'partial' ||
    status === 'failed' ||
    status === 'superseded'
  );
}

export function useIntelligenceStatus(
  claimId: string | null | undefined,
  opts?: { pollIntervalMs?: number; enabled?: boolean },
) {
  const pollMs = opts?.pollIntervalMs ?? 3500;
  const enabled = opts?.enabled !== false && !!claimId;
  return useQuery<IntelligenceStatus | null>({
    queryKey: ['intelligence-status', claimId],
    enabled,
    refetchInterval: (q) => {
      const data = q?.state?.data as IntelligenceStatus | null | undefined;
      if (!data) return false;
      // A paused run makes no progress — poll slowly, but keep polling so a
      // resume/cancel performed elsewhere lands here without a manual reload.
      if (isRunPaused(data)) {
        return Math.max(pollMs, PAUSED_POLL_INTERVAL_MS);
      }
      // Poll while there's pending work; stop otherwise.
      return data.is_pending ? pollMs : false;
    },
    refetchOnWindowFocus: true,
    staleTime: 0,
    gcTime: 60_000,
    queryFn: async () => {
      try {
        const res = await apiService.get(`/claims/${claimId}/intelligence/status`);
        return res.data as IntelligenceStatus;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });
}
