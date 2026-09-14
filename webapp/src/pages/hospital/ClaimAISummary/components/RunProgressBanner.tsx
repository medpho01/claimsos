/**
 * RunProgressBanner — the in-flight state of an analysis run.
 *
 * Extracted from ClaimAISummary/index.tsx when pause/resume landed: the
 * banner is no longer a passive "something is happening" strip, it now
 * carries a control (Pause) and a budget meter, and it has to stay legible
 * next to the paused card and the unreadable-pages banner.
 *
 * It renders only for a LIVE run. A paused run is RunPausedCard's job — the
 * two are mutually exclusive, and showing a spinner over a parked run would
 * be a lie.
 */

import React from 'react';
import { PauseCircle, RefreshCw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { IntelligenceStatus } from '@/hooks/intelligence/useIntelligenceStatus';
import { cn } from '@/lib/utils';

import { formatInr } from './runConsentApi';

export interface RunProgressBannerProps {
  status: IntelligenceStatus;
  onPause: () => void | Promise<void>;
  pausing?: boolean;
  /** Surfaced under the controls when a pause/resume call failed. */
  controlError?: string | null;
}

function formatEta(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `~${Math.ceil(seconds / 60)}m`;
}

export const RunProgressBanner: React.FC<RunProgressBannerProps> = ({
  status,
  onPause,
  pausing = false,
  controlError,
}) => {
  const run = status.run ?? null;
  const stalled = status.is_stalled === true;
  const approved = run?.approved_budget_inr ?? null;
  const spent = run?.spend_so_far_inr ?? null;
  const pct =
    approved != null && approved > 0 && spent != null
      ? Math.min(100, Math.round((spent / approved) * 100))
      : null;

  // can_pause is the server's answer, not ours. Only fall back to a local
  // guess when the backend predates the field.
  const canPause =
    run?.can_pause ?? (run ? run.status === 'running' || run.status === 'queued' : false);

  return (
    <div
      className={cn(
        'rounded-md border px-4 py-3',
        stalled
          ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40'
          : 'border-violet-200 bg-violet-50 dark:border-violet-800 dark:bg-violet-950/40',
      )}
    >
      <div className="flex items-start gap-3">
        {stalled ? (
          <TriangleAlert className="size-4 mt-0.5 text-amber-700 dark:text-amber-300" />
        ) : (
          <RefreshCw className="size-4 mt-0.5 text-violet-700 dark:text-violet-300 animate-spin" />
        )}

        <div className="flex-1 min-w-0">
          <div
            className={cn(
              'text-sm font-medium',
              stalled
                ? 'text-amber-900 dark:text-amber-100'
                : 'text-violet-900 dark:text-violet-100',
            )}
          >
            {stalled ? 'Analysis is stuck — recovering' : 'AI Analysis in progress'}
            {run?.phase && (
              <span className="ml-2 text-xs font-normal opacity-80">
                · {String(run.phase).replaceAll('_', ' ')}
              </span>
            )}
            {typeof status.eta_seconds === 'number' && status.eta_seconds > 0 && (
              <span className="ml-2 text-xs font-normal opacity-80">
                · ETA {formatEta(status.eta_seconds)}
              </span>
            )}
          </div>

          <div
            className={cn(
              'text-xs mt-1',
              stalled
                ? 'text-amber-800 dark:text-amber-200'
                : 'text-violet-700 dark:text-violet-300',
            )}
          >
            {stalled
              ? 'No section has moved for a while. The reconciler is re-driving the stranded work; no action is needed yet.'
              : status.pending_components.join(' · ')}
          </div>

          <div
            className={cn(
              'mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]',
              stalled
                ? 'text-amber-800/80 dark:text-amber-200/80'
                : 'text-violet-700/80 dark:text-violet-300/80',
            )}
          >
            {run && run.total_docs > 0 && (
              <span>
                Documents {run.docs_completed}/{run.total_docs}
                {run.docs_failed > 0 && ` · ${run.docs_failed} failed`}
              </span>
            )}
            <span>
              Sections {status.sections.classified}/{status.sections.total} classified
            </span>
            <span>
              {status.sections.extracted}/{status.sections.classified} extracted
            </span>
            <span>
              Harmoniser: <code>{status.harmoniser.status}</code>
            </span>
            <span>This page auto-refreshes when complete.</span>
          </div>

          {/* Budget meter — the user approved a number; show how much of it
              this run has actually used. When it runs out, the server pauses
              and asks again rather than silently overspending. */}
          {approved != null && (
            <div className="mt-2.5 max-w-md">
              <div className="flex items-baseline justify-between text-[11px] text-violet-800 dark:text-violet-200">
                <span>
                  Spent {formatInr(spent ?? 0)} of {formatInr(approved)} approved
                </span>
                {pct != null && <span className="tabular-nums">{pct}%</span>}
              </div>
              <div className="mt-1 h-1.5 w-full rounded-full bg-violet-200/70 dark:bg-violet-900/60 overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    pct != null && pct >= 90
                      ? 'bg-amber-500'
                      : 'bg-violet-500 dark:bg-violet-400',
                  )}
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5 bg-white/70 dark:bg-slate-900/60"
            onClick={() => void onPause()}
            disabled={!canPause || pausing}
            title={
              canPause
                ? 'Stop starting new work. Anything already in flight finishes.'
                : 'This run cannot be paused right now.'
            }
          >
            {pausing ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : (
              <PauseCircle className="size-3.5" />
            )}
            Pause
          </Button>
          {controlError && (
            <span className="text-[11px] text-red-600 dark:text-red-400 max-w-[14rem] text-right">
              {controlError}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default RunProgressBanner;
