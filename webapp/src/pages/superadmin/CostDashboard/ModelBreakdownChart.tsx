import React, { useMemo } from 'react';
import { cn } from '@/lib/utils';

/**
 * Wave 5B — horizontal-bar SVG chart for cost breakdown by LLM model.
 *
 * Sibling to TaskBreakdownChart; uses a sky/teal palette so the two
 * charts read distinctly when placed side-by-side. Bars are inline SVG;
 * formatting matches the task chart for visual rhythm.
 */

export interface ModelBreakdownChartProps {
  /** model name -> rupees spent. */
  data: Record<string, number>;
  /** Visible-row cap; remainder rolled up into "Other". Default 8. */
  maxRows?: number;
  className?: string;
}

function formatInr(n: number): string {
  if (!Number.isFinite(n)) return '₹0';
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2)} Cr`;
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2)} L`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(1)}k`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/**
 * Map a model identifier to a tone class. Voyage embeds are cheapest →
 * teal; Haiku is mid → sky; Sonnet/Opus are most expensive → indigo.
 * Unknown models fall back to slate.
 */
function paletteFor(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'fill-indigo-600 dark:fill-indigo-400';
  if (m.includes('sonnet')) return 'fill-indigo-500 dark:fill-indigo-300';
  if (m.includes('haiku')) return 'fill-sky-500 dark:fill-sky-400';
  if (m.includes('voyage') || m.includes('embed')) return 'fill-teal-500 dark:fill-teal-400';
  return 'fill-slate-500 dark:fill-slate-400';
}

export const ModelBreakdownChart: React.FC<ModelBreakdownChartProps> = ({
  data,
  maxRows = 8,
  className,
}) => {
  const rows = useMemo(() => {
    const entries = Object.entries(data || {})
      .filter(([, v]) => Number.isFinite(v) && v > 0)
      .sort((a, b) => b[1] - a[1]);
    if (entries.length <= maxRows) return entries;
    const head = entries.slice(0, maxRows - 1);
    const tail = entries.slice(maxRows - 1);
    const other = tail.reduce((s, [, v]) => s + v, 0);
    return [...head, ['Other', other] as [string, number]];
  }, [data, maxRows]);

  const max = rows.reduce((m, [, v]) => Math.max(m, v), 0);
  const total = rows.reduce((s, [, v]) => s + v, 0);

  if (rows.length === 0) {
    return (
      <div
        className={cn(
          'rounded-lg border border-slate-200 dark:border-slate-800',
          'bg-white dark:bg-slate-900 p-4',
          className,
        )}
      >
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          Spend by Model
        </h3>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          No spend recorded in this period.
        </p>
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
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          Spend by Model
        </h3>
        <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
          {formatInr(total)} total
        </span>
      </header>
      <ul className="mt-3 space-y-2">
        {rows.map(([model, amount]) => {
          const pct = max > 0 ? (amount / max) * 100 : 0;
          const share = total > 0 ? (amount / total) * 100 : 0;
          return (
            <li key={model} className="text-xs">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-medium text-slate-700 dark:text-slate-200 truncate">
                  {model}
                </span>
                <span className="tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                  {formatInr(amount)}
                  <span className="ml-1 text-slate-400 dark:text-slate-500">
                    ({share.toFixed(0)}%)
                  </span>
                </span>
              </div>
              <svg
                role="img"
                aria-label={`${model}: ${formatInr(amount)}`}
                viewBox="0 0 100 6"
                preserveAspectRatio="none"
                className="w-full h-1.5 rounded-sm overflow-hidden bg-slate-100 dark:bg-slate-800"
              >
                <rect x={0} y={0} width={pct} height={6} className={paletteFor(model)} />
              </svg>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default ModelBreakdownChart;
