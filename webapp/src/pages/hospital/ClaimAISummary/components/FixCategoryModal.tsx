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
import { SelectField } from '@/components/forms/SelectField';
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
            {/* `components/ui/select.tsx` is a wrapper around a native <select>
                — its popup renders via the browser/OS (AppKit on macOS Chrome)
                and doesn't honour our dark theme or modal styling. Use the
                SelectField primitive instead: it's a button + absolutely-
                positioned listbox panel so the popup is fully under our CSS
                control and matches the rest of the post-UI-revamp surface. */}
            <SelectField
              id="fix-category-select"
              label="New category"
              value={selected}
              placeholder={opts.loading ? 'Loading…' : 'Select a category'}
              disabled={opts.loading}
              onChange={setSelected}
              // doc_category has ~30 entries (and growing — pmjay_card,
              // pmjay_letter, aadhaar_card variants were added in
              // May 2026). A flat scrollable list is painful to navigate;
              // enabling search lets the user type "mri" → instantly
              // narrows to MRI Reports without scrolling.
              searchable
              options={opts.data.map((o) => ({
                value: o.code,
                label: o.label,
              }))}
            />
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
