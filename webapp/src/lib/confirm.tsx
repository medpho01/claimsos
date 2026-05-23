import React, { useState, useCallback, createContext, useContext, useEffect } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';

/**
 * Promise-based confirm() replacement.
 *
 * QA H-5 / FE M-5: `window.confirm()` is synchronous, blocking, ugly, and
 * dark-mode-unaware. The Radix AlertDialog component is declarative + React,
 * which is fine to render but awkward to consume as a one-shot "are you sure?"
 * prompt. This module wraps it in an imperative API.
 *
 * Usage:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Delete file?', destructive: true }))) return;
 *   // ...proceed with destructive action
 *
 * Mount once at the app root via <ConfirmProvider> so the dialog has a
 * stable place in the React tree.
 */

export interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** When true, the confirm button uses a destructive style. */
  destructive?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm: ConfirmFn = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve });
    });
  }, []);

  const handleClose = (result: boolean) => {
    if (pending) {
      pending.resolve(result);
      setPending(null);
    }
  };

  // Close on Escape implicitly via Radix; this is a safety net.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={!!pending} onOpenChange={(open) => { if (!open) handleClose(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title ?? 'Are you sure?'}</AlertDialogTitle>
            {pending?.message && (
              <AlertDialogDescription>{pending.message}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => handleClose(false)}>
              {pending?.cancelText ?? 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleClose(true)}
              className={
                pending?.destructive
                  ? 'bg-danger-600 hover:bg-danger-700 text-white'
                  : undefined
              }
            >
              {pending?.confirmText ?? 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
};

export const useConfirm = (): ConfirmFn => {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>');
  }
  return ctx;
};
