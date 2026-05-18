/**
 * Wave 5B — Cost Dashboard dev demo page.
 *
 * Not routed. Render ad-hoc during review by temporarily importing it
 * from App.tsx:
 *
 *   import CostDashboardDemo from '@/pages/dev/CostDashboardDemo';
 *
 * Drives the CostDashboard with hard-coded mock data across the four
 * states the dashboard needs to handle gracefully:
 *
 *   - empty     : no spend at all, no claims processed
 *   - normal    : healthy spend, breakers well under cap, no alerts
 *   - near cap  : two hospitals at 70-95% of daily cap, warning alert
 *   - over cap  : one hospital tripped, critical + warning alerts firing
 *
 * The hook is faked via the `useMeter` injection prop so we never make
 * a real network call from this demo page.
 */

import React, { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { CostDashboard } from '@/pages/superadmin/CostDashboard';
import type {
  CircuitBreakerEntry,
  HospitalOption,
} from '@/pages/superadmin/CostDashboard';
import type { CostMeterData } from '@/hooks/intelligence/useCostMeter';
import type { CostAlertRow } from '@/pages/superadmin/CostDashboard/AlertsTable';
import type { TopExpensiveClaim } from '@/pages/superadmin/CostDashboard/TopExpensiveClaimsTable';

type DemoState = 'empty' | 'normal' | 'nearCap' | 'overCap';

interface Fixture {
  meter: CostMeterData | null;
  hospitals: HospitalOption[];
  breakers: CircuitBreakerEntry[];
  alerts: CostAlertRow[];
  topClaims: TopExpensiveClaim[];
}

/** State 1: empty — no spend at all. */
const EMPTY: Fixture = {
  meter: {
    spend_inr: 0,
    claim_count: 0,
    avg_per_claim_inr: 0,
    breakdown_by_task: {},
    breakdown_by_model: {},
    tier_escalation_rate: 0,
    cache_hit_rate: 0,
    p95_per_claim_inr: 0,
    alerts: [],
  },
  hospitals: [
    { id: 'h-001', name: 'Apollo Bengaluru' },
    { id: 'h-002', name: 'Manipal Whitefield' },
  ],
  breakers: [],
  alerts: [],
  topClaims: [],
};

/** State 2: normal — healthy spend, in-range KPIs, no alerts. */
const NORMAL: Fixture = {
  meter: {
    // Per-claim avg ~ ₹22 → green; P95 ~ ₹48 → green.
    spend_inr: 18_420,
    claim_count: 834,
    avg_per_claim_inr: 22.1,
    p95_per_claim_inr: 48,
    breakdown_by_task: {
      DocExtractor: 6_240,
      EmailExtractor: 3_180,
      DocSegmenter: 2_810,
      ReasoningAgent: 4_010,
      AdjudicationReport: 1_640,
      PatternMiner: 540,
    },
    breakdown_by_model: {
      'claude-haiku-3.5': 9_410,
      'claude-sonnet-4.5': 7_180,
      'voyage-embed-3': 1_830,
    },
    tier_escalation_rate: 0.06,
    cache_hit_rate: 0.71,
    alerts: [],
  },
  hospitals: [
    { id: 'h-001', name: 'Apollo Bengaluru' },
    { id: 'h-002', name: 'Manipal Whitefield' },
    { id: 'h-003', name: 'Fortis Bannerghatta' },
  ],
  breakers: [
    { hospital_id: 'h-001', hospital_name: 'Apollo Bengaluru', cap_inr: 5_000, spent_inr: 1_180 },
    { hospital_id: 'h-002', hospital_name: 'Manipal Whitefield', cap_inr: 5_000, spent_inr: 2_240 },
    { hospital_id: 'h-003', hospital_name: 'Fortis Bannerghatta', cap_inr: 5_000, spent_inr: 980 },
  ],
  alerts: [],
  topClaims: [
    {
      claim_id: '11111111-1111-4111-8111-111111111111',
      label: 'CL-2026-00417 · R. Verma',
      hospital_name: 'Apollo Bengaluru',
      spend_inr: 188,
      llm_calls: 41,
      escalations: 2,
    },
    {
      claim_id: '22222222-2222-4222-8222-222222222222',
      label: 'CL-2026-00382 · S. Iyer',
      hospital_name: 'Manipal Whitefield',
      spend_inr: 162,
      llm_calls: 36,
      escalations: 1,
    },
    {
      claim_id: '33333333-3333-4333-8333-333333333333',
      label: 'CL-2026-00355 · A. Khan',
      hospital_name: 'Fortis Bannerghatta',
      spend_inr: 144,
      llm_calls: 33,
      escalations: 0,
    },
  ],
};

/** State 3: near cap — amber band, warning alert, P95 elevated. */
const NEAR_CAP: Fixture = {
  meter: {
    // Avg ~ ₹48 → amber; P95 ~ ₹98 → amber; escalation 0.18 → amber.
    spend_inr: 41_280,
    claim_count: 860,
    avg_per_claim_inr: 48,
    p95_per_claim_inr: 98,
    breakdown_by_task: {
      DocExtractor: 14_810,
      ReasoningAgent: 12_220,
      EmailExtractor: 6_180,
      DocSegmenter: 4_710,
      AdjudicationReport: 2_640,
      PatternMiner: 720,
    },
    breakdown_by_model: {
      'claude-sonnet-4.5': 24_870,
      'claude-haiku-3.5': 13_910,
      'voyage-embed-3': 2_500,
    },
    tier_escalation_rate: 0.18,
    cache_hit_rate: 0.41,
    alerts: [
      {
        id: 'a-1',
        severity: 'warning',
        message: 'Daily cap at 84% for Apollo Bengaluru.',
        triggered_at: '2026-05-18T11:04:00.000Z',
      },
    ],
  },
  hospitals: NORMAL.hospitals,
  breakers: [
    { hospital_id: 'h-001', hospital_name: 'Apollo Bengaluru', cap_inr: 5_000, spent_inr: 4_210 },
    { hospital_id: 'h-002', hospital_name: 'Manipal Whitefield', cap_inr: 5_000, spent_inr: 3_780 },
    { hospital_id: 'h-003', hospital_name: 'Fortis Bannerghatta', cap_inr: 5_000, spent_inr: 1_640 },
  ],
  alerts: [
    {
      id: 'a-1',
      hospital_id: 'h-001',
      hospital_name: 'Apollo Bengaluru',
      alert_kind: 'daily_cap_warning',
      severity: 'warning',
      threshold_inr: 4_000,
      current_inr: 4_210,
      fired_at: '2026-05-18T11:04:00.000Z',
    },
  ],
  topClaims: [
    {
      claim_id: '44444444-4444-4444-8444-444444444444',
      label: 'CL-2026-00501 · D. Rao',
      hospital_name: 'Apollo Bengaluru',
      spend_inr: 412,
      llm_calls: 78,
      escalations: 6,
    },
    {
      claim_id: '55555555-5555-4555-8555-555555555555',
      label: 'CL-2026-00498 · M. Patel',
      hospital_name: 'Manipal Whitefield',
      spend_inr: 318,
      llm_calls: 62,
      escalations: 3,
    },
    {
      claim_id: '66666666-6666-4666-8666-666666666666',
      label: 'CL-2026-00477 · K. Nair',
      hospital_name: 'Fortis Bannerghatta',
      spend_inr: 268,
      llm_calls: 51,
      escalations: 2,
    },
  ],
};

/** State 4: over cap — one breaker tripped, critical + warning alerts. */
const OVER_CAP: Fixture = {
  meter: {
    // Avg ~ ₹78 → red; P95 ~ ₹164 → red; escalation 0.31 → red; cache 0.18 → red.
    spend_inr: 68_410,
    claim_count: 877,
    avg_per_claim_inr: 78,
    p95_per_claim_inr: 164,
    breakdown_by_task: {
      ReasoningAgent: 28_840,
      DocExtractor: 16_410,
      EmailExtractor: 8_120,
      AdjudicationReport: 7_810,
      DocSegmenter: 5_680,
      PatternMiner: 1_550,
    },
    breakdown_by_model: {
      'claude-sonnet-4.5': 41_220,
      'claude-opus-4.1': 18_410,
      'claude-haiku-3.5': 6_780,
      'voyage-embed-3': 2_000,
    },
    tier_escalation_rate: 0.31,
    cache_hit_rate: 0.18,
    alerts: [
      {
        id: 'a-2',
        severity: 'critical',
        message: 'Daily cap tripped for Apollo Bengaluru.',
        triggered_at: '2026-05-18T14:21:00.000Z',
      },
      {
        id: 'a-3',
        severity: 'warning',
        message: 'Manipal Whitefield approaching cap (92%).',
        triggered_at: '2026-05-18T13:58:00.000Z',
      },
    ],
  },
  hospitals: NORMAL.hospitals,
  breakers: [
    {
      hospital_id: 'h-001',
      hospital_name: 'Apollo Bengaluru',
      cap_inr: 5_000,
      spent_inr: 5_240,
      tripped: true,
    },
    { hospital_id: 'h-002', hospital_name: 'Manipal Whitefield', cap_inr: 5_000, spent_inr: 4_610 },
    { hospital_id: 'h-003', hospital_name: 'Fortis Bannerghatta', cap_inr: 5_000, spent_inr: 2_180 },
  ],
  alerts: [
    {
      id: 'a-2',
      hospital_id: 'h-001',
      hospital_name: 'Apollo Bengaluru',
      alert_kind: 'daily_cap_tripped',
      severity: 'critical',
      threshold_inr: 5_000,
      current_inr: 5_240,
      fired_at: '2026-05-18T14:21:00.000Z',
    },
    {
      id: 'a-3',
      hospital_id: 'h-002',
      hospital_name: 'Manipal Whitefield',
      alert_kind: 'daily_cap_warning',
      severity: 'warning',
      threshold_inr: 4_500,
      current_inr: 4_610,
      fired_at: '2026-05-18T13:58:00.000Z',
    },
  ],
  topClaims: [
    {
      claim_id: '77777777-7777-4777-8777-777777777777',
      label: 'CL-2026-00612 · V. Joshi',
      hospital_name: 'Apollo Bengaluru',
      spend_inr: 1_240,
      llm_calls: 184,
      escalations: 22,
    },
    {
      claim_id: '88888888-8888-4888-8888-888888888888',
      label: 'CL-2026-00604 · P. Reddy',
      hospital_name: 'Manipal Whitefield',
      spend_inr: 980,
      llm_calls: 142,
      escalations: 14,
    },
    {
      claim_id: '99999999-9999-4999-8999-999999999999',
      label: 'CL-2026-00591 · L. Banerjee',
      hospital_name: 'Apollo Bengaluru',
      spend_inr: 712,
      llm_calls: 108,
      escalations: 9,
    },
  ],
};

const FIXTURES: Record<DemoState, Fixture> = {
  empty: EMPTY,
  normal: NORMAL,
  nearCap: NEAR_CAP,
  overCap: OVER_CAP,
};

const STATE_LABELS: Record<DemoState, string> = {
  empty: 'Empty (no spend)',
  normal: 'Normal',
  nearCap: 'Near cap (amber)',
  overCap: 'Over cap (red)',
};

/**
 * Build a fake useCostMeter that returns one of the fixtures. Same
 * signature as the real hook, but never calls the network.
 */
function makeFakeUseMeter(fixture: Fixture) {
  return function useFakeMeter(_opts?: { hospitalId?: string; period: any }) {
    return {
      data: fixture.meter,
      loading: false,
      error: null as Error | null,
      refetch: async () => ({ data: fixture.meter } as any),
    };
  } as any;
}

const CostDashboardDemo: React.FC = () => {
  const [state, setState] = useState<DemoState>('normal');
  const fixture = FIXTURES[state];
  const fakeHook = React.useMemo(() => makeFakeUseMeter(fixture), [fixture]);

  return (
    <MemoryRouter>
      <div className="min-h-screen bg-slate-100 dark:bg-slate-950">
        <div className="max-w-7xl mx-auto px-4 pt-4">
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-200">
              Demo state:
            </span>
            {(Object.keys(STATE_LABELS) as DemoState[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setState(k)}
                className={
                  state === k
                    ? 'rounded-md px-2 py-1 bg-indigo-600 text-white dark:bg-indigo-500'
                    : 'rounded-md px-2 py-1 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-900'
                }
              >
                {STATE_LABELS[k]}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400">
              Mock data only — no network calls.
            </span>
          </div>
        </div>
        <CostDashboard
          useMeter={fakeHook}
          hospitals={fixture.hospitals}
          circuitBreakers={fixture.breakers}
          alerts={fixture.alerts}
          topClaims={fixture.topClaims}
        />
      </div>
    </MemoryRouter>
  );
};

export default CostDashboardDemo;
