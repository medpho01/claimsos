import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Wave 5B — active alerts table.
 *
 * Lists rows from `cost_alerts` (migration 029). The cost_meter hook
 * currently exposes `alerts: CostMeterAlert[]` with `severity`, `message`,
 * `triggered_at` — none of which include hospital_id, kind, threshold, or
 * current spend. This component takes a richer shape so the demo page
 * can show all states; in production the data layer will need to be
 * extended to expose these fields (see backend notes in the summary).
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface CostAlertRow {
  id: string;
  hospital_id: string;
  hospital_name: string;
  alert_kind: string;
  severity: AlertSeverity;
  threshold_inr: number;
  current_inr: number;
  fired_at: string;
  message?: string;
}

export interface AlertsTableProps {
  rows: CostAlertRow[];
  className?: string;
}

function formatInr(n: number): string {
  if (!Number.isFinite(n)) return '₹0';
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2)} Cr`;
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2)} L`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(1)}k`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

const severityClass: Record<AlertSeverity, string> = {
  info: 'text-sky-700 dark:text-sky-300',
  warning: 'text-amber-700 dark:text-amber-300',
  critical: 'text-red-700 dark:text-red-300',
};

const severityDotClass: Record<AlertSeverity, string> = {
  info: 'bg-sky-500 dark:bg-sky-400',
  warning: 'bg-amber-500 dark:bg-amber-400',
  critical: 'bg-red-500 dark:bg-red-400',
};

export const AlertsTable: React.FC<AlertsTableProps> = ({ rows, className }) => {
  return (
    <div
      className={cn(
        'rounded-lg border border-slate-200 dark:border-slate-800',
        'bg-white dark:bg-slate-900 overflow-hidden',
        className,
      )}
    >
      <header className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          Active alerts
        </h3>
        <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
          {rows.length} firing
        </span>
      </header>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-xs text-slate-500 dark:text-slate-400">
          No alerts firing.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 dark:text-slate-400">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium">Hospital</th>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium text-right">Threshold</th>
                <th className="px-4 py-2 font-medium text-right">Current</th>
                <th className="px-4 py-2 font-medium">Fired at</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-slate-100 dark:border-slate-800"
                >
                  <td className="px-4 py-2 text-slate-800 dark:text-slate-100">
                    {r.hospital_name}
                  </td>
                  <td className={cn('px-4 py-2', severityClass[r.severity])}>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className={cn(
                          'inline-block h-1.5 w-1.5 rounded-full',
                          severityDotClass[r.severity],
                        )}
                      />
                      {r.alert_kind}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {formatInr(r.threshold_inr)}
                  </td>
                  <td
                    className={cn(
                      'px-4 py-2 text-right tabular-nums font-medium',
                      r.current_inr >= r.threshold_inr
                        ? 'text-red-700 dark:text-red-300'
                        : 'text-slate-700 dark:text-slate-200',
                    )}
                  >
                    {formatInr(r.current_inr)}
                  </td>
                  <td className="px-4 py-2 text-slate-500 dark:text-slate-400 tabular-nums">
                    {formatDate(r.fired_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default AlertsTable;
