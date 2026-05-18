import React, { useMemo, useState } from 'react';
import { useCostMeter } from '@/hooks/intelligence/useCostMeter';
import type { CostMeterPeriod, CostMeterData } from '@/hooks/intelligence/useCostMeter';
import { CostKpiCard } from './CostKpiCard';
import type { CostKpiTone } from './CostKpiCard';
import { TaskBreakdownChart } from './TaskBreakdownChart';
import { ModelBreakdownChart } from './ModelBreakdownChart';
import { CircuitBreakerRow } from './CircuitBreakerRow';
import { AlertsTable } from './AlertsTable';
import type { CostAlertRow } from './AlertsTable';
import { TopExpensiveClaimsTable } from './TopExpensiveClaimsTable';
import type { TopExpensiveClaim } from './TopExpensiveClaimsTable';

/**
 * Wave 5B — Cost Dashboard (Superadmin).
 *
 * TODO(routes): mount at /superadmin/cost once the parent routing tree
 * is ready to accept new entries. The mount is intentionally not added
 * here so this PR doesn't touch the central routes file.
 *
 * Layout (top → bottom):
 *   1. Filter bar (period, hospital, refresh)
 *   2. KPI strip (total spend, claims processed, avg/claim, P95/claim)
 *   3. 2-col breakdown grid (by task, by model)
 *   4. Tier-escalation + cache-hit stat tiles
 *   5. Circuit-breaker panel (per-hospital cap usage)
 *   6. Active alerts table
 *   7. Top-3 expensive claims (link to adjudication)
 *
 * Data:
 *   - `useCostMeter` provides everything in section 2/3/4 plus alert
 *     stubs. Sections 5 and 7 plus enriched alert rows (kind, threshold,
 *     hospital, current spend) need backend extensions; see prop-types
 *     on AlertsTable / TopExpensiveClaimsTable. For now the dashboard
 *     accepts the richer slices through optional props so the demo
 *     page can drive them.
 */

export interface CircuitBreakerEntry {
  hospital_id: string;
  hospital_name: string;
  cap_inr: number;
  spent_inr: number;
  tripped?: boolean;
}

export interface HospitalOption {
  id: string;
  name: string;
}

export interface CostDashboardProps {
  /** Optional override hook injection — defaults to live useCostMeter. */
  useMeter?: typeof useCostMeter;
  /**
   * Optional pre-populated hospital list for the filter. If absent, a
   * single "All hospitals" option is shown (live data won't be fetched
   * here — wire from a parent layout that already has the list).
   */
  hospitals?: HospitalOption[];
  /**
   * Optional list of per-hospital cap utilisations for the circuit-
   * breaker panel. Not derivable from the cost-meter payload.
   */
  circuitBreakers?: CircuitBreakerEntry[];
  /** Optional enriched alert rows. */
  alerts?: CostAlertRow[];
  /** Optional top-N expensive claims for the bottom table. */
  topClaims?: TopExpensiveClaim[];
}

const PERIOD_OPTIONS: { value: CostMeterPeriod; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' },
];

function formatInr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2)} Cr`;
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2)} L`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(1)}k`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/**
 * Tone helpers — encode the "within target / approaching / over"
 * semantics for each KPI. Thresholds are intentionally simple
 * heuristics; the eventual product spec may push these into config.
 */
function toneForAvgPerClaim(avg: number): CostKpiTone {
  if (!Number.isFinite(avg) || avg <= 0) return 'neutral';
  if (avg < 30) return 'green';
  if (avg < 60) return 'amber';
  return 'red';
}

function toneForP95(p95: number): CostKpiTone {
  if (!Number.isFinite(p95) || p95 <= 0) return 'neutral';
  if (p95 < 60) return 'green';
  if (p95 < 120) return 'amber';
  return 'red';
}

function toneForEscalation(rate: number): CostKpiTone {
  if (!Number.isFinite(rate)) return 'neutral';
  if (rate < 0.1) return 'green';
  if (rate < 0.25) return 'amber';
  return 'red';
}

function toneForCacheHit(rate: number): CostKpiTone {
  if (!Number.isFinite(rate)) return 'neutral';
  if (rate >= 0.6) return 'green';
  if (rate >= 0.3) return 'amber';
  return 'red';
}

const ALL_HOSPITALS = '__all__';

export const CostDashboard: React.FC<CostDashboardProps> = ({
  useMeter = useCostMeter,
  hospitals,
  circuitBreakers,
  alerts,
  topClaims,
}) => {
  const [period, setPeriod] = useState<CostMeterPeriod>('month');
  const [hospitalId, setHospitalId] = useState<string>(ALL_HOSPITALS);

  const { data, loading, error, refetch } = useMeter({
    hospitalId: hospitalId === ALL_HOSPITALS ? undefined : hospitalId,
    period,
  });

  const meter: CostMeterData | null = data ?? null;

  const totals = useMemo(() => {
    return {
      spend: meter?.spend_inr ?? 0,
      claims: meter?.claim_count ?? 0,
      avgPerClaim: meter?.avg_per_claim_inr ?? 0,
      p95: meter?.p95_per_claim_inr ?? 0,
      escalation: meter?.tier_escalation_rate ?? 0,
      cacheHit: meter?.cache_hit_rate ?? 0,
    };
  }, [meter]);

  const filteredBreakers = useMemo(() => {
    if (!circuitBreakers) return [] as CircuitBreakerEntry[];
    if (hospitalId === ALL_HOSPITALS) return circuitBreakers;
    return circuitBreakers.filter((b) => b.hospital_id === hospitalId);
  }, [circuitBreakers, hospitalId]);

  const filteredAlerts = useMemo(() => {
    if (!alerts) return [] as CostAlertRow[];
    if (hospitalId === ALL_HOSPITALS) return alerts;
    return alerts.filter((a) => a.hospital_id === hospitalId);
  }, [alerts, hospitalId]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">
              LLM cost dashboard
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Spend, throughput, and circuit-breaker health for the intelligence layer.
            </p>
          </div>
        </header>

        {/* 1. Filter bar */}
        <section
          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 flex flex-wrap items-center gap-3"
          aria-label="Filters"
        >
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
            Period
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as CostMeterPeriod)}
              className="ml-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
            >
              {PERIOD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
            Hospital
            <select
              value={hospitalId}
              onChange={(e) => setHospitalId(e.target.value)}
              className="ml-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
            >
              <option value={ALL_HOSPITALS}>All hospitals</option>
              {(hospitals ?? []).map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>

          <div className="ml-auto flex items-center gap-2">
            {loading && (
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                Loading…
              </span>
            )}
            {error && (
              <span className="text-[11px] text-red-700 dark:text-red-300">
                {error.message}
              </span>
            )}
            <button
              type="button"
              onClick={() => refetch()}
              className="text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1 hover:bg-slate-50 dark:hover:bg-slate-900 text-slate-700 dark:text-slate-200"
            >
              Refresh
            </button>
          </div>
        </section>

        {/* 2. KPI strip */}
        <section
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
          aria-label="Key cost metrics"
        >
          <CostKpiCard
            label="Total spend"
            value={formatInr(totals.spend)}
            sublabel={`Period: ${period}`}
            tone={totals.spend > 0 ? 'green' : 'neutral'}
          />
          <CostKpiCard
            label="Claims processed"
            value={totals.claims.toLocaleString('en-IN')}
            sublabel={totals.claims === 0 ? 'No claims in window' : 'in window'}
            tone="neutral"
          />
          <CostKpiCard
            label="Avg cost / claim"
            value={formatInr(totals.avgPerClaim)}
            sublabel="Target: < ₹30"
            tone={toneForAvgPerClaim(totals.avgPerClaim)}
          />
          <CostKpiCard
            label="P95 cost / claim"
            value={formatInr(totals.p95)}
            sublabel="Ceiling: ₹120"
            tone={toneForP95(totals.p95)}
          />
        </section>

        {/* 3. Breakdown grid */}
        <section
          className="grid grid-cols-1 lg:grid-cols-2 gap-3"
          aria-label="Cost breakdowns"
        >
          <TaskBreakdownChart data={meter?.breakdown_by_task ?? {}} />
          <ModelBreakdownChart data={meter?.breakdown_by_model ?? {}} />
        </section>

        {/* 4. Stat tiles (escalation + cache hit) */}
        <section
          className="grid grid-cols-1 sm:grid-cols-2 gap-3"
          aria-label="Tier escalation and cache hit"
        >
          <CostKpiCard
            label="Tier escalation rate"
            value={`${(totals.escalation * 100).toFixed(1)}%`}
            sublabel="Calls that fell back to a more expensive model"
            tone={toneForEscalation(totals.escalation)}
          />
          <CostKpiCard
            label="Cache hit rate"
            value={`${(totals.cacheHit * 100).toFixed(1)}%`}
            sublabel="Higher is cheaper"
            tone={toneForCacheHit(totals.cacheHit)}
          />
        </section>

        {/* 5. Circuit breakers */}
        <section
          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4"
          aria-label="Circuit breakers"
        >
          <header className="flex items-baseline justify-between gap-2 mb-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              Circuit breakers
            </h3>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              Per-hospital daily cap utilisation
            </span>
          </header>
          {filteredBreakers.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No cap data available.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {filteredBreakers.map((b) => (
                <CircuitBreakerRow
                  key={b.hospital_id}
                  hospitalId={b.hospital_id}
                  hospitalName={b.hospital_name}
                  capInr={b.cap_inr}
                  spentInr={b.spent_inr}
                  tripped={b.tripped}
                />
              ))}
            </div>
          )}
        </section>

        {/* 6. Alerts */}
        <section aria-label="Active alerts">
          <AlertsTable rows={filteredAlerts} />
        </section>

        {/* 7. Top expensive claims */}
        <section aria-label="Top expensive claims">
          <TopExpensiveClaimsTable rows={topClaims ?? []} limit={3} />
        </section>
      </div>
    </div>
  );
};

export default CostDashboard;
