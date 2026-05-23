import React, { useState, useEffect } from 'react';
import { X, PlayCircle } from 'lucide-react';

/**
 * Wave 5C — KbPatternReview
 *
 * Superadmin-only manual trigger of the pattern miner.
 * POST /api/admin/kb-miner/run
 *   body: { sinceDays?: number, maxClaims?: number }
 *
 * The miner is normally scheduled by kbPatternMiner.cron in the worker
 * container; this dialog exists for "run it now after I edited a rule"
 * moments. The Wave 4A controller validates the role server-side too.
 */

export interface RunMinerDialogProps {
  open: boolean;
  pending?: boolean;
  result?: { discovered?: number; updated?: number; scanned?: number } | null;
  onClose: () => void;
  onRun: (opts: { sinceDays?: number; maxClaims?: number }) => Promise<void> | void;
}

export const RunMinerDialog: React.FC<RunMinerDialogProps> = ({
  open,
  pending,
  result,
  onClose,
  onRun,
}) => {
  const [sinceDays, setSinceDays] = useState<number | ''>(30);
  const [maxClaims, setMaxClaims] = useState<number | ''>(500);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setError(null);
    try {
      await onRun({
        sinceDays: typeof sinceDays === 'number' ? sinceDays : undefined,
        maxClaims: typeof maxClaims === 'number' ? maxClaims : undefined,
      });
    } catch (e: any) {
      setError(e?.message ?? 'Miner run failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="w-full max-w-md rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl">
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center">
          <PlayCircle className="h-4 w-4 text-violet-600 dark:text-violet-400 mr-1.5" />
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Run miner manually
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
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Since (days)
              </span>
              <input
                type="number"
                value={sinceDays}
                onChange={(e) =>
                  setSinceDays(e.target.value === '' ? '' : Number(e.target.value))
                }
                className="mt-1 w-full text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Max claims
              </span>
              <input
                type="number"
                value={maxClaims}
                onChange={(e) =>
                  setMaxClaims(e.target.value === '' ? '' : Number(e.target.value))
                }
                className="mt-1 w-full text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </label>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Both fields are optional. Empty falls back to the cron defaults
            (sinceDays=7, maxClaims=2000).
          </p>
          {result && (
            <div className="text-xs rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 px-2 py-1.5">
              Miner finished — scanned {result.scanned ?? 0}, discovered{' '}
              {result.discovered ?? 0}, updated {result.updated ?? 0}.
            </div>
          )}
          {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Close
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={submit}
            className="text-xs px-3 py-1.5 rounded font-medium bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {pending ? 'Running…' : 'Run miner'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RunMinerDialog;
