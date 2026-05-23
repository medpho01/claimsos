import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Brain,
  Filter,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { EventRow } from '@/components/intelligence/primitives';
import {
  useAiAuditTrail,
  type AiAuditTrailRow,
} from '@/hooks/intelligence/useAiAuditTrail';

/**
 * Wave 9 — AuditTrailPanel.
 *
 * Renders the per-claim LLM call history with cost roll-up, simple
 * task + date filters, and an expandable per-row detail view.
 */
export interface AuditTrailPanelProps {
  claimId: string;
  /** Override rows — used by the dev demo. */
  rowsOverride?: AiAuditTrailRow[] | null;
  /** Disable network calls — used by the dev demo. */
  offline?: boolean;
}

export const AuditTrailPanel: React.FC<AuditTrailPanelProps> = ({
  claimId,
  rowsOverride,
  offline = false,
}) => {
  const [taskFilter, setTaskFilter] = useState<string>('');
  const [since, setSince] = useState<string>('');
  const [until, setUntil] = useState<string>('');

  const trail = useAiAuditTrail(offline ? null : claimId, {
    task: taskFilter || undefined,
    since: since || undefined,
    until: until || undefined,
  });

  const rows = rowsOverride ?? trail.data;

  const filtered = useMemo(() => {
    // Server applies filters when live; the override path needs client-side.
    if (!rowsOverride) return rows;
    return rows.filter((r) => {
      if (taskFilter && r.task !== taskFilter) return false;
      if (since && new Date(r.created_at) < new Date(since)) return false;
      if (until && new Date(r.created_at) > new Date(until)) return false;
      return true;
    });
  }, [rows, rowsOverride, taskFilter, since, until]);

  const taskOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(r.task));
    return Array.from(set).sort();
  }, [rows]);

  // pg returns `numeric` columns as strings. Coerce every numeric field
  // through Number() before summing, otherwise we end up concatenating
  // strings and .toFixed() blows up at render time.
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const rollup = useMemo(() => {
    const totalCost = filtered.reduce((acc, r) => acc + num(r.cost_inr), 0);
    const totalCalls = filtered.length;
    const totalTokensIn = filtered.reduce(
      (acc, r) => acc + num(r.tokens_input_uncached) + num(r.tokens_input_cached),
      0,
    );
    const totalTokensOut = filtered.reduce(
      (acc, r) => acc + num(r.tokens_output),
      0,
    );
    const failures = filtered.filter((r) => !r.succeeded).length;
    return { totalCost, totalCalls, totalTokensIn, totalTokensOut, failures };
  }, [filtered]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!offline && trail.loading) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
        Loading AI audit trail…
      </div>
    );
  }

  if (!filtered.length) {
    return (
      <div className="space-y-3">
        <FilterBar
          taskFilter={taskFilter}
          setTaskFilter={setTaskFilter}
          since={since}
          setSince={setSince}
          until={until}
          setUntil={setUntil}
          taskOptions={taskOptions}
        />
        <div className="rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-10 text-center space-y-2">
          <div className="mx-auto size-10 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
            <Brain className="size-5 text-slate-500 dark:text-slate-400" />
          </div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            No AI calls yet for this patient
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            LLM calls made on behalf of this claim will appear here with cost,
            tokens, and outcome.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Cost roll-up */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
        <Stat label="LLM calls" value={String(rollup.totalCalls)} />
        <Stat
          label="Total spend"
          value={`₹ ${rollup.totalCost.toFixed(2)}`}
          emphasis
        />
        <Stat
          label="Tokens (in)"
          value={rollup.totalTokensIn.toLocaleString('en-IN')}
        />
        <Stat
          label="Tokens (out)"
          value={rollup.totalTokensOut.toLocaleString('en-IN')}
        />
        <Stat
          label="Failures"
          value={String(rollup.failures)}
          tone={rollup.failures > 0 ? 'bad' : 'ok'}
        />
      </div>

      <FilterBar
        taskFilter={taskFilter}
        setTaskFilter={setTaskFilter}
        since={since}
        setSince={setSince}
        until={until}
        setUntil={setUntil}
        taskOptions={taskOptions}
      />

      {/* Timeline */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2 divide-y divide-slate-100 dark:divide-slate-800">
        {filtered.map((r) => {
          const open = expanded.has(r.id);
          const tone = !r.succeeded ? 'danger' : 'default';
          return (
            <div key={r.id}>
              <EventRow
                when={r.created_at}
                kind={r.succeeded ? 'message' : 'warning'}
                tone={tone}
                title={`${r.task}`}
                description={`${r.provider} · ${r.model}`}
                actor={r.succeeded ? undefined : 'failed'}
                onClick={() => toggle(r.id)}
              >
                <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  <span>
                    in: <span className="tabular-nums text-slate-700 dark:text-slate-200">
                      {(r.tokens_input_uncached ?? 0) + (r.tokens_input_cached ?? 0)}
                    </span>
                    {r.tokens_input_cached ? (
                      <span className="text-emerald-600 dark:text-emerald-300">
                        {' '}
                        ({r.tokens_input_cached} cached)
                      </span>
                    ) : null}
                  </span>
                  <span>
                    out:{' '}
                    <span className="tabular-nums text-slate-700 dark:text-slate-200">
                      {r.tokens_output ?? 0}
                    </span>
                  </span>
                  <span>
                    cost:{' '}
                    <span className="tabular-nums text-slate-700 dark:text-slate-200">
                      ₹ {num(r.cost_inr).toFixed(3)}
                    </span>
                  </span>
                  {r.latency_ms != null && (
                    <span>
                      latency:{' '}
                      <span className="tabular-nums text-slate-700 dark:text-slate-200">
                        {r.latency_ms} ms
                      </span>
                    </span>
                  )}
                  {r.succeeded ? (
                    <CheckCircle2 className="size-3 text-emerald-500" />
                  ) : (
                    <XCircle className="size-3 text-red-500" />
                  )}
                  <span className="ml-auto inline-flex items-center text-slate-400">
                    {open ? (
                      <ChevronDown className="size-3" />
                    ) : (
                      <ChevronRight className="size-3" />
                    )}
                  </span>
                </div>
              </EventRow>
              {open && (
                <div className="px-4 pb-3 pl-24 text-xs space-y-2">
                  {r.prompt_version && (
                    <Row
                      label="Prompt version"
                      value={r.prompt_version}
                      mono
                      hint="TODO(audit-trail) link to /prompts/ in repo"
                    />
                  )}
                  {r.confidence != null && (
                    <Row
                      label="Confidence"
                      value={`${Math.round((r.confidence ?? 0) * 100)}%`}
                    />
                  )}
                  {r.error_message && (
                    <div className="rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-2 py-1.5 text-red-700 dark:text-red-300">
                      {r.error_message}
                    </div>
                  )}
                  {r.meta && Object.keys(r.meta).length > 0 && (
                    <pre className="rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-2 text-[11px] font-mono text-slate-700 dark:text-slate-200 whitespace-pre-wrap max-h-32 overflow-auto">
                      {JSON.stringify(r.meta, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Stat: React.FC<{
  label: string;
  value: string;
  emphasis?: boolean;
  tone?: 'ok' | 'bad' | 'default';
}> = ({ label, value, emphasis, tone = 'default' }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {label}
    </div>
    <div
      className={cn(
        'tabular-nums mt-0.5',
        emphasis ? 'text-lg font-semibold' : 'text-sm font-medium',
        tone === 'ok' && 'text-emerald-700 dark:text-emerald-300',
        tone === 'bad' && 'text-red-700 dark:text-red-300',
        tone === 'default' && 'text-slate-900 dark:text-slate-100',
      )}
    >
      {value}
    </div>
  </div>
);

const Row: React.FC<{
  label: string;
  value: string;
  mono?: boolean;
  hint?: string;
}> = ({ label, value, mono, hint }) => (
  <div className="flex items-baseline gap-2">
    <span className="w-28 shrink-0 text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {label}
    </span>
    <span
      className={cn(
        'text-xs text-slate-700 dark:text-slate-200',
        mono && 'font-mono',
      )}
      title={hint}
    >
      {value}
    </span>
  </div>
);

interface FilterBarProps {
  taskFilter: string;
  setTaskFilter: (v: string) => void;
  since: string;
  setSince: (v: string) => void;
  until: string;
  setUntil: (v: string) => void;
  taskOptions: string[];
}

const FilterBar: React.FC<FilterBarProps> = ({
  taskFilter,
  setTaskFilter,
  since,
  setSince,
  until,
  setUntil,
  taskOptions,
}) => (
  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 flex items-center gap-3 text-xs flex-wrap">
    <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
      <Filter className="size-3.5" />
      Filter
    </span>
    <select
      value={taskFilter}
      onChange={(e) => setTaskFilter(e.target.value)}
      className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
    >
      <option value="">All tasks</option>
      {taskOptions.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
    <label className="inline-flex items-center gap-1">
      <span className="text-slate-500 dark:text-slate-400">From</span>
      <input
        type="date"
        value={since}
        onChange={(e) => setSince(e.target.value)}
        className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
      />
    </label>
    <label className="inline-flex items-center gap-1">
      <span className="text-slate-500 dark:text-slate-400">To</span>
      <input
        type="date"
        value={until}
        onChange={(e) => setUntil(e.target.value)}
        className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
      />
    </label>
    {(taskFilter || since || until) && (
      <button
        type="button"
        onClick={() => {
          setTaskFilter('');
          setSince('');
          setUntil('');
        }}
        className="text-indigo-600 dark:text-indigo-300 hover:underline"
      >
        Clear
      </button>
    )}
  </div>
);

export default AuditTrailPanel;
