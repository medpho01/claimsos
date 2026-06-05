import React from 'react';
import { ListChecks, FileWarning, Check, X, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { useClaimNextSteps, type ClaimAction } from '@/hooks/intelligence/useClaimNextSteps';

/**
 * Next Steps — the pending action items for THIS claim (e.g. documents the
 * insurer requested in a query email). Sourced from claim_actions; today these
 * otherwise only live in the global /hospital/actions queue. Auto-hides when
 * nothing is outstanding.
 */

const prettyType = (t?: string | null): string | null => {
  if (!t) return null;
  return t.replace(/^missing_/, '').replace(/_/g, ' ');
};

const NextStepsCard: React.FC<{ claimId: string }> = ({ claimId }) => {
  const steps = useClaimNextSteps(claimId);
  const list = steps.data ?? [];

  if (!steps.loading && list.length === 0) return null;

  const onDone = async (a: ClaimAction) => {
    try {
      await steps.markDone(a.id, { via: 'claim_next_steps' });
      toast.success('Marked done');
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Failed to update');
    }
  };

  const onDismiss = async (a: ClaimAction) => {
    try {
      await steps.dismiss(a.id, 'Dismissed from claim Next Steps');
      toast.success('Dismissed');
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Failed to dismiss');
    }
  };

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900/60 dark:bg-amber-950/20">
      <div className="mb-3 flex items-center gap-2">
        <ListChecks className="size-4 text-amber-600" />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Next Steps
        </h3>
        {list.length > 0 && (
          <span className="rounded-full bg-amber-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {list.length}
          </span>
        )}
        <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400">
          Action items requested by the insurer
        </span>
      </div>

      {steps.loading ? (
        <div className="h-12 animate-pulse rounded bg-amber-100/70 dark:bg-amber-900/30" />
      ) : (
        <ul className="space-y-2">
          {list.map((a) => {
            const doc = a.payload?.doc_requested || a.payload?.description || 'Document requested';
            const type = prettyType(a.payload?.deficiency_type);
            return (
              <li
                key={a.id}
                className="flex items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900"
              >
                <FileWarning className="size-4 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-slate-900 dark:text-slate-100">
                    Send: {doc}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400">
                    {type && (
                      <span className="rounded bg-amber-100 px-1 py-0.5 capitalize text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                        {type}
                      </span>
                    )}
                    {a.payload?.source_inbound_id && (
                      <span className="inline-flex items-center gap-0.5">
                        <Mail className="size-2.5" /> from insurer email
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={steps.isBusy}
                  onClick={() => onDone(a)}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  title="Mark this item as done"
                >
                  <Check className="size-3" /> Done
                </button>
                <button
                  type="button"
                  disabled={steps.isBusy}
                  onClick={() => onDismiss(a)}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  title="Dismiss this item"
                >
                  <X className="size-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default NextStepsCard;
