/**
 * Sprint 3, Wave 3C — AdjudicationView demo page.
 *
 * Not routed. Render ad-hoc by temporarily importing it from App.tsx
 * during review:
 *
 *   import AdjudicationViewDemo from '@/pages/dev/AdjudicationViewDemo';
 *
 * Uses a fixed mock report so the layout can be validated without the
 * backend running.
 */

import React, { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AdjudicationView } from '@/pages/hospital/AdjudicationView';
import type { AdjudicationReport } from '@/hooks/intelligence';

const MOCK_REPORT_READY: AdjudicationReport = {
  id: 'rpt-001',
  claim_id: '11111111-1111-4111-8111-111111111111',
  readiness: 0.92,
  recommended_action: 'file_now',
  blocking_gaps: [],
  warnings: [
    {
      id: 'w-1',
      message: 'Discharge summary signed by junior resident — may need consultant counter-signature.',
      severity: 'medium',
      source: 'rule:pre_auth.discharge_summary.signer',
    },
  ],
  predicted_outcome: {
    amount: 84_500,
    p_approval: 0.78,
    p_partial: 0.17,
    p_query: 0.05,
    expected_value_inr: 76_300,
  },
  citations: {
    rule_ids: ['rule-discharge-001', 'rule-stay-002', 'rule-meds-007'],
    pattern_ids: ['pat-cataract-rsby-01'],
    case_ids: ['case-2024-Q4-117', 'case-2024-Q4-203'],
  },
  generated_at: '2026-05-18T09:42:00.000Z',
};

const MOCK_REPORT_BLOCKED: AdjudicationReport = {
  id: 'rpt-002',
  claim_id: '22222222-2222-4222-8222-222222222222',
  readiness: 0.34,
  recommended_action: 'request_doc',
  blocking_gaps: [
    {
      id: 'gap-1',
      doc_category: 'discharge_summary',
      severity: 'blocker',
      message: 'Discharge summary not yet uploaded.',
      fix_hint: 'Upload the consultant-signed discharge summary to the patient documents tab.',
    },
    {
      id: 'gap-2',
      doc_category: 'final_bill',
      severity: 'blocker',
      message: 'Final bill missing line-item breakdown for room rent.',
      fix_hint: 'Re-upload the final bill with itemised room rent per day.',
    },
    {
      id: 'gap-3',
      field: 'patient.kyc.aadhaar',
      severity: 'blocker',
      message: 'Aadhaar verification not on file.',
    },
  ],
  warnings: [],
  predicted_outcome: null as any,
  citations: {
    rule_ids: ['rule-discharge-001', 'rule-bill-line-items-003'],
    pattern_ids: [],
    case_ids: [],
  },
  generated_at: '2026-05-18T08:15:00.000Z',
};

const AdjudicationViewDemo: React.FC = () => {
  const [variant, setVariant] = useState<'ready' | 'blocked' | 'empty'>('ready');
  const report =
    variant === 'ready'
      ? MOCK_REPORT_READY
      : variant === 'blocked'
        ? MOCK_REPORT_BLOCKED
        : null;

  return (
    <div>
      <div className="bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 px-6 py-2 text-xs flex items-center gap-3">
        <span className="font-semibold text-amber-900 dark:text-amber-200">DEMO</span>
        <span className="text-amber-700 dark:text-amber-300">
          Mock data — no network calls. Toggle variants:
        </span>
        {(['ready', 'blocked', 'empty'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setVariant(v)}
            className={`px-2 py-0.5 rounded text-[11px] font-medium ${
              variant === v
                ? 'bg-amber-600 text-white'
                : 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-800'
            }`}
          >
            {v}
          </button>
        ))}
      </div>
      <MemoryRouter
        initialEntries={[
          `/hospital/hospital-demo/patients/${report?.claim_id ?? '00000000-0000-0000-0000-000000000000'}/adjudication`,
        ]}
      >
        <Routes>
          <Route
            path="/hospital/:hospitalId/patients/:patientId/adjudication"
            element={
              <AdjudicationView reportOverride={report} offline />
            }
          />
        </Routes>
      </MemoryRouter>
    </div>
  );
};

export default AdjudicationViewDemo;
