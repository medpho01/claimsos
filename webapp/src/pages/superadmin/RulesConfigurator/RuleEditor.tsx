import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useMasterOptions } from '@/hooks/intelligence/useMasterOptions';
import { StageRequirement } from '@/hooks/intelligence/useStageRequirements';
import { cn } from '@/lib/utils';

/**
 * Wave 5C — RulesConfigurator
 *
 * Modal form for creating or editing a stage requirement (rule).
 * Maps onto the Wave 3A schema:
 *   rule_key, target_stage, required_doc_category, required_fields[],
 *   severity, scope { global, panel_id, insurer_id, procedure_code,
 *   diagnosis_class }, version.
 *
 * The required_doc_category dropdown is driven by useMasterOptions
 * (category='doc_category'). target_stage is master-options-driven too
 * (category='stage').
 */

export interface RuleFormValue {
  id?: string;
  rule_key: string;
  target_stage: string;
  required_doc_category: string;
  required_fields: string[];
  severity: 'blocker' | 'warning' | 'info';
  scope: {
    global?: boolean;
    panel_id?: string;
    insurer_id?: string;
    procedure_code?: string;
    diagnosis_class?: string;
  };
  is_active?: boolean;
  version?: number;
}

export interface RuleEditorProps {
  open: boolean;
  initial?: Partial<RuleFormValue> | StageRequirement | null;
  onClose: () => void;
  onSubmit: (value: RuleFormValue) => Promise<void> | void;
  pending?: boolean;
}

const EMPTY: RuleFormValue = {
  rule_key: '',
  target_stage: '',
  required_doc_category: '',
  required_fields: [],
  severity: 'warning',
  scope: { global: true },
  is_active: true,
};

function fromInitial(i: RuleEditorProps['initial']): RuleFormValue {
  if (!i) return { ...EMPTY };
  const anyI = i as any;
  return {
    id: anyI.id,
    rule_key: anyI.rule_key ?? anyI.stage_key ?? '',
    target_stage: anyI.target_stage ?? anyI.stage_key ?? '',
    required_doc_category: anyI.required_doc_category ?? '',
    required_fields: Array.isArray(anyI.required_fields) ? anyI.required_fields : [],
    severity: anyI.severity ?? 'warning',
    scope: {
      global:
        !anyI.scope?.panel_id &&
        !anyI.scope?.insurer_id &&
        !anyI.scope?.procedure_code &&
        !anyI.scope?.diagnosis_class,
      panel_id: anyI.scope?.panel_id ?? '',
      insurer_id: anyI.scope?.insurer_id ?? '',
      procedure_code: anyI.scope?.procedure_code ?? '',
      diagnosis_class: anyI.scope?.diagnosis_class ?? '',
    },
    is_active: anyI.is_active !== false,
    version: anyI.version,
  };
}

export const RuleEditor: React.FC<RuleEditorProps> = ({
  open,
  initial,
  onClose,
  onSubmit,
  pending,
}) => {
  const [v, setV] = useState<RuleFormValue>(() => fromInitial(initial));
  const [fieldInput, setFieldInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stages = useMasterOptions('stage');
  const docCats = useMasterOptions('doc_category');

  useEffect(() => {
    if (open) {
      setV(fromInitial(initial));
      setFieldInput('');
      setError(null);
    }
  }, [open, initial]);

  if (!open) return null;

  const update = (patch: Partial<RuleFormValue>) => setV((s) => ({ ...s, ...patch }));
  const updateScope = (patch: Partial<RuleFormValue['scope']>) =>
    setV((s) => ({ ...s, scope: { ...s.scope, ...patch } }));

  const addField = () => {
    const f = fieldInput.trim();
    if (!f) return;
    if (v.required_fields.includes(f)) return;
    update({ required_fields: [...v.required_fields, f] });
    setFieldInput('');
  };

  const removeField = (f: string) =>
    update({ required_fields: v.required_fields.filter((x) => x !== f) });

  const handleSubmit = async () => {
    setError(null);
    if (!v.rule_key.trim() || !v.target_stage || !v.required_doc_category) {
      setError('rule_key, target_stage, and required_doc_category are required.');
      return;
    }
    const cleaned: RuleFormValue = {
      ...v,
      rule_key: v.rule_key.trim(),
      scope: v.scope.global
        ? { global: true }
        : {
            panel_id: v.scope.panel_id || undefined,
            insurer_id: v.scope.insurer_id || undefined,
            procedure_code: v.scope.procedure_code || undefined,
            diagnosis_class: v.scope.diagnosis_class || undefined,
          },
    };
    try {
      await onSubmit(cleaned);
    } catch (e: any) {
      setError(e?.message ?? 'Submit failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl">
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {v.id ? 'Edit rule' : 'New rule'}
            </div>
            {v.version && (
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                v{v.version} · saving creates a new version
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Rule key">
              <input
                value={v.rule_key}
                onChange={(e) => update({ rule_key: e.target.value })}
                placeholder="e.g. discharge.docs.discharge_summary"
                className="w-full text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
              />
            </Field>
            <Field label="Target stage">
              <select
                value={v.target_stage}
                onChange={(e) => update({ target_stage: e.target.value })}
                className="w-full text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="">Select stage…</option>
                {stages.data.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Required doc category">
              <select
                value={v.required_doc_category}
                onChange={(e) => update({ required_doc_category: e.target.value })}
                className="w-full text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="">Select doc category…</option>
                {docCats.data.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Severity">
              <div className="flex gap-3 text-sm pt-1">
                {(['blocker', 'warning', 'info'] as const).map((s) => (
                  <label key={s} className="inline-flex items-center gap-1.5">
                    <input
                      type="radio"
                      checked={v.severity === s}
                      onChange={() => update({ severity: s })}
                    />
                    <span
                      className={
                        s === 'blocker'
                          ? 'text-red-700 dark:text-red-300'
                          : s === 'warning'
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-sky-700 dark:text-sky-300'
                      }
                    >
                      {s}
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          </div>

          <Field label="Required fields (JSONB array of field names)">
            <div className="space-y-1.5">
              <div className="flex gap-2">
                <input
                  value={fieldInput}
                  onChange={(e) => setFieldInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addField();
                    }
                  }}
                  placeholder="Add field name…"
                  className="flex-1 text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
                />
                <button
                  type="button"
                  onClick={addField}
                  className="text-xs text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-emerald-100 px-2"
                >
                  add
                </button>
              </div>
              {v.required_fields.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {v.required_fields.map((f) => (
                    <span
                      key={f}
                      className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded px-1.5 py-0.5"
                    >
                      {f}
                      <button
                        type="button"
                        onClick={() => removeField(f)}
                        className="text-red-600 dark:text-red-400 hover:text-red-800"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </Field>

          <div className="rounded-md border border-slate-200 dark:border-slate-800 p-3 space-y-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!v.scope.global}
                onChange={(e) => updateScope({ global: e.target.checked })}
              />
              <span className="font-medium text-slate-700 dark:text-slate-200">
                Global rule (applies to all panels / insurers / procedures)
              </span>
            </label>
            {!v.scope.global && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Panel ID">
                  <input
                    value={v.scope.panel_id ?? ''}
                    onChange={(e) => updateScope({ panel_id: e.target.value })}
                    className="w-full text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
                  />
                </Field>
                <Field label="Insurer ID">
                  <input
                    value={v.scope.insurer_id ?? ''}
                    onChange={(e) => updateScope({ insurer_id: e.target.value })}
                    className="w-full text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
                  />
                </Field>
                <Field label="Procedure code">
                  <input
                    value={v.scope.procedure_code ?? ''}
                    onChange={(e) => updateScope({ procedure_code: e.target.value })}
                    className="w-full text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
                  />
                </Field>
                <Field label="Diagnosis class">
                  <input
                    value={v.scope.diagnosis_class ?? ''}
                    onChange={(e) => updateScope({ diagnosis_class: e.target.value })}
                    className="w-full text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
                  />
                </Field>
              </div>
            )}
          </div>

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={handleSubmit}
            className={cn(
              'text-xs px-3 py-1.5 rounded font-medium',
              'bg-slate-900 text-white dark:bg-white dark:text-slate-900',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {pending ? 'Saving…' : v.id ? 'Save new version' : 'Create rule'}
          </button>
        </div>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block">
    <span className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {label}
    </span>
    <div className="mt-1">{children}</div>
  </label>
);

export default RuleEditor;
