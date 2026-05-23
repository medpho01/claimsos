import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * Wave 5C — KbPatternReview
 *
 * Confirms promotion of a candidate pattern to `live`. The reason is
 * optional on promote (per Wave 4A controller) but the UI nudges
 * reviewers to leave a justification for the audit trail.
 */

export interface PromotePatternDialogProps {
  open: boolean;
  patternTitle: string;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}

export const PromotePatternDialog: React.FC<PromotePatternDialogProps> = ({
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
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (e: any) {
      setError(e?.message ?? 'Promote failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="w-full max-w-md rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl">
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center">
          <div>
            <div className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
              Promote pattern
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
            Promoting moves this pattern to <span className="font-semibold">live</span> so the
            adjudicator will use it. Leave a short note for the audit trail.
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Optional reason / evidence summary…"
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
            disabled={pending}
            onClick={submit}
            className="text-xs px-3 py-1.5 rounded font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {pending ? 'Promoting…' : 'Promote'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PromotePatternDialog;
