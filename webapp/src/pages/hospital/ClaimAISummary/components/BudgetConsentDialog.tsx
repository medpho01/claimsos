/**
 * BudgetConsentDialog — the pre-flight cost consent gate (contract §B.3/§E.2).
 *
 * Nothing runs until the user approves a number here. The dialog's job is to
 * make the price legible BEFORE any money is spent: how many documents, how
 * many pages, how many of those pages actually need a paid vision read (the
 * rest carry a typed text layer and are free), and what each part costs.
 *
 * Two rules this component exists to enforce:
 *   1. Declining is free and obvious. The secondary action is a real button,
 *      not a corner "x", and the footnote says in plain words that nothing has
 *      been created and nothing will be charged.
 *   2. We never silently clamp. The backend 400s a number outside
 *      [min, max] rather than quietly adjusting it, and so does this form —
 *      an approval the user did not type is not an approval.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import { formatInr, type RunCostEstimate } from './runConsentApi';

export interface BudgetConsentDialogProps {
  open: boolean;
  estimate: RunCostEstimate | null;
  minBudgetInr: number;
  maxBudgetInr: number;
  /** True while the approve POST is in flight. */
  submitting?: boolean;
  /** True while a re-quote (/estimate) is in flight. */
  requoting?: boolean;
  /**
   * Set when the server answered 409 estimate_stale — the document set moved
   * under the quote and the numbers on screen have just been replaced.
   */
  staleNotice?: boolean;
  /** Server-side rejection to show inline (e.g. budget_out_of_range). */
  error?: string | null;
  /**
   * Seed the input with this instead of the recommended budget. Used when the
   * user arrives from an end-of-run "run again with more budget" CTA, where we
   * already know roughly what finishing the unread pages costs.
   */
  prefillBudgetInr?: number | null;
  onApprove: (budgetInr: number) => void | Promise<void>;
  onCancel: () => void;
  onRequote?: () => void | Promise<void>;
}

export const BudgetConsentDialog: React.FC<BudgetConsentDialogProps> = ({
  open,
  estimate,
  minBudgetInr,
  maxBudgetInr,
  submitting = false,
  requoting = false,
  staleNotice = false,
  error,
  prefillBudgetInr,
  onApprove,
  onCancel,
  onRequote,
}) => {
  const [budget, setBudget] = useState<string>('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [showDocs, setShowDocs] = useState(false);

  // Seed (and re-seed after a re-quote) from the recommended budget. Keyed on
  // the estimate token so a fresh quote resets a number the user had typed
  // against the OLD document set — approving that number would be approving
  // a price for work that no longer matches.
  useEffect(() => {
    if (!open || !estimate) return;
    const seed =
      prefillBudgetInr != null && Number.isFinite(prefillBudgetInr)
        ? Math.max(prefillBudgetInr, estimate.recommended_budget_inr)
        : estimate.recommended_budget_inr;
    setBudget(String(seed));
    setLocalError(null);
  }, [open, estimate?.estimate_token, prefillBudgetInr]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = useMemo(() => {
    const n = Number(budget);
    return Number.isFinite(n) ? n : NaN;
  }, [budget]);

  const submit = () => {
    if (!Number.isFinite(parsed)) {
      setLocalError('Enter a budget in rupees.');
      return;
    }
    if (parsed < minBudgetInr || parsed > maxBudgetInr) {
      setLocalError(
        `Budget must be between ${formatInr(minBudgetInr)} and ${formatInr(
          maxBudgetInr,
        )}. Nothing is adjusted for you — type a number in range.`,
      );
      return;
    }
    setLocalError(null);
    void onApprove(parsed);
  };

  const shortfall =
    estimate && Number.isFinite(parsed) && parsed < estimate.total_inr;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !submitting) onCancel();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Sparkles className="size-4 text-indigo-600 dark:text-indigo-300" />
            Approve a budget before this analysis runs
          </DialogTitle>
          <DialogDescription className="text-xs">
            Reading and understanding these documents costs money. Here is what
            it should cost, and why. Nothing runs until you approve.
          </DialogDescription>
        </DialogHeader>

        {!estimate ? (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-500 dark:text-slate-400">
            <Loader2 className="size-4 animate-spin" />
            Working out what this will cost…
          </div>
        ) : (
          <div className="space-y-4">
            {staleNotice && (
              <div className="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
                <AlertTriangle className="size-4 mt-px shrink-0" />
                <span>
                  The documents on this claim changed since the last quote, so
                  the figures below have been recalculated. Please review them
                  again before approving.
                </span>
              </div>
            )}

            {/* What we are about to read */}
            <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                What will be read
              </div>
              <div className="mt-1 text-sm text-slate-800 dark:text-slate-100">
                <strong>{estimate.docs_total}</strong>{' '}
                {estimate.docs_total === 1 ? 'document' : 'documents'} ·{' '}
                <strong>{estimate.pages_total}</strong>{' '}
                {estimate.pages_total === 1 ? 'page' : 'pages'}
              </div>
              <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                <strong>{estimate.pixel_pages_total}</strong>{' '}
                {estimate.pixel_pages_total === 1 ? 'page is' : 'pages are'}{' '}
                scanned or photographed and must be read by the vision model at{' '}
                {formatInr(estimate.est_page_cost_inr)} a page.
                {estimate.typed_pages_total > 0 && (
                  <>
                    {' '}
                    The other {estimate.typed_pages_total} already{' '}
                    {estimate.typed_pages_total === 1 ? 'has' : 'have'} real
                    text in the file and {estimate.typed_pages_total === 1 ? 'is' : 'are'}{' '}
                    free to read.
                  </>
                )}
              </div>
            </div>

            {/* Cost breakdown */}
            <div className="rounded-md border border-slate-200 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700">
              <CostRow
                label={`Reading pages (${estimate.pixel_pages_total} × ${formatInr(
                  estimate.est_page_cost_inr,
                )})`}
                value={estimate.ocr_inr}
              />
              <CostRow
                label="Pulling fields out of each section"
                value={estimate.extraction_inr}
              />
              <CostRow
                label="Splitting and classifying the bundle"
                value={estimate.fixed_inr}
              />
              <CostRow label="Estimated cost" value={estimate.total_inr} emphasise />
              <CostRow
                label="Recommended budget (includes headroom for surprises)"
                value={estimate.recommended_budget_inr}
                emphasise
              />
            </div>

            {estimate.prior_claim_spend_inr > 0 && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Previous runs on this claim have already cost{' '}
                {formatInr(estimate.prior_claim_spend_inr)}.
              </div>
            )}

            {estimate.notes.length > 0 && (
              <ul className="text-xs text-amber-800 dark:text-amber-300 space-y-1 list-disc pl-4">
                {estimate.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}

            {/* Per-document detail */}
            <div>
              <button
                type="button"
                onClick={() => setShowDocs((v) => !v)}
                className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
              >
                {showDocs ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                Per-document breakdown ({estimate.docs.length})
              </button>
              {showDocs && (
                <div className="mt-2 overflow-x-auto rounded-md border border-slate-200 dark:border-slate-700">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-500 dark:text-slate-400">
                      <tr>
                        <th className="text-left font-medium px-3 py-2">Document</th>
                        <th className="text-right font-medium px-3 py-2">Pages</th>
                        <th className="text-right font-medium px-3 py-2">
                          Need reading
                        </th>
                        <th className="text-right font-medium px-3 py-2">Est.</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {estimate.docs.map((d) => (
                        <tr key={d.doc_id}>
                          <td className="px-3 py-2 text-slate-700 dark:text-slate-200">
                            <span className="inline-flex items-center gap-1.5">
                              <FileText className="size-3.5 text-slate-400" />
                              <span className="truncate max-w-[22rem]">
                                {d.file_name ?? d.doc_id.slice(0, 8)}
                              </span>
                            </span>
                            {d.degraded && (
                              <span className="ml-2 text-[10px] text-amber-700 dark:text-amber-300">
                                page count unknown — quoted conservatively
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {d.total_pages}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {d.pixel_pages}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatInr(d.est_total_inr)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* The approval itself */}
            <div className="rounded-md border border-indigo-200 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-950/30 px-4 py-3 space-y-2">
              <Label
                htmlFor="approved-budget"
                className="text-xs font-medium text-indigo-900 dark:text-indigo-100"
              >
                Budget I approve for this run (₹)
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="approved-budget"
                  type="number"
                  inputMode="decimal"
                  min={minBudgetInr}
                  max={maxBudgetInr}
                  step="10"
                  value={budget}
                  disabled={submitting}
                  onChange={(e) => {
                    setBudget(e.target.value);
                    setLocalError(null);
                  }}
                  className="h-9 w-40 bg-white dark:bg-slate-900"
                />
                <span className="text-[11px] text-indigo-800/80 dark:text-indigo-200/80">
                  Allowed range {formatInr(minBudgetInr)} – {formatInr(maxBudgetInr)}.
                  The run stops and asks you again if it would go past this.
                </span>
              </div>
              {shortfall && (
                <div className="text-[11px] text-amber-800 dark:text-amber-300">
                  This is below the {formatInr(estimate.total_inr)} estimate — the
                  run will very likely pause partway and ask you for more.
                </div>
              )}
              {(localError || error) && (
                <div className="text-[11px] text-red-600 dark:text-red-400">
                  {localError ?? error}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {onRequote && estimate && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => void onRequote()}
              disabled={requoting || submitting}
              className="mr-auto gap-2 text-xs"
            >
              <RefreshCw className={cn('size-3.5', requoting && 'animate-spin')} />
              Recalculate
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={submitting}
          >
            Don't run
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={submitting || !estimate}
            className="gap-2"
          >
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {Number.isFinite(parsed)
              ? `Approve ${formatInr(parsed)} and start`
              : 'Approve and start'}
          </Button>
        </DialogFooter>

        <p className="text-[11px] text-slate-500 dark:text-slate-400 -mt-1">
          Nothing has started yet and nothing has been charged. Closing this
          dialog costs nothing.
        </p>
      </DialogContent>
    </Dialog>
  );
};

const CostRow: React.FC<{ label: string; value: number; emphasise?: boolean }> = ({
  label,
  value,
  emphasise,
}) => (
  <div
    className={cn(
      'flex items-baseline justify-between px-4 py-2',
      emphasise && 'bg-slate-50 dark:bg-slate-900/60',
    )}
  >
    <span
      className={cn(
        'text-xs text-slate-600 dark:text-slate-300',
        emphasise && 'font-medium text-slate-800 dark:text-slate-100',
      )}
    >
      {label}
    </span>
    <span
      className={cn(
        'text-xs tabular-nums text-slate-700 dark:text-slate-200',
        emphasise && 'text-sm font-semibold text-slate-900 dark:text-slate-50',
      )}
    >
      {formatInr(value)}
    </span>
  </div>
);

export default BudgetConsentDialog;
