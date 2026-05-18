import React, { useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMasterOptions } from '@/hooks/intelligence/useMasterOptions';

/**
 * Wave 2D — AI Draft Extraction Editor.
 *
 * Renders an editable form keyed off the draft category. Each category maps
 * to a different field shape (approvals carry an amount + room class, queries
 * carry a list of deficiencies, etc.). The component is uncontrolled-style:
 * call `onChange` with the next snapshot whenever a field updates.
 *
 * The shape of `extractedPayload` is intentionally permissive (`any`) — the
 * Wave 2A/2B contracts are not finalised, so the editor treats unknown fields
 * leniently and falls back to a JSON editor for `other`/`unknown`.
 */

export type AiDraftCategory =
  | 'approved'
  | 'partially_approved'
  | 'enhancement_approved'
  | 'enhancement_partially_approved'
  | 'queried'
  | 'follow_up'
  | 'rejected'
  | 'withdrawn'
  | 'other'
  | 'unknown'
  | string;

export interface AiDraftExtractionEditorProps {
  category: AiDraftCategory;
  extractedPayload: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
  readOnly?: boolean;
  /** Original (server) payload, for dirty detection. Optional. */
  originalPayload?: Record<string, any>;
  className?: string;
}

// ---------- helpers ----------------------------------------------------------

const isApprovalLike = (c: string) =>
  c === 'approved' ||
  c === 'partially_approved' ||
  c === 'enhancement_approved' ||
  c === 'enhancement_partially_approved';

const isQueryLike = (c: string) => c === 'queried' || c === 'follow_up';

const isRejectionLike = (c: string) => c === 'rejected' || c === 'withdrawn';

const shallowEqual = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

const labelCls =
  'text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400';
const inputCls =
  'w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300 disabled:bg-slate-50 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-slate-500 dark:focus:ring-slate-700 dark:disabled:bg-slate-800/40';

const Field: React.FC<{
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}> = ({ label, required, error, children }) => (
  <label className="block space-y-1">
    <span className={labelCls}>
      {label}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </span>
    {children}
    {error && (
      <span className="block text-[11px] text-red-600 dark:text-red-400">{error}</span>
    )}
  </label>
);

// ---------- approval editor --------------------------------------------------

const ApprovalEditor: React.FC<{
  payload: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
  readOnly?: boolean;
}> = ({ payload, onChange, readOnly }) => {
  const set = (k: string, v: any) => onChange({ ...payload, [k]: v });
  const amount = payload.amount_inr ?? '';
  const room = payload.room_category ?? '';
  const from = payload.validity_from ?? '';
  const to = payload.validity_to ?? '';
  const notes = payload.notes ?? '';

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount (INR)" required error={amount === '' ? undefined : undefined}>
          <div className="relative">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">
              ₹
            </span>
            <input
              type="number"
              min={0}
              step={1}
              value={amount}
              disabled={readOnly}
              onChange={(e) =>
                set('amount_inr', e.target.value === '' ? '' : Number(e.target.value))
              }
              className={cn(inputCls, 'pl-6')}
              placeholder="0"
            />
          </div>
        </Field>
        <Field label="Room Category">
          <input
            type="text"
            value={room}
            disabled={readOnly}
            onChange={(e) => set('room_category', e.target.value)}
            className={inputCls}
            placeholder="e.g. Single Standard"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Validity From" required>
          <input
            type="date"
            value={from}
            disabled={readOnly}
            onChange={(e) => set('validity_from', e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Validity To" required>
          <input
            type="date"
            value={to}
            disabled={readOnly}
            onChange={(e) => set('validity_to', e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>
      <Field label="Notes">
        <textarea
          value={notes}
          disabled={readOnly}
          rows={3}
          onChange={(e) => set('notes', e.target.value)}
          className={cn(inputCls, 'resize-y')}
          placeholder="Optional internal note"
        />
      </Field>
    </div>
  );
};

// ---------- query editor -----------------------------------------------------

interface QueryRow {
  description?: string;
  deficiency_type?: string;
  doc_requested?: string;
  deadline?: string;
}

const QueryEditor: React.FC<{
  payload: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
  readOnly?: boolean;
}> = ({ payload, onChange, readOnly }) => {
  const queries: QueryRow[] = Array.isArray(payload.queries) ? payload.queries : [];
  const { data: deficiencyOptions } = useMasterOptions('deficiency_type');

  const update = (next: QueryRow[]) => onChange({ ...payload, queries: next });

  const setRow = (idx: number, patch: Partial<QueryRow>) => {
    const next = queries.map((q, i) => (i === idx ? { ...q, ...patch } : q));
    update(next);
  };
  const removeRow = (idx: number) => update(queries.filter((_, i) => i !== idx));
  const addRow = () =>
    update([
      ...queries,
      { description: '', deficiency_type: '', doc_requested: '', deadline: '' },
    ]);

  return (
    <div className="space-y-3">
      {queries.length === 0 && (
        <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 p-3 text-xs text-slate-500 dark:text-slate-400">
          No queries yet. Click <em>Add query</em> to create one.
        </div>
      )}
      {queries.map((q, idx) => (
        <div
          key={idx}
          className="rounded-md border border-slate-200 dark:border-slate-800 p-3 space-y-2 bg-slate-50/50 dark:bg-slate-900/40"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Query #{idx + 1}
            </span>
            {!readOnly && (
              <button
                type="button"
                onClick={() => removeRow(idx)}
                className="inline-flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400 hover:underline"
              >
                <Trash2 className="h-3 w-3" /> Remove
              </button>
            )}
          </div>
          <Field
            label="Description"
            required
            error={!q.description ? 'Description is required' : undefined}
          >
            <textarea
              rows={2}
              value={q.description ?? ''}
              disabled={readOnly}
              onChange={(e) => setRow(idx, { description: e.target.value })}
              className={cn(inputCls, 'resize-y')}
              placeholder="What is the insurer asking for?"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Deficiency Type">
              <select
                value={q.deficiency_type ?? ''}
                disabled={readOnly}
                onChange={(e) => setRow(idx, { deficiency_type: e.target.value })}
                className={inputCls}
              >
                <option value="">— select —</option>
                {deficiencyOptions.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Document Requested">
              <input
                type="text"
                value={q.doc_requested ?? ''}
                disabled={readOnly}
                onChange={(e) => setRow(idx, { doc_requested: e.target.value })}
                className={inputCls}
                placeholder="e.g. Final bill copy"
              />
            </Field>
          </div>
          <Field
            label="Deadline"
            error={
              q.deadline && Number.isNaN(new Date(q.deadline).getTime())
                ? 'Invalid date'
                : undefined
            }
          >
            <input
              type="date"
              value={q.deadline ?? ''}
              disabled={readOnly}
              onChange={(e) => setRow(idx, { deadline: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-slate-300 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60"
        >
          <Plus className="h-3.5 w-3.5" /> Add query
        </button>
      )}
    </div>
  );
};

// ---------- rejection editor -------------------------------------------------

interface DeductionRow {
  reason?: string;
  amount?: number;
}

const RejectionEditor: React.FC<{
  payload: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
  readOnly?: boolean;
}> = ({ payload, onChange, readOnly }) => {
  const reasons: string[] = Array.isArray(payload.reasons) ? payload.reasons : [];
  const deductions: DeductionRow[] = Array.isArray(payload.deduction_breakdown)
    ? payload.deduction_breakdown
    : [];
  const appealAllowed = !!payload.appeal_allowed;
  const finalityNote = payload.finality_note ?? '';
  const { data: deductionOptions } = useMasterOptions('deduction_reason');

  const setReason = (idx: number, v: string) => {
    onChange({
      ...payload,
      reasons: reasons.map((r, i) => (i === idx ? v : r)),
    });
  };
  const addReason = () => onChange({ ...payload, reasons: [...reasons, ''] });
  const removeReason = (idx: number) =>
    onChange({ ...payload, reasons: reasons.filter((_, i) => i !== idx) });

  const setDeduction = (idx: number, patch: Partial<DeductionRow>) =>
    onChange({
      ...payload,
      deduction_breakdown: deductions.map((d, i) => (i === idx ? { ...d, ...patch } : d)),
    });
  const addDeduction = () =>
    onChange({
      ...payload,
      deduction_breakdown: [...deductions, { reason: '', amount: 0 }],
    });
  const removeDeduction = (idx: number) =>
    onChange({
      ...payload,
      deduction_breakdown: deductions.filter((_, i) => i !== idx),
    });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className={labelCls}>Reasons</span>
          {!readOnly && (
            <button
              type="button"
              onClick={addReason}
              className="inline-flex items-center gap-1 text-[11px] text-slate-700 dark:text-slate-200 hover:underline"
            >
              <Plus className="h-3 w-3" /> Add
            </button>
          )}
        </div>
        {reasons.length === 0 && (
          <div className="text-xs text-slate-500 dark:text-slate-400 italic">
            No reasons captured.
          </div>
        )}
        {reasons.map((r, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input
              type="text"
              value={r}
              disabled={readOnly}
              onChange={(e) => setReason(idx, e.target.value)}
              className={inputCls}
              placeholder="Reason text"
            />
            {!readOnly && (
              <button
                type="button"
                onClick={() => removeReason(idx)}
                className="text-red-600 dark:text-red-400 hover:opacity-80"
                aria-label="Remove reason"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className={labelCls}>Deduction Breakdown</span>
          {!readOnly && (
            <button
              type="button"
              onClick={addDeduction}
              className="inline-flex items-center gap-1 text-[11px] text-slate-700 dark:text-slate-200 hover:underline"
            >
              <Plus className="h-3 w-3" /> Add
            </button>
          )}
        </div>
        {deductions.length === 0 && (
          <div className="text-xs text-slate-500 dark:text-slate-400 italic">
            No deductions captured.
          </div>
        )}
        {deductions.map((d, idx) => (
          <div key={idx} className="grid grid-cols-[1fr_120px_24px] items-end gap-2">
            <Field label="Reason">
              <select
                value={d.reason ?? ''}
                disabled={readOnly}
                onChange={(e) => setDeduction(idx, { reason: e.target.value })}
                className={inputCls}
              >
                <option value="">— select —</option>
                {deductionOptions.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount (INR)">
              <input
                type="number"
                min={0}
                value={d.amount ?? 0}
                disabled={readOnly}
                onChange={(e) =>
                  setDeduction(idx, { amount: Number(e.target.value || 0) })
                }
                className={inputCls}
              />
            </Field>
            {!readOnly && (
              <button
                type="button"
                onClick={() => removeDeduction(idx)}
                className="text-red-600 dark:text-red-400 pb-2"
                aria-label="Remove deduction"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={appealAllowed}
          disabled={readOnly}
          onChange={(e) => onChange({ ...payload, appeal_allowed: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 dark:border-slate-600"
        />
        Appeal allowed
      </label>

      <Field label="Finality Note">
        <textarea
          rows={2}
          value={finalityNote}
          disabled={readOnly}
          onChange={(e) => onChange({ ...payload, finality_note: e.target.value })}
          className={cn(inputCls, 'resize-y')}
        />
      </Field>
    </div>
  );
};

// ---------- generic JSON editor (other/unknown) ------------------------------

const RawJsonEditor: React.FC<{
  payload: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
  readOnly?: boolean;
}> = ({ payload, onChange, readOnly }) => {
  const [text, setText] = React.useState(() => JSON.stringify(payload, null, 2));
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Keep text in sync if parent resets payload reference (e.g. on reset).
    setText(JSON.stringify(payload, null, 2));
  }, [payload]);

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-amber-600 dark:text-amber-400">
        TODO: Wave 2A/2B will finalise the payload shape per category. For now,
        unknown categories use a raw JSON editor.
      </div>
      <textarea
        rows={12}
        value={text}
        disabled={readOnly}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value);
            setErr(null);
            onChange(parsed);
          } catch (ex: any) {
            setErr(ex?.message ?? 'Invalid JSON');
          }
        }}
        className={cn(inputCls, 'font-mono text-xs resize-y')}
      />
      {err && <div className="text-[11px] text-red-600 dark:text-red-400">{err}</div>}
    </div>
  );
};

// ---------- main component ---------------------------------------------------

export const AiDraftExtractionEditor: React.FC<AiDraftExtractionEditorProps> = ({
  category,
  extractedPayload,
  onChange,
  readOnly,
  originalPayload,
  className,
}) => {
  const dirty = useMemo(
    () => (originalPayload ? !shallowEqual(originalPayload, extractedPayload) : false),
    [originalPayload, extractedPayload],
  );

  let editor: React.ReactNode;
  if (isApprovalLike(category)) {
    editor = (
      <ApprovalEditor
        payload={extractedPayload}
        onChange={onChange}
        readOnly={readOnly}
      />
    );
  } else if (isQueryLike(category)) {
    editor = (
      <QueryEditor payload={extractedPayload} onChange={onChange} readOnly={readOnly} />
    );
  } else if (isRejectionLike(category)) {
    editor = (
      <RejectionEditor
        payload={extractedPayload}
        onChange={onChange}
        readOnly={readOnly}
      />
    );
  } else {
    editor = (
      <RawJsonEditor
        payload={extractedPayload}
        onChange={onChange}
        readOnly={readOnly}
      />
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          AI Extraction
        </h3>
        {dirty && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
            Modified
          </span>
        )}
      </div>
      {editor}
    </div>
  );
};

export default AiDraftExtractionEditor;
