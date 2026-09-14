/**
 * Run-control API surface for the Claim AI Summary page.
 *
 * Types and thin call wrappers for the cost-consent / pause-resume /
 * unreadable-pages endpoints (backend contract §E). Everything here is a
 * plain async function over `apiService` — the page owns the flow state,
 * exactly as it did when `onRerun` was a single POST.
 *
 * The one non-obvious thing in this file is `startAnalysis`: POST /analyze
 * answers 428 when the run needs a budget approval, and the 428 body carries
 * the estimate. So the happy path is ONE round trip — click Run Analysis,
 * get the estimate back as a "precondition required", render the consent
 * dialog from it, then POST again with the approved number. We deliberately
 * do NOT call /estimate first; that endpoint exists for the "show me the
 * cost before I commit to anything" affordance and for re-quoting.
 */

import apiService from '@/services/api';
import type {
  RunEndReason,
  RunStatus,
  UnreadableReason,
} from '@/hooks/intelligence/useIntelligenceStatus';

// ───────────────────────────── estimate ──────────────────────────────

export interface RunCostEstimateDoc {
  doc_id: string;
  file_name: string | null;
  total_pages: number;
  /** Pages with no usable typed text layer — these need a vision read. */
  pixel_pages: number;
  /** True when the page census failed; pixel_pages is a conservative guess. */
  degraded: boolean;
  est_ocr_inr: number;
  est_sections: number;
  est_extraction_inr: number;
  est_total_inr: number;
}

export interface RunCostEstimate {
  /** Hash of the inputs. Echoed back on approve; 409 when it no longer matches. */
  estimate_token: string;
  computed_at: string;
  docs_total: number;
  pages_total: number;
  pixel_pages_total: number;
  /** Pages that already carry a typed layer and cost nothing to read. */
  typed_pages_total: number;
  est_page_cost_inr: number;
  ocr_inr: number;
  extraction_inr: number;
  fixed_inr: number;
  total_inr: number;
  recommended_budget_inr: number;
  claim_ocr_headroom_inr: number;
  claim_reasoning_headroom_inr: number;
  prior_claim_spend_inr: number;
  docs: RunCostEstimateDoc[];
  notes: string[];
}

export interface EstimateResponse {
  ok: boolean;
  claim_id: string;
  estimate: RunCostEstimate;
  consent_required: boolean;
  min_budget_inr: number;
  max_budget_inr: number;
}

// ──────────────────────── unreadable pages ───────────────────────────

export type UnreadableAction =
  | 'approve_more_budget'
  | 'rerun_with_more_time'
  | 'split_document'
  | 'retry_document'
  | 'reupload_document';

export interface UnreadableDocGroup {
  doc_id: string;
  file_name: string | null;
  total_pages: number;
  unreadable_page_numbers: number[];
  /** Compact display form, e.g. "4-7, 11". */
  page_ranges: string;
  reasons: UnreadableReason[];
  primary_action: UnreadableAction;
  /** Sections lost wholesale, so we can say WHAT was lost, not just where. */
  affected_section_categories: string[];
}

export interface RunUnreadableSummary {
  run_id: string;
  claim_id: string;
  run_status: RunStatus;
  end_reason: RunEndReason | null;
  unreadable_pages_total: number;
  readable_pages_total: number;
  documents_affected: number;
  documents_fully_unreadable: number;
  by_reason: Record<UnreadableReason, number>;
  documents: UnreadableDocGroup[];
  suggested_actions: UnreadableAction[];
  est_cost_to_finish_inr: number | null;
  decision_required: boolean;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

// ─────────────────────── human-readable labels ───────────────────────

/**
 * One line per reason, phrased as what HAPPENED — not as an error code.
 * These are the sentences a hospital operator reads at the end of a run,
 * so they say what the machine did and what it cost them.
 */
export const UNREADABLE_REASON_LABEL: Record<UnreadableReason, string> = {
  vision_failed: 'The reader could not make sense of the page',
  cost_budget: 'Never read — the run ran out of the approved budget',
  latency_budget: 'Never read — the run ran out of time',
  page_budget: 'Never read — past the page limit for one document',
  render_failed: 'The page never turned into an image we could read',
};

export const UNREADABLE_REASON_SHORT: Record<UnreadableReason, string> = {
  vision_failed: 'Unreadable',
  cost_budget: 'Out of budget',
  latency_budget: 'Out of time',
  page_budget: 'Past page limit',
  render_failed: 'Render failed',
};

export const UNREADABLE_ACTION_LABEL: Record<UnreadableAction, string> = {
  approve_more_budget: 'Approve more budget',
  rerun_with_more_time: 'Re-run this claim',
  split_document: 'Split the document and re-upload',
  retry_document: 'Retry this document',
  reupload_document: 'Re-upload this document',
};

export const UNREADABLE_ACTION_HINT: Record<UnreadableAction, string> = {
  approve_more_budget:
    'These pages were never sent to the reader. Approving more budget reads them.',
  rerun_with_more_time:
    'The run hit its wall-clock budget. Running again picks these pages up.',
  split_document:
    'This document is longer than one read allows. Split it into parts and upload them separately.',
  retry_document:
    'The reader returned nothing usable for these pages. A re-run often succeeds.',
  reupload_document:
    'These pages never rendered — the file is likely damaged. Upload a fresh copy.',
};

/**
 * Label lookups that survive a wire value we have never heard of.
 *
 * The five reasons and five actions are frozen by contract, but a backend
 * ahead of this build can still send a sixth. A raw `MAP[x]` would then render
 * `undefined` — or, worse, an empty cell that reads as "nothing wrong here".
 * These fall back to the code itself, which is ugly and honest.
 */
function humanise(code: string): string {
  const s = String(code ?? '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown';
}

export function reasonLabel(r: UnreadableReason | string): string {
  return UNREADABLE_REASON_LABEL[r as UnreadableReason] ?? humanise(r);
}

export function reasonShort(r: UnreadableReason | string): string {
  return UNREADABLE_REASON_SHORT[r as UnreadableReason] ?? humanise(r);
}

export function actionLabel(a: UnreadableAction | string): string {
  return UNREADABLE_ACTION_LABEL[a as UnreadableAction] ?? 'Re-run this claim';
}

export function actionHint(a: UnreadableAction | string): string {
  return (
    UNREADABLE_ACTION_HINT[a as UnreadableAction] ??
    'These pages were not read. Running the analysis again is the way to pick them up.'
  );
}

// ───────────────────────────── formatting ────────────────────────────

/** ₹1,234.50 — two decimals, trimmed when the rupee amount is whole. */
export function formatInr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const whole = Math.abs(n % 1) < 0.005;
  return `₹${n.toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

// ───────────────────── analyze / consent call flow ───────────────────

export interface StartAnalysisBody {
  force: boolean;
  approved_budget_inr?: number;
  estimate_token?: string;
  target_stage?: string;
}

export interface AnalyzeStarted {
  ok: true;
  claim_id: string;
  run_id: string;
  approved_budget_inr: number | null;
  estimate: RunCostEstimate | null;
  docs_total: number;
  docs_enqueued_for_segmentation: number;
  warnings: string[];
  message: string;
}

/**
 * Everything POST /analyze can answer with, as a discriminated union, so the
 * caller handles each outcome explicitly instead of pattern-matching HTTP
 * codes at the call site.
 *
 *   'started'            — 202, the run is live.
 *   'consent_required'   — 428, NOTHING was created; show the consent dialog.
 *   'estimate_stale'     — 409, the document set changed under the quote;
 *                          the fresh estimate is attached, re-ask.
 *   'budget_out_of_range'— 400, the number is outside [min, max]. The server
 *                          refuses rather than clamping, and so do we: a
 *                          silently clamped approval is not an approval.
 *   'kill_switch'        — 503, AI analysis is disabled server-side.
 *   'error'              — anything else.
 */
export type StartAnalysisResult =
  | { kind: 'started'; data: AnalyzeStarted }
  | {
      kind: 'consent_required';
      estimate: RunCostEstimate;
      minBudgetInr: number;
      maxBudgetInr: number;
      message: string;
    }
  | { kind: 'estimate_stale'; estimate: RunCostEstimate }
  | { kind: 'budget_out_of_range'; minBudgetInr: number; maxBudgetInr: number }
  | { kind: 'kill_switch'; message: string }
  | { kind: 'error'; message: string };

const DEFAULT_MIN_BUDGET_INR = 5;
const DEFAULT_MAX_BUDGET_INR = 1000;

function errMessage(e: any, fallback: string): string {
  return (
    e?.response?.data?.message ??
    e?.response?.data?.error ??
    e?.message ??
    fallback
  );
}

/**
 * A consent gate is only a gate if it has numbers on it.
 *
 * Both 428 and 409 are supposed to carry the estimate that the dialog renders
 * from. If one arrives without it we must NOT enter the awaiting-approval
 * state: the dialog would sit on its "working out what this will cost…"
 * placeholder forever with a disabled Approve button, which looks exactly like
 * a hang. Degrade to a plain error the user can act on instead.
 */
function hasEstimate(data: any): boolean {
  return (
    !!data?.estimate &&
    typeof data.estimate === 'object' &&
    typeof data.estimate.estimate_token === 'string'
  );
}

export async function startAnalysis(
  claimId: string,
  body: StartAnalysisBody,
): Promise<StartAnalysisResult> {
  try {
    const res = await apiService.post(
      `/claims/${claimId}/intelligence/analyze`,
      body,
    );
    return { kind: 'started', data: res.data as AnalyzeStarted };
  } catch (e: any) {
    const status = e?.response?.status;
    const data = e?.response?.data ?? {};
    if (status === 428 || data.error === 'budget_approval_required') {
      if (!hasEstimate(data)) {
        return {
          kind: 'error',
          message:
            'This run needs a budget approval, but the server did not send a cost estimate. Please try again.',
        };
      }
      return {
        kind: 'consent_required',
        estimate: data.estimate as RunCostEstimate,
        minBudgetInr: Number(data.min_budget_inr ?? DEFAULT_MIN_BUDGET_INR),
        maxBudgetInr: Number(data.max_budget_inr ?? DEFAULT_MAX_BUDGET_INR),
        message:
          data.message ?? 'This run needs a budget approval before it can start.',
      };
    }
    if (status === 409 && data.error === 'estimate_stale') {
      if (!hasEstimate(data)) {
        return {
          kind: 'error',
          message:
            'The documents on this claim changed while you were approving. Please start the run again.',
        };
      }
      return { kind: 'estimate_stale', estimate: data.estimate as RunCostEstimate };
    }
    if (status === 400 && data.error === 'budget_out_of_range') {
      return {
        kind: 'budget_out_of_range',
        minBudgetInr: Number(data.min_budget_inr ?? DEFAULT_MIN_BUDGET_INR),
        maxBudgetInr: Number(data.max_budget_inr ?? DEFAULT_MAX_BUDGET_INR),
      };
    }
    if (status === 503) {
      return {
        kind: 'kill_switch',
        message: errMessage(e, 'AI analysis is currently paused.'),
      };
    }
    return { kind: 'error', message: errMessage(e, 'Could not start analysis.') };
  }
}

/**
 * Pre-flight estimate (E.1). CPU-only on the server — no LLM spend, no run
 * row created, safe to call as often as the user likes. Used for the
 * "re-quote" button inside the consent dialog.
 */
export async function fetchEstimate(claimId: string): Promise<EstimateResponse> {
  const res = await apiService.post(`/claims/${claimId}/intelligence/estimate`, {});
  const data = res.data as EstimateResponse;
  return {
    ...data,
    min_budget_inr: Number(data.min_budget_inr ?? DEFAULT_MIN_BUDGET_INR),
    max_budget_inr: Number(data.max_budget_inr ?? DEFAULT_MAX_BUDGET_INR),
  };
}

// ───────────────────────── pause / resume / cancel ───────────────────

export async function pauseRun(claimId: string, runId?: string | null) {
  const res = await apiService.post(`/claims/${claimId}/intelligence/pause`, {
    ...(runId ? { run_id: runId } : {}),
  });
  return res.data as { ok: boolean; run: any; message: string };
}

export type ResumeResult =
  | { kind: 'resumed'; data: any }
  | {
      kind: 'budget_not_increased';
      approvedBudgetInr: number;
      requested: number;
    }
  | { kind: 'budget_out_of_range'; minBudgetInr: number; maxBudgetInr: number }
  | { kind: 'not_paused'; status: string }
  | { kind: 'error'; message: string };

/**
 * Resume. `approvedBudgetInr` is the NEW TOTAL, never a delta — the server
 * rejects anything not strictly greater than the standing approval when the
 * pause was a cost-consent pause.
 */
export async function resumeRun(
  claimId: string,
  runId: string | null | undefined,
  approvedBudgetInr?: number,
): Promise<ResumeResult> {
  try {
    const res = await apiService.post(`/claims/${claimId}/intelligence/resume`, {
      ...(runId ? { run_id: runId } : {}),
      ...(approvedBudgetInr != null
        ? { approved_budget_inr: approvedBudgetInr }
        : {}),
    });
    return { kind: 'resumed', data: res.data };
  } catch (e: any) {
    const status = e?.response?.status;
    const data = e?.response?.data ?? {};
    if (status === 400 && data.error === 'budget_not_increased') {
      return {
        kind: 'budget_not_increased',
        approvedBudgetInr: Number(data.approved_budget_inr ?? 0),
        requested: Number(data.requested ?? 0),
      };
    }
    if (status === 400 && data.error === 'budget_out_of_range') {
      return {
        kind: 'budget_out_of_range',
        minBudgetInr: Number(data.min_budget_inr ?? DEFAULT_MIN_BUDGET_INR),
        maxBudgetInr: Number(data.max_budget_inr ?? DEFAULT_MAX_BUDGET_INR),
      };
    }
    if (status === 409 && data.error === 'run_not_paused') {
      return { kind: 'not_paused', status: String(data.status ?? 'unknown') };
    }
    return { kind: 'error', message: errMessage(e, 'Could not resume the run.') };
  }
}

export interface CancelRunResponse {
  ok: boolean;
  run: { id: string; status: RunStatus; end_reason: RunEndReason; finished_at: string };
  unreadable?: RunUnreadableSummary | null;
  message: string;
}

/**
 * End a paused run, keeping everything it already produced. This is the
 * DECLINE half of the mid-run consent question — "finish with what we have".
 * Nothing is deleted and nothing is rolled back.
 */
export async function cancelRun(
  claimId: string,
  runId: string | null | undefined,
  reason: 'budget_declined' | 'user_cancelled',
): Promise<CancelRunResponse> {
  const res = await apiService.post(`/claims/${claimId}/intelligence/cancel`, {
    ...(runId ? { run_id: runId } : {}),
    reason,
  });
  return res.data as CancelRunResponse;
}

export async function fetchUnreadableSummary(
  claimId: string,
  runId: string,
): Promise<RunUnreadableSummary | null> {
  try {
    const res = await apiService.get(
      `/claims/${claimId}/intelligence/runs/${runId}/unreadable`,
    );
    return res.data as RunUnreadableSummary;
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

/**
 * Build a minimal, honest summary out of the compact /status roll-up.
 *
 * The grouped per-document detail is a SECOND request, and that request can be
 * in flight, 404, or fail outright. When it does, the page still knows — from
 * /status alone — that pages were not read. Rendering nothing in that window
 * is the one outcome this whole surface exists to prevent: a finished-looking
 * run over a document that was never read.
 *
 * So we degrade instead: same red banner, same counts, same "this is missing
 * from the analysis" sentence — just no per-document rows, because we do not
 * have them and will not invent them.
 */
export function unreadableSummaryFromRollup(args: {
  runId: string;
  claimId: string;
  runStatus: RunStatus;
  endReason: RunEndReason | null;
  rollup: {
    pages_total: number;
    documents_affected: number;
    by_reason?: Record<UnreadableReason, number> | null;
    decision_required: boolean;
  };
}): RunUnreadableSummary {
  const { runId, claimId, runStatus, endReason, rollup } = args;
  const byReason = (rollup.by_reason ?? {}) as Record<UnreadableReason, number>;
  const budgetBound =
    (byReason.cost_budget ?? 0) > 0 || endReason === 'budget_declined';
  const suggested: UnreadableAction[] = budgetBound
    ? ['approve_more_budget']
    : ['rerun_with_more_time'];
  return {
    run_id: runId,
    claim_id: claimId,
    run_status: runStatus,
    end_reason: endReason,
    unreadable_pages_total: rollup.pages_total ?? 0,
    // Unknown from the roll-up. -1 would be a lie in the other direction, so
    // the banner is written to say "N pages were not read" without claiming a
    // denominator it does not have.
    readable_pages_total: 0,
    documents_affected: rollup.documents_affected ?? 0,
    documents_fully_unreadable: 0,
    by_reason: byReason,
    documents: [],
    suggested_actions: suggested,
    est_cost_to_finish_inr: null,
    decision_required: rollup.decision_required !== false,
    acknowledged_at: null,
    acknowledged_by: null,
  };
}

export async function acknowledgeUnreadable(claimId: string, runId: string) {
  const res = await apiService.post(
    `/claims/${claimId}/intelligence/runs/${runId}/unreadable/acknowledge`,
    {},
  );
  return res.data as {
    ok: boolean;
    acknowledged_at: string;
    acknowledged_by: string;
    decision_required: boolean;
  };
}
