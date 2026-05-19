/**
 * Wave 9 — Claim AI Summary page.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ TODO(routing)                                                        ║
 * ║                                                                      ║
 * ║ This page is NOT yet wired into the route tree. Intended route:      ║
 * ║   /portal/:hospitalId/patient/:patientId/ai-summary                  ║
 * ║                                                                      ║
 * ║ Mount in webapp/src/App.tsx alongside the existing hospital patient  ║
 * ║ routes once Wave 9 ships its backend endpoints (harmonised, rules-v2,║
 * ║ ai-audit-trail, document-section category correction).               ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Layout:
 *   Top header — patient context + ReadinessGauge + bucket + Re-run button
 *   Tab strip  — Documents · Harmonised · Rules · Verdict · Audit
 *   Body       — selected panel
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
      await apiService.post(`/claims/${claimId}/intelligence/analyze`, {});
      await Promise.all([
        dossier.refetch(),
        adj.refetch(),
        rules.refetch(),
        harmonised.refetch(),
      ]);
    } catch (e: any) {
      setRunError(e?.response?.data?.error ?? e?.message ?? 'failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Header */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-start gap-6">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Claim AI Summary
            </div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 truncate">
              {patientName}
            </h1>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-3">
              <span>
                UHID: <code className="font-mono">{uhid}</code>
              </span>
              {stage && (
                <span className="text-indigo-700 dark:text-indigo-300">Stage: {stage}</span>
              )}
            </div>
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
          <div className="max-w-7xl mx-auto px-6 pb-4 -mt-1">
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
          className="max-w-7xl mx-auto px-6 flex items-center gap-1 -mb-px"
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
      <main className="max-w-7xl mx-auto px-6 py-6">
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
      </main>
    </div>
  );
};

export default ClaimAISummary;
