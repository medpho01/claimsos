import React, { useState } from 'react';
import { CheckCircle2, XCircle, Send, AlertTriangle, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ReadinessGauge } from '@/components/intelligence/primitives';
import {
  useAdjudicationReport,
  type AdjudicationReport,
} from '@/hooks/intelligence';

/**
 * Wave 9 — embedded verdict panel.
 *
 * A condensed re-render of the AdjudicationView surface, scoped to fit
 * inside the Claim AI Summary tab strip. Mirrors readiness + bucket +
 * recommended action + blocking gaps + warnings + predicted outcome.
 *
 * Action buttons are wired through a `onAction` prop so the page can
 * decide how to commit (approve to file, decline, file anyway). When
 * undefined the buttons toast a friendly "wired in a later wave" hint.
 */
export interface VerdictPanelProps {
  claimId: string;
  reportOverride?: AdjudicationReport | null;
  offline?: boolean;
  onAction?: (action: 'approve' | 'decline' | 'file_anyway', reason?: string) => void;
}

const RECOMMENDATION_LABEL: Record<string, string> = {
  request_doc: 'Request document',
  review: 'Review needed',
  file_now: 'Ready to file',
  approval_request: 'Approval requested',
  escalate_to_human: 'Escalate to human',
};

export const VerdictPanel: React.FC<VerdictPanelProps> = ({
  claimId,
  reportOverride,
  offline = false,
  onAction,
}) => {
  const adj = useAdjudicationReport(offline ? null : claimId);
  const latest: AdjudicationReport | null =
    reportOverride !== undefined
      ? reportOverride
      : Array.isArray(adj.data)
        ? (adj.data[0] as AdjudicationReport | undefined) ?? null
        : (adj.data as AdjudicationReport | null);

  const [toast, setToast] = useState<string | null>(null);
  const [fileAnywayReason, setFileAnywayReason] = useState('');
  const [showFileAnyway, setShowFileAnyway] = useState(false);

  const fireAction = (action: 'approve' | 'decline' | 'file_anyway', reason?: string) => {
    if (onAction) {
      onAction(action, reason);
    } else {
      setToast(`TODO: wire ${action} to actionEngine endpoint.`);
      window.setTimeout(() => setToast(null), 2500);
    }
  };

  if (!offline && adj.loading) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
        Loading verdict…
      </div>
    );
  }

  if (!latest) {
    return (
      <div className="rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-10 text-center space-y-3">
        <div className="mx-auto size-10 rounded-full bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
          <Sparkles className="size-5 text-indigo-600 dark:text-indigo-300" />
        </div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          No verdict yet
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Run the adjudication engine to compute readiness and a recommended
          action.
        </p>
      </div>
    );
  }

  const pct = Math.round(latest.readiness * 100);
  const bucket = pct >= 80 ? 'Ready' : pct >= 50 ? 'Almost' : 'Blocked';

  return (
    <div className="space-y-3">
      {/* Header */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex items-center gap-5">
        <ReadinessGauge
          score={pct}
          size={96}
          label={bucket}
          subtitle={`${latest.blocking_gaps.length} blocker${latest.blocking_gaps.length === 1 ? '' : 's'}`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Recommended action
          </div>
          <div className="text-lg font-semibold text-slate-900 dark:text-slate-100 mt-1">
            {RECOMMENDATION_LABEL[latest.recommended_action] ?? latest.recommended_action}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Generated {new Date(latest.generated_at).toLocaleString()}
          </div>
        </div>
      </section>

      {/* Blocking gaps */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">
          Blocking gaps
          <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
            ({latest.blocking_gaps.length})
          </span>
        </h3>
        {latest.blocking_gaps.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400 italic">
            No blocking gaps remaining.
          </p>
        ) : (
          <ul className="space-y-2">
            {latest.blocking_gaps.map((g) => (
              <li
                key={g.id}
                className="flex items-start gap-2 text-sm rounded border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/30 px-3 py-2"
              >
                <XCircle className="size-4 text-red-600 dark:text-red-300 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-red-900 dark:text-red-200">{g.message}</div>
                  {g.fix_hint && (
                    <div className="text-xs text-red-700/80 dark:text-red-300/80 mt-0.5">
                      {g.fix_hint}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Warnings */}
      {latest.warnings.length > 0 && (
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">
            Warnings
            <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
              ({latest.warnings.length})
            </span>
          </h3>
          <ul className="space-y-2">
            {latest.warnings.map((w) => (
              <li
                key={w.id}
                className="flex items-start gap-2 text-sm rounded border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2"
              >
                <AlertTriangle className="size-4 text-amber-600 dark:text-amber-300 mt-0.5 shrink-0" />
                <div className="min-w-0 text-amber-900 dark:text-amber-200">
                  {w.message}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Predicted outcome */}
      {latest.predicted_outcome && (
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
            Predicted outcome
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <Metric
              label="Amount"
              value={
                latest.predicted_outcome.amount != null
                  ? `₹ ${Number(latest.predicted_outcome.amount).toLocaleString('en-IN')}`
                  : '—'
              }
            />
            <Metric
              label="P(approval)"
              value={pctOrDash(latest.predicted_outcome.p_approval)}
              tone="ok"
            />
            <Metric
              label="P(partial)"
              value={pctOrDash(latest.predicted_outcome.p_partial)}
              tone="warn"
            />
            <Metric
              label="P(query)"
              value={pctOrDash(latest.predicted_outcome.p_query)}
              tone="bad"
            />
          </div>
        </section>
      )}

      {/* Actions */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center gap-2 flex-wrap">
        <Button
          onClick={() => fireAction('approve')}
          disabled={offline}
          className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <CheckCircle2 className="size-4" />
          Approve to file
        </Button>
        <Button
          variant="ghost"
          onClick={() => fireAction('decline')}
          disabled={offline}
          className="gap-1.5 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
        >
          <XCircle className="size-4" />
          Decline
        </Button>
        <Button
          variant="ghost"
          onClick={() => setShowFileAnyway(true)}
          disabled={offline}
          className="gap-1.5 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40"
        >
          <Send className="size-4" />
          File anyway with reason
        </Button>
        {toast && (
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400 italic">
            {toast}
          </span>
        )}
      </section>

      {/* File-anyway inline form */}
      {showFileAnyway && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 p-4 space-y-2">
          <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Reason for filing despite open gaps
          </div>
          <textarea
            value={fileAnywayReason}
            onChange={(e) => setFileAnywayReason(e.target.value)}
            rows={3}
            className="w-full rounded border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-900 text-sm p-2 text-slate-900 dark:text-slate-100"
            placeholder="Clinical urgency, partial approval acceptable, etc."
          />
          <div className="flex items-center gap-2 justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowFileAnyway(false);
                setFileAnywayReason('');
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                fireAction('file_anyway', fileAnywayReason);
                setShowFileAnyway(false);
                setFileAnywayReason('');
              }}
              disabled={fileAnywayReason.trim().length < 5 || offline}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              File now
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

const Metric: React.FC<{
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad' | 'default';
}> = ({ label, value, tone = 'default' }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {label}
    </div>
    <div
      className={cn(
        'text-base font-semibold tabular-nums mt-0.5',
        tone === 'ok' && 'text-emerald-700 dark:text-emerald-300',
        tone === 'warn' && 'text-amber-700 dark:text-amber-300',
        tone === 'bad' && 'text-red-700 dark:text-red-300',
        tone === 'default' && 'text-slate-900 dark:text-slate-100',
      )}
    >
      {value}
    </div>
  </div>
);

const pctOrDash = (v?: number) =>
  v == null ? '—' : `${Math.round(v * 100)}%`;

export default VerdictPanel;
