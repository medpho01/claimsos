import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Wave 2D — Rejection confirmation dialog.
 *
 * Simple centred modal asking for a free-text reason before rejecting an
 * AI draft. The drawer mounts this and wires onSubmit to the rejectDraft
 * mutation from useAiDrafts.
 */
export interface AiDraftRejectionDialogProps {
  isOpen: boolean;
  onSubmit: (reason: string) => void;
  onClose: () => void;
  submitting?: boolean;
}

export const AiDraftRejectionDialog: React.FC<AiDraftRejectionDialogProps> = ({
  isOpen,
  onSubmit,
  onClose,
  submitting,
}) => {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setReason('');
      setTouched(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const trimmed = reason.trim();
  const error = touched && !trimmed ? 'Reason is required' : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <X className="h-4 w-4" />
        </button>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
          Reject AI Draft
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Tell the model why this extraction was wrong. This feeds the eval loop.
        </p>
        <textarea
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="e.g. Amount field captured the deposit, not the approval value."
          className={cn(
            'mt-3 w-full rounded-md border bg-white px-2.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-1 dark:bg-slate-900 dark:text-slate-100',
            error
              ? 'border-red-400 focus:border-red-500 focus:ring-red-300 dark:border-red-500'
              : 'border-slate-200 focus:border-slate-400 focus:ring-slate-300 dark:border-slate-700 dark:focus:border-slate-500 dark:focus:ring-slate-700',
          )}
        />
        {error && (
          <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || !trimmed}
            onClick={() => {
              setTouched(true);
              if (trimmed) onSubmit(trimmed);
            }}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Rejecting…' : 'Confirm Rejection'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AiDraftRejectionDialog;
