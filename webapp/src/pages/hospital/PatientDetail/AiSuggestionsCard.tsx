import React, { useState } from 'react';
import {
  Sparkles,
  ChevronRight,
  IndianRupee,
  FileWarning,
  Inbox,
  Mail,
  Paperclip,
  ExternalLink,
} from 'lucide-react';
import { useAiDrafts, type AiDraft } from '@/hooks/intelligence/useAiDrafts';
import { AiDraftDrawer } from '@/components/intelligence/AiDraftDrawer/AiDraftDrawer';

/**
 * AI Suggestions / Next Steps — Overview-tab surface for the email-intelligence
 * pipeline.
 *
 * The Gmail inbound pipeline classifies each insurer reply and writes an
 * extraction draft to hospital.email_intelligence_drafts (status
 * pending_review). This card is the human-review surface for those drafts:
 *   - a one-line summary of what the AI read from the email
 *     (outcome category + key extracted fields: approved amount, requested
 *      documents/deficiencies)
 *   - confidence
 *   - "Review & Apply" → opens the AiDraftDrawer to confirm/edit/reject.
 *
 * Applying a draft commits the extraction (e.g. writes the approved amount into
 * claim_financials, opens deficiency actions). Nothing is auto-applied — this
 * is the "AI suggests, human decides" gate.
 */

const CATEGORY_LABEL: Record<string, string> = {
  approved: 'Approved',
  partially_approved: 'Partially approved',
  enhancement_approved: 'Enhancement approved',
  enhancement_partially_approved: 'Enhancement partially approved',
  queried: 'Query / documents requested',
  query: 'Query / documents requested',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  acknowledged: 'Acknowledged',
  unknown: 'Needs review',
};

const APPROVAL_LIKE = new Set([
  'approved',
  'partially_approved',
  'enhancement_approved',
  'enhancement_partially_approved',
]);
const REJECTION_LIKE = new Set(['rejected', 'withdrawn']);

const toneClasses = (cat: string): string => {
  if (APPROVAL_LIKE.has(cat))
    return 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900/60';
  if (REJECTION_LIKE.has(cat))
    return 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900/60';
  return 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/60';
};

const inr = (v: unknown): string | null =>
  v == null || v === '' || Number.isNaN(Number(v))
    ? null
    : '₹' + Number(v).toLocaleString('en-IN');

/** Build the human one-liner of what the AI extracted from the email. */
const summarize = (d: AiDraft): { line: string; icon: React.ReactNode } => {
  const p = d.extracted_payload ?? {};
  const amount = inr(p.amount_inr ?? p.approved_amount ?? p.amount);
  // QueryExtraction stores items under `queries`; accept `deficiencies` too.
  const deficiencies: any[] = Array.isArray(p.queries)
    ? p.queries
    : Array.isArray(p.deficiencies)
      ? p.deficiencies
      : [];

  if (amount && (APPROVAL_LIKE.has(d.kind) || p.amount_inr != null)) {
    const room = p.room_category ? ` · ${p.room_category}` : '';
    return {
      line: `Approved amount ${amount}${room}`,
      icon: <IndianRupee className="size-3.5 text-emerald-600" />,
    };
  }
  if (deficiencies.length) {
    const first = deficiencies[0]?.description || deficiencies[0]?.doc_requested || 'document(s) requested';
    const more = deficiencies.length > 1 ? ` (+${deficiencies.length - 1} more)` : '';
    return {
      line: `${deficiencies.length} document(s) requested: ${first}${more}`,
      icon: <FileWarning className="size-3.5 text-amber-600" />,
    };
  }
  if (p.notes) return { line: String(p.notes).slice(0, 120), icon: <Sparkles className="size-3.5 text-indigo-500" /> };
  return { line: 'Insurer reply parsed — open to review the extracted details.', icon: <Sparkles className="size-3.5 text-indigo-500" /> };
};

const fmtDate = (s?: string): string => {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

export interface AiSuggestionsCardProps {
  claimId: string;
  /** Jump to the source insurer email in the Filings timeline (the "proof").
   *  Receives the inbound email id. */
  onViewSource?: (inboundEmailId: string) => void;
}

const AiSuggestionsCard: React.FC<AiSuggestionsCardProps> = ({ claimId, onViewSource }) => {
  const drafts = useAiDrafts(claimId, 'pending_review');
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);

  const list = drafts.data ?? [];

  // Hide entirely when there's nothing pending — keeps the Overview clean.
  if (!drafts.loading && list.length === 0) return null;

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-900/60 dark:bg-indigo-950/20">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="size-4 text-indigo-600" />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          AI Suggestions &amp; Next Steps
        </h3>
        {list.length > 0 && (
          <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {list.length}
          </span>
        )}
        <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400">
          Extracted from insurer emails · review before applying
        </span>
      </div>

      {drafts.loading ? (
        <div className="animate-pulse space-y-2">
          <div className="h-12 rounded bg-slate-200/70 dark:bg-slate-800" />
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((d) => {
            const cat = d.kind || 'unknown';
            const { line, icon } = summarize(d);
            const conf = Number(d.confidence);
            const src = d.source_email;
            const attachCount = Array.isArray(src?.attachments) ? src!.attachments!.length : 0;
            return (
              <li
                key={d.id}
                className="rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
              >
                <button
                  type="button"
                  onClick={() => setOpenDraftId(d.id)}
                  className="group flex w-full items-center gap-3 rounded-t-md px-3 py-2 text-left transition-colors hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${toneClasses(cat)}`}
                      >
                        {CATEGORY_LABEL[cat] ?? cat}
                      </span>
                      {Number.isFinite(conf) && conf > 0 && (
                        <span className="text-[10px] text-slate-400">
                          {Math.round(conf * 100)}% confident
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 truncate text-xs text-slate-700 dark:text-slate-200">
                      {icon}
                      <span className="truncate">{line}</span>
                    </div>
                  </div>
                  <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-indigo-600 dark:text-indigo-300">
                    Review &amp; Apply
                    <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </button>

                {/* Proof: the source insurer email this was extracted from */}
                {src && (
                  <div className="border-t border-slate-100 px-3 py-2 dark:border-slate-800">
                    <div className="flex items-start gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                      <Mail className="mt-0.5 size-3 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate">
                          <span className="font-medium text-slate-600 dark:text-slate-300">
                            {src.from || 'Insurer'}
                          </span>
                          {src.subject ? <span> — {src.subject}</span> : null}
                        </div>
                        {src.body && (
                          <div className="mt-0.5 line-clamp-2 text-slate-400">
                            “{src.body.replace(/\s+/g, ' ').slice(0, 180)}
                            {src.body.length > 180 ? '…' : ''}”
                          </div>
                        )}
                        <div className="mt-1 flex items-center gap-3">
                          {src.received_at && <span>{fmtDate(src.received_at)}</span>}
                          {attachCount > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <Paperclip className="size-3" />
                              {attachCount} attachment{attachCount > 1 ? 's' : ''}
                            </span>
                          )}
                          {onViewSource && src.id && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onViewSource(src.id);
                              }}
                              className="inline-flex items-center gap-1 font-semibold text-indigo-600 hover:underline dark:text-indigo-300"
                            >
                              View source email
                              <ExternalLink className="size-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {list.length === 0 && !drafts.loading && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Inbox className="size-4" /> No pending insurer-email suggestions.
        </div>
      )}

      <AiDraftDrawer
        draftId={openDraftId}
        claimId={claimId}
        onClose={() => setOpenDraftId(null)}
        onApplied={() => {
          setOpenDraftId(null);
          drafts.refetch();
        }}
        onRejected={() => {
          setOpenDraftId(null);
          drafts.refetch();
        }}
      />
    </div>
  );
};

export default AiSuggestionsCard;
