import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Sprint 4, Wave 5A — Confidence calibration chart.
 *
 * Inline SVG histogram: per readiness-score bucket (0–20, 20–40, …,
 * 80–100) we plot two bars — the predicted probability the model
 * emitted (bucket midpoint, normalised 0..1) and the *actual* observed
 * rate of correct predictions in that bucket. A perfectly calibrated
 * model has the bars equal in every bucket.
 *
 * Dark-mode aware. No chart library — pure SVG so it ships dependency-free.
 */

export interface CalibrationBucket {
  bucket_low: number;
  bucket_high: number;
  /** 0..1 — the predicted rate (typically the bucket midpoint /100). */
  predicted_rate: number;
  /** 0..1 — observed fraction correct in this bucket. */
  actual_rate: number;
  n: number;
}

export interface ConfidenceCalibrationChartProps {
  buckets: CalibrationBucket[];
  height?: number;
  className?: string;
}

const W = 520;
const PAD_L = 36;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 28;

export const ConfidenceCalibrationChart: React.FC<ConfidenceCalibrationChartProps> = ({
  buckets,
  height = 200,
  className,
}) => {
  const H = height;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  if (buckets.length === 0) {
    return (
      <div
        className={cn(
          'flex h-[200px] items-center justify-center rounded-md border border-dashed border-slate-300 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400',
          className,
        )}
      >
        No calibration data yet
      </div>
    );
  }

  const groupW = innerW / buckets.length;
  const barW = groupW * 0.35;
  const yScale = (v: number) => PAD_T + innerH - v * innerH;

  return (
    <div className={cn('w-full', className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full text-slate-500 dark:text-slate-400"
        role="img"
        aria-label="Confidence calibration plot"
      >
        {/* Y-axis grid + labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={g}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yScale(g)}
              y2={yScale(g)}
              className="stroke-slate-200 dark:stroke-slate-800"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 6}
              y={yScale(g) + 3}
              textAnchor="end"
              className="fill-current text-[9px]"
            >
              {(g * 100).toFixed(0)}%
            </text>
          </g>
        ))}

        {/* Bars */}
        {buckets.map((b, i) => {
          const x0 = PAD_L + i * groupW;
          const predY = yScale(b.predicted_rate);
          const actY = yScale(b.actual_rate);
          const predH = innerH - (predY - PAD_T);
          const actH = innerH - (actY - PAD_T);
          return (
            <g key={`${b.bucket_low}-${b.bucket_high}`}>
              <rect
                x={x0 + groupW / 2 - barW - 2}
                y={predY}
                width={barW}
                height={predH}
                className="fill-slate-400 dark:fill-slate-500"
              >
                <title>{`Predicted: ${(b.predicted_rate * 100).toFixed(0)}%`}</title>
              </rect>
              <rect
                x={x0 + groupW / 2 + 2}
                y={actY}
                width={barW}
                height={actH}
                className={cn(
                  Math.abs(b.predicted_rate - b.actual_rate) < 0.05
                    ? 'fill-emerald-500 dark:fill-emerald-400'
                    : Math.abs(b.predicted_rate - b.actual_rate) < 0.15
                      ? 'fill-amber-500 dark:fill-amber-400'
                      : 'fill-red-500 dark:fill-red-400',
                )}
              >
                <title>{`Actual: ${(b.actual_rate * 100).toFixed(0)}% (n=${b.n})`}</title>
              </rect>
              <text
                x={x0 + groupW / 2}
                y={H - PAD_B + 14}
                textAnchor="middle"
                className="fill-current text-[9px]"
              >
                {b.bucket_low}–{b.bucket_high}
              </text>
              <text
                x={x0 + groupW / 2}
                y={H - PAD_B + 24}
                textAnchor="middle"
                className="fill-current text-[8px] opacity-70"
              >
                n={b.n}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex items-center gap-4 text-[11px] text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-slate-400 dark:bg-slate-500" />
          Predicted rate
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500 dark:bg-emerald-400" />
          Actual rate (well-calibrated)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-red-500 dark:bg-red-400" />
          Mis-calibrated (gap &gt; 15%)
        </span>
      </div>
    </div>
  );
};

export default ConfidenceCalibrationChart;
