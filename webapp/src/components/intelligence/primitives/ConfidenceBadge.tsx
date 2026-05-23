import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Intelligence Layer — Sprint 0 primitive.
 *
 * Inline confidence indicator. Renders as tone-coloured plain text
 * (no background pill) to match the chip-removal pattern used in
 * the Patients list (see toneTextClass in pages/hospital/Patients).
 *
 * Buckets:
 *   confidence >= 0.85 → "High"   (emerald)
 *   0.6 <= c < 0.85    → "Medium" (amber)
 *   confidence < 0.6   → "Low"    (red)
 *
 * Modes:
 *   - 'auto'   (default): bucket label + numeric % via title attr on hover
 *   - 'pct'   : just "87%"
 *   - 'bucket': just "High"/"Medium"/"Low"
 *   - 'icon'  : a tone-coloured filled dot only
 */
export interface ConfidenceBadgeProps {
  /**
   * 0..1 model/heuristic confidence. Values outside the range are clamped.
   * Pass `null`/`undefined` (or `0`) to render an inert "—" placeholder
   * rather than a misleading red "Low" pill — surfaces that synthesise
   * placeholder section rows (no real classifier run yet) need that to
   * avoid telling the user their docs failed when they simply haven't
   * been scored yet.
   */
  confidence: number | null | undefined;
  /** Rendering style. Default 'auto'. */
  mode?: 'auto' | 'pct' | 'bucket' | 'icon';
  /** Text size. Default 'sm'. */
  size?: 'sm' | 'md';
  /** Optional override for the hover tooltip. If omitted, a sensible default is used. */
  tooltip?: string;
  className?: string;
}

type Tone = 'high' | 'mid' | 'low';

const bucketOf = (c: number): Tone => {
  const v = Math.max(0, Math.min(1, c));
  if (v >= 0.85) return 'high';
  if (v >= 0.6) return 'mid';
  return 'low';
};

const bucketLabel: Record<Tone, string> = {
  high: 'High',
  mid: 'Medium',
  low: 'Low',
};

const toneTextClass: Record<Tone, string> = {
  high: 'text-emerald-700 dark:text-emerald-300',
  mid: 'text-amber-700 dark:text-amber-300',
  low: 'text-red-700 dark:text-red-300',
};

const toneDotClass: Record<Tone, string> = {
  high: 'bg-emerald-500 dark:bg-emerald-400',
  mid: 'bg-amber-500 dark:bg-amber-400',
  low: 'bg-red-500 dark:bg-red-400',
};

const sizeTextClass: Record<NonNullable<ConfidenceBadgeProps['size']>, string> = {
  sm: 'text-xs',
  md: 'text-sm',
};

const sizeDotClass: Record<NonNullable<ConfidenceBadgeProps['size']>, string> = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
};

export const ConfidenceBadge: React.FC<ConfidenceBadgeProps> = ({
  confidence,
  mode = 'auto',
  size = 'sm',
  tooltip,
  className,
}) => {
  // Treat null/undefined/exact-0 as "no data" rather than "0% confidence".
  // The dossier projector synthesises placeholder section objects with
  // classification_confidence: null when only section_ids are stored —
  // averaging those into a numeric mean produced 0 → red "Low" pill,
  // which read as a failure signal to users.
  if (confidence == null || confidence === 0) {
    return (
      <span
        title={tooltip ?? 'No confidence score yet'}
        className={cn(
          'inline-flex items-center gap-1 font-medium tabular-nums',
          sizeTextClass[size],
          'text-slate-400 dark:text-slate-500',
          className,
        )}
      >
        <span
          aria-hidden
          className={cn(
            'inline-block rounded-full bg-slate-300 dark:bg-slate-600',
            sizeDotClass[size],
          )}
        />
        —
      </span>
    );
  }
  const v = Math.max(0, Math.min(1, confidence));
  const tone = bucketOf(v);
  const pct = `${Math.round(v * 100)}%`;
  const label = bucketLabel[tone];
  const title = tooltip ?? `${label} confidence · ${pct}`;

  if (mode === 'icon') {
    return (
      <span
        title={title}
        className={cn(
          'inline-block rounded-full align-middle',
          toneDotClass[tone],
          sizeDotClass[size],
          className,
        )}
        aria-label={title}
      />
    );
  }

  let body: React.ReactNode;
  if (mode === 'pct') {
    body = pct;
  } else if (mode === 'bucket') {
    body = label;
  } else {
    // auto: bucket label, % visible only via tooltip
    body = label;
  }

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 font-medium tabular-nums',
        sizeTextClass[size],
        toneTextClass[tone],
        className,
      )}
    >
      <span
        aria-hidden
        className={cn('inline-block rounded-full', toneDotClass[tone], sizeDotClass[size])}
      />
      {body}
    </span>
  );
};

export default ConfidenceBadge;
