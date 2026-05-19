import React, { useState, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { PlayCircle, AlertCircle } from 'lucide-react';
import apiService from '@/services/api';
import {
  useKbPatterns,
  KbPattern,
  KbPatternStatus,
} from '@/hooks/intelligence/useKbPatterns';
import {
  CategoryPill,
  ConfidenceBadge,
} from '@/components/intelligence/primitives';
import PatternDetailDrawer, {
  EvidenceClaim,
  PatternMatch,
} from './PatternDetailDrawer';
import PromotePatternDialog from './PromotePatternDialog';
import DemotePatternDialog from './DemotePatternDialog';
import RunMinerDialog from './RunMinerDialog';

/**
 * Wave 5C — KB Pattern Review (Superadmin)
 *
 * TODO(routing): mount at `/superadmin/kb-patterns` once review signs off.
 *
 * Backend endpoints USED (Wave 4A):
 *   - GET    /kb-patterns?status=…&pattern_type=…
 *   - GET    /kb-patterns/:id            (full detail incl. evidence + matches)
 *   - POST   /kb-patterns/:id/promote    (body: { reason })
 *   - POST   /kb-patterns/:id/demote     (body: { reason })
 *   - POST   /admin/kb-miner/run         (body: { sinceDays?, maxClaims? })
 *
 * All other endpoints in this page are read-only and already shipped.
 */

type TabKey = 'candidate' | 'live' | 'demoted' | 'all' | 'corrections';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'candidate', label: 'Candidates' },
  { key: 'live', label: 'Live' },
  { key: 'demoted', label: 'Demoted' },
  { key: 'all', label: 'All' },
  // Wave 10 — patterns mined from human corrections (category_confusion,
  // harmonisation_drift, rule_overreach, extraction_field_pattern).
  { key: 'corrections', label: 'From Corrections' },
];

// Wave 10 — pattern types produced by correction-driven mining strategies.
const CORRECTION_PATTERN_TYPES = new Set<string>([
  'category_confusion',
  'harmonisation_drift',
  'rule_overreach',
  'extraction_field_pattern',
]);

function fmtRel(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const diff = Date.now() - t.getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function summarizeScope(scope: Record<string, any>): string {
  const entries = Object.entries(scope ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  if (entries.length === 0) return 'global';
  return entries.map(([k, v]) => `${k}:${typeof v === 'object' ? '…' : v}`).join(' · ');
}

interface PatternDetailPayload {
  pattern: KbPattern;
  title?: string;
  description?: string;
  evidenceClaims?: EvidenceClaim[];
  recentMatches?: PatternMatch[];
}

export const KbPatternReview: React.FC = () => {
  const [tab, setTab] = useState<TabKey>('candidate');
  // The 'corrections' tab does not pin a single status — we want to see
  // candidate + live correction-driven patterns side by side so the
  // reviewer can promote them in one pass.
  const statusFilter: KbPatternStatus | undefined =
    tab === 'all' || tab === 'corrections' ? undefined : (tab as KbPatternStatus);

  const {
    data: rawPatterns,
    loading,
    error,
    refetch,
    promotePattern,
    demotePattern,
    promoting,
    demoting,
  } = useKbPatterns({ status: statusFilter });

  // For the corrections tab we further filter client-side. Doing the
  // filter here (rather than fetching pattern_type-by-type) keeps the
  // request count down and the cache aligned with the other tabs.
  const patterns = useMemo(() => {
    if (tab !== 'corrections') return rawPatterns;
    return rawPatterns.filter((p) =>
      CORRECTION_PATTERN_TYPES.has(p.pattern_type),
    );
  }, [rawPatterns, tab]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [demoteOpen, setDemoteOpen] = useState(false);
  const [minerOpen, setMinerOpen] = useState(false);
  const [minerResult, setMinerResult] = useState<any>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const flash = (kind: 'ok' | 'err', msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 2500);
  };

  const selectedPattern = useMemo(
    () => patterns.find((p) => p.id === selectedId) ?? null,
    [patterns, selectedId],
  );

  const detailQ = useQuery({
    queryKey: ['kb-pattern-review', 'detail', selectedId],
    enabled: !!selectedId,
    staleTime: 30_000,
    queryFn: async (): Promise<PatternDetailPayload | null> => {
      if (!selectedId) return null;
      try {
        const res = await apiService.get(`/kb-patterns/${selectedId}`);
        const payload = (res.data?.data ?? res.data ?? {}) as any;
        return {
          pattern: payload.pattern ?? payload,
          title: payload.title,
          description: payload.description,
          evidenceClaims: Array.isArray(payload.evidence_claims)
            ? payload.evidence_claims
            : Array.isArray(payload.evidenceClaims)
            ? payload.evidenceClaims
            : [],
          recentMatches: Array.isArray(payload.recent_matches)
            ? payload.recent_matches
            : Array.isArray(payload.recentMatches)
            ? payload.recentMatches
            : [],
        };
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });

  const minerMut = useMutation({
    mutationFn: async (vars: { sinceDays?: number; maxClaims?: number }) => {
      const res = await apiService.post('/admin/kb-miner/run', vars);
      return res.data?.data ?? res.data;
    },
    onSuccess: (data) => {
      setMinerResult(data);
      flash('ok', 'Miner run complete');
      refetch();
    },
    onError: (e: any) => flash('err', e?.message ?? 'Miner failed'),
  });

  const handlePromote = async (reason: string) => {
    if (!selectedPattern) return;
    try {
      // Promote endpoint accepts an optional reason; the hook supports
      // only the id. We POST directly for the optional reason payload.
      if (reason) {
        await apiService.post(`/kb-patterns/${selectedPattern.id}/promote`, { reason });
      } else {
        await promotePattern(selectedPattern.id);
      }
      flash('ok', 'Pattern promoted');
      setPromoteOpen(false);
      refetch();
    } catch (e: any) {
      flash('err', e?.message ?? 'Promote failed');
    }
  };

  const handleDemote = async (reason: string) => {
    if (!selectedPattern) return;
    try {
      await demotePattern(selectedPattern.id, reason);
      flash('ok', 'Pattern demoted');
      setDemoteOpen(false);
      refetch();
    } catch (e: any) {
      flash('err', e?.message ?? 'Demote failed');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            KB Pattern Review
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Approve, demote, or audit candidate patterns mined from past claims.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setMinerResult(null);
            setMinerOpen(true);
          }}
          className="inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded bg-violet-600 text-white hover:bg-violet-700"
        >
          <PlayCircle className="h-3.5 w-3.5" /> Run Miner
        </button>
      </div>

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

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800 pb-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              'text-xs px-2.5 py-1 rounded-md transition-colors ' +
              (t.key === tab
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div className="text-xs text-slate-500 dark:text-slate-400 px-3 py-6">Loading…</div>
      ) : error ? (
        <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400 px-3 py-6">
          <AlertCircle className="h-3.5 w-3.5" /> Failed to load patterns.
        </div>
      ) : patterns.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-800 px-4 py-10 text-center text-xs text-slate-500 dark:text-slate-400">
          No patterns in this tab yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {patterns.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              className="text-left rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2.5 hover:border-slate-400 dark:hover:border-slate-600 transition-colors"
            >
              <div className="flex items-center gap-2">
                <CategoryPill category={p.pattern_type} size="xs" />
                <ConfidenceBadge confidence={p.confidence} mode="auto" size="sm" />
                <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400">
                  {fmtRel(p.last_seen_at)}
                </span>
              </div>
              <div className="mt-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100 line-clamp-2">
                {(p as any).title ?? `${p.pattern_type} pattern`}
              </div>
              {(p as any).description && (
                <div className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2 mt-0.5">
                  {(p as any).description}
                </div>
              )}
              <div className="flex items-center gap-3 mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                <span className="font-mono truncate">{summarizeScope(p.scope)}</span>
                <span className="ml-auto tabular-nums">
                  {p.evidence_count} evidence
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <PatternDetailDrawer
        open={!!selectedId}
        pattern={selectedPattern}
        title={detailQ.data?.title}
        description={detailQ.data?.description}
        evidenceClaims={detailQ.data?.evidenceClaims ?? []}
        recentMatches={detailQ.data?.recentMatches ?? []}
        loading={detailQ.isLoading}
        pendingPromote={promoting}
        pendingDemote={demoting}
        onClose={() => setSelectedId(null)}
        onPromote={() => setPromoteOpen(true)}
        onDemote={() => setDemoteOpen(true)}
      />

      <PromotePatternDialog
        open={promoteOpen}
        patternTitle={(selectedPattern as any)?.title ?? selectedPattern?.pattern_type ?? ''}
        pending={promoting}
        onClose={() => setPromoteOpen(false)}
        onConfirm={handlePromote}
      />

      <DemotePatternDialog
        open={demoteOpen}
        patternTitle={(selectedPattern as any)?.title ?? selectedPattern?.pattern_type ?? ''}
        pending={demoting}
        onClose={() => setDemoteOpen(false)}
        onConfirm={handleDemote}
      />

      <RunMinerDialog
        open={minerOpen}
        pending={minerMut.isPending}
        result={minerResult}
        onClose={() => setMinerOpen(false)}
        onRun={(opts) => minerMut.mutateAsync(opts).then(() => undefined)}
      />
    </div>
  );
};

export default KbPatternReview;
