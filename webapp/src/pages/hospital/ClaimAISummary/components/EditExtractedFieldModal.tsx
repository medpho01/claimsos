import React, { useState, useEffect } from 'react';
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
 * Step 1c — Per-field human override of an LLM-extracted value.
 *
 * Opened from the SectionRow's JSON viewer when the user clicks the
 * pencil next to a field. Persists via useExtractedFieldCorrection,
 * which targets the new POST /document-sections/:id/fields/:key endpoint.
 *
 * Renders type-aware inputs based on the inferred type of the current
 * value (string/number/date/boolean). For complex nested values (arrays,
 * objects) we fall through to a JSON textarea — the user can paste a
 * corrected JSON blob and we parse before submitting.
 */
export interface EditExtractedFieldModalProps {
  open: boolean;
  sectionId: string;
  fieldKey: string;
  currentValue: unknown;
  /** Document category, surfaced to the user as context. */
  category?: string;
  /** Optional human-friendly label (e.g. "Aadhaar Number"). */
  fieldLabel?: string;
  onClose: () => void;
  onSave: (newValue: unknown, reason: string) => Promise<void> | void;
  saving?: boolean;
}

type InputMode = 'text' | 'number' | 'date' | 'boolean' | 'json' | 'null';

/**
 * Infer the input UI mode from the current value's runtime type. The
 * schema-driven field_type from document_field_schemas would be more
 * authoritative, but plumbing that through every edit-button click is
 * heavier than necessary; inferring from the current value gets the
 * right input in 99% of cases.
 */
function inferInputMode(value: unknown): InputMode {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'object') return 'json';
  if (typeof value === 'string') {
    // ISO date heuristic — fields like date_of_birth/study_date come
    // back as YYYY-MM-DD strings.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  }
  return 'text';
}

export const EditExtractedFieldModal: React.FC<EditExtractedFieldModalProps> = ({
  open,
  sectionId,
  fieldKey,
  currentValue,
  category,
  fieldLabel,
  onClose,
  onSave,
  saving = false,
}) => {
  const initialMode = inferInputMode(currentValue);
  const [mode, setMode] = useState<InputMode>(initialMode);
  const [textValue, setTextValue] = useState<string>('');
  const [boolValue, setBoolValue] = useState<boolean>(
    typeof currentValue === 'boolean' ? currentValue : false,
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reset on (re)open. We don't trust state from a previous open since
  // the section may have changed under us.
  useEffect(() => {
    if (!open) return;
    const m = inferInputMode(currentValue);
    setMode(m);
    setReason('');
    setError(null);
    if (m === 'boolean') {
      setBoolValue(Boolean(currentValue));
      setTextValue('');
    } else if (m === 'json') {
      setTextValue(JSON.stringify(currentValue, null, 2));
    } else if (m === 'null') {
      setTextValue('');
    } else {
      setTextValue(String(currentValue ?? ''));
    }
  }, [open, currentValue]);

  const parseValue = (): { ok: true; value: unknown } | { ok: false; err: string } => {
    if (mode === 'boolean') return { ok: true, value: boolValue };
    if (mode === 'number') {
      if (textValue.trim() === '') return { ok: true, value: null };
      const n = Number(textValue);
      if (Number.isNaN(n)) return { ok: false, err: 'Not a valid number.' };
      return { ok: true, value: n };
    }
    if (mode === 'date') {
      if (textValue.trim() === '') return { ok: true, value: null };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(textValue.trim())) {
        return { ok: false, err: 'Date must be YYYY-MM-DD.' };
      }
      return { ok: true, value: textValue.trim() };
    }
    if (mode === 'json') {
      const t = textValue.trim();
      if (t === '') return { ok: true, value: null };
      try {
        return { ok: true, value: JSON.parse(t) };
      } catch (e: any) {
        return { ok: false, err: `Invalid JSON: ${e?.message ?? e}` };
      }
    }
    // text / null
    return { ok: true, value: textValue.trim() === '' ? null : textValue };
  };

  const submit = async () => {
    setError(null);
    const parsed = parseValue();
    if (!parsed.ok) {
      // TS 4.9 narrowing of the discriminated union doesn't reach this
      // branch reliably — cast keeps the strict check explicit.
      setError((parsed as { ok: false; err: string }).err);
      return;
    }
    try {
      await onSave((parsed as { ok: true; value: unknown }).value, reason.trim());
      onClose();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Save failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">
            Edit extracted field
          </DialogTitle>
          <DialogDescription className="text-xs">
            Your correction overrides the LLM&apos;s value for this field and
            will NOT be overwritten on a future re-run. The system also
            learns from this correction across claims.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="text-xs">
            <div className="text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-0.5">
              Field
            </div>
            <div className="font-mono text-sm text-slate-900 dark:text-slate-100">
              {fieldLabel ?? fieldKey}{' '}
              <span className="text-slate-400 text-[10px]">
                ({fieldKey}
                {category ? ` · ${category}` : ''})
              </span>
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-0.5">
              Current value
            </div>
            <pre className="text-[11px] font-mono bg-slate-50 dark:bg-slate-950 rounded border border-slate-200 dark:border-slate-800 p-2 max-h-24 overflow-auto whitespace-pre-wrap break-words">
              {currentValue === null || currentValue === undefined
                ? '(empty)'
                : typeof currentValue === 'object'
                  ? JSON.stringify(currentValue, null, 2)
                  : String(currentValue)}
            </pre>
          </div>

          <div>
            <Label htmlFor="edit-field-value" className="text-xs">
              New value
            </Label>
            {mode === 'boolean' ? (
              <div className="mt-1 flex items-center gap-3 text-sm">
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={boolValue === true}
                    onChange={() => setBoolValue(true)}
                  />{' '}
                  true
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={boolValue === false}
                    onChange={() => setBoolValue(false)}
                  />{' '}
                  false
                </label>
              </div>
            ) : mode === 'json' ? (
              <Textarea
                id="edit-field-value"
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                rows={6}
                className="mt-1 font-mono text-xs"
                placeholder='{"key": "value"} — JSON only, empty to clear'
              />
            ) : (
              <Input
                id="edit-field-value"
                type={mode === 'number' ? 'number' : mode === 'date' ? 'date' : 'text'}
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                className="mt-1"
                placeholder={mode === 'date' ? 'YYYY-MM-DD' : 'Empty to clear field'}
              />
            )}
            <div className="text-[10px] text-slate-400 mt-1">
              Detected type: <code>{mode}</code>. Leave blank to clear the
              field; this lets the extractor try again on the next re-run.
            </div>
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
              placeholder="Why was the original value wrong? (helps the system learn)"
            />
          </div>

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="text-[10px] text-slate-500 dark:text-slate-400">
            Section <code className="font-mono">{sectionId.slice(0, 8)}…</code>
          </div>
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

export default EditExtractedFieldModal;
