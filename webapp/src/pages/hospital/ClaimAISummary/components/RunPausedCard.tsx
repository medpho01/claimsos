/**
 * RunPausedCard — a run that is parked, and the decision that un-parks it.
 *
 * Two pauses arrive here and they are NOT the same event:
 *
 *   'user_requested'          — the operator hit Pause. One way out: Resume.
 *   'cost_consent_required'   — the server stopped because the next unit of
 *                               work would cross the budget the user approved.
 *                               This is the mid-run half of cost consent, and
 *                               it is a real question with two real answers:
 *                               approve more, or finish with what we have.
 *
 * Deliberately an inline card, not a modal. A modal can be dismissed and then
 * the run is stuck with nothing on screen explaining why nothing is happening.
 * The card stays until the run moves, and the Documents tab stays visible
 * beside it so the partial results are never hidden behind the question.
 */

import React, { useMemo, useState } from 'react';
import { CircleCheck, Loader2, PauseCircle, Wallet } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { IntelligenceRunStatus } from '@/hooks/intelligence/useIntelligenceStatus';

import { formatInr } from './runConsentApi';

export interface RunPausedCardProps {
  run: IntelligenceRunStatus;
  /** Approve more budget and resume. `newTotalInr` is the NEW TOTAL, not a delta. */
  onResumeWithBudget: (newTotalInr: number) => void | Promise<void>;
  /** Plain resume, for a user-requested pause (no budget change). */
  onResume: () => void | Promise<void>;
  /** End the run, keeping partial results. */
  onCancel: (reason: 'budget_declined' | 'user_cancelled') => void | Promise<void>;
  resuming?: boolean;
  cancelling?: boolean;
  error?: string | null;
}

export const RunPausedCard: React.FC<RunPausedCardProps> = ({
  run,
  onResumeWithBudget,
  onResume,
  onCancel,
  resuming = false,
  cancelling = false,
  error,
}) => {
  const forConsent = run.pause_reason === 'cost_consent_required';

  const approvedRaw = run.approved_budget_inr ?? null;
  const spentRaw = run.spend_at_pause_inr ?? run.spend_so_far_inr ?? null;
  const approved = approvedRaw ?? 0;
  const spent = spentRaw ?? 0;
  const remaining = run.projected_remaining_inr ?? null;
  // "You approved ₹0 and ₹0 has been spent" is a lie dressed up as a fact.
  // Only tell the money story when the server actually sent the money.
  const knowsMoney = approvedRaw != null && spentRaw != null;
  // The server computes the suggestion (remaining × 1.25, rounded up to ₹10).
  // Fall back to the same arithmetic only if an older backend omits it.
  const suggestedAdditional = useMemo(() => {
    if (run.suggested_additional_budget_inr != null) {
      return Number(run.suggested_additional_budget_inr);
    }
    if (remaining != null) return Math.ceil((remaining * 1.25) / 10) * 10;
    return null;
  }, [run.suggested_additional_budget_inr, remaining]);

  // When the server could not suggest a number, the suggested-amount button is
  // disabled — so the custom field IS the primary action and must be visible,
  // not hidden behind a link.
  const [customOpen, setCustomOpen] = useState(
    () => run.pause_reason === 'cost_consent_required' && suggestedAdditional == null,
  );
  const [customAdditional, setCustomAdditional] = useState<string>('');
  const [localError, setLocalError] = useState<string | null>(null);

  const busy = resuming || cancelling;

  const approveSuggested = () => {
    if (suggestedAdditional == null) return;
    setLocalError(null);
    void onResumeWithBudget(approved + suggestedAdditional);
  };

  const approveCustom = () => {
    const extra = Number(customAdditional);
    if (!Number.isFinite(extra) || extra <= 0) {
      setLocalError('Enter how much more you want to approve, in rupees.');
      return;
    }
    setLocalError(null);
    void onResumeWithBudget(approved + extra);
  };

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {forConsent ? (
            <Wallet className="size-4 text-amber-700 dark:text-amber-300" />
          ) : (
            <PauseCircle className="size-4 text-amber-700 dark:text-amber-300" />
          )}
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          <div className="text-sm font-medium text-amber-900 dark:text-amber-100">
            {forConsent
              ? 'Paused — this run needs more budget'
              : 'Paused by you'}
          </div>

          {forConsent ? (
            <div className="text-xs text-amber-900/90 dark:text-amber-200/90 leading-relaxed">
              {knowsMoney ? (
                <>
                  You approved <strong>{formatInr(approved)}</strong> for this run
                  and <strong>{formatInr(spent)}</strong> has been spent.
                </>
              ) : (
                <>
                  This run reached the budget that was approved for it and
                  stopped before spending any more.
                </>
              )}
              {remaining != null && (
                <>
                  {' '}
                  About <strong>{formatInr(remaining)}</strong> of work is left —
                  pages still to read and sections still to extract.
                </>
              )}{' '}
              Nothing new will start until you decide. Everything already
              analysed is kept either way.
            </div>
          ) : (
            <div className="text-xs text-amber-900/90 dark:text-amber-200/90 leading-relaxed">
              Nothing new is being started. Work that was already in flight when
              you paused has finished and is counted.
              {knowsMoney && (
                <>
                  {' '}
                  Spent so far {formatInr(spent)} of {formatInr(approved)} approved.
                </>
              )}{' '}
              Resuming picks up exactly where it stopped — completed documents
              are not re-done.
            </div>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-amber-800/80 dark:text-amber-200/80">
            <span>
              Documents {run.docs_completed}/{run.total_docs}
              {run.docs_failed > 0 && ` · ${run.docs_failed} failed`}
            </span>
            {run.phase && <span>Stopped during: {String(run.phase).replaceAll('_', ' ')}</span>}
            {run.paused_at && (
              <span>Paused {new Date(run.paused_at).toLocaleString()}</span>
            )}
            {(run.resume_count ?? 0) > 0 && (
              <span>Resumed {run.resume_count} time{run.resume_count === 1 ? '' : 's'}</span>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {forConsent ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  onClick={approveSuggested}
                  disabled={busy || suggestedAdditional == null}
                >
                  {resuming ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Wallet className="size-3.5" />
                  )}
                  {suggestedAdditional != null
                    ? `Approve ${formatInr(suggestedAdditional)} more`
                    : 'Approve more budget'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1.5 bg-white/70 dark:bg-slate-900/60"
                  onClick={() => void onCancel('budget_declined')}
                  disabled={busy}
                >
                  {cancelling ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <CircleCheck className="size-3.5" />
                  )}
                  Finish with what we have
                </Button>
                <button
                  type="button"
                  className="text-[11px] underline text-amber-900/80 dark:text-amber-200/80 hover:text-amber-950 dark:hover:text-amber-100"
                  onClick={() => setCustomOpen((v) => !v)}
                  disabled={busy}
                >
                  Approve a different amount
                </button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => void onResume()}
                  disabled={busy || run.can_resume === false}
                >
                  {resuming ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <PauseCircle className="size-3.5" />
                  )}
                  Resume
                </Button>
                {run.can_cancel !== false && (
                  <button
                    type="button"
                    className="text-[11px] underline text-amber-900/80 dark:text-amber-200/80 hover:text-amber-950 dark:hover:text-amber-100"
                    onClick={() => void onCancel('user_cancelled')}
                    disabled={busy}
                  >
                    End the run and keep what we have
                  </button>
                )}
              </>
            )}
          </div>

          {customOpen && forConsent && (
            <div className="flex flex-wrap items-end gap-2 pt-1">
              <div className="space-y-1">
                <Label
                  htmlFor="additional-budget"
                  className="text-[11px] text-amber-900 dark:text-amber-100"
                >
                  Additional budget (₹)
                </Label>
                <Input
                  id="additional-budget"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  step="10"
                  value={customAdditional}
                  disabled={busy}
                  onChange={(e) => {
                    setCustomAdditional(e.target.value);
                    setLocalError(null);
                  }}
                  className="h-8 w-32 bg-white dark:bg-slate-900"
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={approveCustom}
                disabled={busy}
              >
                Approve and resume
              </Button>
              <span className="text-[11px] text-amber-800/80 dark:text-amber-200/80">
                New total would be{' '}
                {formatInr(approved + (Number(customAdditional) || 0))}.
              </span>
            </div>
          )}

          {(localError || error) && (
            <div className="text-[11px] text-red-700 dark:text-red-400">
              {localError ?? error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default RunPausedCard;
