import React, { useMemo, useState } from 'react';
import { useEvalMetrics } from '@/hooks/intelligence/useEvalMetrics';
import type { EvalMetricsData, EvalMetricsPeriod } from '@/hooks/intelligence/useEvalMetrics';
import { KpiCard } from './KpiCard';
import {
  ConfidenceCalibrationChart,
  type CalibrationBucket,
} from './ConfidenceCalibrationChart';
import { WeeklyTrendChart } from './WeeklyTrendChart';
import { TaskBreakdownTable, type TaskBreakdownRow } from './TaskBreakdownTable';

/**
 * Sprint 4, Wave 5A — Eval Dashboard (Superadmin).
 *
 * TODO(routes): mount at `/superadmin/eval` once the parent routing tree is
 * ready to accept new entries. The mount is intentionally not added here so
 * this PR doesn't touch the central App routes file.
 *
 * Layout (top → bottom):
 *   1. Filter bar (period, task, hospital)
 *   2. KPI strip (accuracy %, sample size, mean cost/claim, action-correct rate)
 *   3. Confidence calibration plot (predicted vs actual per readiness bucket)
 *   4. Weekly trend line
 *   5. Per-task breakdown table
 *
 * Data:
 *   - `useEvalMetrics` is the Wave 1 hook. Its current return shape carries
 *     prediction_accuracy_pct, sample_size, breakdown_by_task, weekly_trend
 *     and a deliberately-loose `confidence_calibration: any`. We narrow that
 *     shape locally to the array-of-buckets the backend service emits.
 *   - Hospitals are passed in via props (mirrors CostDashboard's contract);
 *     the parent layout owns the list.
 *   - The dev demo page (`pages/dev/EvalDashboardDemo.tsx`) drives this page
 *     with mock metrics so the visual hierarchy can be validated without the
 *     backend.
 */

export interface HospitalOption {
  id: string;
  name: string;
}

export interface EvalDashboardProps {
  /** Optional override hook — defaults to live useEvalMetrics. */
  useMetrics?: typeof useEvalMetrics;
  /** Optional pre-populated hospital list for the filter. */
  hospitals?: HospitalOption[];
  /**
   * Optional metrics override — bypasses the hook entirely. Used by the dev
   * demo page so we don't hit the backend.
   */
  metricsOverride?: EvalMetricsData | null;
  /** When true, the demo banner renders above the dashboard. */
  offline?: boolean;
}

const PERIOD_OPTIONS: { value: EvalMetricsPeriod | 'today'; label: string }[] = [
  { value: 'today' as any, label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────

function isCalibrationArray(c: any): c is CalibrationBucket[] {
  return (
    Array.isArray(c) &&
    (c.length === 0 ||
      (typeof c[0]?.bucket_low === 'number' &&
        typeof c[0]?.predicted_rate === 'number' &&
        typeof c[0]?.actual_rate === 'number'))
  );
}

function deriveActionCorrectRate(
  breakdown: Record<string, { precision: number; n?: number; sample_size?: number }>,
): { rate: number; n: number } {
  let weighted = 0;
  let n = 0;
  for (const k of Object.keys(breakdown)) {
    const row = breakdown[k]!;
    const rowN = row.n ?? row.sample_size ?? 0;
    weighted += (row.precision ?? 0) * rowN;
    n += rowN;
  }
  return { rate: n > 0 ? weighted / n : 0, n };
}

function deriveMeanCostPerClaim(metrics: any): number | null {
  // Service surfaces this as cost_per_claim.mean; the hook's typedef is
  // loose, so probe defensively.
  const v = metrics?.cost_per_claim?.mean;
  return typeof v === 'number' ? v : null;
}

// ─── Component ───────────────────────────────────────────────────────────

export const EvalDashboard: React.FC<EvalDashboardProps> = ({
  useMetrics = useEvalMetrics,
  hospitals = [],
  metricsOverride,
  offline = false,
}) => {
  const [period, setPeriod] = useState<EvalMetricsPeriod>('week');
  const [task, setTask] = useState<string>('');
  const [hospitalId, setHospitalId] = useState<string>('');

  // Live hook — skipped when an override is provided.
  const hookOpts = useMemo(
    () => ({ period, task: task || undefined }),
    [period, task],
  );
  const live = useMetrics(hookOpts);
  const metrics = metricsOverride ?? live.data;
  const loading = metricsOverride ? false : live.loading;
  const error = metricsOverride ? null : (live as any).error ?? null;

  const calibration: CalibrationBucket[] = useMemo(
    () =>
      isCalibrationArray(metrics?.confidence_calibration)
        ? (metrics!.confidence_calibration as CalibrationBucket[])
        : [],
    [metrics],
  );

  const taskRows: TaskBreakdownRow[] = useMemo(() => {
    if (!metrics?.breakdown_by_task) return [];
    return Object.entries(metrics.breakdown_by_task).map(([taskName, r]) => ({
      task: taskName,
      precision: (r as any).precision ?? 0,
      recall: (r as any).recall ?? 0,
      mean_error: (r as any).mean_error ?? 0,
      n: (r as any).n ?? (r as any).sample_size ?? 0,
    }));
  }, [metrics]);

  const actionCorrect = useMemo(
    () => deriveActionCorrectRate(metrics?.breakdown_by_task ?? {}),
    [metrics],
  );
  const meanCost = deriveMeanCostPerClaim(metrics);

  // Filter task options: union of "all" + the keys present in the
  // breakdown. We can't enumerate target_stages a priori without an
  // extra endpoint, so we derive from the current payload.
  const taskOptions = useMemo(() => {
    const keys = Object.keys(metrics?.breakdown_by_task ?? {});
    return ['', ...keys];
  }, [metrics]);

  return (
    <div className="flex flex-col gap-6 p-6 bg-slate-50 dark:bg-slate-950 min-h-screen text-slate-900 dark:text-slate-100">
      {offline && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-semibold">DEMO</span> · Mock data, no backend calls.
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Intelligence eval</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Honest scoreboard for the adjudication engine — prediction accuracy,
          confidence calibration, and per-task error trends.
        </p>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Period
          </label>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as EvalMetricsPeriod)}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm"
          >
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Task
          </label>
          <select
            value={task}
            onChange={(e) => setTask(e.target.value)}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm"
          >
            {taskOptions.map((t) => (
              <option key={t || 'all'} value={t}>
                {t || 'All tasks'}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Hospital
          </label>
          <select
            value={hospitalId}
            onChange={(e) => setHospitalId(e.target.value)}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm"
            disabled={hospitals.length === 0}
          >
            <option value="">All hospitals</option>
            {hospitals.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>

        <div className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          {loading ? (
            <span>Loading…</span>
          ) : error ? (
            <span className="text-red-600 dark:text-red-400">
              Failed to load metrics
            </span>
          ) : metrics ? (
            <span>
              {metrics.sample_size?.toLocaleString('en-IN') ?? 0} predictions in window
            </span>
          ) : (
            <span>No data</span>
          )}
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="Prediction accuracy"
          value={
            metrics ? `${(metrics.prediction_accuracy_pct ?? 0).toFixed(1)}%` : '—'
          }
          sub={
            metrics
              ? `n=${(metrics.sample_size ?? 0).toLocaleString('en-IN')}`
              : undefined
          }
          tone={
            metrics
              ? metrics.prediction_accuracy_pct >= 80
                ? 'good'
                : metrics.prediction_accuracy_pct >= 65
                  ? 'warn'
                  : 'bad'
              : 'default'
          }
        />
        <KpiCard
          label="Sample size"
          value={
            metrics ? (metrics.sample_size ?? 0).toLocaleString('en-IN') : '—'
          }
          sub="Resolved predictions"
        />
        <KpiCard
          label="Mean cost / claim"
          value={meanCost != null ? `₹${meanCost.toFixed(2)}` : '—'}
          sub="LLM + reasoning"
        />
        <KpiCard
          label="Action-correct rate"
          value={
            actionCorrect.n > 0
              ? `${(actionCorrect.rate * 100).toFixed(1)}%`
              : '—'
          }
          sub={`n=${actionCorrect.n.toLocaleString('en-IN')}`}
          tone={
            actionCorrect.n === 0
              ? 'default'
              : actionCorrect.rate >= 0.8
                ? 'good'
                : actionCorrect.rate >= 0.65
                  ? 'warn'
                  : 'bad'
          }
        />
      </div>

      {/* Calibration plot */}
      <section className="flex flex-col gap-2 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Confidence calibration</h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Predicted readiness vs. actual outcome rate by 20-pt bucket
          </span>
        </header>
        <ConfidenceCalibrationChart buckets={calibration} />
      </section>

      {/* Weekly trend */}
      <section className="flex flex-col gap-2 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Weekly trend</h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Prediction accuracy, ISO week
          </span>
        </header>
        <WeeklyTrendChart
          points={(metrics?.weekly_trend ?? []).map((p) => ({
            week_start: p.week_start,
            accuracy_pct: p.accuracy_pct,
            n: (p as any).n ?? (p as any).sample_size ?? 0,
          }))}
        />
      </section>

      {/* Per-task breakdown */}
      <section className="flex flex-col gap-2">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Per-task breakdown</h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Precision = action correct · Recall = query prediction correct
          </span>
        </header>
        <TaskBreakdownTable rows={taskRows} />
      </section>
    </div>
  );
};

export default EvalDashboard;
