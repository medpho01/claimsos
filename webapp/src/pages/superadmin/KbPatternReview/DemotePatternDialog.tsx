import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * Wave 5C — KbPatternReview
 *
 * Confirms demotion of a pattern (live → demoted, or candidate →
 * demoted). The Wave 4A controller REQUIRES a reason — the dialog
 * disables the confirm button until one is typed.
 */

export interface DemotePatternDialogProps {
  open: boolean;
  patternTitle: string;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}

export const DemotePatternDialog: React.FC<DemotePatternDialogProps> = ({
  open,
  patternTitle,
  pending,
  onClose,
  onConfirm,
}) => {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    const r = reason.trim();
    if (!r) {
      setError('Reason is required for demotion.');
      return;
    }
    setError(null);
    try {
      await onConfirm(r);
    } catch (e: any) {
      setError(e?.message ?? 'Demote failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="w-full max-w-md rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl">
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center">
          <div>
            <div className="text-sm font-semibold text-red-700 dark:text-red-300">
              Demote pattern
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[320px]">
              {patternTitle}
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
        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Demoting hides this pattern from the adjudicator. Record why —
            this is shown to whoever revisits the queue.
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Required: why is this pattern wrong / stale?"
            className="w-full text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          />
          {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={submit}
            className="text-xs px-3 py-1.5 rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {pending ? 'Demoting…' : 'Demote'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DemotePatternDialog;
