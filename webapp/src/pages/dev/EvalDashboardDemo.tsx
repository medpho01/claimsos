/**
 * Sprint 4, Wave 5A — EvalDashboard demo page.
 *
 * Not routed. Renders the EvalDashboard with a fixed mock payload so the
 * KPI strip, calibration plot, weekly trend and task breakdown can all
 * be validated without the backend.
 *
 * The mock is shaped exactly like the live `useEvalMetrics` hook return
 * plus the extra `cost_per_claim` slice the service actually surfaces but
 * the hook's typedef hasn't been tightened to (yet).
 */

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { EvalDashboard } from '@/pages/superadmin/EvalDashboard';

const MOCK_METRICS = {
  prediction_accuracy_pct: 81.4,
  sample_size: 1284,
  breakdown_by_task: {
    pre_auth: { precision: 0.86, recall: 0.78, mean_error: 1450, n: 720 },
    enhancement: { precision: 0.74, recall: 0.66, mean_error: -890, n: 312 },
    final_filing: { precision: 0.69, recall: 0.61, mean_error: 2100, n: 184 },
    discharge_filing: { precision: 0.82, recall: 0.75, mean_error: -340, n: 68 },
  },
  confidence_calibration: [
    { bucket_low: 0, bucket_high: 20, predicted_rate: 0.1, actual_rate: 0.12, n: 42 },
    { bucket_low: 20, bucket_high: 40, predicted_rate: 0.3, actual_rate: 0.36, n: 78 },
    { bucket_low: 40, bucket_high: 60, predicted_rate: 0.5, actual_rate: 0.58, n: 156 },
    { bucket_low: 60, bucket_high: 80, predicted_rate: 0.7, actual_rate: 0.73, n: 412 },
    { bucket_low: 80, bucket_high: 100, predicted_rate: 0.9, actual_rate: 0.86, n: 596 },
  ],
  weekly_trend: [
    { week_start: '2026-04-06', accuracy_pct: 72.4, n: 184 },
    { week_start: '2026-04-13', accuracy_pct: 75.1, n: 211 },
    { week_start: '2026-04-20', accuracy_pct: 78.9, n: 244 },
    { week_start: '2026-04-27', accuracy_pct: 79.6, n: 271 },
    { week_start: '2026-05-04', accuracy_pct: 80.8, n: 298 },
    { week_start: '2026-05-11', accuracy_pct: 81.4, n: 76 },
  ],
  cost_per_claim: { mean: 11.42, p50: 9.5, p95: 21.8 },
} as any;

const MOCK_HOSPITALS = [
  { id: 'hosp-1', name: 'Sadbhawana Hospital' },
  { id: 'hosp-2', name: 'Sunrise Medical Centre' },
  { id: 'hosp-3', name: 'Pune Sevasadan' },
];

const EvalDashboardDemo: React.FC = () => {
  return (
    <MemoryRouter initialEntries={['/superadmin/eval']}>
      <EvalDashboard
        metricsOverride={MOCK_METRICS}
        hospitals={MOCK_HOSPITALS}
        offline
      />
    </MemoryRouter>
  );
};

export default EvalDashboardDemo;
