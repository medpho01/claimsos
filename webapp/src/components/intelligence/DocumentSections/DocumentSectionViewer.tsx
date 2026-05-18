import React, { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useDocumentSections,
  type DocumentSection,
} from '@/hooks/intelligence/useDocumentSections';
import { CategoryPill, ConfidenceBadge } from '@/components/intelligence/primitives';
import { SectionExtractionPanel } from './SectionExtractionPanel';
import { SectionBoundaryEditor } from './SectionBoundaryEditor';

/**
 * Wave 2D — Document Section Viewer.
 *
 * Vertical list of sections in a single document. Each row shows:
 *   page range · category pill · confidence · status dot
 *
 * Click to expand → reveals SectionExtractionPanel (and, when boundary edit
 * mode is on, SectionBoundaryEditor too). One section open at a time.
 */

const STATUS_DOT: Record<DocumentSection['status'], string> = {
  pending: 'bg-slate-400 dark:bg-slate-500',
  classified: 'bg-sky-500 dark:bg-sky-400',
  reviewed: 'bg-emerald-500 dark:bg-emerald-400',
  rejected: 'bg-red-500 dark:bg-red-400',
};

const STATUS_LABEL: Record<DocumentSection['status'], string> = {
  pending: 'Pending',
  classified: 'Auto',
  reviewed: 'Reviewed',
  rejected: 'Rejected',
};

export interface DocumentSectionViewerProps {
  documentId: string;
  /** Optional override for dev/demo pages where the API isn't reachable. */
  sectionsOverride?: DocumentSection[];
  /** Optional save hook for the extraction panel. */
  onSaveSection?: (next: DocumentSection) => void;
  className?: string;
}

export const DocumentSectionViewer: React.FC<DocumentSectionViewerProps> = ({
  documentId,
  sectionsOverride,
  onSaveSection,
  className,
}) => {
  const { data, loading, error } = useDocumentSections(
    sectionsOverride ? null : documentId,
  );
  const sections = sectionsOverride ?? data;

  const [openId, setOpenId] = useState<string | null>(null);
  const [boundaryMode, setBoundaryMode] = useState(false);

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <FileText className="h-4 w-4" />
          Document Sections
          {sections.length > 0 && (
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              · {sections.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setBoundaryMode((v) => !v)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors',
            boundaryMode
              ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200'
              : 'border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800',
          )}
        >
          <Settings2 className="h-3.5 w-3.5" />
          {boundaryMode ? 'Done' : 'Edit boundaries'}
        </button>
      </div>

      {loading && !sectionsOverride && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800/60"
            />
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          Failed to load sections: {error.message}
        </div>
      )}

      {!loading && !error && sections.length === 0 && (
        <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-sm text-slate-500 dark:text-slate-400">
          No sections classified yet for this document.
        </div>
      )}

      <ul className="space-y-1.5">
        {sections.map((s) => {
          const open = openId === s.id;
          return (
            <li
              key={s.id}
              className="rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
            >
              <button
                type="button"
                onClick={() => setOpenId(open ? null : s.id)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40"
              >
                {open ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                )}
                <span className="w-20 shrink-0 font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                  p{s.page_start}–{s.page_end}
                </span>
                <CategoryPill
                  category={s.category}
                  ontologyCategory="doc_category"
                  size="xs"
                />
                <ConfidenceBadge
                  confidence={s.classification_confidence}
                  mode="auto"
                  size="sm"
                />
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                  <span
                    className={cn(
                      'inline-block h-1.5 w-1.5 rounded-full',
                      STATUS_DOT[s.status],
                    )}
                  />
                  {STATUS_LABEL[s.status]}
                </span>
              </button>

              {open && (
                <div className="space-y-3 border-t border-slate-200 px-3 py-3 dark:border-slate-800">
                  <SectionExtractionPanel section={s} onSave={onSaveSection} />
                  {boundaryMode && (
                    <SectionBoundaryEditor section={s} siblings={sections} />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default DocumentSectionViewer;
