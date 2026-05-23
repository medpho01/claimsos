import React, { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

/**
 * Wave 9 — captures the human-overrides-failing-rule reason. The
 * rules-v2 backend records the actor, reason, and timestamp.
 */
export interface OverrideRuleDialogProps {
  open: boolean;
  ruleName: string;
  ruleId: string;
  defaultReason?: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
  saving?: boolean;
}

export const OverrideRuleDialog: React.FC<OverrideRuleDialogProps> = ({
  open,
  ruleName,
  ruleId,
  defaultReason = '',
  onClose,
  onConfirm,
  saving = false,
}) => {
  const [reason, setReason] = useState(defaultReason);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason(defaultReason);
      setError(null);
    }
  }, [open, defaultReason]);

  const submit = async () => {
    if (reason.trim().length < 5) {
      setError('Please provide a reason of at least 5 characters.');
      return;
    }
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e: any) {
      setError(e?.message ?? 'Override failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Override rule</DialogTitle>
          <DialogDescription className="text-xs">
            You are accepting a failing rule. Your reason is logged in the audit
            trail and shown to insurers if queried.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wide text-slate-500">
              Rule
            </Label>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mt-0.5">
              {ruleName}
            </div>
            <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              {ruleId}
            </div>
          </div>

          <div>
            <Label htmlFor="override-reason" className="text-xs">
              Justification
            </Label>
            <Textarea
              id="override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              className="mt-1"
              placeholder="Clinical rationale, prior approval, or other compensating evidence…"
            />
          </div>

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving}
            className="gap-2 bg-amber-600 hover:bg-amber-700 text-white"
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default OverrideRuleDialog;
