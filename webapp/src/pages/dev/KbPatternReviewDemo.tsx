import React, { useState } from 'react';
import {
  CategoryPill,
  ConfidenceBadge,
} from '@/components/intelligence/primitives';
import PatternDetailDrawer, {
  EvidenceClaim,
  PatternMatch,
} from '@/pages/superadmin/KbPatternReview/PatternDetailDrawer';
import PromotePatternDialog from '@/pages/superadmin/KbPatternReview/PromotePatternDialog';
import DemotePatternDialog from '@/pages/superadmin/KbPatternReview/DemotePatternDialog';
import RunMinerDialog from '@/pages/superadmin/KbPatternReview/RunMinerDialog';
import { KbPattern } from '@/hooks/intelligence/useKbPatterns';

/**
 * Wave 5C — KbPatternReview DEMO
 *
 * NOT routed. Mock-data tour of all states:
 *   - empty tab
 *   - populated card grid (candidate, live, demoted)
 *   - detail drawer with evidence + matches (correct + incorrect)
 *   - detail drawer with no evidence / no matches
 *   - promote dialog
 *   - demote dialog (required reason)
 *   - run miner dialog (pending, success)
 *   - toast (ok + err)
 */

const patterns: Array<KbPattern & { title?: string; description?: string }> = [
  {
    id: 'p1',
    pattern_type: 'co_occurrence',
    scope: { panel_id: 'panel-12' },
    condition: { docs: ['discharge_summary', 'final_bill'], gap_days_gt: 2 },
    prediction: { likely_outcome: 'rejection', reason: 'late_filing' },
    evidence_count: 38,
    confidence: 0.91,
    status: 'candidate',
    last_seen_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    title: 'Late filing → rejection (panel-12)',
    description: 'When discharge summary and final bill are >2 days apart, panel-12 rejects 91% of claims.',
  },
  {
    id: 'p2',
    pattern_type: 'deduction_predictor',
    scope: { insurer_id: 'insurer-9' },
    condition: { missing_fields: ['icu_admission_time'] },
    prediction: { deduction_pct_range: [12, 18] },
    evidence_count: 67,
    confidence: 0.72,
    status: 'live',
    last_seen_at: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(),
    title: 'ICU admission time missing → 12-18% deduction',
  },
  {
    id: 'p3',
    pattern_type: 'co_occurrence',
    scope: {},
    condition: { stage_skipped: 'pre_auth' },
    prediction: { likely_outcome: 'deficiency' },
    evidence_count: 8,
    confidence: 0.45,
    status: 'demoted',
    last_seen_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 12).toISOString(),
    title: 'Pre-auth skip → deficiency (demoted, low confidence)',
  },
];

const evidence: EvidenceClaim[] = [
  {
    id: 'e1',
    case_id: 'case-2104',
    case_label: 'Case #2104 · Rajesh K.',
    occurred_at: new Date().toISOString(),
    summary: 'Discharge filed 4 days late; insurer cited 4.2(b).',
  },
  {
    id: 'e2',
    case_id: 'case-2109',
    case_label: 'Case #2109 · Sunita P.',
    occurred_at: new Date().toISOString(),
    summary: 'Same panel; deduction applied.',
  },
];

const matches: PatternMatch[] = [
  {
    id: 'm1',
    claim_id: 'claim-3001',
    claim_label: 'Claim #3001',
    matched_at: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
    prediction_correct: true,
  },
  {
    id: 'm2',
    claim_id: 'claim-3002',
    claim_label: 'Claim #3002',
    matched_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    prediction_correct: false,
  },
  {
    id: 'm3',
    claim_id: 'claim-3003',
    claim_label: 'Claim #3003',
    matched_at: new Date(Date.now() - 1000 * 60 * 60 * 22).toISOString(),
    prediction_correct: null,
  },
];

function fmtRel(iso: string): string {
  const t = new Date(iso);
  const diff = Date.now() - t.getTime();
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function summarizeScope(scope: Record<string, any>): string {
  const entries = Object.entries(scope ?? {}).filter(([, v]) => v);
  if (entries.length === 0) return 'global';
  return entries.map(([k, v]) => `${k}:${v}`).join(' · ');
}

const KbPatternReviewDemo: React.FC = () => {
  const [tab, setTab] = useState<'candidate' | 'live' | 'demoted' | 'all' | 'empty'>(
    'candidate',
  );
  const [selected, setSelected] = useState<typeof patterns[number] | null>(null);
  const [showPromote, setShowPromote] = useState(false);
  const [showDemote, setShowDemote] = useState(false);
  const [showMiner, setShowMiner] = useState(false);
  const [minerResult, setMinerResult] = useState<any>(null);
  const [minerPending, setMinerPending] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [evidenceMode, setEvidenceMode] = useState<'full' | 'empty'>('full');

  const flash = (kind: 'ok' | 'err', msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 2000);
  };

  const visible =
    tab === 'empty'
      ? []
      : tab === 'all'
      ? patterns
      : patterns.filter((p) => p.status === tab);

  const runMiner = async () => {
    setMinerPending(true);
    setMinerResult(null);
    await new Promise((r) => setTimeout(r, 600));
    setMinerResult({ scanned: 1240, discovered: 4, updated: 12 });
    setMinerPending(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <header>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">
            KbPatternReview — demo states
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Not routed. Mock data only. Switch tabs incl. "empty" to see all states.
          </p>
        </header>

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

        <div className="flex flex-wrap items-center gap-2">
          {(['candidate', 'live', 'demoted', 'all', 'empty'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={
                'text-xs px-2.5 py-1 rounded-md ' +
                (t === tab
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60')
              }
            >
              {t}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowMiner(true)}
            className="ml-auto text-xs px-3 py-1.5 rounded bg-violet-600 text-white hover:bg-violet-700"
          >
            Open miner dialog
          </button>
          <button
            type="button"
            onClick={() =>
              setEvidenceMode((m) => (m === 'full' ? 'empty' : 'full'))
            }
            className="text-xs px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700"
          >
            Detail drawer evidence: {evidenceMode}
          </button>
        </div>

        {visible.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-800 px-4 py-10 text-center text-xs text-slate-500 dark:text-slate-400">
            No patterns in this tab.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {visible.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelected(p)}
                className="text-left rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2.5 hover:border-slate-400"
              >
                <div className="flex items-center gap-2">
                  <CategoryPill category={p.pattern_type} size="xs" />
                  <ConfidenceBadge confidence={p.confidence} mode="auto" size="sm" />
                  <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400">
                    {fmtRel(p.last_seen_at)}
                  </span>
                </div>
                <div className="mt-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100 line-clamp-2">
                  {p.title}
                </div>
                {p.description && (
                  <div className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2 mt-0.5">
                    {p.description}
                  </div>
                )}
                <div className="flex items-center gap-3 mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="font-mono truncate">{summarizeScope(p.scope)}</span>
                  <span className="ml-auto tabular-nums">{p.evidence_count} evidence</span>
                </div>
              </button>
            ))}
          </div>
        )}

        <PatternDetailDrawer
          open={!!selected}
          pattern={selected}
          title={selected?.title}
          description={selected?.description}
          evidenceClaims={evidenceMode === 'full' ? evidence : []}
          recentMatches={evidenceMode === 'full' ? matches : []}
          onClose={() => setSelected(null)}
          onPromote={() => setShowPromote(true)}
          onDemote={() => setShowDemote(true)}
        />

        <PromotePatternDialog
          open={showPromote}
          patternTitle={selected?.title ?? ''}
          onClose={() => setShowPromote(false)}
          onConfirm={async () => {
            setShowPromote(false);
            flash('ok', 'Pattern promoted (demo)');
          }}
        />

        <DemotePatternDialog
          open={showDemote}
          patternTitle={selected?.title ?? ''}
          onClose={() => setShowDemote(false)}
          onConfirm={async () => {
            setShowDemote(false);
            flash('ok', 'Pattern demoted (demo)');
          }}
        />

        <RunMinerDialog
          open={showMiner}
          pending={minerPending}
          result={minerResult}
          onClose={() => setShowMiner(false)}
          onRun={runMiner}
        />
      </div>
    </div>
  );
};

export default KbPatternReviewDemo;
