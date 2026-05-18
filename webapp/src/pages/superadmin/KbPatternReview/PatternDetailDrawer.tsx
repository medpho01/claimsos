import React from 'react';
import { X, CheckCircle2, XCircle } from 'lucide-react';
import {
  CategoryPill,
  ConfidenceBadge,
  CitationLink,
  EventRow,
} from '@/components/intelligence/primitives';
import { KbPattern } from '@/hooks/intelligence/useKbPatterns';

/**
 * Wave 5C — KbPatternReview
 *
 * Drawer showing a pattern's full payload:
 *   - condition JSONB
 *   - prediction JSONB
 *   - evidence claims (CitationLink kind='case')
 *   - recent matches with prediction_correct flag
 *
 * The parent loads supporting data (`evidenceClaims`, `recentMatches`)
 * via the detail endpoint and passes them in; the drawer is presentational.
 */

export interface EvidenceClaim {
  id: string;
  case_id: string;
  case_label: string;
  occurred_at: string;
  summary?: string;
}

export interface PatternMatch {
  id: string;
  claim_id: string;
  claim_label: string;
  matched_at: string;
  prediction_correct?: boolean | null;
}

export interface PatternDetailDrawerProps {
  open: boolean;
  pattern: KbPattern | null;
  title?: string;
  description?: string;
  evidenceClaims: EvidenceClaim[];
  recentMatches: PatternMatch[];
  loading?: boolean;
  pendingPromote?: boolean;
  pendingDemote?: boolean;
  onClose: () => void;
  onPromote: () => void;
  onDemote: () => void;
}

function summarizeScope(scope: Record<string, any>): string {
  const entries = Object.entries(scope ?? {});
  if (entries.length === 0) return 'global';
  return entries
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}:${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
}

export const PatternDetailDrawer: React.FC<PatternDetailDrawerProps> = ({
  open,
  pattern,
  title,
  description,
  evidenceClaims,
  recentMatches,
  loading,
  pendingPromote,
  pendingDemote,
  onClose,
  onPromote,
  onDemote,
}) => {
  if (!open || !pattern) return null;

  const status = pattern.status;
  const isCandidate = status === 'candidate';
  const isLive = status === 'live';

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-xl border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl flex flex-col">
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-start gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CategoryPill category={pattern.pattern_type} size="xs" />
            <ConfidenceBadge confidence={pattern.confidence} mode="auto" size="sm" />
            <span
              className={
                'text-[10px] uppercase tracking-wide ' +
                (isLive
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : isCandidate
                  ? 'text-amber-700 dark:text-amber-300'
                  : 'text-slate-500 dark:text-slate-400')
              }
            >
              {status}
            </span>
          </div>
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 mt-0.5 truncate">
            {title ?? pattern.pattern_type}
          </div>
          {description && (
            <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">{description}</div>
          )}
          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
            scope: {summarizeScope(pattern.scope)}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {loading && (
          <div className="text-xs text-slate-500 dark:text-slate-400">Loading detail…</div>
        )}

        <Section title="Condition">
          <pre className="text-[11px] leading-snug font-mono whitespace-pre-wrap bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-2 text-slate-800 dark:text-slate-200">
            {JSON.stringify(pattern.condition, null, 2)}
          </pre>
        </Section>

        <Section title="Prediction">
          <pre className="text-[11px] leading-snug font-mono whitespace-pre-wrap bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-2 text-slate-800 dark:text-slate-200">
            {JSON.stringify(pattern.prediction, null, 2)}
          </pre>
        </Section>

        <Section title={`Evidence (${pattern.evidence_count})`}>
          {evidenceClaims.length === 0 ? (
            <div className="text-xs text-slate-500 dark:text-slate-400 italic">
              No backing claims attached.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {evidenceClaims.map((c) => (
                <li key={c.id} className="flex items-start gap-2">
                  <CitationLink
                    kind="case"
                    id={c.case_id}
                    label={c.case_label}
                    inline
                    onOpen={() => {
                      /* parent decides; v1 no-op */
                    }}
                  />
                  {c.summary && (
                    <span className="text-xs text-slate-600 dark:text-slate-300">
                      {c.summary}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Recent matches (${recentMatches.length})`}>
          {recentMatches.length === 0 ? (
            <div className="text-xs text-slate-500 dark:text-slate-400 italic">
              No matches recorded yet.
            </div>
          ) : (
            <div className="space-y-0">
              {recentMatches.map((m) => {
                const tone =
                  m.prediction_correct === true
                    ? 'success'
                    : m.prediction_correct === false
                    ? 'danger'
                    : 'default';
                const kind =
                  m.prediction_correct === true
                    ? 'success'
                    : m.prediction_correct === false
                    ? 'warning'
                    : 'info';
                return (
                  <EventRow
                    key={m.id}
                    when={m.matched_at}
                    kind={kind}
                    tone={tone as any}
                    title={
                      m.prediction_correct === true
                        ? 'Prediction confirmed'
                        : m.prediction_correct === false
                        ? 'Prediction wrong'
                        : 'Matched (no feedback yet)'
                    }
                    citations={[{ kind: 'case', id: m.claim_id, label: m.claim_label }]}
                  >
                    {m.prediction_correct === true ? (
                      <span className="text-[11px] text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> correct
                      </span>
                    ) : m.prediction_correct === false ? (
                      <span className="text-[11px] text-red-700 dark:text-red-300 inline-flex items-center gap-1">
                        <XCircle className="h-3 w-3" /> incorrect
                      </span>
                    ) : null}
                  </EventRow>
                );
              })}
            </div>
          )}
        </Section>
      </div>

      <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
        {(isCandidate || status === 'demoted') && (
          <button
            type="button"
            onClick={onPromote}
            disabled={pendingPromote}
            className="text-xs px-3 py-1.5 rounded font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {pendingPromote ? 'Promoting…' : 'Promote to live'}
          </button>
        )}
        {(isCandidate || isLive) && (
          <button
            type="button"
            onClick={onDemote}
            disabled={pendingDemote}
            className="text-xs px-3 py-1.5 rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {pendingDemote ? 'Demoting…' : 'Demote'}
          </button>
        )}
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
      {title}
    </div>
    {children}
  </div>
);

export default PatternDetailDrawer;
