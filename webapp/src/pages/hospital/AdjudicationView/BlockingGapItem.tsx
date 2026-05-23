import React from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CategoryPill,
  ConfidenceBadge,
} from '@/components/intelligence/primitives';
import type { AdjudicationBlockingGap } from '@/hooks/intelligence';

/**
 * Sprint 3, Wave 3C — AdjudicationView sub-component.
 *
 * One row in the Blocking Gaps list. Renders:
 *   - severity indicator (always blocker in this list)
 *   - doc_category as a CategoryPill (when present)
 *   - human-readable message + fix_hint
 *   - field name (when the gap is field-level rather than doc-level)
 *
 * Visually distinct from WarningItem — red left-border accent so the
 * "this is blocking" semantics are immediately legible.
 */
export interface BlockingGapItemProps {
  gap: AdjudicationBlockingGap;
  className?: string;
}

export const BlockingGapItem: React.FC<BlockingGapItemProps> = ({
  gap,
  className,
}) => {
  // Severity is technically a union ('blocker' | 'warning') but this
  // component is rendered inside the blocking list; treat anything
  // non-blocker as a defensive warning render rather than throwing.
  const isBlocker = gap.severity === 'blocker';
  return (
    <li
      className={cn(
        'rounded-md border-l-4 bg-white dark:bg-slate-900',
        'border border-slate-200 dark:border-slate-800 pl-3 pr-3 py-2',
        isBlocker
          ? 'border-l-red-500 dark:border-l-red-400'
          : 'border-l-amber-500 dark:border-l-amber-400',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertCircle
          className={cn(
            'mt-0.5 size-4 shrink-0',
            isBlocker ? 'text-red-500 dark:text-red-400' : 'text-amber-500 dark:text-amber-400',
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {gap.doc_category && (
              <CategoryPill
                category={gap.doc_category.replace(/_/g, ' ')}
                ontologyCategory="doc_category"
                size="xs"
              />
            )}
            {gap.field && (
              <code className="text-[11px] text-slate-500 dark:text-slate-400">
                field: {gap.field}
              </code>
            )}
            {/* Severity ≈ confidence in semantics: blockers are "high"
                certainty that something's wrong. Surface as a badge so
                this list element shares vocabulary with the rest of the
                intelligence surface. */}
            <ConfidenceBadge
              confidence={isBlocker ? 0.95 : 0.7}
              mode="bucket"
              size="sm"
            />
          </div>
          <p className="text-sm text-slate-900 dark:text-slate-100">
            {gap.message}
          </p>
          {gap.fix_hint && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              <span className="font-medium">How to fix:</span> {gap.fix_hint}
            </p>
          )}
        </div>
      </div>
    </li>
  );
};
