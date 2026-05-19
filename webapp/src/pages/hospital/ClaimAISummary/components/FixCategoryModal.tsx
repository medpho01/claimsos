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
import { useMasterOptions } from '@/hooks/intelligence';

/**
 * Wave 9 — re-assign the category of a document section when the
 * classifier got it wrong. Backed by useMasterOptions('doc_category')
 * so the dropdown always matches the live ontology.
 */
export interface FixCategoryModalProps {
  open: boolean;
  sectionId: string;
  currentCategory?: string;
  /** Document file name, surfaced for context. */
  documentName?: string;
  onClose: () => void;
  onSave: (newCategory: string, reason: string) => Promise<void> | void;
  saving?: boolean;
}

export const FixCategoryModal: React.FC<FixCategoryModalProps> = ({
  open,
  sectionId,
  currentCategory,
  documentName,
  onClose,
  onSave,
  saving = false,
}) => {
  const opts = useMasterOptions('doc_category');
  const [selected, setSelected] = useState<string>(currentCategory ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelected(currentCategory ?? '');
      setReason('');
      setError(null);
    }
  }, [open, currentCategory]);

  const submit = async () => {
    if (!selected) {
      setError('Please choose a category.');
      return;
    }
    if (selected === currentCategory) {
      setError('Choose a different category from the current one.');
      return;
    }
    setError(null);
    try {
      await onSave(selected, reason.trim());
      onClose();
    } catch (e: any) {
      setError(e?.message ?? 'Save failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Fix document category</DialogTitle>
          <DialogDescription className="text-xs">
            Re-assign this section to the correct category. The classifier
            will learn from this correction over time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {documentName && (
            <div>
              <Label className="text-xs uppercase tracking-wide text-slate-500">
                Document
              </Label>
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mt-0.5 truncate">
                {documentName}
              </div>
            </div>
          )}
          <div>
            <Label className="text-xs uppercase tracking-wide text-slate-500">
              Section
            </Label>
            <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              {sectionId}
            </div>
            {currentCategory && (
              <div className="text-xs text-slate-700 dark:text-slate-200 mt-1">
                Currently:{' '}
                <code className="text-[11px] bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                  {currentCategory}
                </code>
              </div>
            )}
          </div>

          <div>
            <Label htmlFor="fix-category-select" className="text-xs">
              New category
            </Label>
            <select
              id="fix-category-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm py-2 px-3 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            >
              <option value="" disabled>
                {opts.loading ? 'Loading…' : 'Select a category'}
              </option>
              {opts.data.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="fix-category-reason" className="text-xs">
              Reason (optional)
            </Label>
            <Textarea
              id="fix-category-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="mt-1"
              placeholder="Why was the original classification wrong?"
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
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default FixCategoryModal;
