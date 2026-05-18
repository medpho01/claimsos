import React, { useState, useMemo, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, History, AlertCircle } from 'lucide-react';
import apiService from '@/services/api';
import {
  useStageRequirements,
  StageRequirement,
  StageRequirementsScope,
} from '@/hooks/intelligence/useStageRequirements';
import { useMasterOptions } from '@/hooks/intelligence/useMasterOptions';
import { CategoryPill } from '@/components/intelligence/primitives';
import RuleEditor, { RuleFormValue } from './RuleEditor';
import RuleVersionHistory, { RuleVersion } from './RuleVersionHistory';

/**
 * Wave 5C — Rules Configurator (Superadmin)
 *
 * TODO(routing): mount at `/superadmin/rules` once review signs off.
 *
 * Reads via the Wave 1 useStageRequirements hook; mutates via the
 * Wave 3A POST/PUT/DELETE /stage-requirements endpoints (controller
 * gates by checkSuperAdminOrAdmin).
 *
 * Backend endpoints USED:
 *   - GET    /stage-requirements                (list/filter)
 *   - POST   /stage-requirements                (create — auto-bumps version)
 *   - PUT    /stage-requirements/:id            (update — soft-versions)
 *   - DELETE /stage-requirements/:id            (soft delete)
 *
 * Backend endpoints NOT yet wired (graceful empty state):
 *   - GET /stage-requirements/history?rule_key= (version timeline)
 */

const SCOPE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'global', label: 'Global' },
  { key: 'panel', label: 'Panel' },
  { key: 'insurer', label: 'Insurer' },
  { key: 'procedure', label: 'Procedure' },
] as const;
type ScopeFilter = (typeof SCOPE_FILTERS)[number]['key'];

function scopeKindOf(r: StageRequirement): Exclude<ScopeFilter, 'all'> {
  if (r.scope?.procedure_code) return 'procedure';
  if (r.scope?.insurer_id) return 'insurer';
  if (r.scope?.panel_id) return 'panel';
  return 'global';
}

function summarizeScope(r: StageRequirement): string {
  const s = r.scope ?? {};
  const parts: string[] = [];
  if (s.panel_id) parts.push(`panel:${s.panel_id}`);
  if (s.insurer_id) parts.push(`insurer:${s.insurer_id}`);
  if (s.procedure_code) parts.push(`proc:${s.procedure_code}`);
  return parts.length === 0 ? 'global' : parts.join(' · ');
}

function severityOntology(sev: string) {
  if (sev === 'blocker') return 'deficiency_type' as const;
  if (sev === 'warning') return 'deduction_reason' as const;
  return undefined;
}

export const RulesConfigurator: React.FC = () => {
  const qc = useQueryClient();
  const stages = useMasterOptions('stage');

  const [stageFilter, setStageFilter] = useState<string>('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [activeOnly, setActiveOnly] = useState(true);

  // The hook supports panel/insurer/procedure scoping; for the admin
  // configurator we want EVERY rule, so we leave the scope params empty
  // and filter client-side.
  const scope: StageRequirementsScope = useMemo(() => ({}), []);
  const { data: rules, loading, error, refetch } = useStageRequirements(scope);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<StageRequirement | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const flash = (kind: 'ok' | 'err', msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 2500);
  };

  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: ['intelligence', 'stage-requirements'] }),
    [qc],
  );

  const saveMut = useMutation({
    mutationFn: async (value: RuleFormValue) => {
      const payload = {
        rule_key: value.rule_key,
        target_stage: value.target_stage,
        required_doc_category: value.required_doc_category,
        required_fields: value.required_fields,
        severity: value.severity,
        scope: value.scope.global ? {} : { ...value.scope, global: undefined },
        is_active: value.is_active ?? true,
      };
      if (value.id) {
        const res = await apiService.put(`/stage-requirements/${value.id}`, payload);
        return res.data?.data ?? res.data;
      }
      const res = await apiService.post('/stage-requirements', payload);
      return res.data?.data ?? res.data;
    },
    onSuccess: () => {
      flash('ok', 'Rule saved');
      setEditorOpen(false);
      invalidate();
      refetch();
    },
    onError: (e: any) => flash('err', e?.message ?? 'Save failed'),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiService.delete(`/stage-requirements/${id}`);
      return res.data?.data ?? res.data;
    },
    onSuccess: () => {
      flash('ok', 'Rule deactivated');
      invalidate();
      refetch();
    },
    onError: (e: any) => flash('err', e?.message ?? 'Delete failed'),
  });

  const historyQ = useQuery({
    queryKey: ['rules-config', 'history', historyKey],
    enabled: !!historyKey,
    staleTime: 30_000,
    queryFn: async (): Promise<RuleVersion[]> => {
      if (!historyKey) return [];
      try {
        const res = await apiService.get(
          `/stage-requirements/history?rule_key=${encodeURIComponent(historyKey)}`,
        );
        const rows = (res.data?.data ?? res.data ?? []) as RuleVersion[];
        return Array.isArray(rows) ? rows : [];
      } catch (e: any) {
        // TODO(backend): history endpoint not built yet.
        if (e?.response?.status === 404 || e?.response?.status === 501) return [];
        console.warn('[RulesConfigurator] history endpoint missing:', e?.message);
        return [];
      }
    },
  });

  const filtered = useMemo(() => {
    return (rules ?? []).filter((r) => {
      if (stageFilter && r.stage_key !== stageFilter) return false;
      if (scopeFilter !== 'all' && scopeKindOf(r) !== scopeFilter) return false;
      if (activeOnly && (r as any).is_active === false) return false;
      return true;
    });
  }, [rules, stageFilter, scopeFilter, activeOnly]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Rules Configurator
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Stage requirements — what docs and fields each stage demands.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditorInitial(null);
            setEditorOpen(true);
          }}
          className="inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded bg-slate-900 text-white dark:bg-white dark:text-slate-900"
        >
          <Plus className="h-3.5 w-3.5" /> New rule
        </button>
      </div>

      {toast && (
        <div
          className={
            'rounded-md border px-3 py-2 text-sm ' +
            (toast.kind === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300')
          }
        >
          {toast.msg}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2">
        <label className="text-xs flex items-center gap-1.5">
          <span className="text-slate-500 dark:text-slate-400">Stage</span>
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="">All</option>
            {stages.data.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1">
          {SCOPE_FILTERS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setScopeFilter(s.key)}
              className={
                'text-[11px] px-2 py-0.5 rounded-md ' +
                (scopeFilter === s.key
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60')
              }
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="text-xs flex items-center gap-1.5 ml-auto">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
          />
          <span className="text-slate-500 dark:text-slate-400">Active only</span>
        </label>
      </div>

      {/* Rules table */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        {loading ? (
          <div className="text-xs text-slate-500 dark:text-slate-400 px-3 py-6">Loading…</div>
        ) : error ? (
          <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400 px-3 py-6">
            <AlertCircle className="h-3.5 w-3.5" /> Failed to load rules.
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-slate-500 dark:text-slate-400 px-3 py-6 italic">
            No rules match the current filter.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/60">
              <tr>
                <th className="text-left font-medium px-3 py-2">Rule key</th>
                <th className="text-left font-medium px-3 py-2">Stage</th>
                <th className="text-left font-medium px-3 py-2">Required doc</th>
                <th className="text-left font-medium px-3 py-2">Severity</th>
                <th className="text-left font-medium px-3 py-2">Scope</th>
                <th className="text-left font-medium px-3 py-2 tabular-nums">v</th>
                <th className="text-left font-medium px-3 py-2">Active</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {filtered.map((r) => {
                const ruleKey = (r as any).rule_key ?? r.stage_key;
                const active = (r as any).is_active !== false;
                return (
                  <tr
                    key={r.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-900/40 cursor-pointer"
                    onClick={() => setHistoryKey(ruleKey)}
                  >
                    <td className="px-3 py-2 font-mono text-xs text-slate-800 dark:text-slate-200">
                      {ruleKey}
                    </td>
                    <td className="px-3 py-2">
                      <CategoryPill category={r.stage_key} ontologyCategory="stage" size="xs" />
                    </td>
                    <td className="px-3 py-2">
                      <CategoryPill
                        category={r.required_doc_category}
                        ontologyCategory="doc_category"
                        size="xs"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <CategoryPill
                        category={r.severity}
                        ontologyCategory={severityOntology(r.severity)}
                        size="xs"
                      />
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300 font-mono">
                      {summarizeScope(r)}
                    </td>
                    <td className="px-3 py-2 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                      {r.version}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span
                        className={
                          active
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : 'text-slate-400 dark:text-slate-500'
                        }
                      >
                        {active ? 'active' : 'inactive'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div
                        className="inline-flex items-center gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setEditorInitial(r);
                            setEditorOpen(true);
                          }}
                          className="text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white inline-flex items-center gap-0.5"
                          title="Edit"
                        >
                          <Pencil className="h-3 w-3" />
                          edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setHistoryKey(ruleKey)}
                          className="text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white inline-flex items-center gap-0.5"
                          title="History"
                        >
                          <History className="h-3 w-3" />
                          history
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteMut.mutate(r.id)}
                          disabled={deleteMut.isPending}
                          className="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 inline-flex items-center gap-0.5"
                          title="Soft delete"
                        >
                          <Trash2 className="h-3 w-3" />
                          delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <RuleEditor
        open={editorOpen}
        initial={editorInitial}
        onClose={() => setEditorOpen(false)}
        onSubmit={(v) => saveMut.mutateAsync(v).then(() => undefined)}
        pending={saveMut.isPending}
      />

      <RuleVersionHistory
        open={!!historyKey}
        ruleKey={historyKey}
        versions={historyQ.data ?? []}
        loading={historyQ.isLoading}
        onClose={() => setHistoryKey(null)}
      />
    </div>
  );
};

export default RulesConfigurator;
