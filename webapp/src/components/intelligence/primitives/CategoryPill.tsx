import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Intelligence Layer — Sprint 0 primitive.
 *
 * Compact category pill driven by an ontology-aware colour map. Used wherever
 * we surface a typed label from the intelligence layer (doc category, stage,
 * deficiency type, deduction reason, insurer outcome).
 *
 * Visual: small rounded-md pill with subtle background and tone-coloured text.
 * Muted by default; if `onClick` is provided the pill brightens on hover and
 * becomes keyboard-focusable.
 */
export type OntologyCategory =
  | 'doc_category'
  | 'stage'
  | 'deficiency_type'
  | 'deduction_reason'
  | 'insurer_outcome';

export interface CategoryPillProps {
  /** Display label, shown verbatim. */
  category: string;
  /** Drives the colour family. Undefined → neutral slate/gray. */
  ontologyCategory?: OntologyCategory;
  /** Size preset. Default 'sm'. */
  size?: 'xs' | 'sm' | 'md';
  /** If provided, pill becomes interactive (clickable, focusable, hover brightens). */
  onClick?: () => void;
  /**
   * Reduces saturation. Default true. Set false to render at full saturation
   * (useful when the pill is the dominant element in its context).
   */
  muted?: boolean;
  className?: string;
}

type Palette = {
  /** Default (muted) bg + text */
  base: string;
  /** Hover/active classes (only applied when onClick is set) */
  hover: string;
  /** Full-saturation variant when muted=false */
  vivid: string;
};

const PALETTES: Record<OntologyCategory | 'neutral', Palette> = {
  doc_category: {
    base: 'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-200',
    hover:
      'hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-700/70 dark:hover:text-slate-50',
    vivid: 'bg-slate-200 text-slate-900 dark:bg-slate-700/70 dark:text-slate-50',
  },
  deficiency_type: {
    base: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
    hover:
      'hover:bg-red-100 hover:text-red-800 dark:hover:bg-red-900/60 dark:hover:text-red-200',
    vivid: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200',
  },
  deduction_reason: {
    base: 'bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
    hover:
      'hover:bg-orange-100 hover:text-orange-800 dark:hover:bg-orange-900/60 dark:hover:text-orange-200',
    vivid: 'bg-orange-100 text-orange-800 dark:bg-orange-900/60 dark:text-orange-200',
  },
  insurer_outcome: {
    base: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
    hover:
      'hover:bg-blue-100 hover:text-blue-800 dark:hover:bg-blue-900/60 dark:hover:text-blue-200',
    vivid: 'bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200',
  },
  stage: {
    base: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300',
    hover:
      'hover:bg-indigo-100 hover:text-indigo-800 dark:hover:bg-indigo-900/60 dark:hover:text-indigo-200',
    vivid: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200',
  },
  neutral: {
    base: 'bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-200',
    hover:
      'hover:bg-gray-200 hover:text-gray-900 dark:hover:bg-gray-700/70 dark:hover:text-gray-50',
    vivid: 'bg-gray-200 text-gray-900 dark:bg-gray-700/70 dark:text-gray-50',
  },
};

const SIZE_CLASS: Record<NonNullable<CategoryPillProps['size']>, string> = {
  xs: 'text-[10px] px-1.5 py-0.5',
  sm: 'text-xs px-2 py-0.5',
  md: 'text-sm px-2.5 py-1',
};

export const CategoryPill: React.FC<CategoryPillProps> = ({
  category,
  ontologyCategory,
  size = 'sm',
  onClick,
  muted = true,
  className,
}) => {
  const palette = PALETTES[ontologyCategory ?? 'neutral'];
  const interactive = !!onClick;

  const Tag: 'button' | 'span' = interactive ? 'button' : 'span';

  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-md font-medium leading-none whitespace-nowrap transition-colors',
        SIZE_CLASS[size],
        muted ? palette.base : palette.vivid,
        interactive &&
          'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-slate-400 dark:focus-visible:ring-slate-500 dark:focus-visible:ring-offset-slate-900',
        interactive && palette.hover,
        className,
      )}
    >
      {category}
    </Tag>
  );
};

export default CategoryPill;
