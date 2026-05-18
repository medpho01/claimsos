import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Intelligence Layer — Sprint 0 primitive.
 *
 * Circular readiness gauge. Renders an SVG ring with a background
 * track and a foreground arc whose sweep is proportional to `score`.
 *
 * Colour follows the same buckets as ConfidenceBadge so the visual
 * vocabulary stays consistent:
 *   score >= 80 → emerald
 *   50–79       → amber
 *   < 50        → red
 *
 * If `label` is omitted, a sensible default is derived from the score
 * ("Ready" / "Almost" / "Blocked").
 */
export interface ReadinessGaugeProps {
  /** 0..100. Values outside the range are clamped. */
  score: number;
  /** Outer diameter in px. Default 56. */
  size?: 40 | 56 | 72 | 96;
  /** Override the auto-derived bucket label. */
  label?: string;
  /** Tiny line below the bucket label (e.g. "12 of 15 docs"). */
  subtitle?: string;
  className?: string;
}

type Tone = 'high' | 'mid' | 'low';

const toneOf = (s: number): Tone => {
  const v = Math.max(0, Math.min(100, s));
  if (v >= 80) return 'high';
  if (v >= 50) return 'mid';
  return 'low';
};

const STROKE_CLASS: Record<Tone, string> = {
  high: 'stroke-emerald-500 dark:stroke-emerald-400',
  mid: 'stroke-amber-500 dark:stroke-amber-400',
  low: 'stroke-red-500 dark:stroke-red-400',
};

const TEXT_CLASS: Record<Tone, string> = {
  high: 'text-emerald-700 dark:text-emerald-300',
  mid: 'text-amber-700 dark:text-amber-300',
  low: 'text-red-700 dark:text-red-300',
};

const DEFAULT_LABEL: Record<Tone, string> = {
  high: 'Ready',
  mid: 'Almost',
  low: 'Blocked',
};

const NUMBER_SIZE: Record<NonNullable<ReadinessGaugeProps['size']>, string> = {
  40: 'text-xs',
  56: 'text-sm',
  72: 'text-base',
  96: 'text-xl',
};

const STROKE_WIDTH: Record<NonNullable<ReadinessGaugeProps['size']>, number> = {
  40: 4,
  56: 5,
  72: 6,
  96: 8,
};

export const ReadinessGauge: React.FC<ReadinessGaugeProps> = ({
  score,
  size = 56,
  label,
  subtitle,
  className,
}) => {
  const v = Math.max(0, Math.min(100, Math.round(score)));
  const tone = toneOf(v);
  const sw = STROKE_WIDTH[size];
  const r = (size - sw) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - v / 100);
  const displayLabel = label ?? DEFAULT_LABEL[tone];

  return (
    <div className={cn('inline-flex flex-col items-center', className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
          aria-hidden
        >
          {/* Background track */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            strokeWidth={sw}
            className="stroke-slate-200 dark:stroke-slate-700"
          />
          {/* Foreground arc */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className={cn('transition-[stroke-dashoffset] duration-500 ease-out', STROKE_CLASS[tone])}
            style={{ transitionProperty: 'stroke-dashoffset' }}
          />
        </svg>
        <div
          className={cn(
            'absolute inset-0 flex items-center justify-center font-semibold tabular-nums',
            NUMBER_SIZE[size],
            TEXT_CLASS[tone],
          )}
        >
          {v}
        </div>
      </div>
      {(displayLabel || subtitle) && (
        <div className="mt-1 text-center leading-tight">
          {displayLabel && (
            <div className={cn('text-xs font-medium', TEXT_CLASS[tone])}>{displayLabel}</div>
          )}
          {subtitle && (
            <div className="text-[10px] text-slate-500 dark:text-slate-400">{subtitle}</div>
          )}
        </div>
      )}
    </div>
  );
};

export default ReadinessGauge;
