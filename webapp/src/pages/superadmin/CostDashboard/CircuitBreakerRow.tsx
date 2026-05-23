import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Wave 5B — single circuit-breaker row.
 *
 * Surfaces a per-hospital daily-cap utilisation as a labelled horizontal
 * progress bar. Tone follows the same green/amber/red ladder as
 * ConfidenceBadge — green <70% consumed, amber 70-95%, red >=95%
 * (or breaker tripped). A small status string sits on the right so the
 * cap, current spend, and breaker state are all visible without
 * tooltips.
 */

export interface CircuitBreakerRowProps {
  hospitalId: string;
  hospitalName: string;
  /** Cap in INR for the period (typically daily). */
  capInr: number;
  /** Spend so far in INR for the same period. */
  spentInr: number;
  /**
   * Whether the breaker has tripped. When tripped, the row reads red
   * regardless of percentage (defensive — should also be >=cap).
   */
  tripped?: boolean;
  className?: string;
}

function formatInr(n: number): string {
  if (!Number.isFinite(n)) return '₹0';
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2)} Cr`;
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2)} L`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(1)}k`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

type Tone = 'green' | 'amber' | 'red';

function toneFor(pct: number, tripped?: boolean): Tone {
  if (tripped) return 'red';
  if (pct >= 95) return 'red';
  if (pct >= 70) return 'amber';
  return 'green';
}

const barClass: Record<Tone, string> = {
  green: 'fill-emerald-500 dark:fill-emerald-400',
  amber: 'fill-amber-500 dark:fill-amber-400',
  red: 'fill-red-500 dark:fill-red-400',
};

const textToneClass: Record<Tone, string> = {
  green: 'text-emerald-700 dark:text-emerald-300',
  amber: 'text-amber-700 dark:text-amber-300',
  red: 'text-red-700 dark:text-red-300',
};

export const CircuitBreakerRow: React.FC<CircuitBreakerRowProps> = ({
  hospitalId,
  hospitalName,
  capInr,
  spentInr,
  tripped,
  className,
}) => {
  const pctRaw = capInr > 0 ? (spentInr / capInr) * 100 : 0;
  const pct = Math.max(0, Math.min(100, pctRaw));
  const tone = toneFor(pctRaw, tripped);

  return (
    <div
      className={cn(
        'rounded-md border border-slate-200 dark:border-slate-800',
        'bg-slate-50 dark:bg-slate-950/40 px-3 py-2',
        className,
      )}
      data-hospital-id={hospitalId}
    >
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <div className="min-w-0 flex items-center gap-2">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">
            {hospitalName}
          </span>
          {tripped && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-300">
              tripped
            </span>
          )}
        </div>
        <div className={cn('text-xs tabular-nums shrink-0', textToneClass[tone])}>
          {formatInr(spentInr)}
          <span className="text-slate-400 dark:text-slate-500"> / {formatInr(capInr)}</span>
          <span className="ml-1 text-slate-500 dark:text-slate-400">({pctRaw.toFixed(0)}%)</span>
        </div>
      </div>
      <svg
        role="img"
        aria-label={`${hospitalName} cap usage: ${pctRaw.toFixed(0)}%`}
        viewBox="0 0 100 6"
        preserveAspectRatio="none"
        className="w-full h-1.5 rounded-sm overflow-hidden bg-slate-200 dark:bg-slate-800"
      >
        <rect x={0} y={0} width={pct} height={6} className={barClass[tone]} />
      </svg>
    </div>
  );
};

export default CircuitBreakerRow;
