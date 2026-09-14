/**
 * Wave 9 — Claim AI Summary surface.
 *
 * Embedded as the "AI Summary" tab on the patient detail page (see
 * webapp/src/pages/hospital/PatientDetail/index.tsx — search for
 * `tab === 'ai-summary'`). There is no longer a standalone route for
 * this surface; deep-links use `?tab=ai-summary` on the patient page.
 *
 * Layout:
 *   Top header — patient context + ReadinessGauge + bucket + Run/Re-run button
 *   Run strip  — exactly ONE of: progress banner · paused card ·
 *                unreadable-pages decision · run-outcome notice
 *   Tab strip  — Documents · Harmonised · Adjudication · Audit
 *   Body       — selected panel
 *
 * THE RUN LIFECYCLE, as this page presents it. Every one of these states is
 * visibly distinct, because the failure mode we are designing against is a
 * user who believes a document was fully read when it was not:
 *
 *   idle                     nothing running; primary button offers a run
 *   estimating               we asked the server what the run will cost
 *   awaiting_approval        consent dialog is up; NOTHING has been created
 *   starting                 approved; the orchestrator is enqueueing
 *   running                  progress banner + live budget meter + Pause
 *   paused-by-user           paused card, single Resume affordance
 *   paused-for-consent       paused card as a budget question: approve more,
 *                            or finish with what we have
 *   finished-with-unreadable red decision banner listing every unread page
 *   ended-early / failed     outcome notice explaining WHY it stopped
 *
 * Pass `embedded` when rendering inside another page shell to drop the
 * outer `min-h-screen` chrome and the inner `max-w-7xl` width cap.
 */

import React, { useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { RefreshCw, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  useAdjudicationReport,
  useClaimDossier,
  type AdjudicationReport,
} from '@/hooks/intelligence';
import { useRulesV2, type RulesV2Result } from '@/hooks/intelligence/useRulesV2';
import { useStageAdjudication } from '@/hooks/intelligence/useStageAdjudication';
import {
  useHarmonisedEpisode,
  type HarmonisedEpisode,
} from '@/hooks/intelligence/useHarmonisedEpisode';
import type { AiAuditTrailRow } from '@/hooks/intelligence/useAiAuditTrail';
import {
  isRunTerminal,
  useIntelligenceStatus,
} from '@/hooks/intelligence/useIntelligenceStatus';
import { ReadinessGauge } from '@/components/intelligence/primitives';
import { cn } from '@/lib/utils';

import { DocumentsPanel } from './panels/DocumentsPanel';
import { HarmonisedEpisodePanel } from './panels/HarmonisedEpisodePanel';
import { AuditTrailPanel } from './panels/AuditTrailPanel';
import { StageAdjudicationPanel } from './panels/StageAdjudicationPanel';

import { BudgetConsentDialog } from './components/BudgetConsentDialog';
import { RunProgressBanner } from './components/RunProgressBanner';
import { RunPausedCard } from './components/RunPausedCard';
import { UnreadablePagesBanner } from './components/UnreadablePagesBanner';
import { RunOutcomeNotice } from './components/RunOutcomeNotice';
import { useUnreadableSummary } from './components/useUnreadableSummary';
import {
  acknowledgeUnreadable,
  cancelRun,
  fetchEstimate,
  formatInr,
  pauseRun,
  resumeRun,
  startAnalysis,
  unreadableSummaryFromRollup,
  type RunCostEstimate,
} from './components/runConsentApi';

// NOTE: the legacy "Insurer Rules" (Wave-8 rules-v2) and "Verdict" (Wave-3B
// adjudication) tabs were retired here — the Stage Adjudication engine is now
// the single verdict surface. The old engines + hooks (useRulesV2,
// useAdjudicationReport) are intentionally kept: the standalone
// /patient/:id/adjudication page (AdjudicationView) still consumes them, and
// the header gauge falls back to them when no stage hypothesis exists yet.
type TabKey = 'documents' | 'harmonised' | 'stage' | 'audit';

const TAB_META: Array<{ key: TabKey; label: string }> = [
  { key: 'documents', label: 'Documents' },
  { key: 'harmonised', label: 'Harmonised Episode' },
  { key: 'stage', label: 'Adjudication' },
  { key: 'audit', label: 'AI Audit Trail' },
];

/**
 * The client-side half of the run lifecycle — the part that exists only
 * between the click and the run row. Once a run row exists the SERVER's
 * `status.run` is the source of truth and this drops back to `idle`.
 */
type RunFlow =
  | { kind: 'idle' }
  | { kind: 'estimating' }
  | {
      kind: 'awaiting_approval';
      estimate: RunCostEstimate;
      minBudgetInr: number;
      maxBudgetInr: number;
      prefillBudgetInr: number | null;
      submitting: boolean;
      requoting: boolean;
      stale: boolean;
      error: string | null;
    }
  | { kind: 'starting' };

type ControlOp = 'pause' | 'resume' | 'cancel' | null;

export interface ClaimAISummaryProps {
  /** Override the claimId from the URL — used by the dev demo. */
  claimIdOverride?: string;
  /** Disable network calls — used by the dev demo. */
  offline?: boolean;
  /**
   * When `true`, the page renders without its outer `min-h-screen` chrome
   * and drops the `max-w-7xl mx-auto px-6` content cap. Use this when
   * embedding inside another page shell (e.g. the PatientDetail "AI Summary"
   * tab) so the surface fills the parent's content area instead of
   * stacking a narrower inner column inside it.
   */
  embedded?: boolean;
  /** Demo-mode overrides for each panel. */
  overrides?: {
    dossier?: any;
    harmonised?: HarmonisedEpisode | null;
    rules?: RulesV2Result | null;
    verdict?: AdjudicationReport | null;
    auditTrail?: AiAuditTrailRow[] | null;
  };
}

export const ClaimAISummary: React.FC<ClaimAISummaryProps> = ({
  claimIdOverride,
  offline = false,
  embedded = false,
  overrides,
}) => {
  const params = useParams();
  const location = useLocation();
  const claimId = claimIdOverride ?? params.patientId ?? '';

  const dossier = useClaimDossier(offline ? null : claimId);
  const adj = useAdjudicationReport(offline ? null : claimId);
  const rules = useRulesV2(offline ? null : claimId);
  const stageAdj = useStageAdjudication(offline ? null : claimId);
  const harmonised = useHarmonisedEpisode(offline ? null : claimId);
  const status = useIntelligenceStatus(offline ? null : claimId);
  const statusData = status.data ?? null;

  const run = statusData?.run ?? null;
  const runPaused = run?.status === 'paused';
  const runActive =
    run != null &&
    (run.status === 'queued' || run.status === 'running' || run.status === 'paused');
  const runTerminal = run != null && isRunTerminal(run.status);

  // When the status flips from pending → idle, refetch all the data hooks
  // so the page picks up the freshly-generated harmonised episode + rules.
  const wasPendingRef = React.useRef(false);
  React.useEffect(() => {
    if (!statusData) return;
    if (wasPendingRef.current && !statusData.is_pending) {
      // Just completed — pull all dependent data.
      void dossier.refetch();
      void adj.refetch();
      void rules.refetch();
      void stageAdj.refetch();
      void harmonised.refetch();
    }
    wasPendingRef.current = statusData.is_pending;
  }, [statusData?.is_pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const [tab, setTab] = useState<TabKey>('documents');
  const [flow, setFlow] = useState<RunFlow>({ kind: 'idle' });
  const [runError, setRunError] = useState<string | null>(null);
  const [controlOp, setControlOp] = useState<ControlOp>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);
  /** Run id whose outcome notice the user has dismissed, so it stays dismissed. */
  const [outcomeDismissedRunId, setOutcomeDismissedRunId] = useState<string | null>(
    null,
  );

  // ── unreadable pages ───────────────────────────────────────────────
  // The compact roll-up rides on /status; the grouped decision is a separate
  // fetch we only make when there is actually a decision to present.
  const rollup = statusData?.unreadable ?? null;
  const wantsUnreadableDecision = Boolean(
    !offline &&
      run?.id &&
      runTerminal &&
      rollup &&
      rollup.pages_total > 0 &&
      rollup.decision_required,
  );
  const unreadable = useUnreadableSummary(claimId, run?.id ?? null, {
    enabled: wantsUnreadableDecision,
  });

  /**
   * THE INVARIANT: once /status says pages were not read, SOMETHING says so on
   * screen. The grouped detail is a second request and it can be in flight,
   * 404, or fail — and in that window the old code rendered nothing at all,
   * which is indistinguishable from "the whole document was read". So the
   * detail is an upgrade to the banner, never its precondition: when it is
   * missing we build a degraded summary from the roll-up we already have.
   */
  const unreadableSummary = useMemo(() => {
    if (!wantsUnreadableDecision || !run || !rollup) return null;
    // The detail endpoint is authoritative WHEN IT ANSWERS — including when it
    // answers "nothing to decide". `undefined` means still loading or errored;
    // `null` means 404. Both are absence of an answer, not an answer.
    const detailed = unreadable.data;
    if (detailed != null) return detailed;
    return unreadableSummaryFromRollup({
      runId: run.id,
      claimId,
      runStatus: run.status,
      endReason: run.end_reason ?? null,
      rollup,
    });
  }, [wantsUnreadableDecision, run, rollup, unreadable.data, claimId]);

  const showUnreadableBanner = Boolean(
    unreadableSummary &&
      unreadableSummary.unreadable_pages_total > 0 &&
      unreadableSummary.decision_required,
  );

  const showOutcomeNotice = Boolean(
    run &&
      runTerminal &&
      (run.status === 'partial' || run.status === 'failed') &&
      !showUnreadableBanner &&
      outcomeDismissedRunId !== run.id &&
      flow.kind === 'idle',
  );

  const dossierData = overrides?.dossier ?? dossier.data;

  const verdictReport: AdjudicationReport | null =
    overrides?.verdict !== undefined
      ? overrides.verdict
      : Array.isArray(adj.data)
        ? (adj.data[0] as AdjudicationReport | undefined) ?? null
        : (adj.data as AdjudicationReport | null);

  const rulesData = overrides?.rules !== undefined ? overrides.rules : rules.data;

  // The stage-aware engine is now the source of truth for the header gauge.
  // Its latest hypothesis (ordered updated_at DESC) carries the readiness
  // score + recommended action. Fall back to the legacy rules-v2 / adjudication
  // report only when no stage hypothesis exists yet.
  const stageL4 =
    stageAdj.data?.adjudication?.hypotheses?.[0]?.layer4_readiness ?? null;
  const stageAction = stageL4?.recommended_action ?? null;

  const readinessScore = useMemo(() => {
    if (typeof stageL4?.readiness_score === 'number') return stageL4.readiness_score;
    if (typeof rulesData?.readiness_score === 'number') return rulesData.readiness_score;
    if (verdictReport?.readiness != null) return Math.round(verdictReport.readiness * 100);
    return 0;
  }, [stageL4?.readiness_score, rulesData?.readiness_score, verdictReport?.readiness]);

  const bucketLabel =
    stageAction === 'file_now'
      ? 'Ready'
      : stageAction === 'request_doc'
        ? 'Blocked'
        : stageAction === 'review'
          ? 'Review'
          : readinessScore >= 80
            ? 'Ready'
            : readinessScore >= 50
              ? 'Almost'
              : 'Blocked';

  const patientName = useMemo(() => {
    const d: any = dossierData;
    const ep: any = overrides?.harmonised ?? harmonised.data;
    const first = ep?.patient_context?.first_name ?? d?.first_name;
    const last = ep?.patient_context?.last_name ?? d?.last_name;
    const joined = [first, last].filter(Boolean).join(' ').trim();
    return joined || d?.patient_name || '—';
  }, [dossierData, harmonised.data, overrides?.harmonised]);

  const uhid =
    (overrides?.harmonised as any)?.patient_context?.uhid ??
    (harmonised.data as any)?.patient_context?.uhid ??
    claimId.slice(0, 8);

  const stage = dossierData?.current_stage;

  // Has the pipeline produced a result for this claim yet? Drives the primary
  // button label: a claim with no analysis output shows "Run Analysis"; once
  // it has a harmonised episode or an adjudication verdict it becomes "Re-run
  // AI Analysis". We also read the persisted status timestamps (harmoniser /
  // adjudication) so a transient fetch miss on harmonised.data doesn't make a
  // real result look un-analysed. Deliberately NOT keyed on sections.total —
  // that fires the instant segmentation starts, which would flip the label
  // mid-way through the very first run, before any result exists.
  const hasBeenAnalysed = Boolean(
    harmonised.data ||
      verdictReport ||
      statusData?.harmoniser.generated_at ||
      statusData?.adjudication.latest_at,
  );

  // ── shared plumbing ────────────────────────────────────────────────

  const fanOutRefetch = React.useCallback(async () => {
    await Promise.all([
      dossier.refetch(),
      adj.refetch(),
      rules.refetch(),
      stageAdj.refetch(),
      harmonised.refetch(),
      status.refetch(),
    ]);
  }, [dossier, adj, rules, stageAdj, harmonised, status]);

  /**
   * Visible-feedback loop after a run is accepted.
   *
   * The harmoniser frequently completes in <1.5s when the underlying
   * section/extracted_fields hashes haven't changed (that step is cached); in
   * that case the DB pending flag flickers too briefly for our refetchInterval
   * to catch, and the user would otherwise see the button spinner vanish in
   * ~1s with no other indication that anything happened. So we poll /status
   * every 500ms for up to 8s and hold the button in its running state for the
   * whole window, handing off to the hook's own refetchInterval the moment we
   * observe a live (or paused) run.
   */
  const awaitRunVisible = React.useCallback(async () => {
    const POLL_TOTAL_MS = 8_000;
    const POLL_STEP_MS = 500;
    const burstStart = Date.now();
    while (Date.now() - burstStart < POLL_TOTAL_MS) {
      await new Promise((r) => setTimeout(r, POLL_STEP_MS));
      const refetched = await status.refetch();
      const cur = (refetched.data ?? null) as {
        is_pending?: boolean;
        run?: { status?: string } | null;
      } | null;
      const st = cur?.run?.status;
      if (cur?.is_pending || st === 'running' || st === 'queued' || st === 'paused') {
        break;
      }
    }
    await fanOutRefetch();
  }, [status, fanOutRefetch]);

  // ── the run entry point ────────────────────────────────────────────

  /**
   * THE SINGLE USER ENTRY POINT for analysis. No other control on this page
   * (or on PatientDetail) starts a run, and nothing starts one automatically.
   *
   * One round trip on the happy path: POST /analyze with no budget answers
   * 428 and carries the estimate, which is exactly what the consent dialog
   * needs. We do NOT pre-call /estimate — that endpoint is the "recalculate"
   * affordance inside the dialog.
   *
   * `force: true` is still required. Without it the orchestrator
   * short-circuits at the "this doc already has sections" check and returns
   * having enqueued nothing, making a re-run a silent no-op.
   */
  const beginRun = async (prefillBudgetInr?: number) => {
    if (offline || !claimId) return;
    setRunError(null);
    setControlError(null);
    setFlow({ kind: 'estimating' });

    const res = await startAnalysis(claimId, { force: true });

    if (res.kind === 'consent_required') {
      setFlow({
        kind: 'awaiting_approval',
        estimate: res.estimate,
        minBudgetInr: res.minBudgetInr,
        maxBudgetInr: res.maxBudgetInr,
        prefillBudgetInr: prefillBudgetInr ?? null,
        submitting: false,
        requoting: false,
        stale: false,
        error: null,
      });
      return;
    }

    if (res.kind === 'started') {
      // Consent is disabled server-side (CI / self-hosted). Nothing to ask.
      setFlow({ kind: 'starting' });
      await awaitRunVisible();
      setFlow({ kind: 'idle' });
      return;
    }

    setFlow({ kind: 'idle' });
    setRunError(
      res.kind === 'kill_switch'
        ? res.message
        : res.kind === 'budget_out_of_range'
          ? `Budget must be between ${formatInr(res.minBudgetInr)} and ${formatInr(
              res.maxBudgetInr,
            )}.`
          : res.kind === 'estimate_stale'
            ? 'The documents on this claim changed. Please try again.'
            : res.message,
    );
  };

  const approveAndStart = async (budgetInr: number) => {
    if (flow.kind !== 'awaiting_approval') return;
    const current = flow;
    setFlow({ ...current, submitting: true, error: null });

    const res = await startAnalysis(claimId, {
      force: true,
      approved_budget_inr: budgetInr,
      estimate_token: current.estimate.estimate_token,
    });

    if (res.kind === 'started') {
      setFlow({ kind: 'starting' });
      setOutcomeDismissedRunId(null);
      await awaitRunVisible();
      setFlow({ kind: 'idle' });
      return;
    }

    if (res.kind === 'estimate_stale') {
      // The document set moved under the quote. Replace the numbers and make
      // the user look again rather than approving a price for different work.
      setFlow({
        ...current,
        estimate: res.estimate,
        prefillBudgetInr: null,
        submitting: false,
        stale: true,
        error: null,
      });
      return;
    }

    if (res.kind === 'budget_out_of_range') {
      setFlow({
        ...current,
        submitting: false,
        minBudgetInr: res.minBudgetInr,
        maxBudgetInr: res.maxBudgetInr,
        error: `Budget must be between ${formatInr(res.minBudgetInr)} and ${formatInr(
          res.maxBudgetInr,
        )}.`,
      });
      return;
    }

    if (res.kind === 'consent_required') {
      setFlow({
        ...current,
        estimate: res.estimate,
        minBudgetInr: res.minBudgetInr,
        maxBudgetInr: res.maxBudgetInr,
        submitting: false,
        error: 'That approval was not accepted. Please review and approve again.',
      });
      return;
    }

    setFlow({
      ...current,
      submitting: false,
      error: res.kind === 'kill_switch' ? res.message : res.message,
    });
  };

  const requote = async () => {
    if (flow.kind !== 'awaiting_approval') return;
    const current = flow;
    setFlow({ ...current, requoting: true, error: null });
    try {
      const fresh = await fetchEstimate(claimId);
      setFlow({
        ...current,
        estimate: fresh.estimate,
        minBudgetInr: fresh.min_budget_inr,
        maxBudgetInr: fresh.max_budget_inr,
        prefillBudgetInr: null,
        requoting: false,
        stale: false,
        error: null,
      });
    } catch (e: any) {
      setFlow({
        ...current,
        requoting: false,
        error: e?.response?.data?.error ?? e?.message ?? 'Could not recalculate.',
      });
    }
  };

  const declineRun = () => {
    // Free and total: no run row was ever created, so there is nothing to
    // clean up and nothing to explain.
    setFlow({ kind: 'idle' });
    setRunError(null);
  };

  // ── pause / resume / cancel ────────────────────────────────────────

  const doPause = async () => {
    if (offline || !run) return;
    setControlError(null);
    setControlOp('pause');
    try {
      await pauseRun(claimId, run.id);
      await status.refetch();
    } catch (e: any) {
      const data = e?.response?.data ?? {};
      setControlError(
        data.error === 'run_not_pausable'
          ? `This run is already ${data.status ?? 'finished'}.`
          : data.message ?? data.error ?? e?.message ?? 'Could not pause the run.',
      );
      await status.refetch();
    } finally {
      setControlOp(null);
    }
  };

  const doResume = async (newTotalBudgetInr?: number) => {
    if (offline || !run) return;
    setControlError(null);
    setControlOp('resume');
    try {
      const res = await resumeRun(claimId, run.id, newTotalBudgetInr);
      if (res.kind === 'budget_not_increased') {
        setControlError(
          `Resuming needs MORE than the ${formatInr(
            res.approvedBudgetInr,
          )} already approved — approve a higher total, or finish with what we have.`,
        );
      } else if (res.kind === 'budget_out_of_range') {
        setControlError(
          `Budget must be between ${formatInr(res.minBudgetInr)} and ${formatInr(
            res.maxBudgetInr,
          )}.`,
        );
      } else if (res.kind === 'not_paused') {
        setControlError(`This run is ${res.status}, not paused.`);
      } else if (res.kind === 'error') {
        setControlError(res.message);
      }
      await status.refetch();
    } finally {
      setControlOp(null);
    }
  };

  const doCancel = async (reason: 'budget_declined' | 'user_cancelled') => {
    if (offline || !run) return;
    setControlError(null);
    setControlOp('cancel');
    try {
      await cancelRun(claimId, run.id, reason);
      // Ending the run settles the claim's derived state — pull everything so
      // the panels show the partial results the user just chose to keep.
      setOutcomeDismissedRunId(null);
      await fanOutRefetch();
      await unreadable.refetch();
    } catch (e: any) {
      const data = e?.response?.data ?? {};
      setControlError(
        data.error === 'run_not_cancellable'
          ? `This run is already ${data.status ?? 'finished'}.`
          : data.message ?? data.error ?? e?.message ?? 'Could not end the run.',
      );
      await status.refetch();
    } finally {
      setControlOp(null);
    }
  };

  const doAcknowledgeUnreadable = async () => {
    if (offline || !run?.id) return;
    setAcknowledging(true);
    try {
      await acknowledgeUnreadable(claimId, run.id);
      await Promise.all([status.refetch(), unreadable.refetch()]);
    } catch (e: any) {
      setControlError(e?.response?.data?.error ?? e?.message ?? 'Could not dismiss.');
    } finally {
      setAcknowledging(false);
    }
  };

  // Re-upload / split both end at the patient's Documents tab. A plain anchor
  // (full navigation) is deliberate: PatientDetail seeds its active tab from
  // `?tab=` on mount only, so a client-side push would not switch tabs.
  const uploadHref = claimIdOverride
    ? undefined
    : `${location.pathname}?tab=documents`;

  const startingOrEstimating = flow.kind === 'estimating' || flow.kind === 'starting';
  const primaryDisabled = offline || startingOrEstimating || runActive;

  // The live-run banner. Keyed on is_pending OR an un-settled run row: a run
  // can be 'running' for a beat before any component reports pending work,
  // and during that beat the Pause control must still exist — otherwise the
  // only way to stop a run you just started by mistake is to wait it out.
  const showProgressBanner =
    !runPaused &&
    statusData != null &&
    (statusData.is_pending || run?.status === 'running' || run?.status === 'queued');

  // When embedded inside another page shell (PatientDetail AI Summary tab),
  // drop the page-level chrome and let the surface span the full content
  // width. The standalone /ai-summary route keeps the centred max-w-7xl
  // framing it always had.
  const headerInnerCls = embedded
    ? 'w-full px-4 py-5 flex items-start gap-6'
    : 'max-w-7xl mx-auto px-6 py-5 flex items-start gap-6';
  const bodyCls = embedded ? 'w-full pt-5' : 'max-w-7xl mx-auto px-6 py-6';
  const stripCls = embedded
    ? 'w-full pb-4 -mt-1 space-y-2'
    : 'max-w-7xl mx-auto px-6 pb-4 -mt-1 space-y-2';

  // The panels are hidden while work is genuinely in flight, because
  // intermediate state lies (9 sections after bundle-classify, collapsing to
  // 2 after dedup). A PAUSED run is different: nothing is moving, the numbers
  // are stable, and the user was explicitly told partial results are kept —
  // so the panels stay visible beside the pause card.
  const gatePanels = Boolean(statusData?.is_pending) && !runPaused;

  return (
    <div
      className={cn(
        embedded ? '' : 'min-h-screen bg-slate-50 dark:bg-slate-950',
      )}
    >
      {/* Header */}
      <header
        className={cn(
          embedded
            ? 'border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-lg overflow-hidden'
            : 'border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900',
        )}
      >
        <div className={headerInnerCls}>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Claim AI Summary
            </div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 truncate">
              {patientName}
            </h1>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-3 flex-wrap">
              <span>
                UHID: <code className="font-mono">{uhid}</code>
              </span>
              {stage && (
                <span className="text-indigo-700 dark:text-indigo-300">Stage: {stage}</span>
              )}
              {(() => {
                const ep: any = harmonised.data ?? {};
                const dx = ep?.diagnosis?.primary_diagnosis?.diagnosis_name;
                const icd = ep?.diagnosis?.primary_diagnosis?.icd_code;
                const hosp = ep?.hospital_context?.name;
                const ins = ep?.insurance_context?.insurer_name;
                return (
                  <>
                    {dx && (
                      <span>
                        Dx:{' '}
                        <span className="text-slate-700 dark:text-slate-200">{dx}</span>
                        {icd && (
                          <code className="ml-1 font-mono text-[10px] text-slate-500">
                            ({icd})
                          </code>
                        )}
                      </span>
                    )}
                    {hosp && <span>· {hosp}</span>}
                    {ins && <span>· {ins}</span>}
                  </>
                );
              })()}
            </div>
            {/* One-line operator summary */}
            {harmonised.data && (
              <div className="text-xs text-slate-600 dark:text-slate-300 mt-2 leading-relaxed max-w-3xl">
                {(() => {
                  const ep: any = harmonised.data;
                  const age = ep?.patient_context?.age;
                  const gender = ep?.patient_context?.gender;
                  const epType = ep?.meta?.episode_type;
                  const subtype = ep?.meta?.episode_subtype;
                  const los = ep?.stay_summary?.total_los;
                  const cost = (ep as any)?._meta?.cost_inr;
                  const bits: string[] = [];
                  if (age && gender) bits.push(`${age}${String(gender)[0]}`);
                  else if (age) bits.push(`${age}y`);
                  if (epType) bits.push(String(epType).replaceAll('_', ' ').toLowerCase());
                  if (subtype) bits.push(String(subtype).replaceAll('_', ' ').toLowerCase());
                  if (los?.value) bits.push(`${los.value}${String(los.unit ?? 'd')[0]} stay`);
                  return (
                    <>
                      {bits.length > 0 && bits.join(' · ')}
                      {cost && (
                        <span className="ml-2 text-slate-400 dark:text-slate-500">
                          (harmoniser ₹{Number(cost).toFixed(2)})
                        </span>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          <ReadinessGauge
            score={readinessScore}
            size={96}
            label={bucketLabel}
            subtitle={
              stageL4?.rule_set
                ? stageL4.rule_set
                : rulesData?.rule_set_name
                  ? rulesData.rule_set_name
                  : verdictReport
                    ? 'Adjudication'
                    : 'Pending'
            }
          />

          <div className="flex flex-col items-end gap-2">
            <Button
              onClick={() => void beginRun()}
              disabled={primaryDisabled}
              className="gap-2"
              title={
                runActive
                  ? runPaused
                    ? 'This run is paused — resume it or end it below.'
                    : 'A run is already in progress.'
                  : undefined
              }
            >
              {startingOrEstimating ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              {flow.kind === 'estimating'
                ? 'Checking cost…'
                : flow.kind === 'starting'
                  ? 'Starting…'
                  : hasBeenAnalysed
                    ? 'Re-run AI Analysis'
                    : 'Run Analysis'}
            </Button>
            <span className="text-[11px] text-slate-400 dark:text-slate-500">
              You approve a budget before anything runs.
            </span>
            {runError && (
              <span className="text-xs text-red-600 dark:text-red-400 max-w-[18rem] text-right">
                {runError}
              </span>
            )}
          </div>
        </div>

        {/*
          The run strip. Exactly one of these is visible at a time, and the
          order below is the precedence: a live run outranks everything; a
          pause outranks a stale outcome; the unreadable decision outranks the
          generic outcome notice because it is the one that needs a choice.
        */}
        {!offline && (
          <>
            {runPaused && run && (
              <div className={stripCls}>
                <RunPausedCard
                  run={run}
                  resuming={controlOp === 'resume'}
                  cancelling={controlOp === 'cancel'}
                  error={controlError}
                  onResume={() => doResume()}
                  onResumeWithBudget={(total) => doResume(total)}
                  onCancel={(reason) => doCancel(reason)}
                />
              </div>
            )}

            {showProgressBanner && statusData && (
              <div className={stripCls}>
                <RunProgressBanner
                  status={statusData}
                  onPause={doPause}
                  pausing={controlOp === 'pause'}
                  controlError={controlError}
                />
              </div>
            )}

            {!runPaused && !showProgressBanner && showUnreadableBanner && unreadableSummary && (
              <div className={stripCls}>
                <UnreadablePagesBanner
                  summary={unreadableSummary}
                  uploadHref={uploadHref}
                  rerunning={startingOrEstimating}
                  acknowledging={acknowledging}
                  onAcknowledge={doAcknowledgeUnreadable}
                  onRerun={(suggested) => void beginRun(suggested)}
                />
              </div>
            )}

            {!runPaused && !showProgressBanner && !showUnreadableBanner &&
              showOutcomeNotice &&
              run && (
                <div className={stripCls}>
                  <RunOutcomeNotice
                    run={run}
                    rerunning={startingOrEstimating}
                    onRerun={() => void beginRun()}
                    onDismiss={() => setOutcomeDismissedRunId(run.id)}
                  />
                </div>
              )}
          </>
        )}

        {/* Tab strip */}
        <nav
          aria-label="Claim AI Summary tabs"
          className={cn(
            'flex items-center gap-1 -mb-px',
            embedded ? 'w-full px-4' : 'max-w-7xl mx-auto px-6',
          )}
        >
          {TAB_META.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'px-3 py-2 text-sm border-b-2 transition-colors',
                tab === t.key
                  ? 'border-indigo-500 text-indigo-700 dark:text-indigo-300 font-medium'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Body */}
      <main className={bodyCls}>
        {/* Hide ALL panel contents while the pipeline is still running.
            Previously, intermediate state was visible — e.g. 9 sections
            briefly visible right after bundle-classify finishes but
            BEFORE dedup runs, then collapsing to 2 canonical documents
            on the next refresh. The "9 documents then 2" flicker
            confused reviewers and made them distrust the analysis.
            Now: progress banner only until is_pending=false — EXCEPT on a
            paused run, where nothing is in motion and the partial results
            are exactly what the user is being asked to judge. */}
        {gatePanels ? (
          <div className="rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-10 text-center space-y-3">
            <div className="mx-auto size-10 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
              <RefreshCw className="size-5 text-violet-600 dark:text-violet-300 animate-spin" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Stabilising — results not final yet
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                The pipeline is still classifying, extracting, or deduplicating
                sections. Intermediate state can show document counts that
                shift as new sections finish. This panel will populate when
                analysis is complete.
              </p>
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Working on: <code>{statusData?.pending_components.join(' · ')}</code>
            </div>
          </div>
        ) : (
          <>
            {runPaused && (
              <div className="mb-3 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
                This run is paused. What you see below is everything analysed so
                far — it is real, but it is not the whole claim yet.
              </div>
            )}
            {tab === 'documents' && (
              <DocumentsPanel
                claimId={claimId}
                dossierOverride={overrides?.dossier}
                offline={offline}
              />
            )}
            {tab === 'harmonised' && (
              <HarmonisedEpisodePanel
                claimId={claimId}
                episodeOverride={overrides?.harmonised}
                offline={offline}
              />
            )}
            {tab === 'stage' && (
              <StageAdjudicationPanel claimId={claimId} offline={offline} />
            )}
            {tab === 'audit' && (
              <AuditTrailPanel
                claimId={claimId}
                rowsOverride={overrides?.auditTrail}
                offline={offline}
              />
            )}
          </>
        )}
      </main>

      {/* Pre-flight cost consent. Rendered last so it overlays everything;
          until it is approved NO run row exists on the server. */}
      <BudgetConsentDialog
        open={flow.kind === 'awaiting_approval'}
        estimate={flow.kind === 'awaiting_approval' ? flow.estimate : null}
        minBudgetInr={flow.kind === 'awaiting_approval' ? flow.minBudgetInr : 5}
        maxBudgetInr={flow.kind === 'awaiting_approval' ? flow.maxBudgetInr : 1000}
        prefillBudgetInr={
          flow.kind === 'awaiting_approval' ? flow.prefillBudgetInr : null
        }
        submitting={flow.kind === 'awaiting_approval' && flow.submitting}
        requoting={flow.kind === 'awaiting_approval' && flow.requoting}
        staleNotice={flow.kind === 'awaiting_approval' && flow.stale}
        error={flow.kind === 'awaiting_approval' ? flow.error : null}
        onApprove={approveAndStart}
        onCancel={declineRun}
        onRequote={requote}
      />
    </div>
  );
};

export default ClaimAISummary;
