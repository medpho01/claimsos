import React, { useState } from 'react';
import ConceptEditor, { ConceptRow } from '@/pages/superadmin/OntologyManager/ConceptEditor';
import AliasManager, { ConceptAlias } from '@/pages/superadmin/OntologyManager/AliasManager';
import DocumentFieldSchemaEditor, {
  DocumentFieldSchema,
} from '@/pages/superadmin/OntologyManager/DocumentFieldSchemaEditor';
import { CategoryPill } from '@/components/intelligence/primitives';

/**
 * Wave 5C — OntologyManager DEMO
 *
 * NOT routed. Render directly to visually test states without hitting
 * the backend. Covers:
 *   - empty category list
 *   - populated category list
 *   - row mid-edit (toggle by clicking "edit")
 *   - alias panel empty / populated
 *   - document_field_schema empty / populated
 *   - error + success toasts (use the buttons)
 */

const rows: ConceptRow[] = [
  {
    id: '1',
    category: 'doc_category',
    code: 'discharge_summary',
    label: 'Discharge Summary',
    sort_order: 10,
    is_active: true,
  },
  {
    id: '2',
    category: 'doc_category',
    code: 'investigation_report',
    label: 'Investigation Report',
    sort_order: 20,
    is_active: true,
  },
  {
    id: '3',
    category: 'doc_category',
    code: 'obsolete_form',
    label: 'Obsolete Form (deprecated)',
    sort_order: 99,
    is_active: false,
  },
];

const aliases: ConceptAlias[] = [
  { id: 'a1', concept_id: '1', alias: 'DC summary', source: 'auto' },
  { id: 'a2', concept_id: '1', alias: 'final summary', source: 'manual' },
];

const schemas: DocumentFieldSchema[] = [
  {
    id: 's1',
    doc_category: 'discharge_summary',
    version: 3,
    is_active: true,
    fields: [
      { name: 'admission_date', type: 'date', required: true },
      { name: 'discharge_date', type: 'date', required: true },
      { name: 'final_diagnosis', type: 'text', required: true },
      { name: 'treatment_summary', type: 'text' },
    ],
  },
];

const OntologyManagerDemo: React.FC = () => {
  const [toast, setToast] = useState<string | null>(null);
  const [conceptRows, setConceptRows] = useState<ConceptRow[]>(rows);
  const [conceptAliases, setConceptAliases] = useState<ConceptAlias[]>(aliases);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <header>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">
            OntologyManager — demo states
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Not routed. Mock data only. Toggle states by interacting with the rows.
          </p>
        </header>

        {toast && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-900 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            {toast}
          </div>
        )}

        <Section title="ConceptEditor — populated + inline edit + inactive row">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2">
            <div className="px-2 py-2 flex items-center gap-2">
              <CategoryPill
                category="Document Categories"
                ontologyCategory="doc_category"
                size="sm"
              />
              <span className="text-[11px] text-slate-500 dark:text-slate-400 ml-auto">
                {conceptRows.length} concepts
              </span>
            </div>
            {conceptRows.map((row) => (
              <ConceptEditor
                key={row.id}
                row={row}
                onSave={(patch) => {
                  setConceptRows((rs) =>
                    rs.map((r) => (r.id === row.id ? { ...r, ...patch } : r)),
                  );
                  flash('Concept updated');
                }}
                onDelete={() => {
                  setConceptRows((rs) => rs.filter((r) => r.id !== row.id));
                  flash('Concept removed');
                }}
                onToggleActive={(next) => {
                  setConceptRows((rs) =>
                    rs.map((r) => (r.id === row.id ? { ...r, is_active: next } : r)),
                  );
                  flash(next ? 'Activated' : 'Deactivated');
                }}
              />
            ))}
          </div>
        </Section>

        <Section title="ConceptEditor — empty state">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-6">
            <div className="text-xs text-slate-500 dark:text-slate-400 italic">
              No concepts in this category yet.
            </div>
          </div>
        </Section>

        <Section title="AliasManager — populated">
          <AliasManager
            conceptLabel="Discharge Summary"
            conceptCode="discharge_summary"
            aliases={conceptAliases}
            onAdd={(alias) => {
              setConceptAliases((a) => [
                ...a,
                { id: `a-${Date.now()}`, concept_id: '1', alias, source: 'manual' },
              ]);
              flash('Alias added');
            }}
            onRemove={(id) => {
              setConceptAliases((a) => a.filter((x) => x.id !== id));
              flash('Alias removed');
            }}
          />
        </Section>

        <Section title="AliasManager — empty">
          <AliasManager
            conceptLabel="Brand new concept"
            conceptCode="brand_new"
            aliases={[]}
            onAdd={() => flash('Alias added')}
            onRemove={() => flash('Alias removed')}
          />
        </Section>

        <Section title="DocumentFieldSchemaEditor — populated">
          <DocumentFieldSchemaEditor docCategory="discharge_summary" schemas={schemas} />
        </Section>

        <Section title="DocumentFieldSchemaEditor — empty (404 path)">
          <DocumentFieldSchemaEditor docCategory="investigation_report" schemas={[]} />
        </Section>

        <Section title="DocumentFieldSchemaEditor — loading">
          <DocumentFieldSchemaEditor docCategory="anything" schemas={[]} loading />
        </Section>
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-2">
    <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">{title}</h2>
    <div>{children}</div>
  </section>
);

export default OntologyManagerDemo;
