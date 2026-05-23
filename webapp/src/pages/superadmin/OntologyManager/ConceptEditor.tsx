import React, { useState, useEffect } from 'react';
import { Check, X, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Wave 5C — OntologyManager
 *
 * Inline-edit row for a single master_options entry. Follows the
 * chip-removal / tone-coloured-text style used elsewhere (Patients
 * list) — no heavy chips, only tone-coloured text + small action
 * icons. Toggles, save, cancel, delete are all surfaced here.
 *
 * v1 caveat: a few master_options mutation endpoints exist
 * (`POST/PUT/DELETE /master-options`) but the per-category PATCH for
 * the `is_active` toggle is not yet split out, so the parent attempts
 * the call and tolerates 405/501.
 */

export interface ConceptRow {
  id: string;
  category: string;
  code: string;
  label: string;
  description?: string;
  sort_order: number;
  is_active: boolean;
}

export interface ConceptEditorProps {
  row: ConceptRow;
  onSave: (patch: Partial<ConceptRow>) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
  onToggleActive: (next: boolean) => Promise<void> | void;
  pending?: boolean;
}

export const ConceptEditor: React.FC<ConceptEditorProps> = ({
  row,
  onSave,
  onDelete,
  onToggleActive,
  pending,
}) => {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(row.label);
  const [code, setCode] = useState(row.code);
  const [sortOrder, setSortOrder] = useState<number>(row.sort_order);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setLabel(row.label);
      setCode(row.code);
      setSortOrder(row.sort_order);
    }
  }, [row, editing]);

  const handleSave = async () => {
    setError(null);
    try {
      await onSave({ label, code, sort_order: sortOrder });
      setEditing(false);
    } catch (e: any) {
      setError(e?.message ?? 'Save failed');
    }
  };

  if (editing) {
    return (
      <div className="grid grid-cols-12 gap-2 items-center px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="code"
          className="col-span-3 text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="label"
          className="col-span-5 text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
        />
        <input
          type="number"
          value={sortOrder}
          onChange={(e) => setSortOrder(Number(e.target.value))}
          className="col-span-2 text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 tabular-nums"
        />
        <div className="col-span-2 flex justify-end gap-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={pending}
            className="text-xs text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-emerald-100 inline-flex items-center gap-0.5 px-1.5 py-0.5"
          >
            <Check className="h-3.5 w-3.5" />
            save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 inline-flex items-center gap-0.5 px-1.5 py-0.5"
          >
            <X className="h-3.5 w-3.5" />
            cancel
          </button>
        </div>
        {error && (
          <div className="col-span-12 text-[11px] text-red-600 dark:text-red-400">{error}</div>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'grid grid-cols-12 gap-2 items-center px-2 py-1.5 rounded-md group hover:bg-slate-50 dark:hover:bg-slate-900/40 transition-colors',
        !row.is_active && 'opacity-60',
      )}
    >
      <span className="col-span-3 text-xs font-mono text-slate-700 dark:text-slate-200 truncate" title={row.code}>
        {row.code}
      </span>
      <span className="col-span-5 text-sm text-slate-900 dark:text-slate-100 truncate" title={row.label}>
        {row.label}
      </span>
      <span className="col-span-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
        {row.sort_order}
      </span>
      <div className="col-span-1">
        <button
          type="button"
          onClick={() => onToggleActive(!row.is_active)}
          className={cn(
            'text-[11px] font-medium',
            row.is_active
              ? 'text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-emerald-100'
              : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300',
          )}
          title="Toggle active"
        >
          {row.is_active ? 'active' : 'inactive'}
        </button>
      </div>
      <div className="col-span-2 flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white inline-flex items-center gap-0.5"
        >
          <Pencil className="h-3 w-3" />
          edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 inline-flex items-center gap-0.5"
        >
          <Trash2 className="h-3 w-3" />
          delete
        </button>
      </div>
    </div>
  );
};

export default ConceptEditor;
