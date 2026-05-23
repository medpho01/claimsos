/**
 * Sprint 3, Wave 3C — ActionQueue demo page.
 *
 * Not routed. Renders the ActionQueue page with a fixed mock list so the
 * layout + decline dialog can be validated without the backend.
 */

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ActionQueue } from '@/pages/hospital/ActionQueue';
import type { ClaimAction } from '@/hooks/intelligence';

const MOCK_ACTIONS: ClaimAction[] = [
  {
    id: 'act-001',
    claim_id: '11111111-1111-4111-8111-111111111111',
    kind: 'request_doc',
    target: 'whatsapp:120363111111111111@g.us',
    payload: {
      title: 'Document required — discharge summary',
      summary: 'Discharge summary not yet uploaded for IPD #aabbccdd.',
      fix_hint: 'Upload the consultant-signed discharge summary to patient documents.',
      deep_link: '/hospital/hospital-demo/patients/11111111-1111-4111-8111-111111111111',
      panel_name: 'Sadbhawana',
    },
    status: 'pending',
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: 'act-002',
    claim_id: '22222222-2222-4222-8222-222222222222',
    kind: 'approval_request',
    target: 'in_app:user-admin',
    payload: {
      title: 'Approval requested',
      summary: 'Claim ready for approval — readiness 95%.',
      deep_link: '/hospital/hospital-demo/patients/22222222-2222-4222-8222-222222222222',
    },
    status: 'pending',
    created_at: new Date(Date.now() - 35 * 60_000).toISOString(),
  },
  {
    id: 'act-003',
    claim_id: '33333333-3333-4333-8333-333333333333',
    kind: 'notify_ops',
    target: 'in_app:user-admin',
    payload: {
      title: 'Escalation — human review needed',
      summary: 'Adjudication could not auto-resolve (readiness 41%).',
      priority: 'high',
      deep_link: '/hospital/hospital-demo/patients/33333333-3333-4333-8333-333333333333',
    },
    status: 'pending',
    created_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  },
];

const ActionQueueDemo: React.FC = () => {
  return (
    <div>
      <div className="bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 px-6 py-2 text-xs">
        <span className="font-semibold text-amber-900 dark:text-amber-200">DEMO</span>
        <span className="ml-2 text-amber-700 dark:text-amber-300">
          Mock data — Ack/Decline are no-ops.
        </span>
      </div>
      <MemoryRouter initialEntries={['/hospital/actions']}>
        <ActionQueue itemsOverride={MOCK_ACTIONS} offline />
      </MemoryRouter>
    </div>
  );
};

export default ActionQueueDemo;
