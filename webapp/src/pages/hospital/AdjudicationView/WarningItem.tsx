import React from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AdjudicationWarning } from '@/hooks/intelligence';

/**
 * Sprint 3, Wave 3C — AdjudicationView sub-component.
 *
 * Compact warning row. Visually lighter than BlockingGapItem — amber/yellow
 * left-border, smaller body copy. `severity` modulates the icon (high =
 * triangle, low/medium = info).
 */
export interface WarningItemProps {
  warning: AdjudicationWarning;
  className?: string;
}

export const WarningItem: React.FC<WarningItemProps> = ({ warning, className }) => {
  const sev = warning.severity ?? 'medium';
  const Icon = sev === 'high' ? AlertTriangle : Info;
  const tone =
    sev === 'high'
      ? 'border-l-amber-500 dark:border-l-amber-400 text-amber-700 dark:text-amber-300'
      : 'border-l-slate-400 dark:border-l-slate-500 text-slate-600 dark:text-slate-400';
  return (
    <li
      className={cn(
        'rounded-md border-l-4 bg-white dark:bg-slate-900',
        'border border-slate-200 dark:border-slate-800 pl-3 pr-3 py-2',
        tone,
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-900 dark:text-slate-100">
            {warning.message}
          </p>
          {warning.source && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
              source: {warning.source}
            </p>
          )}
        </div>
      </div>
    </li>
  );
};
