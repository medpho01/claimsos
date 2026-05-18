import React, { useState } from 'react';
import { Scissors, GitMerge, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMasterOptions } from '@/hooks/intelligence/useMasterOptions';
import type { DocumentSection } from '@/hooks/intelligence/useDocumentSections';

/**
 * Wave 2D — Section Boundary Editor (UI shell).
 *
 * Renders the three boundary-manipulation controls — split, merge, reclassify —
 * for a single section. Mutations are NOT wired up in this wave; the parent
 * passes callbacks if any, and the API surface will land in a later wave.
 *
 * TODO(Wave 3+): wire to /documents/{id}/sections POST/PATCH endpoints once
 * the contract is finalised.
 */

export interface SectionBoundaryEditorProps {
  section: DocumentSection;
  onSplit?: (page: number) => void;
  onMerge?: (otherSectionId: string) => void;
  onReclassify?: (category: string) => void;
  /** Optional list of sibling sections this one could be merged into. */
  siblings?: DocumentSection[];
  className?: string;
}

const inputCls =
  'w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-slate-500 dark:focus:ring-slate-700';

const btnCls =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';

export const SectionBoundaryEditor: React.FC<SectionBoundaryEditorProps> = ({
  section,
  onSplit,
  onMerge,
  onReclassify,
  siblings = [],
  className,
}) => {
  const [splitPage, setSplitPage] = useState<number>(
    Math.min(section.page_start + 1, section.page_end),
  );
  const [mergeTarget, setMergeTarget] = useState<string>('');
  const [reclassifyCat, setReclassifyCat] = useState<string>(section.category);
  const { data: docCategoryOptions } = useMasterOptions('doc_category');

  const splitDisabled =
    splitPage <= section.page_start || splitPage > section.page_end;

  return (
    <div
      className={cn(
        'rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900',
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Edit Boundaries
        </h4>
        <span className="text-[11px] text-slate-500 dark:text-slate-400">
          pages {section.page_start}–{section.page_end}
        </span>
      </div>
      <div className="text-[11px] text-amber-600 dark:text-amber-400">
        TODO: mutations land in Wave 3+. These controls dispatch optional callbacks only.
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* Split */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <Scissors className="h-3.5 w-3.5" /> Split
          </div>
          <input
            type="number"
            min={section.page_start + 1}
            max={section.page_end}
            value={splitPage}
            onChange={(e) => setSplitPage(Number(e.target.value || 0))}
            className={inputCls}
          />
          <button
            type="button"
            disabled={splitDisabled || !onSplit}
            onClick={() => onSplit?.(splitPage)}
            className={btnCls}
          >
            Split at page {splitPage}
          </button>
        </div>

        {/* Merge */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <GitMerge className="h-3.5 w-3.5" /> Merge
          </div>
          <select
            value={mergeTarget}
            onChange={(e) => setMergeTarget(e.target.value)}
            className={inputCls}
          >
            <option value="">— pick sibling —</option>
            {siblings
              .filter((s) => s.id !== section.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.category} · p{s.page_start}-{s.page_end}
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={!mergeTarget || !onMerge}
            onClick={() => onMerge?.(mergeTarget)}
            className={btnCls}
          >
            Merge into selected
          </button>
        </div>

        {/* Reclassify */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <Tag className="h-3.5 w-3.5" /> Reclassify
          </div>
          <select
            value={reclassifyCat}
            onChange={(e) => setReclassifyCat(e.target.value)}
            className={inputCls}
          >
            {docCategoryOptions.length === 0 && (
              <option value={section.category}>{section.category}</option>
            )}
            {docCategoryOptions.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={reclassifyCat === section.category || !onReclassify}
            onClick={() => onReclassify?.(reclassifyCat)}
            className={btnCls}
          >
            Apply category
          </button>
        </div>
      </div>
    </div>
  );
};

export default SectionBoundaryEditor;
