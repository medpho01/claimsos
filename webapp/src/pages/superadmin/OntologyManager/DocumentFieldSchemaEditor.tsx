import React from 'react';
import { Info } from 'lucide-react';

/**
 * Wave 5C — OntologyManager
 *
 * Read-only display of the document_field_schemas attached to a
 * doc_category. v1 ONLY: editing is deferred to a later wave because
 * the JSONB schema shape (`fields`, `validations`, `required_fields`)
 * is still in flux. The page renders an empty/loading state when no
 * schema rows exist.
 *
 * TODO(backend): /api/document-field-schemas endpoints do NOT exist
 * yet. The parent loads via apiService.get(...) and treats 404/Network
 * as "no schemas configured" (the most common case today).
 */

export interface DocumentFieldSchema {
  id: string;
  doc_category: string;
  version: number;
  fields: Array<{
    name: string;
    label?: string;
    type: string;
    required?: boolean;
  }>;
  is_active?: boolean;
}

export interface DocumentFieldSchemaEditorProps {
  docCategory: string;
  schemas: DocumentFieldSchema[];
  loading?: boolean;
}

export const DocumentFieldSchemaEditor: React.FC<DocumentFieldSchemaEditorProps> = ({
  docCategory,
  schemas,
  loading,
}) => {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Field schemas for
        </div>
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {docCategory}
        </div>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
          read-only · v1
        </span>
      </div>
      <div className="px-4 py-3">
        {loading ? (
          <div className="text-xs text-slate-500 dark:text-slate-400">Loading…</div>
        ) : schemas.length === 0 ? (
          <div className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              No field schema configured for{' '}
              <span className="font-mono">{docCategory}</span>. The OCR
              extractor will fall back to generic key-value pairs.
            </span>
          </div>
        ) : (
          <div className="space-y-3">
            {schemas.map((s) => (
              <div key={s.id} className="space-y-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    v{s.version}
                  </span>
                  <span
                    className={
                      'text-[10px] uppercase tracking-wide ' +
                      (s.is_active === false
                        ? 'text-slate-400 dark:text-slate-500'
                        : 'text-emerald-700 dark:text-emerald-300')
                    }
                  >
                    {s.is_active === false ? 'inactive' : 'active'}
                  </span>
                </div>
                <ul className="ml-2 space-y-0.5">
                  {s.fields.map((f) => (
                    <li
                      key={f.name}
                      className="text-xs text-slate-700 dark:text-slate-200 flex items-center gap-2"
                    >
                      <span className="font-mono">{f.name}</span>
                      <span className="text-slate-400 dark:text-slate-500">·</span>
                      <span className="text-slate-500 dark:text-slate-400">{f.type}</span>
                      {f.required && (
                        <span className="text-red-600 dark:text-red-400 text-[10px] uppercase">
                          required
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DocumentFieldSchemaEditor;
