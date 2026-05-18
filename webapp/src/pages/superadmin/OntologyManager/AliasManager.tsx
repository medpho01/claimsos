import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Wave 5C — OntologyManager
 *
 * Side-panel alias manager. For a selected concept (master_option row)
 * shows the list of `concept_aliases` rows and supports add / remove.
 *
 * TODO(backend): /api/concept-aliases endpoints do NOT exist yet. The
 * mutations defined in the parent page are wrapped in try/catch and
 * gracefully no-op against the wire; the UI still updates optimistically.
 */

export interface ConceptAlias {
  id: string;
  concept_id: string;
  alias: string;
  source?: string;
  confidence?: number;
}

export interface AliasManagerProps {
  conceptLabel: string;
  conceptCode: string;
  aliases: ConceptAlias[];
  pending?: boolean;
  onAdd: (alias: string) => Promise<void> | void;
  onRemove: (aliasId: string) => Promise<void> | void;
}

export const AliasManager: React.FC<AliasManagerProps> = ({
  conceptLabel,
  conceptCode,
  aliases,
  pending,
  onAdd,
  onRemove,
}) => {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const v = input.trim();
    if (!v) return;
    setError(null);
    try {
      await onAdd(v);
      setInput('');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to add');
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Aliases for
        </div>
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {conceptLabel}
        </div>
        <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
          {conceptCode}
        </div>
      </div>
      <div className="px-4 py-3 space-y-2">
        {aliases.length === 0 ? (
          <div className="text-xs text-slate-500 dark:text-slate-400 italic">
            No aliases yet. Add the first synonym below.
          </div>
        ) : (
          <ul className="space-y-1">
            {aliases.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between text-sm group"
              >
                <span className="text-slate-700 dark:text-slate-200">
                  {a.alias}
                  {a.source && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                      {a.source}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(a.id)}
                  className="opacity-0 group-hover:opacity-100 text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 transition-opacity"
                  title="Remove alias"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Add alias…"
            className="flex-1 text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          />
          <button
            type="button"
            onClick={submit}
            disabled={pending || !input.trim()}
            className={cn(
              'inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded text-emerald-700 dark:text-emerald-300',
              'hover:text-emerald-900 dark:hover:text-emerald-100',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            add
          </button>
        </div>
        {error && (
          <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</div>
        )}
      </div>
    </div>
  );
};

export default AliasManager;
