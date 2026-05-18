import React from 'react';
import { cn } from '@/lib/utils';
import { ConfidenceBadge } from '@/components/intelligence/primitives/ConfidenceBadge';

/**
 * Sprint 4, Wave 5A — Per-task breakdown table.
 *
 * One row per target_stage (task) showing precision, recall, mean error
 * and sample size. Precision/recall are rendered as ConfidenceBadge-style
 * inline indicators so the tone matches the rest of the intelligence UI
 * (Wave 0 primitive). Mean error is the average amount_error_inr — the
 * sign tells you whether the model over- or under-predicted.
 */

export interface TaskBreakdownRow {
  task: string;
  precision: number;
  recall: number;
  mean_error: number;
  n: number;
}

export interface TaskBreakdownTableProps {
  rows: TaskBreakdownRow[];
  className?: string;
}

function formatINR(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export const TaskBreakdownTable: React.FC<TaskBreakdownTableProps> = ({
  rows,
  className,
}) => {
  if (rows.length === 0) {
    return (
      <div
        className={cn(
          'flex h-[120px] items-center justify-center rounded-md border border-dashed border-slate-300 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400',
          className,
        )}
      >
        No task breakdown yet
      </div>
    );
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-slate-200 dark:border-slate-800',
        className,
      )}
    >
      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-900 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Task</th>
            <th className="px-3 py-2 text-right font-medium">Precision</th>
            <th className="px-3 py-2 text-right font-medium">Recall</th>
            <th className="px-3 py-2 text-right font-medium">Mean error</th>
            <th className="px-3 py-2 text-right font-medium">n</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800 bg-white dark:bg-slate-900">
          {rows.map((r) => (
            <tr key={r.task} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
              <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-200">
                {r.task}
              </td>
              <td className="px-3 py-2 text-right">
                <ConfidenceBadge confidence={r.precision} mode="pct" />
              </td>
              <td className="px-3 py-2 text-right">
                <ConfidenceBadge confidence={r.recall} mode="pct" />
              </td>
              <td
                className={cn(
                  'px-3 py-2 text-right tabular-nums',
                  r.mean_error > 0
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : r.mean_error < 0
                      ? 'text-red-700 dark:text-red-300'
                      : 'text-slate-600 dark:text-slate-400',
                )}
              >
                {formatINR(r.mean_error)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">
                {r.n.toLocaleString('en-IN')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default TaskBreakdownTable;
