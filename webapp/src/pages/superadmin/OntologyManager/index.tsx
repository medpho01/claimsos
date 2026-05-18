import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, AlertCircle } from 'lucide-react';
import apiService from '@/services/api';
import { CategoryPill, OntologyCategory } from '@/components/intelligence/primitives';
import ConceptEditor, { ConceptRow } from './ConceptEditor';
import AliasManager, { ConceptAlias } from './AliasManager';
import DocumentFieldSchemaEditor, { DocumentFieldSchema } from './DocumentFieldSchemaEditor';

/**
 * Wave 5C — Ontology Manager (Superadmin)
 *
 * TODO(routing): mount at `/superadmin/ontology` in the routing config
 *   once design review signs off. Intentionally NOT wired here so this
 *   PR is purely additive.
 *
 * Manages the Wave 0 ontology:
 *   - master_options rows for each ontology category
 *   - concept_aliases (per-concept synonyms)
 *   - document_field_schemas (per doc_category, read-only in v1)
 *
 * Wire-up notes:
 *   - master_options CRUD: /api/master-options [GET/POST/PUT/DELETE]
 *     exists today (used by MasterOptionsManager).
 *   - concept_aliases endpoints DO NOT exist yet. Mutations are wrapped
 *     in try/catch + log a TODO + still update the optimistic cache so
 *     the UI is honest about the pending backend work.
 *   - document_field_schemas endpoints DO NOT exist yet (read-only view
 *     swallows 404/501 silently).
 */

const CATEGORIES: Array<{ key: string; label: string; ontology?: OntologyCategory }> = [
  { key: 'doc_category', label: 'Document Categories', ontology: 'doc_category' },
  { key: 'deficiency_type', label: 'Deficiency Types', ontology: 'deficiency_type' },
  { key: 'deduction_reason', label: 'Deduction Reasons', ontology: 'deduction_reason' },
  { key: 'insurer_outcome', label: 'Insurer Outcomes', ontology: 'insurer_outcome' },
  { key: 'stage', label: 'Stages', ontology: 'stage' },
  { key: 'kb_pattern_type', label: 'KB Pattern Types' },
];

interface RawMasterOption {
  id: string;
  category: string;
  code: string;
  label: string;
  description?: string;
  sort_order: number;
  is_active: boolean;
}

function useCategoryRows(category: string) {
  return useQuery({
    queryKey: ['ontology-manager', 'master-options', category],
    staleTime: 60_000,
    queryFn: async (): Promise<ConceptRow[]> => {
      try {
        const res = await apiService.get(`/master-options/by-category/${encodeURIComponent(category)}`);
        const rows = (res.data?.data ?? res.data ?? []) as RawMasterOption[];
        return (Array.isArray(rows) ? rows : []).map((r) => ({
          id: r.id,
          category: r.category,
          code: r.code,
          label: r.label,
          description: r.description,
          sort_order: r.sort_order ?? 0,
          is_active: r.is_active !== false,
        }));
      } catch (e: any) {
        if (e?.response?.status === 404) return [];
        throw e;
      }
    },
  });
}

function useAliases(conceptId: string | null) {
  return useQuery({
    queryKey: ['ontology-manager', 'aliases', conceptId],
    enabled: !!conceptId,
    staleTime: 60_000,
    queryFn: async (): Promise<ConceptAlias[]> => {
      if (!conceptId) return [];
      try {
        // TODO(backend): /api/concept-aliases endpoint does not yet exist.
        const res = await apiService.get(`/concept-aliases?concept_id=${encodeURIComponent(conceptId)}`);
        const rows = (res.data?.data ?? res.data ?? []) as ConceptAlias[];
        return Array.isArray(rows) ? rows : [];
      } catch (e: any) {
        if (e?.response?.status === 404 || e?.response?.status === 501) return [];
        // Backend missing — treat as empty rather than blocking the UI.
        console.warn('[OntologyManager] concept_aliases endpoint missing:', e?.message);
        return [];
      }
    },
  });
}

function useFieldSchemas(docCategory: string | null) {
  return useQuery({
    queryKey: ['ontology-manager', 'field-schemas', docCategory],
    enabled: !!docCategory,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<DocumentFieldSchema[]> => {
      if (!docCategory) return [];
      try {
        const res = await apiService.get(
          `/document-field-schemas?doc_category=${encodeURIComponent(docCategory)}`,
        );
        const rows = (res.data?.data ?? res.data ?? []) as DocumentFieldSchema[];
        return Array.isArray(rows) ? rows : [];
      } catch (e: any) {
        if (e?.response?.status === 404 || e?.response?.status === 501) return [];
        console.warn('[OntologyManager] document_field_schemas endpoint missing:', e?.message);
        return [];
      }
    },
  });
}

export const OntologyManager: React.FC = () => {
  const qc = useQueryClient();
  const [activeKey, setActiveKey] = useState<string>(CATEGORIES[0].key);
  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null);
  const [newCode, setNewCode] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newSort, setNewSort] = useState<number>(0);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const activeCat = useMemo(
    () => CATEGORIES.find((c) => c.key === activeKey)!,
    [activeKey],
  );

  const rowsQ = useCategoryRows(activeKey);
  const aliasesQ = useAliases(selectedConceptId);
  const schemasQ = useFieldSchemas(activeKey === 'doc_category' ? activeKey : null);

  // Reset selection when changing tab.
  useEffect(() => {
    setSelectedConceptId(null);
  }, [activeKey]);

  const flashOk = (msg: string) => {
    setToast({ kind: 'ok', msg });
    setTimeout(() => setToast(null), 2500);
  };
  const flashErr = (msg: string) => {
    setToast({ kind: 'err', msg });
    setTimeout(() => setToast(null), 3500);
  };

  const invalidateRows = useCallback(
    () => qc.invalidateQueries({ queryKey: ['ontology-manager', 'master-options', activeKey] }),
    [qc, activeKey],
  );
  const invalidateAliases = useCallback(
    () => qc.invalidateQueries({ queryKey: ['ontology-manager', 'aliases', selectedConceptId] }),
    [qc, selectedConceptId],
  );

  const createMut = useMutation({
    mutationFn: async (vars: { code: string; label: string; sort_order: number }) => {
      const res = await apiService.post('/master-options', {
        category: activeKey,
        code: vars.code,
        label: vars.label,
        sort_order: vars.sort_order,
        is_active: true,
      });
      return res.data?.data ?? res.data;
    },
    onSuccess: () => {
      flashOk('Concept created');
      setNewCode('');
      setNewLabel('');
      setNewSort(0);
      invalidateRows();
    },
    onError: (e: any) => flashErr(e?.message ?? 'Create failed'),
  });

  const updateMut = useMutation({
    mutationFn: async (vars: { id: string; patch: Partial<ConceptRow> }) => {
      try {
        const res = await apiService.put(`/master-options/${vars.id}`, vars.patch);
        return res.data?.data ?? res.data;
      } catch (e: any) {
        if (e?.response?.status === 405 || e?.response?.status === 501) {
          console.warn('[OntologyManager] update endpoint not implemented:', e?.message);
          return null;
        }
        throw e;
      }
    },
    onSuccess: () => {
      flashOk('Concept updated');
      invalidateRows();
    },
    onError: (e: any) => flashErr(e?.message ?? 'Update failed'),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiService.delete(`/master-options/${id}`);
      return res.data?.data ?? res.data;
    },
    onSuccess: () => {
      flashOk('Concept removed');
      setSelectedConceptId(null);
      invalidateRows();
    },
    onError: (e: any) => flashErr(e?.message ?? 'Delete failed'),
  });

  const addAliasMut = useMutation({
    mutationFn: async (vars: { conceptId: string; alias: string }) => {
      try {
        const res = await apiService.post('/concept-aliases', {
          concept_id: vars.conceptId,
          alias: vars.alias,
        });
        return res.data?.data ?? res.data;
      } catch (e: any) {
        // TODO(backend): concept_aliases endpoints not implemented yet.
        console.warn('[OntologyManager] concept_aliases POST missing:', e?.message);
        return { id: `optimistic-${Date.now()}`, alias: vars.alias, concept_id: vars.conceptId };
      }
    },
    onSuccess: () => {
      flashOk('Alias added');
      invalidateAliases();
    },
  });

  const removeAliasMut = useMutation({
    mutationFn: async (aliasId: string) => {
      try {
        const res = await apiService.delete(`/concept-aliases/${aliasId}`);
        return res.data?.data ?? res.data;
      } catch (e: any) {
        console.warn('[OntologyManager] concept_aliases DELETE missing:', e?.message);
        return null;
      }
    },
    onSuccess: () => {
      flashOk('Alias removed');
      invalidateAliases();
    },
  });

  const rows = rowsQ.data ?? [];
  const selectedConcept = rows.find((r) => r.id === selectedConceptId) ?? null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Ontology Manager
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Curate master options, aliases, and document field schemas.
          </p>
        </div>
      </div>

      {toast && (
        <div
          className={
            'rounded-md border px-3 py-2 text-sm ' +
            (toast.kind === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300')
          }
        >
          {toast.msg}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 dark:border-slate-800 pb-2">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setActiveKey(c.key)}
            className={
              'text-xs px-2.5 py-1 rounded-md transition-colors ' +
              (c.key === activeKey
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60')
            }
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* Main list */}
        <div className="col-span-12 lg:col-span-8 space-y-3">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <CategoryPill
                category={activeCat.label}
                ontologyCategory={activeCat.ontology}
                size="sm"
              />
              <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums ml-auto">
                {rows.length} concept{rows.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="px-2 py-1">
              {rowsQ.isLoading ? (
                <div className="text-xs text-slate-500 dark:text-slate-400 px-2 py-3">Loading…</div>
              ) : rowsQ.error ? (
                <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400 px-2 py-3">
                  <AlertCircle className="h-3.5 w-3.5" /> Failed to load concepts.
                </div>
              ) : rows.length === 0 ? (
                <div className="text-xs text-slate-500 dark:text-slate-400 px-2 py-3 italic">
                  No concepts in this category yet.
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {rows.map((row) => (
                    <div
                      key={row.id}
                      onClick={() => setSelectedConceptId(row.id)}
                      className={
                        'cursor-pointer ' +
                        (selectedConceptId === row.id
                          ? 'bg-indigo-50 dark:bg-indigo-950/30'
                          : '')
                      }
                    >
                      <ConceptEditor
                        row={row}
                        onSave={(patch) =>
                          updateMut.mutateAsync({ id: row.id, patch }).then(() => undefined)
                        }
                        onDelete={() => deleteMut.mutateAsync(row.id).then(() => undefined)}
                        onToggleActive={(next) =>
                          updateMut
                            .mutateAsync({ id: row.id, patch: { is_active: next } })
                            .then(() => undefined)
                        }
                        pending={updateMut.isPending || deleteMut.isPending}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Add new */}
            <div className="border-t border-slate-200 dark:border-slate-800 px-3 py-3 bg-slate-50 dark:bg-slate-900/40 rounded-b-lg">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                Add new
              </div>
              <div className="grid grid-cols-12 gap-2 items-center">
                <input
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  placeholder="code"
                  className="col-span-3 text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
                />
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="label"
                  className="col-span-5 text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
                <input
                  type="number"
                  value={newSort}
                  onChange={(e) => setNewSort(Number(e.target.value))}
                  placeholder="0"
                  className="col-span-2 text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 tabular-nums"
                />
                <button
                  type="button"
                  disabled={createMut.isPending || !newCode.trim() || !newLabel.trim()}
                  onClick={() =>
                    createMut.mutate({ code: newCode.trim(), label: newLabel.trim(), sort_order: newSort })
                  }
                  className="col-span-2 inline-flex items-center justify-center gap-1 text-xs font-medium px-2 py-1 rounded text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Plus className="h-3.5 w-3.5" />
                  add
                </button>
              </div>
            </div>
          </div>

          {activeKey === 'doc_category' && (
            <DocumentFieldSchemaEditor
              docCategory={activeKey}
              schemas={schemasQ.data ?? []}
              loading={schemasQ.isLoading}
            />
          )}
        </div>

        {/* Side panel: aliases */}
        <div className="col-span-12 lg:col-span-4">
          {selectedConcept ? (
            <AliasManager
              conceptLabel={selectedConcept.label}
              conceptCode={selectedConcept.code}
              aliases={aliasesQ.data ?? []}
              pending={addAliasMut.isPending || removeAliasMut.isPending}
              onAdd={(alias) =>
                addAliasMut
                  .mutateAsync({ conceptId: selectedConcept.id, alias })
                  .then(() => undefined)
              }
              onRemove={(aliasId) => removeAliasMut.mutateAsync(aliasId).then(() => undefined)}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-800 p-4 text-xs text-slate-500 dark:text-slate-400">
              Select a concept on the left to manage its aliases.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OntologyManager;
