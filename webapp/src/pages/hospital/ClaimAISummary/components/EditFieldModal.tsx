import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
 * Wave 9 — generic edit modal used by the HarmonisedEpisodePanel to let
 * a human override an AI-extracted field. Input type is inferred from
 * `fieldType` and falls back to a text input.
 */
export type EditFieldType = 'text' | 'number' | 'date' | 'datetime-local' | 'textarea';

export interface EditFieldModalProps {
  open: boolean;
  label: string;
  /** Dotted/json-path location of the field — shown in the helper text. */
  fieldPath?: string;
  currentValue: any;
  fieldType?: EditFieldType;
  onClose: () => void;
  onSave: (newValue: any, reason: string) => Promise<void> | void;
  saving?: boolean;
}

export const EditFieldModal: React.FC<EditFieldModalProps> = ({
  open,
  label,
  fieldPath,
  currentValue,
  fieldType = 'text',
  onClose,
  onSave,
  saving = false,
}) => {
  const [value, setValue] = useState<string>(stringifyForInput(currentValue));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reset state when the modal re-opens for a different field.
  React.useEffect(() => {
    if (open) {
      setValue(stringifyForInput(currentValue));
      setReason('');
      setError(null);
    }
  }, [open, currentValue]);

  const submit = async () => {
    setError(null);
    try {
      const coerced = coerce(value, fieldType);
      await onSave(coerced, reason.trim());
      onClose();
    } catch (e: any) {
      setError(e?.message ?? 'Save failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Edit field</DialogTitle>
          <DialogDescription className="text-xs">
            Your correction overrides the AI-extracted value and is recorded in the
            audit trail.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wide text-slate-500">
              Field
            </Label>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mt-0.5">
              {label}
            </div>
            {fieldPath && (
              <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                {fieldPath}
              </div>
            )}
          </div>

          <div>
            <Label htmlFor="edit-field-value" className="text-xs">
              New value
            </Label>
            {fieldType === 'textarea' ? (
              <Textarea
                id="edit-field-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                rows={4}
                className="mt-1"
              />
            ) : (
              <Input
                id="edit-field-value"
                type={
                  fieldType === 'number'
                    ? 'number'
                    : fieldType === 'date'
                      ? 'date'
                      : fieldType === 'datetime-local'
                        ? 'datetime-local'
                        : 'text'
                }
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="mt-1"
              />
            )}
          </div>

          <div>
            <Label htmlFor="edit-field-reason" className="text-xs">
              Reason (optional)
            </Label>
            <Textarea
              id="edit-field-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="mt-1"
              placeholder="Why is this change needed?"
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
          <Button onClick={submit} disabled={saving} className="gap-2">
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Save correction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const stringifyForInput = (v: any): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const coerce = (raw: string, type: EditFieldType): any => {
  if (type === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error('Value must be a number');
    return n;
  }
  return raw;
};

export default EditFieldModal;
