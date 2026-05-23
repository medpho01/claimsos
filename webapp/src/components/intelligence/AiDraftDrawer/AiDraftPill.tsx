import React from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Wave 2D — AI Draft pill.
 *
 * Tiny attention chip attached to a timeline event (typically an inbound
 * insurer email) to signal "there is an AI-extracted draft waiting for
 * review". Click opens the AiDraftDrawer.
 *
 * Colour:
 *   - approval-like categories → emerald
 *   - rejection-like categories → red
 *   - everything else (incl. queries, unknown) → amber (default)
 *
 * Intentionally lighter visually than CategoryPill — this is a CTA, not a
 * label. We use a small icon + count to keep the timeline scannable.
 */

const APPROVAL_LIKE = new Set([
  'approved',
  'partially_approved',
  'enhancement_approved',
  'enhancement_partially_approved',
]);
const REJECTION_LIKE = new Set(['rejected', 'withdrawn']);

type Tone = 'amber' | 'emerald' | 'red';

const toneClass: Record<Tone, string> = {
  amber:
    'bg-amber-50 text-amber-800 ring-amber-200 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/60 dark:hover:bg-amber-900/40',
  emerald:
    'bg-emerald-50 text-emerald-800 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900/60 dark:hover:bg-emerald-900/40',
  red: 'bg-red-50 text-red-800 ring-red-200 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900/60 dark:hover:bg-red-900/40',
};

const toneFor = (cat?: string): Tone => {
  if (!cat) return 'amber';
  if (APPROVAL_LIKE.has(cat)) return 'emerald';
  if (REJECTION_LIKE.has(cat)) return 'red';
  return 'amber';
};

export interface AiDraftPillProps {
  draftCount: number;
  /** Category of the latest draft, used to colour the pill. */
  latestCategory?: string;
  onClick: () => void;
  className?: string;
}

export const AiDraftPill: React.FC<AiDraftPillProps> = ({
  draftCount,
  latestCategory,
  onClick,
  className,
}) => {
  if (draftCount <= 0) return null;
  const tone = toneFor(latestCategory);
  const label = draftCount > 1 ? `AI Draft · ${draftCount}` : 'AI Draft';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset transition-colors focus:outline-none focus-visible:ring-2',
        toneClass[tone],
        className,
      )}
      title={
        latestCategory
          ? `${draftCount} AI draft${draftCount > 1 ? 's' : ''} · latest: ${latestCategory}`
          : `${draftCount} AI draft${draftCount > 1 ? 's' : ''} pending review`
      }
    >
      <Sparkles className="h-3 w-3" aria-hidden />
      {label}
    </button>
  );
};

export default AiDraftPill;
