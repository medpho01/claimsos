/**
 * Sprint 3, Wave 3C — AdjudicationView page.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ ROUTE MOUNT TODO                                                     ║
 * ║                                                                      ║
 * ║ This page is NOT yet wired into the route tree. Intended route:      ║
 * ║   /hospital/:hospitalId/patients/:patientId/adjudication             ║
 * ║                                                                      ║
 * ║ Mount in webapp/src/routes/index.tsx (or wherever the hospital       ║
 * ║ child routes are declared today) once Wave 3B's                      ║
 * ║ POST /api/claims/:id/adjudication/run endpoint lands.                ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Layout:
 *   - Top: patient header (name, UHID, stage)
 *   - Left ~60%: ReadinessGauge + bucket label + blocking gaps + warnings
 *                + predicted outcome
 *   - Right ~40%: citations sidebar (rule_ids, pattern_ids, case_ids)
 *   - Footer: Run Adjudication button + View History link
 *
 * Empty state: when the latest report is null, the left column collapses
 * to a "Run adjudication" CTA. We still render the patient header so the
 * user knows which claim they're on.
 */

import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Play, History, RefreshCw, Scale, Sparkles, FileText } from 'lucide-react';

import apiService from '@/services/api';
import { Button } from '@/components/ui/button';
import {
  useAdjudicationReport,
  useClaimDossier,
  type AdjudicationReport,
} from '@/hooks/intelligence';
import {
  ReadinessGauge,
  CitationLink,
} from '@/components/intelligence/primitives';

import { BlockingGapItem } from './BlockingGapItem';
import { WarningItem } from './WarningItem';
import { PredictedOutcomeCard } from './PredictedOutcomeCard';

// ─── Route params ──────────────────────────────────────────────────────────

interface AdjudicationViewProps {
  /** Optional override; default is read from the URL via useParams. */
  claimIdOverride?: string;
  /** Override the latest report (used by the dev demo page). */
  reportOverride?: AdjudicationReport | null;
  /** Disable network calls — for the demo page. */
  offline?: boolean;
}

const RECOMMENDATION_LABEL: Record<string, string> = {
  request_doc: 'Request document',
  review: 'Review needed',
  file_now: 'Ready to file',
  approval_request: 'Approval requested',
  escalate_to_human: 'Escalate to human',
};

export const AdjudicationView: React.FC<AdjudicationViewProps> = ({
  claimIdOverride,
  reportOverride,
  offline = false,
}) => {
  const params = useParams();
  const claimId = claimIdOverride ?? params.patientId ?? '';
  const hospitalId = params.hospitalId ?? '';

  // Skip the hooks entirely when offline — useAdjudicationReport reads
  // from apiService which will 404 in the dev demo otherwise.
  const adj = useAdjudicationReport(offline ? null : claimId);
  const dossier = useClaimDossier(offline ? null : claimId);

  // Reduce to the latest single report. The hook can return an array when
  // called with { history: true }; we don't pass history here so it's a
  // single object or null — but defend anyway.
  const latest: AdjudicationReport | null =
    reportOverride !== undefined
      ? reportOverride
      : Array.isArray(adj.data)
        ? (adj.data[0] as AdjudicationReport | undefined) ?? null
        : (adj.data as AdjudicationReport | null);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const onRun = async () => {
    if (offline) return;
    setRunError(null);
    setRunning(true);
    try {
      await apiService.post(`/claims/${claimId}/adjudication/run`, {});
      await adj.refetch();
    } catch (e: any) {
      setRunError(e?.response?.data?.error ?? e?.message ?? 'failed');
    } finally {
      setRunning(false);
    }
  };

  const patientName = (() => {
    const d = dossier.data as any;
    if (!d) return '—';
    // claim_dossier doesn't expose first/last name directly today, but
    // surfaces a patient header via events_summary's claim_created
    // payload in v1. Keep this graceful.
    return d.patient_name ?? d.first_name
      ? `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim()
      : '—';
  })();

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Patient header */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Adjudication
            </div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate">
              {patientName !== '—' ? patientName : 'Patient'}
            </h1>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-3">
              <span>UHID: <code>{claimId.slice(0, 8)}</code></span>
              {dossier.data?.current_stage && (
                <span>Stage: {dossier.data.current_stage}</span>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left column ~60% */}
        <div className="lg:col-span-3 space-y-4">
          {adj.loading ? (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
              Loading latest adjudication run…
            </div>
          ) : latest === null ? (
            <EmptyState onRun={onRun} running={running} error={runError} />
          ) : (
            <ReportBody report={latest} />
          )}
        </div>

        {/* Right column ~40% */}
        <aside className="lg:col-span-2 space-y-4">
          <CitationsSidebar report={latest} />
        </aside>
      </div>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto px-6 pb-10 flex items-center gap-3">
        <Button
          onClick={onRun}
          disabled={running || offline}
          className="gap-2"
        >
          {running ? <RefreshCw className="size-4 animate-spin" /> : <Play className="size-4" />}
          {latest ? 'Re-run Adjudication' : 'Run Adjudication'}
        </Button>
        <Button variant="ghost" className="gap-2" disabled>
          <History className="size-4" />
          View History
        </Button>
        {runError && (
          <span className="text-xs text-red-600 dark:text-red-400">{runError}</span>
        )}
      </footer>
    </div>
  );
};

// ─── Sub-renderers (kept inline; small, page-specific) ────────────────────

const EmptyState: React.FC<{ onRun: () => void; running: boolean; error: string | null }> = ({
  onRun,
  running,
  error,
}) => (
  <div className="rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-10 text-center space-y-4">
    <div className="mx-auto size-12 rounded-full bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
      <Sparkles className="size-6 text-indigo-600 dark:text-indigo-300" />
    </div>
    <div>
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
        No adjudication run yet
      </h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
        Run the engine to compute readiness, surface blocking gaps, and
        predict the likely outcome.
      </p>
    </div>
    <Button onClick={onRun} disabled={running} className="gap-2">
      {running ? <RefreshCw className="size-4 animate-spin" /> : <Play className="size-4" />}
      Run Adjudication
    </Button>
    {error && (
      <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
    )}
  </div>
);

const ReportBody: React.FC<{ report: AdjudicationReport }> = ({ report }) => {
  const readinessPct = Math.round(report.readiness * 100);
  const bucketLabel =
    readinessPct >= 80
      ? 'Ready'
      : readinessPct >= 50
        ? 'Almost'
        : 'Blocked';

  return (
    <>
      {/* Readiness + recommendation banner */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex items-center gap-5">
        <ReadinessGauge
          score={readinessPct}
          size={96}
          label={bucketLabel}
          subtitle={`${report.blocking_gaps.length} blocker${report.blocking_gaps.length === 1 ? '' : 's'}`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Recommended action
          </div>
          <div className="text-lg font-semibold text-slate-900 dark:text-slate-100 mt-1">
            {RECOMMENDATION_LABEL[report.recommended_action] ?? report.recommended_action}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
            Generated {new Date(report.generated_at).toLocaleString()}
          </div>
        </div>
      </section>

      {/* Blocking gaps */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
          Blocking gaps
          <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
            ({report.blocking_gaps.length})
          </span>
        </h2>
        {report.blocking_gaps.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400 italic">
            No blocking gaps — every requirement for the next stage is satisfied.
          </p>
        ) : (
          <ul className="space-y-2">
            {report.blocking_gaps.map((gap) => (
              <BlockingGapItem key={gap.id} gap={gap} />
            ))}
          </ul>
        )}
      </section>

      {/* Warnings */}
      {report.warnings.length > 0 && (
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
            Warnings
            <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
              ({report.warnings.length})
            </span>
          </h2>
          <ul className="space-y-2">
            {report.warnings.map((w) => (
              <WarningItem key={w.id} warning={w} />
            ))}
          </ul>
        </section>
      )}

      {/* Predicted outcome */}
      <PredictedOutcomeCard outcome={report.predicted_outcome ?? null} />
    </>
  );
};

const CitationsSidebar: React.FC<{ report: AdjudicationReport | null }> = ({ report }) => {
  if (!report) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 text-xs text-slate-500 dark:text-slate-400">
        Citations will appear here after the engine runs.
      </div>
    );
  }
  const c = report.citations ?? { rule_ids: [], pattern_ids: [], case_ids: [] };
  const total = c.rule_ids.length + c.pattern_ids.length + c.case_ids.length;
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        Evidence
        <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
          ({total})
        </span>
      </h2>

      <CitationGroup
        title="Rules cited"
        kind="rule"
        icon={Scale}
        ids={c.rule_ids}
      />
      <CitationGroup
        title="Patterns matched"
        kind="pattern"
        icon={Sparkles}
        ids={c.pattern_ids}
      />
      <CitationGroup
        title="Similar cases"
        kind="case"
        icon={FileText}
        ids={c.case_ids}
      />
    </div>
  );
};

const CitationGroup: React.FC<{
  title: string;
  kind: 'rule' | 'pattern' | 'case';
  icon: React.ComponentType<{ className?: string }>;
  ids: string[];
}> = ({ title, kind, icon: Icon, ids }) => (
  <div>
    <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
      <Icon className="size-3.5" />
      {title}
      <span className="ml-auto text-slate-400">{ids.length}</span>
    </div>
    {ids.length === 0 ? (
      <p className="text-xs text-slate-400 dark:text-slate-500 italic">none</p>
    ) : (
      <div className="flex flex-wrap gap-1.5">
        {ids.map((id) => (
          <CitationLink
            key={id}
            kind={kind}
            id={id}
            label={id.length > 12 ? `${id.slice(0, 8)}…` : id}
            inline
          />
        ))}
      </div>
    )}
  </div>
);

export default AdjudicationView;
