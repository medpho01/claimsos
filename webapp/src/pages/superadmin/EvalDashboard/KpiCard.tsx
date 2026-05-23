import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Sprint 4, Wave 5A — Eval Dashboard KPI card.
 *
 * Single metric tile for the top of the dashboard. Big number, small
 * label, optional sub-line (e.g. n=12,345) and optional delta caret. No
 * background card; uses border + padding consistent with the rest of
 * the SuperAdmin pages.
 */

export interface KpiCardProps {
  label: string;
  /** The headline value, already formatted (e.g. "84.2%" or "₹12.4"). */
  value: string;
  /** Optional secondary line under the value. */
  sub?: string;
  /**
   * Optional delta — positive renders green up-caret, negative red
   * down-caret, zero/undefined hides the caret.
   */
  delta?: number;
  /** Tone hint for the value text. Default 'default'. */
  tone?: 'default' | 'good' | 'warn' | 'bad';
  className?: string;
}

const toneClass: Record<NonNullable<KpiCardProps['tone']>, string> = {
  default: 'text-slate-900 dark:text-slate-100',
  good: 'text-emerald-700 dark:text-emerald-300',
  warn: 'text-amber-700 dark:text-amber-300',
  bad: 'text-red-700 dark:text-red-300',
};

export const KpiCard: React.FC<KpiCardProps> = ({
  label,
  value,
  sub,
  delta,
  tone = 'default',
  className,
}) => {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3',
        className,
      )}
    >
      <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className={cn('text-2xl font-semibold tabular-nums', toneClass[tone])}>
        {value}
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        {sub && <span>{sub}</span>}
        {typeof delta === 'number' && delta !== 0 && (
          <span
            className={cn(
              'tabular-nums font-medium',
              delta > 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-600 dark:text-red-400',
            )}
            title={`${delta > 0 ? '+' : ''}${delta.toFixed(1)} vs previous period`}
          >
            {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}
          </span>
        )}
      </div>
    </div>
  );
};

export default KpiCard;
