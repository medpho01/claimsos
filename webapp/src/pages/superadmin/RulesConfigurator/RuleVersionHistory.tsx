import React from 'react';
import { X, History } from 'lucide-react';
import { CategoryPill } from '@/components/intelligence/primitives';

/**
 * Wave 5C — RulesConfigurator
 *
 * Read-only timeline drawer showing previous versions of a single
 * rule_key. The backend may not yet expose a `?history=1` endpoint;
 * the parent loads via apiService.get(...) and the drawer renders an
 * empty-state if the call 404s.
 *
 * TODO(backend): a dedicated GET /stage-requirements/history?rule_key=…
 * endpoint would be a clean fit; for now the controller's list endpoint
 * does NOT return inactive prior versions.
 */

export interface RuleVersion {
  id: string;
  rule_key: string;
  target_stage: string;
  required_doc_category: string;
  severity: 'blocker' | 'warning' | 'info';
  version: number;
  is_active: boolean;
  updated_at: string;
  updated_by?: string;
}

export interface RuleVersionHistoryProps {
  open: boolean;
  ruleKey: string | null;
  versions: RuleVersion[];
  loading?: boolean;
  onClose: () => void;
}

export const RuleVersionHistory: React.FC<RuleVersionHistoryProps> = ({
  open,
  ruleKey,
  versions,
  loading,
  onClose,
}) => {
  if (!open) return null;
  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-md border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl flex flex-col">
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
        <History className="h-4 w-4 text-slate-500 dark:text-slate-400" />
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Version history
          </div>
          <div className="text-sm font-mono font-semibold text-slate-900 dark:text-slate-100 truncate max-w-[260px]">
            {ruleKey ?? '—'}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <div className="text-xs text-slate-500 dark:text-slate-400 px-3 py-4">Loading…</div>
        ) : versions.length === 0 ? (
          <div className="text-xs text-slate-500 dark:text-slate-400 px-3 py-4 italic">
            No prior versions recorded.
          </div>
        ) : (
          <ol className="relative border-l border-slate-200 dark:border-slate-800 ml-3 space-y-3 pl-4 py-2">
            {versions.map((v) => (
              <li key={v.id} className="relative">
                <span
                  className={
                    'absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ' +
                    (v.is_active
                      ? 'bg-emerald-500 dark:bg-emerald-400'
                      : 'bg-slate-300 dark:bg-slate-600')
                  }
                />
                <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  v{v.version} · {new Date(v.updated_at).toLocaleString()}
                  {v.updated_by && (
                    <span className="ml-2 text-slate-400 dark:text-slate-500">
                      by {v.updated_by}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-sm text-slate-900 dark:text-slate-100">
                    {v.required_doc_category}
                  </span>
                  <CategoryPill
                    category={v.severity}
                    ontologyCategory={
                      v.severity === 'blocker' ? 'deficiency_type' : undefined
                    }
                    size="xs"
                  />
                  {v.is_active && (
                    <span className="text-[10px] uppercase text-emerald-700 dark:text-emerald-300">
                      current
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  stage: <span className="font-mono">{v.target_stage}</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
};

export default RuleVersionHistory;
