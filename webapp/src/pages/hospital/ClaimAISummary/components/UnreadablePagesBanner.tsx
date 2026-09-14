/**
 * UnreadablePagesBanner — the consolidated end-of-run decision (contract §C.4).
 *
 * This surface is the whole point of removing the silent Tesseract fallback.
 * Before, a page the vision reader could not handle was quietly re-read by a
 * far weaker engine and its garbage text flowed into the extraction as if it
 * were real. The user saw a finished run and believed the document had been
 * read. It had not.
 *
 * Now such a page is a HOLE, and this banner is where the holes are declared:
 * which document, which pages, why, what was lost as a result, and the one
 * thing the user can do about it. ONE decision per run — not one per page and
 * not one per document — which is why this reads the server's grouped summary
 * rather than assembling its own from page rows.
 *
 * It stays on screen until acknowledged. That is deliberate: "I have seen
 * this" is a decision, and it should cost a click.
 */

import React from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileWarning,
  Loader2,
  RefreshCw,
  Upload,
  Wallet,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { UnreadableReason } from '@/hooks/intelligence/useIntelligenceStatus';
import { cn } from '@/lib/utils';

import {
  actionHint,
  actionLabel,
  formatInr,
  reasonLabel,
  reasonShort,
  type RunUnreadableSummary,
  type UnreadableAction,
  type UnreadableDocGroup,
} from './runConsentApi';

export interface UnreadablePagesBannerProps {
  summary: RunUnreadableSummary;
  /**
   * Start a fresh run. `suggestedBudgetInr` is passed when the fix is money —
   * it pre-fills the consent dialog so the user does not have to work out how
   * much "enough" is.
   */
  onRerun: (suggestedBudgetInr?: number) => void;
  /** Where the user goes to replace a damaged or oversized file. */
  uploadHref?: string;
  onAcknowledge: () => void | Promise<void>;
  acknowledging?: boolean;
  rerunning?: boolean;
}

const NEUTRAL_TONE =
  'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100';

const REASON_TONE: Record<UnreadableReason, string> = {
  cost_budget:
    'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100',
  latency_budget:
    'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100',
  page_budget:
    'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100',
  vision_failed: 'bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-100',
  render_failed: 'bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-100',
};

function prettyCategory(cat: string): string {
  return cat.replaceAll('_', ' ');
}

export const UnreadablePagesBanner: React.FC<UnreadablePagesBannerProps> = ({
  summary,
  onRerun,
  uploadHref,
  onAcknowledge,
  acknowledging = false,
  rerunning = false,
}) => {
  const [expanded, setExpanded] = React.useState(true);

  // Defensive: an older backend (or a partially-populated summary) can omit
  // these. A missing roll-up must degrade to "we know pages were lost but not
  // the breakdown" — never to a blank screen, which reads as "all fine".
  const byReason = summary.by_reason ?? ({} as Record<UnreadableReason, number>);
  const documents = summary.documents ?? [];
  const suggestedActions = summary.suggested_actions ?? [];

  const unreadablePages = summary.unreadable_pages_total ?? 0;
  const readablePages = summary.readable_pages_total ?? 0;
  const totalPages = unreadablePages + readablePages;
  // The degraded roll-up fallback has no readable-page count. Claiming
  // "0 of N pages were read" would be worse than saying nothing, so the
  // denominator sentence is only rendered when we actually have one.
  const knowsDenominator = readablePages > 0;
  const reasons = (Object.keys(byReason) as UnreadableReason[]).filter(
    (r) => (byReason[r] ?? 0) > 0,
  );

  const endedByDecline = summary.end_reason === 'budget_declined';

  return (
    <div className="rounded-md border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40 px-4 py-3">
      <div className="flex items-start gap-3">
        <FileWarning className="size-4 mt-0.5 shrink-0 text-red-700 dark:text-red-300" />

        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-red-900 dark:text-red-100">
                {summary.unreadable_pages_total}{' '}
                {summary.unreadable_pages_total === 1 ? 'page was' : 'pages were'}{' '}
                not read
                {summary.documents_affected > 0 && (
                  <>
                    {' '}
                    across {summary.documents_affected}{' '}
                    {summary.documents_affected === 1 ? 'document' : 'documents'}
                  </>
                )}
              </div>
              <div className="text-xs text-red-800/90 dark:text-red-200/90 mt-0.5 leading-relaxed">
                {knowsDenominator && (
                  <>
                    {readablePages} of {totalPages} pages were read.{' '}
                  </>
                )}
                Anything on the unread pages is <strong>missing</strong> from the
                analysis below — it was not guessed at and it was not filled in
                from a weaker reader.
                {endedByDecline &&
                  ' This run was ended early because more budget was declined; everything already analysed has been kept.'}
                {summary.documents_fully_unreadable > 0 && (
                  <>
                    {' '}
                    {summary.documents_fully_unreadable}{' '}
                    {summary.documents_fully_unreadable === 1
                      ? 'document was'
                      : 'documents were'}{' '}
                    not read at all.
                  </>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void onAcknowledge()}
              disabled={acknowledging}
              title="Dismiss this notice. It will not come back for this run."
              className="shrink-0 rounded p-1 text-red-700/70 hover:text-red-900 hover:bg-red-100 dark:text-red-300/70 dark:hover:text-red-100 dark:hover:bg-red-900/40"
            >
              {acknowledging ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <X className="size-4" />
              )}
              <span className="sr-only">Dismiss</span>
            </button>
          </div>

          {/* Why, at a glance */}
          <div className="flex flex-wrap gap-1.5">
            {reasons.map((r) => (
              <span
                key={r}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px] font-medium',
                  REASON_TONE[r] ?? NEUTRAL_TONE,
                )}
                title={reasonLabel(r)}
              >
                {byReason[r]} · {reasonShort(r)}
              </span>
            ))}
          </div>

          {documents.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-1 text-xs text-red-800 dark:text-red-200 hover:underline"
              >
                {expanded ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                {expanded ? 'Hide' : 'Show'} the affected documents (
                {documents.length})
              </button>

              {expanded && (
                <div className="space-y-2">
                  {documents.map((doc) => (
                    <DocRow
                      key={doc.doc_id}
                      doc={doc}
                      estCostToFinishInr={summary.est_cost_to_finish_inr}
                      uploadHref={uploadHref}
                      onRerun={onRerun}
                      rerunning={rerunning}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            // Degraded: the roll-up on /status told us pages were lost but the
            // grouped detail has not arrived. Say so plainly rather than
            // rendering an empty list, which would read as "nothing to see".
            <div className="text-[11px] text-red-800/90 dark:text-red-200/90">
              The page-by-page breakdown could not be loaded. The counts above
              come from the run itself and are correct.
            </div>
          )}

          {/* The way forward. When money is the fix and the server priced it,
              the CTA carries that number so the user does not have to guess
              what "enough" means. When it did not — or when the grouped detail
              never arrived — there is STILL a way out: a plain re-run. A
              banner that names a problem and offers nothing is a dead end. */}
          {(() => {
            const moneyIsTheFix = suggestedActions.includes('approve_more_budget');
            const priced = summary.est_cost_to_finish_inr != null;
            const perDocCtaExists = documents.length > 0;
            if (moneyIsTheFix && priced) {
              return (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    className="gap-1.5"
                    disabled={rerunning}
                    onClick={() =>
                      onRerun(
                        Math.ceil(
                          ((summary.est_cost_to_finish_inr as number) * 1.25) / 10,
                        ) * 10,
                      )
                    }
                  >
                    {rerunning ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Wallet className="size-3.5" />
                    )}
                    Run again with more budget
                  </Button>
                  <span className="text-[11px] text-red-800/90 dark:text-red-200/90">
                    Reading the remaining pages should cost about{' '}
                    {formatInr(summary.est_cost_to_finish_inr)}.
                  </span>
                </div>
              );
            }
            if (perDocCtaExists) return null;
            return (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  disabled={rerunning}
                  onClick={() => onRerun()}
                >
                  {rerunning ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  Run the analysis again
                </Button>
                <span className="text-[11px] text-red-800/90 dark:text-red-200/90">
                  You will see the cost and approve a budget before anything runs.
                </span>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
};

const DocRow: React.FC<{
  doc: UnreadableDocGroup;
  estCostToFinishInr: number | null;
  uploadHref?: string;
  onRerun: (suggestedBudgetInr?: number) => void;
  rerunning?: boolean;
}> = ({ doc, estCostToFinishInr, uploadHref, onRerun, rerunning }) => {
  const unreadableCount = (doc.unreadable_page_numbers ?? []).length;
  const fully = doc.total_pages > 0 && unreadableCount >= doc.total_pages;
  return (
    <div className="rounded border border-red-200 dark:border-red-900 bg-white/70 dark:bg-slate-900/50 px-3 py-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate max-w-[26rem]">
            {doc.file_name ?? doc.doc_id.slice(0, 8)}
          </div>
          <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">
            {fully ? (
              <>None of its {doc.total_pages} pages could be read</>
            ) : doc.page_ranges ? (
              <>
                Pages <strong>{doc.page_ranges}</strong> of {doc.total_pages} not
                read
              </>
            ) : (
              <>
                <strong>{unreadableCount}</strong> of {doc.total_pages} pages not
                read
              </>
            )}
            {(doc.reasons ?? []).length > 0 && (
              <>
                {' · '}
                {doc.reasons.map((r) => reasonLabel(r)).join('; ')}
              </>
            )}
          </div>
          {(doc.affected_section_categories ?? []).length > 0 && (
            <div className="text-[11px] text-red-800 dark:text-red-300 mt-0.5">
              Missing from the analysis:{' '}
              {doc.affected_section_categories.map(prettyCategory).join(', ')}
            </div>
          )}
          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            {actionHint(doc.primary_action)}
          </div>
        </div>

        <DocAction
          action={doc.primary_action}
          uploadHref={uploadHref}
          rerunning={rerunning}
          onRerun={() =>
            onRerun(
              doc.primary_action === 'approve_more_budget' &&
                estCostToFinishInr != null
                ? Math.ceil((estCostToFinishInr * 1.25) / 10) * 10
                : undefined,
            )
          }
        />
      </div>
    </div>
  );
};

const DocAction: React.FC<{
  action: UnreadableAction;
  uploadHref?: string;
  onRerun: () => void;
  rerunning?: boolean;
}> = ({ action, uploadHref, onRerun, rerunning }) => {
  if (action === 'reupload_document' || action === 'split_document') {
    if (!uploadHref) {
      return (
        <span className="text-[11px] text-slate-500 dark:text-slate-400 shrink-0">
          {actionLabel(action)}
        </span>
      );
    }
    return (
      <Button asChild type="button" size="sm" variant="outline" className="gap-1.5 shrink-0">
        <a href={uploadHref}>
          <Upload className="size-3.5" />
          {actionLabel(action)}
        </a>
      </Button>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant={action === 'approve_more_budget' ? 'default' : 'outline'}
      className="gap-1.5 shrink-0"
      onClick={onRerun}
      disabled={rerunning}
    >
      {rerunning ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : action === 'approve_more_budget' ? (
        <Wallet className="size-3.5" />
      ) : (
        <RefreshCw className="size-3.5" />
      )}
      {actionLabel(action)}
    </Button>
  );
};

export default UnreadablePagesBanner;
