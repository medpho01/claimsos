import React, { useMemo, useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Wand2,
  FolderOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  CategoryPill,
  ConfidenceBadge,
} from '@/components/intelligence/primitives';
import {
  useClaimDossier,
  useMasterOptions,
} from '@/hooks/intelligence';
import { useDocumentSections } from '@/hooks/intelligence';
import type {
  DossierDocSection,
} from '@/hooks/intelligence';
import { FixCategoryModal } from '../components/FixCategoryModal';
import { useDocumentCategoryCorrection } from '@/hooks/intelligence/useDocumentCategoryCorrection';

/**
 * Wave 9 — Documents panel for the Claim AI Summary page.
 *
 * Uses the claim dossier's `doc_sections_by_category` map as the authoritative
 * list of sections on this claim and groups them back into per-document rows.
 * The dossier doesn't carry file_name today, so we fall back to a stable
 * document_id prefix. When the backend ships a richer doc list we'll plumb
 * the file_name through without changing the component shape.
 */
export interface DocumentsPanelProps {
  claimId: string;
  /** Override the dossier — used by the dev demo to inject mock data. */
  dossierOverride?: any;
  /** Disable network calls — used by the dev demo. */
  offline?: boolean;
}

interface DocRow {
  documentId: string;
  fileName: string;
  sections: DossierDocSection[];
}

export const DocumentsPanel: React.FC<DocumentsPanelProps> = ({
  claimId,
  dossierOverride,
  offline = false,
}) => {
  const dossier = useClaimDossier(offline ? null : claimId);
  const categoryMaster = useMasterOptions(offline ? null : 'doc_category');
  const correction = useDocumentCategoryCorrection();

  const data = dossierOverride ?? dossier.data;

  const docs: DocRow[] = useMemo(() => {
    if (!data?.doc_sections_by_category) return [];
    const byDoc: Record<string, DocRow> = {};
    // The Wave 1 projector stores doc_sections_by_category as
    // { category: [section_id, ...] } — arrays of strings, not section
    // objects. We accept BOTH shapes defensively so future enrichment
    // (Wave 9 demo data ships full objects) renders identically.
    Object.entries(
      data.doc_sections_by_category as Record<string, Array<DossierDocSection | string>>,
    ).forEach(([category, items]) => {
      if (!Array.isArray(items)) return;
      items.forEach((item) => {
        // Skip null/undefined safely.
        if (item == null) return;
        let sectionObj: DossierDocSection;
        if (typeof item === 'string') {
          // Bare section_id — synthesise a placeholder shape so the rest of
          // the panel can iterate cleanly. Real details get fetched on
          // expansion via the per-section endpoint (TODO when wired).
          sectionObj = {
            id: item,
            document_id: item,
            category,
            classification_confidence: null,
            page_start: 1,
            page_end: 1,
            status: 'auto',
            extracted_fields: null,
            extraction_confidence: null,
          } as any;
        } else {
          sectionObj = item;
        }
        const key = sectionObj.document_id ?? sectionObj.id ?? 'unknown';
        if (!byDoc[key]) {
          byDoc[key] = {
            documentId: key,
            fileName: `doc_${String(key).slice(0, 8)}.pdf`,
            sections: [],
          };
        }
        byDoc[key].sections.push(sectionObj);
      });
    });
    return Object.values(byDoc).map((d) => ({
      ...d,
      sections: [...d.sections].sort(
        (a, b) => (a.page_start ?? 0) - (b.page_start ?? 0),
      ),
    }));
  }, [data]);

  const summary = useMemo(() => {
    const docCount = docs.length;
    const sectionCount = docs.reduce((acc, d) => acc + d.sections.length, 0);
    const categorised = docs.reduce(
      (acc, d) =>
        acc + d.sections.filter((s) => s.status !== 'pending' && !!s.category).length,
      0,
    );
    const extracted = docs.reduce(
      (acc, d) => acc + d.sections.filter((s) => s.status === 'reviewed').length,
      0,
    );
    return { docCount, sectionCount, categorised, extracted };
  }, [docs]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRow = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [fixTarget, setFixTarget] = useState<{
    sectionId: string;
    currentCategory: string;
    documentName: string;
  } | null>(null);

  const categoryLabel = (code: string): string => {
    const found = categoryMaster.data.find((o) => o.code === code);
    return found?.label ?? code;
  };

  const onFixSave = async (newCategory: string, reason: string) => {
    if (!fixTarget) return;
    await correction.mutateAsync({
      sectionId: fixTarget.sectionId,
      new_category: newCategory,
      reason,
    });
  };

  if (!offline && dossier.loading) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
        Loading documents…
      </div>
    );
  }

  if (!docs.length) {
    return (
      <div className="rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-10 text-center space-y-3">
        <div className="mx-auto size-10 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
          <FolderOpen className="size-5 text-slate-500 dark:text-slate-400" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            No documents uploaded yet
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Upload IPD documents to kick off the OCR + classifier pipeline.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary strip */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 flex items-center gap-5 text-sm">
        <Stat label="Documents" value={summary.docCount} />
        <Divider />
        <Stat label="Sections" value={summary.sectionCount} />
        <Divider />
        <Stat label="Categorised" value={summary.categorised} tone="ok" />
        <Divider />
        <Stat label="Extracted" value={summary.extracted} tone="ok" />
      </div>

      {/* Table */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/40 text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <tr>
              <th className="text-left px-4 py-2 w-6"></th>
              <th className="text-left px-4 py-2">File</th>
              <th className="text-left px-4 py-2">Sections</th>
              <th className="text-left px-4 py-2">Categories</th>
              <th className="text-left px-4 py-2">Confidence</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {docs.map((d) => {
              const open = expanded.has(d.documentId);
              const avgConf =
                d.sections.length === 0
                  ? 0
                  : d.sections.reduce(
                      (acc, s) => acc + (s.classification_confidence ?? 0),
                      0,
                    ) / d.sections.length;
              const uniqueCategories = Array.from(
                new Set(d.sections.map((s) => s.category).filter(Boolean)),
              );
              return (
                <React.Fragment key={d.documentId}>
                  <tr
                    className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30 cursor-pointer"
                    onClick={() => toggleRow(d.documentId)}
                  >
                    <td className="px-4 py-3 text-slate-400">
                      {open ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                    </td>
                    <td className="px-4 py-3 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="size-4 shrink-0 text-slate-500" />
                        <span className="truncate text-slate-900 dark:text-slate-100">
                          {d.fileName}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-200 tabular-nums">
                      {d.sections.length}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {uniqueCategories.slice(0, 3).map((c) => (
                          <CategoryPill
                            key={c}
                            category={categoryLabel(c)}
                            ontologyCategory="doc_category"
                            size="xs"
                          />
                        ))}
                        {uniqueCategories.length > 3 && (
                          <span className="text-[10px] text-slate-500">
                            +{uniqueCategories.length - 3}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <ConfidenceBadge confidence={avgConf} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          const first = d.sections[0];
                          if (!first) return;
                          setFixTarget({
                            sectionId: first.id,
                            currentCategory: first.category,
                            documentName: d.fileName,
                          });
                        }}
                      >
                        <Wand2 className="size-3.5" />
                        Fix category
                      </Button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-slate-50/40 dark:bg-slate-950/40">
                      <td />
                      <td colSpan={5} className="px-4 py-3">
                        <SectionsList
                          sections={d.sections}
                          categoryLabel={categoryLabel}
                          documentName={d.fileName}
                          onFix={(s) =>
                            setFixTarget({
                              sectionId: s.id,
                              currentCategory: s.category,
                              documentName: d.fileName,
                            })
                          }
                          offline={offline}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <FixCategoryModal
        open={!!fixTarget}
        sectionId={fixTarget?.sectionId ?? ''}
        currentCategory={fixTarget?.currentCategory}
        documentName={fixTarget?.documentName}
        onClose={() => setFixTarget(null)}
        onSave={onFixSave}
        saving={correction.isPending}
      />
    </div>
  );
};

// ─── helpers ───────────────────────────────────────────────────────────────

const Stat: React.FC<{
  label: string;
  value: number;
  tone?: 'ok' | 'default';
}> = ({ label, value, tone = 'default' }) => (
  <div>
    <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {label}
    </div>
    <div
      className={cn(
        'text-lg font-semibold tabular-nums',
        tone === 'ok'
          ? 'text-emerald-700 dark:text-emerald-300'
          : 'text-slate-900 dark:text-slate-100',
      )}
    >
      {value}
    </div>
  </div>
);

const Divider: React.FC = () => (
  <div className="h-8 w-px bg-slate-200 dark:bg-slate-700" />
);

interface SectionsListProps {
  sections: DossierDocSection[];
  categoryLabel: (c: string) => string;
  documentName: string;
  onFix: (s: DossierDocSection) => void;
  offline: boolean;
}

const SectionsList: React.FC<SectionsListProps> = ({
  sections,
  categoryLabel,
  onFix,
  offline,
}) => {
  return (
    <div className="space-y-2">
      {sections.map((s) => (
        <SectionRow
          key={s.id}
          section={s}
          categoryLabel={categoryLabel}
          onFix={() => onFix(s)}
          offline={offline}
        />
      ))}
    </div>
  );
};

const SectionRow: React.FC<{
  section: DossierDocSection;
  categoryLabel: (c: string) => string;
  onFix: () => void;
  offline: boolean;
}> = ({ section, categoryLabel, onFix, offline }) => {
  const [open, setOpen] = useState(false);
  // Fetch full extracted_fields on demand — sections-by-category in the
  // dossier doesn't carry the extracted payload.
  const sections = useDocumentSections(
    offline ? null : open ? section.document_id : null,
  );
  const full = sections.data.find((s) => s.id === section.id);
  const extracted = full?.extracted_fields ?? null;

  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2">
      <div className="flex items-center gap-3 text-xs">
        <span className="text-slate-500 dark:text-slate-400 tabular-nums w-14 shrink-0">
          p.{section.page_start}
          {section.page_end !== section.page_start && `–${section.page_end}`}
        </span>
        <CategoryPill
          category={categoryLabel(section.category)}
          ontologyCategory="doc_category"
          size="xs"
        />
        <ConfidenceBadge confidence={section.classification_confidence} mode="auto" />
        <span className="text-slate-500 dark:text-slate-400 ml-2">{section.status}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Hide JSON' : 'View JSON'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px] gap-1"
            onClick={onFix}
          >
            <Wand2 className="size-3" />
            Fix
          </Button>
        </div>
      </div>
      {open && (
        <pre
          className={cn(
            'mt-2 max-h-64 overflow-auto rounded bg-slate-50 dark:bg-slate-950',
            'border border-slate-200 dark:border-slate-800 p-2 text-[11px] font-mono',
            'text-slate-700 dark:text-slate-200 whitespace-pre-wrap',
          )}
        >
          {extracted
            ? JSON.stringify(extracted, null, 2)
            : sections.loading
              ? 'Loading extracted fields…'
              : 'No extracted fields yet.'}
        </pre>
      )}
    </div>
  );
};

export default DocumentsPanel;
