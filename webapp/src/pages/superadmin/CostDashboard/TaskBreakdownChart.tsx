import React, { useMemo } from 'react';
import { cn } from '@/lib/utils';

/**
 * Wave 5B — horizontal-bar SVG chart for cost breakdown by intelligence task.
 *
 * Renders entries sorted descending by spend. Bars are inline SVG — no
 * chart library — so the component can be safely rendered inside dense
 * grids and dark-mode contexts without external deps. Counts are
 * formatted as INR (whole rupees).
 *
 * Empty state: a single muted "No spend recorded" row.
 */

export interface TaskBreakdownChartProps {
  /** task name -> rupees spent. Keys are surfaced verbatim as labels. */
  data: Record<string, number>;
  /** Limit visible rows. Default 8; remainder collapsed into "Other". */
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

export const TaskBreakdownChart: React.FC<TaskBreakdownChartProps> = ({
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
          Spend by Task
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
          Spend by Task
        </h3>
        <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
          {formatInr(total)} total
        </span>
      </header>
      <ul className="mt-3 space-y-2">
        {rows.map(([task, amount]) => {
          const pct = max > 0 ? (amount / max) * 100 : 0;
          const share = total > 0 ? (amount / total) * 100 : 0;
          return (
            <li key={task} className="text-xs">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-medium text-slate-700 dark:text-slate-200 truncate">
                  {task}
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
                aria-label={`${task}: ${formatInr(amount)}`}
                viewBox="0 0 100 6"
                preserveAspectRatio="none"
                className="w-full h-1.5 rounded-sm overflow-hidden bg-slate-100 dark:bg-slate-800"
              >
                <rect
                  x={0}
                  y={0}
                  width={pct}
                  height={6}
                  className="fill-indigo-500 dark:fill-indigo-400"
                />
              </svg>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default TaskBreakdownChart;
