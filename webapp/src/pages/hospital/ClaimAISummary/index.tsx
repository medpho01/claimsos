/**
 * Wave 9 — Claim AI Summary surface.
 *
 * Embedded as the "AI Summary" tab on the patient detail page (see
 * webapp/src/pages/hospital/PatientDetail/index.tsx — search for
 * `tab === 'ai-summary'`). There is no longer a standalone route for
 * this surface; deep-links use `?tab=ai-summary` on the patient page.
 *
 * Layout:
 *   Top header — patient context + ReadinessGauge + bucket + Re-run button
 *   Tab strip  — Documents · Harmonised · Rules · Verdict · Audit
 *   Body       — selected panel
 *
 * Pass `embedded` when rendering inside another page shell to drop the
 * outer `min-h-screen` chrome and the inner `max-w-7xl` width cap.
 */

import React, { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { RefreshCw, Sparkles } from 'lucide-react';

import apiService from '@/services/api';
import { Button } from '@/components/ui/button';
import {
  useAdjudicationReport,
  useClaimDossier,
  type AdjudicationReport,
} from '@/hooks/intelligence';
import { useRulesV2, type RulesV2Result } from '@/hooks/intelligence/useRulesV2';
import {
  useHarmonisedEpisode,
  type HarmonisedEpisode,
} from '@/hooks/intelligence/useHarmonisedEpisode';
import type { AiAuditTrailRow } from '@/hooks/intelligence/useAiAuditTrail';
import { useIntelligenceStatus } from '@/hooks/intelligence/useIntelligenceStatus';
import { ReadinessGauge } from '@/components/intelligence/primitives';
import { cn } from '@/lib/utils';

import { DocumentsPanel } from './panels/DocumentsPanel';
import { HarmonisedEpisodePanel } from './panels/HarmonisedEpisodePanel';
import { RulesPanel } from './panels/RulesPanel';
import { VerdictPanel } from './panels/VerdictPanel';
import { AuditTrailPanel } from './panels/AuditTrailPanel';

type TabKey = 'documents' | 'harmonised' | 'rules' | 'verdict' | 'audit';

const TAB_META: Array<{ key: TabKey; label: string }> = [
  { key: 'documents', label: 'Documents' },
  { key: 'harmonised', label: 'Harmonised Episode' },
  { key: 'rules', label: 'Insurer Rules' },
  { key: 'verdict', label: 'Verdict' },
  { key: 'audit', label: 'AI Audit Trail' },
];

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
  const claimId = claimIdOverride ?? params.patientId ?? '';

  const dossier = useClaimDossier(offline ? null : claimId);
  const adj = useAdjudicationReport(offline ? null : claimId);
  const rules = useRulesV2(offline ? null : claimId);
  const harmonised = useHarmonisedEpisode(offline ? null : claimId);
  const status = useIntelligenceStatus(offline ? null : claimId);
  const statusData = status.data ?? null;
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
      void harmonised.refetch();
    }
    wasPendingRef.current = statusData.is_pending;
  }, [statusData?.is_pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const [tab, setTab] = useState<TabKey>('documents');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const dossierData = overrides?.dossier ?? dossier.data;

  const verdictReport: AdjudicationReport | null =
    overrides?.verdict !== undefined
      ? overrides.verdict
      : Array.isArray(adj.data)
        ? (adj.data[0] as AdjudicationReport | undefined) ?? null
        : (adj.data as AdjudicationReport | null);

  const rulesData = overrides?.rules !== undefined ? overrides.rules : rules.data;

  // Primary readiness: rules-v2 score takes precedence; fall back to adj report.
  const readinessScore = useMemo(() => {
    if (typeof rulesData?.readiness_score === 'number') return rulesData.readiness_score;
    if (verdictReport?.readiness != null) return Math.round(verdictReport.readiness * 100);
    return 0;
  }, [rulesData?.readiness_score, verdictReport?.readiness]);

  const bucketLabel =
    readinessScore >= 80 ? 'Ready' : readinessScore >= 50 ? 'Almost' : 'Blocked';

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

  const onRerun = async () => {
    if (offline) return;
    setRunError(null);
    setRunning(true);
    try {
      // Wave 6 orchestrator — runs the full intelligence pipeline.
      //
      // `force: true` is critical here. Without it the orchestrator
      // short-circuits at the "this doc already has sections" check
      // (intelligenceOrchestrator.service.ts:104) and returns 202 having
      // enqueued nothing — making "Re-run" a silent no-op once the claim
      // has been analysed once. The page-level "Run AI Analysis" button
      // (PatientDetail.RunAIButton) intentionally does NOT force, because
      // first-time runs should respect idempotency. This Re-run button
      // exists precisely to override that, so force=true is correct.
      await apiService.post(`/claims/${claimId}/intelligence/analyze`, {
        force: true,
      });

      // Visible-feedback loop. The harmoniser frequently completes in
      // <1.5s when the underlying section/extracted_fields hashes haven't
      // changed (the orchestrator's harmonisation step is cached); in
      // that case the DB pending flag flickers too briefly for our
      // refetchInterval to catch, and the user would otherwise see the
      // button spinner vanish in ~1s with no other indication that
      // anything happened.
      //
      // We bridge this by:
      //   1. Polling /status every 500ms for up to 8s.
      //   2. Keeping the button in its running state for the WHOLE
      //      window so the spinner is the user's persistent "something
      //      is happening" anchor.
      //   3. If is_pending=true is observed at any point, hand off to
      //      the hook's own refetchInterval (which engages while pending
      //      is true) and let the banner show the rest of the run.
      //   4. Either way, do a final refetch of all data hooks so the
      //      panels pick up the new harmonised episode / rules / etc.
      const POLL_TOTAL_MS = 8_000;
      const POLL_STEP_MS = 500;
      const burstStart = Date.now();
      let sawPending = false;
      while (Date.now() - burstStart < POLL_TOTAL_MS) {
        await new Promise((r) => setTimeout(r, POLL_STEP_MS));
        const refetched = await status.refetch();
        const cur = (refetched.data ?? null) as
          | { is_pending?: boolean }
          | null;
        if (cur?.is_pending) {
          sawPending = true;
          // Banner is up — the hook's refetchInterval takes over from
          // here. We still keep the spinner until pending flips off,
          // BUT only briefly so the button doesn't appear stuck on
          // long-running pipelines (segmenter etc.). The banner shows
          // the live progress; this is just the kick-off anchor.
          break;
        }
      }
      // Final fan-out refetch regardless of whether we saw pending —
      // ensures the panels reflect any new harmoniser/rules/adj output
      // that completed during the burst.
      await Promise.all([
        dossier.refetch(),
        adj.refetch(),
        rules.refetch(),
        harmonised.refetch(),
        status.refetch(),
      ]);
      // Light log so we can tell from devtools whether the run was
      // visible vs invisible-fast in the user's environment.
      if (!sawPending) {
        // eslint-disable-next-line no-console
        console.info(
          '[ClaimAISummary] Re-run completed within burst window without ever flipping is_pending — likely a cache-hit harmonisation. Data refetched.',
        );
      }
    } catch (e: any) {
      setRunError(e?.response?.data?.error ?? e?.message ?? 'failed');
    } finally {
      setRunning(false);
    }
  };

  // When embedded inside another page shell (PatientDetail AI Summary tab),
  // drop the page-level chrome and let the surface span the full content
  // width. The standalone /ai-summary route keeps the centred max-w-7xl
  // framing it always had.
  const headerInnerCls = embedded
    ? 'w-full px-4 py-5 flex items-start gap-6'
    : 'max-w-7xl mx-auto px-6 py-5 flex items-start gap-6';
  const bodyCls = embedded
    ? 'w-full pt-5'
    : 'max-w-7xl mx-auto px-6 py-6';

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
              rulesData?.rule_set_name
                ? rulesData.rule_set_name
                : verdictReport
                  ? 'Adjudication'
                  : 'Pending'
            }
          />

          <div className="flex flex-col items-end gap-2">
            <Button
              onClick={onRerun}
              disabled={running || offline}
              className="gap-2"
            >
              {running ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Re-run AI Analysis
            </Button>
            {runError && (
              <span className="text-xs text-red-600 dark:text-red-400">{runError}</span>
            )}
          </div>
        </div>

        {/* Live progress banner — appears whenever any async pipeline
            component is still running. Polls /intelligence/status every
            ~3.5s and auto-refetches the data hooks when work completes. */}
        {statusData?.is_pending && (
          <div className={cn(embedded ? 'w-full pb-4 -mt-1' : 'max-w-7xl mx-auto px-6 pb-4 -mt-1')}>
            <div className="rounded-md border border-violet-200 bg-violet-50 dark:border-violet-800 dark:bg-violet-950/40 px-4 py-3">
              <div className="flex items-start gap-3">
                <RefreshCw className="size-4 mt-0.5 text-violet-700 dark:text-violet-300 animate-spin" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-violet-900 dark:text-violet-100">
                    AI Analysis in progress
                    {typeof statusData.eta_seconds === 'number' && statusData.eta_seconds > 0 && (
                      <span className="ml-2 text-xs font-normal text-violet-700 dark:text-violet-300">
                        · ETA ~{statusData.eta_seconds < 60
                          ? `${statusData.eta_seconds}s`
                          : `${Math.ceil(statusData.eta_seconds / 60)}m`}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-violet-700 dark:text-violet-300 mt-1">
                    {statusData.pending_components.join(' · ')}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-violet-700/80 dark:text-violet-300/80">
                    <span>
                      Sections {statusData.sections.classified}/{statusData.sections.total} classified
                    </span>
                    <span>
                      {statusData.sections.extracted}/{statusData.sections.classified} extracted
                    </span>
                    <span>
                      Harmoniser:{' '}
                      <code>{statusData.harmoniser.status}</code>
                    </span>
                    <span>This page auto-refreshes when complete.</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
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
            Now: progress banner only until is_pending=false. */}
        {statusData?.is_pending ? (
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
              Working on: <code>{statusData.pending_components.join(' · ')}</code>
            </div>
          </div>
        ) : (
          <>
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
            {tab === 'rules' && (
              <RulesPanel
                claimId={claimId}
                resultOverride={overrides?.rules}
                offline={offline}
              />
            )}
            {tab === 'verdict' && (
              <VerdictPanel
                claimId={claimId}
                reportOverride={overrides?.verdict}
                offline={offline}
              />
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
    </div>
  );
};

export default ClaimAISummary;
