import React, { useState } from 'react';
import {
  AiDraftDrawer,
  AiDraftPill,
  AiDraftExtractionEditor,
} from '@/components/intelligence/AiDraftDrawer';
import type { AiDraft } from '@/hooks/intelligence/useAiDrafts';

/**
 * Wave 2D dev page — AI Draft Drawer + Pill + Extraction Editor.
 *
 * Not routed. Mount temporarily for visual review during design QA.
 */

const baseSource = {
  subject: 'Re: Pre-auth #PA-9923 — Mr. Suresh K.',
  from: 'claims@carehealthinsurance.com',
  received_at: new Date(Date.now() - 35 * 60_000).toISOString(),
  body:
    'Dear Hospital,\n\nWith reference to your pre-auth request, we have approved an initial sum ' +
    'of INR 1,25,000 for the above patient under Single Standard room category. ' +
    'Approval is valid from 16-May-2026 to 22-May-2026.\n\nFor any extension, please share ' +
    'updated clinical notes 24 hrs in advance.\n\nRegards,\nCare Health Claims Team',
  attachments: [
    { id: 'a1', filename: 'PreAuth-Approval-PA-9923.pdf', size_bytes: 184_320 },
    { id: 'a2', filename: 'Coverage-Letter.pdf', size_bytes: 92_180 },
  ],
};

const drafts: Record<string, AiDraft> = {
  approved: {
    id: 'demo-approved',
    claim_id: 'claim-demo',
    kind: 'approved',
    confidence: 0.92,
    status: 'pending_review',
    created_at: new Date().toISOString(),
    llm_provider: 'anthropic',
    llm_model: 'claude-opus-4-7',
    extracted_payload: {
      amount_inr: 125000,
      room_category: 'Single Standard',
      validity_from: '2026-05-16',
      validity_to: '2026-05-22',
      notes: 'Pre-auth approved with standard validity window.',
      source: baseSource,
    },
  },
  queried: {
    id: 'demo-queried',
    claim_id: 'claim-demo',
    kind: 'queried',
    confidence: 0.71,
    status: 'pending_review',
    created_at: new Date().toISOString(),
    llm_provider: 'anthropic',
    llm_model: 'claude-opus-4-7',
    extracted_payload: {
      queries: [
        {
          description: 'Missing latest investigation report from 14-May-2026',
          deficiency_type: 'INVESTIGATION_REPORT',
          doc_requested: 'CBC + LFT reports dated 14-May',
          deadline: '2026-05-20',
        },
        {
          description: 'Discharge summary appears incomplete',
          deficiency_type: 'DISCHARGE_SUMMARY',
          doc_requested: 'Signed discharge summary',
          deadline: '2026-05-21',
        },
      ],
      source: { ...baseSource, subject: 'Query: PA-9923 — Documents required' },
    },
  },
  rejected: {
    id: 'demo-rejected',
    claim_id: 'claim-demo',
    kind: 'rejected',
    confidence: 0.55,
    status: 'pending_review',
    created_at: new Date().toISOString(),
    llm_provider: 'anthropic',
    llm_model: 'claude-opus-4-7',
    extracted_payload: {
      reasons: ['Procedure outside policy scope', 'Pre-existing exclusion'],
      deduction_breakdown: [
        { reason: 'NON_PAYABLES', amount: 4500 },
        { reason: 'TARIFF_EXCESS', amount: 12000 },
      ],
      appeal_allowed: true,
      finality_note: 'Patient may file appeal within 30 days.',
      source: { ...baseSource, subject: 'Rejection: PA-9923' },
    },
  },
  unknown: {
    id: 'demo-unknown',
    claim_id: 'claim-demo',
    kind: 'other',
    confidence: 0.4,
    status: 'pending_review',
    created_at: new Date().toISOString(),
    llm_provider: 'anthropic',
    llm_model: 'claude-opus-4-7',
    extracted_payload: {
      free_form_note: 'Auto-classifier could not bucket this email.',
      raw_text_excerpt: '... please refer to attached annexure ...',
      source: baseSource,
    },
  },
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <section className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-5 first:border-0 first:pt-0">
    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      {children}
    </div>
  </section>
);

const AiDraftDemo: React.FC = () => {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editorPayload, setEditorPayload] = useState<Record<string, any>>(
    drafts.approved.extracted_payload,
  );
  const [editorCategory, setEditorCategory] = useState<string>('approved');

  const openDraft = drafts[openId ?? ''] ?? null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <header>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">
            Intelligence Layer · AI Draft Drawer
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Wave 2D visual reference. Mock drafts cover approval, query, rejection, and
            unknown categories.
          </p>
        </header>

        <Section title="AiDraftPill — colour by latest category">
          <div className="flex flex-wrap items-center gap-3">
            <AiDraftPill draftCount={1} latestCategory="approved" onClick={() => {}} />
            <AiDraftPill draftCount={3} latestCategory="queried" onClick={() => {}} />
            <AiDraftPill draftCount={2} latestCategory="rejected" onClick={() => {}} />
            <AiDraftPill draftCount={1} latestCategory="other" onClick={() => {}} />
          </div>
        </Section>

        <Section title="Open drawer with a mock draft">
          <div className="flex flex-wrap items-center gap-2">
            {Object.entries(drafts).map(([k, d]) => (
              <button
                key={k}
                type="button"
                onClick={() => setOpenId(k)}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Open {d.kind} draft
              </button>
            ))}
          </div>
        </Section>

        <Section title="AiDraftExtractionEditor — standalone preview">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {Object.entries(drafts).map(([k, d]) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setEditorCategory(d.kind);
                  setEditorPayload(d.extracted_payload);
                }}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
                  editorCategory === d.kind
                    ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
                }`}
              >
                {d.kind}
              </button>
            ))}
          </div>
          <AiDraftExtractionEditor
            category={editorCategory}
            extractedPayload={editorPayload}
            onChange={setEditorPayload}
            originalPayload={drafts[
              Object.keys(drafts).find((k) => drafts[k].kind === editorCategory) ?? ''
            ]?.extracted_payload}
          />
        </Section>
      </div>

      <AiDraftDrawer
        draftId={openId}
        onClose={() => setOpenId(null)}
        draftOverride={openDraft}
      />
    </div>
  );
};

export default AiDraftDemo;
