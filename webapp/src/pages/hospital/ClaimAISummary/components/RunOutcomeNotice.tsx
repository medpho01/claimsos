/**
 * RunOutcomeNotice — how a run ENDED, in one sentence.
 *
 * A run that stops early because the user declined more budget is a normal,
 * chosen outcome. Without this notice it reads as a crash: the spinner
 * disappears, half the documents are analysed, and nothing says why. So every
 * non-clean ending gets a plain-language line here, with the spend and the
 * way forward.
 *
 * A clean 'succeeded' renders nothing — the analysis itself is the message.
 */

import React from 'react';
import { CircleAlert, CircleCheck, Loader2, RefreshCw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { IntelligenceRunStatus } from '@/hooks/intelligence/useIntelligenceStatus';
import { cn } from '@/lib/utils';

import { formatInr } from './runConsentApi';

export interface RunOutcomeNoticeProps {
  run: IntelligenceRunStatus;
  onRerun: () => void;
  onDismiss: () => void;
  rerunning?: boolean;
}

export const RunOutcomeNotice: React.FC<RunOutcomeNoticeProps> = ({
  run,
  onRerun,
  onDismiss,
  rerunning = false,
}) => {
  const failed = run.status === 'failed';

  const headline = (() => {
    if (failed) return 'Analysis failed';
    switch (run.end_reason) {
      case 'budget_declined':
        return 'Run ended — you chose to finish with what we had';
      case 'user_cancelled':
        return 'Run ended at your request';
      case 'unreadable_pages':
        return 'Run finished with pages that could not be read';
      case 'superseded':
        return 'Run replaced by a newer run';
      case 'orchestrator_error':
        return 'Run stopped on an internal error';
      default:
        return 'Run finished with partial results';
    }
  })();

  const detail = (() => {
    if (failed) {
      return (
        run.error ??
        'The pipeline stopped before it could finish. Nothing that was already analysed has been lost.'
      );
    }
    if (run.end_reason === 'superseded') {
      return 'A newer analysis was started for this claim, so this one was retired. The newer run owns the results.';
    }
    return 'Everything that was analysed before the run stopped has been kept. The panels below show it; nothing is being hidden or guessed at.';
  })();

  return (
    <div
      className={cn(
        'rounded-md border px-4 py-3',
        failed
          ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40'
          : 'border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60',
      )}
    >
      <div className="flex items-start gap-3">
        {failed ? (
          <CircleAlert className="size-4 mt-0.5 shrink-0 text-red-700 dark:text-red-300" />
        ) : (
          <CircleCheck className="size-4 mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
        )}

        <div className="flex-1 min-w-0">
          <div
            className={cn(
              'text-sm font-medium',
              failed
                ? 'text-red-900 dark:text-red-100'
                : 'text-slate-900 dark:text-slate-100',
            )}
          >
            {headline}
          </div>
          <div
            className={cn(
              'text-xs mt-0.5 leading-relaxed',
              failed
                ? 'text-red-800/90 dark:text-red-200/90'
                : 'text-slate-600 dark:text-slate-300',
            )}
          >
            {detail}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
            <span>
              Documents {run.docs_completed}/{run.total_docs} analysed
              {run.docs_failed > 0 && ` · ${run.docs_failed} failed`}
            </span>
            {run.spend_so_far_inr != null && (
              <span>
                Spent {formatInr(run.spend_so_far_inr)}
                {run.approved_budget_inr != null &&
                  ` of ${formatInr(run.approved_budget_inr)} approved`}
              </span>
            )}
            {run.finished_at && (
              <span>Ended {new Date(run.finished_at).toLocaleString()}</span>
            )}
          </div>

          {run.end_reason !== 'superseded' && (
            <div className="mt-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5 bg-white/70 dark:bg-slate-900/60"
                onClick={onRerun}
                disabled={rerunning}
              >
                {rerunning ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                Run the analysis again
              </Button>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <X className="size-4" />
          <span className="sr-only">Dismiss</span>
        </button>
      </div>
    </div>
  );
};

export default RunOutcomeNotice;
