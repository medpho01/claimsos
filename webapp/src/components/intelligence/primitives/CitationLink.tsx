import React from 'react';
import { Scale, Sparkles, FileText, Clock, LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Intelligence Layer — Sprint 0 primitive.
 *
 * Inline citation link. Used inside event rows, explanations, and
 * recommendation text to reference the evidence backing a claim:
 *
 *   - 'rule'    — codified rule (Scale icon)
 *   - 'pattern' — ML/heuristic pattern (Sparkles icon)
 *   - 'case'    — a specific past case (FileText icon)
 *   - 'event'   — a timeline event (Clock icon)
 *
 * The click handler is a callback only; the parent decides what to do
 * (typically open a side drawer with the cited item). No routing inside
 * the primitive.
 */
export type CitationKind = 'rule' | 'pattern' | 'case' | 'event';

export interface CitationLinkProps {
  kind: CitationKind;
  /** Stable id of the cited entity. Passed to the onOpen callback. */
  id: string;
  /** Human-readable label rendered as the link text. */
  label: string;
  /** Click handler. If omitted, renders as non-interactive styled text. */
  onOpen?: (kind: CitationKind, id: string) => void;
  /**
   * inline=true → smaller text (text-xs) and tighter spacing, intended
   * for use mid-sentence inside body copy. Default false (text-sm).
   */
  inline?: boolean;
  className?: string;
}

const KIND_ICON: Record<CitationKind, LucideIcon> = {
  rule: Scale,
  pattern: Sparkles,
  case: FileText,
  event: Clock,
};

const KIND_TONE: Record<CitationKind, string> = {
  rule: 'text-indigo-700 dark:text-indigo-300 decoration-indigo-400/50 dark:decoration-indigo-500/60',
  pattern:
    'text-violet-700 dark:text-violet-300 decoration-violet-400/50 dark:decoration-violet-500/60',
  case: 'text-slate-700 dark:text-slate-200 decoration-slate-400/50 dark:decoration-slate-500/60',
  event: 'text-sky-700 dark:text-sky-300 decoration-sky-400/50 dark:decoration-sky-500/60',
};

const KIND_HOVER: Record<CitationKind, string> = {
  rule: 'hover:text-indigo-800 dark:hover:text-indigo-200',
  pattern: 'hover:text-violet-800 dark:hover:text-violet-200',
  case: 'hover:text-slate-900 dark:hover:text-slate-50',
  event: 'hover:text-sky-800 dark:hover:text-sky-200',
};

export const CitationLink: React.FC<CitationLinkProps> = ({
  kind,
  id,
  label,
  onOpen,
  inline = false,
  className,
}) => {
  const Icon = KIND_ICON[kind];
  const interactive = !!onOpen;
  const sizeClass = inline ? 'text-xs gap-0.5' : 'text-sm gap-1';
  const iconSize = inline ? 'h-3 w-3' : 'h-3.5 w-3.5';

  const common = cn(
    'inline-flex items-center align-baseline underline underline-offset-2 decoration-dotted font-medium transition-colors',
    sizeClass,
    KIND_TONE[kind],
    interactive && KIND_HOVER[kind],
    interactive &&
      'cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-current rounded-sm',
    className,
  );

  if (interactive) {
    return (
      <button
        type="button"
        onClick={() => onOpen?.(kind, id)}
        className={common}
        title={`${kind}:${id}`}
      >
        <Icon className={cn('shrink-0', iconSize)} aria-hidden />
        <span>{label}</span>
      </button>
    );
  }
  return (
    <span className={common} title={`${kind}:${id}`}>
      <Icon className={cn('shrink-0', iconSize)} aria-hidden />
      <span>{label}</span>
    </span>
  );
};

export default CitationLink;
