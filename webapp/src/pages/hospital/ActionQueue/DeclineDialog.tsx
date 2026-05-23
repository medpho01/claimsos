import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * Sprint 3, Wave 3C — ActionQueue sub-component.
 *
 * Generic decline dialog used across all action kinds. Modelled after
 * AiDraftRejectionDialog (Wave 2C) but kind-agnostic — same surface for
 * "decline this document request" and "decline this approval".
 *
 * Reason is required (>= 4 chars). The submit handler is async; the
 * dialog disables its buttons while in-flight.
 */
export interface DeclineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Async — parent typically calls declineAction(id, reason). */
  onConfirm: (reason: string) => Promise<void> | void;
  /** Used in the dialog title — e.g. "Document request". */
  actionTitle?: string;
}

export const DeclineDialog: React.FC<DeclineDialogProps> = ({
  open,
  onOpenChange,
  onConfirm,
  actionTitle,
}) => {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setReason('');
    setError(null);
    setSubmitting(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    if (reason.trim().length < 4) {
      setError('Please provide a brief reason (at least 4 characters).');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onOpenChange(false);
      reset();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to decline.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Decline {actionTitle ?? 'action'}
          </DialogTitle>
          <DialogDescription>
            Tell us why this isn't applicable. The reason is recorded on the
            action and used to tune the engine.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          placeholder="e.g. patient discharged early; document not required"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          disabled={submitting}
        />
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={submitting || reason.trim().length < 4}
          >
            {submitting ? 'Declining…' : 'Decline'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
