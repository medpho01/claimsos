import React, { useState } from 'react';
import {
  useClaimDossier,
  useAdjudicationReport,
  useAiDrafts,
  useDocumentSections,
  useMasterOptions,
  useActionQueue,
  useStageRequirements,
  useKbPatterns,
  useCostMeter,
  useEvalMetrics,
} from '@/hooks/intelligence';

/**
 * Visual smoke-test page for the Sprint W1-C intelligence hooks.
 * Not wired into any route — render it ad-hoc during review by
 * temporarily importing it from App.tsx.
 *
 * Most endpoints aren't live yet; hooks return null / [] on 404 so this
 * page should always render without throwing. The "loading → empty / data"
 * transitions are the thing to watch.
 */

const SAMPLE_CLAIM_ID = '00000000-0000-0000-0000-000000000001';
const SAMPLE_DOCUMENT_ID = '00000000-0000-0000-0000-000000000002';

const Card: React.FC<{
  title: string;
  hookName: string;
  loading: boolean;
  error: Error | null;
  data: unknown;
  extra?: React.ReactNode;
}> = ({ title, hookName, loading, error, data, extra }) => {
  const isEmpty =
    data === null ||
    data === undefined ||
    (Array.isArray(data) && data.length === 0);

  let state: 'loading' | 'error' | 'empty' | 'data';
  if (loading) state = 'loading';
  else if (error) state = 'error';
  else if (isEmpty) state = 'empty';
  else state = 'data';

  const stateColor: Record<typeof state, string> = {
    loading: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200',
    error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200',
    empty: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    data: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200',
  };

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
            {title}
          </h2>
          <code className="text-[11px] text-slate-500 dark:text-slate-400">
            {hookName}
          </code>
        </div>
        <span
          className={`text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded ${stateColor[state]}`}
        >
          {state}
        </span>
      </header>
      {extra && <div className="text-xs">{extra}</div>}
      <pre className="text-[11px] leading-snug bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-2 overflow-auto max-h-56 text-slate-700 dark:text-slate-300">
        {error
          ? String(error?.message ?? error)
          : isEmpty
            ? '(no data)'
            : JSON.stringify(data, null, 2)}
      </pre>
    </section>
  );
};

const IntelligenceHooksDemo: React.FC = () => {
  const [claimId, setClaimId] = useState(SAMPLE_CLAIM_ID);
  const [documentId, setDocumentId] = useState(SAMPLE_DOCUMENT_ID);

  const dossier = useClaimDossier(claimId);
  const adjudication = useAdjudicationReport(claimId);
  const drafts = useAiDrafts(claimId, 'pending_review');
  const sections = useDocumentSections(documentId);
  const stages = useMasterOptions('ipd_stage');
  const actions = useActionQueue({ status: 'pending' });
  const reqs = useStageRequirements({});
  const patterns = useKbPatterns({ status: 'live' });
  const meter = useCostMeter({ period: 'month' });
  const evals = useEvalMetrics({ period: 'month' });

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="space-y-2">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">
            Intelligence Hooks — visual smoke test
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 max-w-2xl">
            Sprint W1-C. Each card calls one hook against a sample input.
            Most backend endpoints are not live yet — hooks treat 404 as
            "endpoint not ready" and return null/[], so this page is safe
            to render even before Wave 1 backend lands.
          </p>
          <div className="flex flex-wrap gap-3 text-xs">
            <label className="flex items-center gap-2">
              <span className="text-slate-500 dark:text-slate-400">claimId</span>
              <input
                value={claimId}
                onChange={(e) => setClaimId(e.target.value)}
                className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-mono w-72"
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-slate-500 dark:text-slate-400">documentId</span>
              <input
                value={documentId}
                onChange={(e) => setDocumentId(e.target.value)}
                className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-mono w-72"
              />
            </label>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card
            title="Claim dossier"
            hookName="useClaimDossier(claimId)"
            loading={dossier.loading}
            error={dossier.error}
            data={dossier.data}
            extra={
              <button
                onClick={() => dossier.refetch()}
                className="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-[11px]"
              >
                refetch
              </button>
            }
          />
          <Card
            title="Adjudication report (latest)"
            hookName="useAdjudicationReport(claimId)"
            loading={adjudication.loading}
            error={adjudication.error}
            data={adjudication.data}
          />
          <Card
            title="AI drafts (pending_review)"
            hookName="useAiDrafts(claimId, 'pending_review')"
            loading={drafts.loading}
            error={drafts.error}
            data={drafts.data}
            extra={
              <span className="text-slate-500 dark:text-slate-400">
                mutations available: applyDraft / rejectDraft
              </span>
            }
          />
          <Card
            title="Document sections"
            hookName="useDocumentSections(documentId)"
            loading={sections.loading}
            error={sections.error}
            data={sections.data}
          />
          <Card
            title="Master options (ipd_stage)"
            hookName="useMasterOptions('ipd_stage')"
            loading={stages.loading}
            error={stages.error}
            data={stages.data}
          />
          <Card
            title="Action queue (pending)"
            hookName="useActionQueue({ status: 'pending' })"
            loading={actions.loading}
            error={actions.error}
            data={actions.data}
            extra={
              <span className="text-slate-500 dark:text-slate-400">
                mutations available: ackAction / declineAction
              </span>
            }
          />
          <Card
            title="Stage requirements (global)"
            hookName="useStageRequirements({})"
            loading={reqs.loading}
            error={reqs.error}
            data={reqs.data}
          />
          <Card
            title="KB patterns (live)"
            hookName="useKbPatterns({ status: 'live' })"
            loading={patterns.loading}
            error={patterns.error}
            data={patterns.data}
            extra={
              <span className="text-slate-500 dark:text-slate-400">
                mutations available: promotePattern / demotePattern
              </span>
            }
          />
          <Card
            title="Cost meter (month)"
            hookName="useCostMeter({ period: 'month' })"
            loading={meter.loading}
            error={meter.error}
            data={meter.data}
          />
          <Card
            title="Eval metrics (month)"
            hookName="useEvalMetrics({ period: 'month' })"
            loading={evals.loading}
            error={evals.error}
            data={evals.data}
          />
        </div>
      </div>
    </div>
  );
};

export default IntelligenceHooksDemo;
