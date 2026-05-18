import React from 'react';
import { TrendingUp, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AdjudicationPredictedOutcome } from '@/hooks/intelligence';

/**
 * Sprint 3, Wave 3C — AdjudicationView sub-component.
 *
 * Predicted outcome card. Handles `null` predicted_outcome gracefully —
 * the engine doesn't always emit a prediction (cold-start, low confidence
 * KB match, etc.). In that case we render a muted placeholder rather than
 * leaving a hole in the layout.
 */
export interface PredictedOutcomeCardProps {
  outcome: AdjudicationPredictedOutcome | null | undefined;
  className?: string;
}

function fmtInr(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(v);
}

function fmtPct(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return `${Math.round(v * 100)}%`;
}

export const PredictedOutcomeCard: React.FC<PredictedOutcomeCardProps> = ({
  outcome,
  className,
}) => {
  if (!outcome) {
    return (
      <div
        className={cn(
          'rounded-lg border border-dashed border-slate-300 dark:border-slate-700',
          'bg-slate-50 dark:bg-slate-900/50 p-4',
          'flex items-start gap-3',
          className,
        )}
      >
        <HelpCircle
          className="size-5 text-slate-400 dark:text-slate-500 shrink-0 mt-0.5"
          aria-hidden
        />
        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
            Predicted outcome
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            No prediction yet — the engine needs more docs or a similar case
            in the knowledge base.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-slate-200 dark:border-slate-800',
        'bg-white dark:bg-slate-900 p-4',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <TrendingUp
          className="size-5 text-indigo-500 dark:text-indigo-400 shrink-0 mt-0.5"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Predicted outcome
          </h3>
          <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Likely amount
              </div>
              <div className="font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                {fmtInr(outcome.amount)}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Expected value
              </div>
              <div className="font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                {outcome.expected_value_inr !== undefined
                  ? fmtInr(outcome.expected_value_inr)
                  : '—'}
              </div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div>
              <span className="text-slate-500 dark:text-slate-400">P(approve): </span>
              <span className="font-medium text-emerald-700 dark:text-emerald-300">
                {fmtPct(outcome.p_approval)}
              </span>
            </div>
            <div>
              <span className="text-slate-500 dark:text-slate-400">P(partial): </span>
              <span className="font-medium text-amber-700 dark:text-amber-300">
                {fmtPct(outcome.p_partial)}
              </span>
            </div>
            <div>
              <span className="text-slate-500 dark:text-slate-400">P(query): </span>
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {fmtPct(outcome.p_query)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
