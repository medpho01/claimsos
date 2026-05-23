import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Wave 5B — Cost Dashboard KPI card.
 *
 * One of four cards in the KPI strip on the Cost Dashboard. Mirrors the
 * KpiCard pattern used by the EvalDashboard sketches — a labelled value
 * with an optional sub-label and a tone-coloured left rail driven by
 * ConfidenceBadge semantics (green within target, amber approaching,
 * red over). Tone is computed inline so the card can be used
 * standalone without a separate confidence prop.
 */

export type CostKpiTone = 'green' | 'amber' | 'red' | 'neutral';

export interface CostKpiCardProps {
  /** Short label, e.g. "Total spend". */
  label: string;
  /** Primary value as already-formatted string ("₹1,24,500", "P95: ₹38"). */
  value: string;
  /** Optional small sub-line shown under value (e.g. "since 1 May"). */
  sublabel?: string;
  /** Health colour. Defaults to neutral if undefined. */
  tone?: CostKpiTone;
  /** Optional trailing right-aligned element (icon, delta, hint). */
  trailing?: React.ReactNode;
  className?: string;
}

const toneRailClass: Record<CostKpiTone, string> = {
  green: 'bg-emerald-500 dark:bg-emerald-400',
  amber: 'bg-amber-500 dark:bg-amber-400',
  red: 'bg-red-500 dark:bg-red-400',
  neutral: 'bg-slate-300 dark:bg-slate-600',
};

const toneTextClass: Record<CostKpiTone, string> = {
  green: 'text-emerald-700 dark:text-emerald-300',
  amber: 'text-amber-700 dark:text-amber-300',
  red: 'text-red-700 dark:text-red-300',
  neutral: 'text-slate-700 dark:text-slate-200',
};

export const CostKpiCard: React.FC<CostKpiCardProps> = ({
  label,
  value,
  sublabel,
  tone = 'neutral',
  trailing,
  className,
}) => {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800',
        'bg-white dark:bg-slate-900 px-4 py-3 flex items-center gap-3 min-h-[88px]',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn('absolute inset-y-0 left-0 w-1', toneRailClass[tone])}
      />
      <div className="flex-1 min-w-0 pl-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {label}
        </div>
        <div
          className={cn(
            'mt-1 text-2xl font-semibold tabular-nums truncate',
            toneTextClass[tone],
          )}
          title={value}
        >
          {value}
        </div>
        {sublabel && (
          <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">
            {sublabel}
          </div>
        )}
      </div>
      {trailing && (
        <div className="text-xs text-slate-500 dark:text-slate-400 shrink-0">
          {trailing}
        </div>
      )}
    </div>
  );
};

export default CostKpiCard;
