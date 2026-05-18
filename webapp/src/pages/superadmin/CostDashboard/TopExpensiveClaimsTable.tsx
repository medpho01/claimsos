import React from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * Wave 5B — top expensive claims table.
 *
 * Lists the most expensive claims by LLM spend for the current period.
 * Each row links to the per-claim adjudication view so the operator
 * can pivot from "this claim cost a lot" → "let me see why".
 *
 * The cost_meter hook doesn't yet surface a top-N list; the demo page
 * wires its own mock data and prod will need a backend extension
 * (see summary). This component is purely presentational.
 */

export interface TopExpensiveClaim {
  claim_id: string;
  /** Short patient/claim label, e.g. "CL-2026-00417 · R. Verma". */
  label: string;
  hospital_name: string;
  spend_inr: number;
  llm_calls: number;
  /** Cents-per-call escalation count, optional. */
  escalations?: number;
}

export interface TopExpensiveClaimsTableProps {
  rows: TopExpensiveClaim[];
  /** Default 3. The dashboard spec calls for top-3. */
  limit?: number;
  className?: string;
}

function formatInr(n: number): string {
  if (!Number.isFinite(n)) return '₹0';
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2)} Cr`;
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2)} L`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(1)}k`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export const TopExpensiveClaimsTable: React.FC<TopExpensiveClaimsTableProps> = ({
  rows,
  limit = 3,
  className,
}) => {
  const visible = rows.slice(0, limit);

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
          Top {limit} most expensive claims
        </h3>
        <span className="text-[11px] text-slate-500 dark:text-slate-400">
          this week
        </span>
      </header>
      {visible.length === 0 ? (
        <div className="px-4 py-6 text-xs text-slate-500 dark:text-slate-400">
          No claims processed in this period.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 dark:text-slate-400">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium">Claim</th>
                <th className="px-4 py-2 font-medium">Hospital</th>
                <th className="px-4 py-2 font-medium text-right">LLM spend</th>
                <th className="px-4 py-2 font-medium text-right">Calls</th>
                <th className="px-4 py-2 font-medium text-right">Escalations</th>
                <th className="px-4 py-2 font-medium text-right">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.claim_id}
                  className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-950/40"
                >
                  <td className="px-4 py-2 text-slate-800 dark:text-slate-100 font-medium">
                    {r.label}
                  </td>
                  <td className="px-4 py-2 text-slate-600 dark:text-slate-300">
                    {r.hospital_name}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium text-slate-800 dark:text-slate-100">
                    {formatInr(r.spend_inr)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                    {r.llm_calls.toLocaleString('en-IN')}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                    {r.escalations ?? 0}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      to={`/claims/${r.claim_id}/adjudication`}
                      className="text-indigo-600 dark:text-indigo-300 hover:underline"
                    >
                      View
                    </Link>
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

export default TopExpensiveClaimsTable;
