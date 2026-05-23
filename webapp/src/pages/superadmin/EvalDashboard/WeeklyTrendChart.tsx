import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Sprint 4, Wave 5A — Weekly trend line.
 *
 * Inline SVG sparkline-style chart of prediction accuracy by ISO week.
 * Points are plotted at the start of each week; the line connects them;
 * each point carries a tooltip with the sample size for that bucket.
 *
 * Dark-mode aware. No chart library.
 */

export interface WeeklyTrendPoint {
  week_start: string;
  accuracy_pct: number;
  /** Per-week sample size — surfaced via tooltip and below the chart. */
  n: number;
}

export interface WeeklyTrendChartProps {
  points: WeeklyTrendPoint[];
  height?: number;
  className?: string;
}

const W = 520;
const PAD_L = 36;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;

export const WeeklyTrendChart: React.FC<WeeklyTrendChartProps> = ({
  points,
  height = 180,
  className,
}) => {
  const H = height;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  if (points.length === 0) {
    return (
      <div
        className={cn(
          'flex h-[180px] items-center justify-center rounded-md border border-dashed border-slate-300 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400',
          className,
        )}
      >
        No weekly data yet
      </div>
    );
  }

  // Y axis: clamp to 0..100; if data range is narrow, zoom in a little.
  const min = Math.max(0, Math.floor(Math.min(...points.map((p) => p.accuracy_pct)) / 10) * 10 - 5);
  const max = Math.min(100, Math.ceil(Math.max(...points.map((p) => p.accuracy_pct)) / 10) * 10 + 5);
  const span = Math.max(10, max - min);

  const xStep = points.length > 1 ? innerW / (points.length - 1) : 0;
  const xScale = (i: number) => PAD_L + i * xStep;
  const yScale = (v: number) => PAD_T + innerH - ((v - min) / span) * innerH;

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(p.accuracy_pct)}`)
    .join(' ');

  // Y-grid: 4 ticks
  const ticks = [min, min + span / 2, max];

  return (
    <div className={cn('w-full', className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full text-slate-500 dark:text-slate-400"
        role="img"
        aria-label="Weekly accuracy trend"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yScale(t)}
              y2={yScale(t)}
              className="stroke-slate-200 dark:stroke-slate-800"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 6}
              y={yScale(t) + 3}
              textAnchor="end"
              className="fill-current text-[9px]"
            >
              {t.toFixed(0)}%
            </text>
          </g>
        ))}

        <path
          d={pathD}
          fill="none"
          className="stroke-indigo-500 dark:stroke-indigo-400"
          strokeWidth={2}
        />

        {points.map((p, i) => (
          <g key={p.week_start}>
            <circle
              cx={xScale(i)}
              cy={yScale(p.accuracy_pct)}
              r={3}
              className="fill-indigo-600 dark:fill-indigo-300"
            >
              <title>
                {p.week_start} · {p.accuracy_pct.toFixed(1)}% · n={p.n}
              </title>
            </circle>
            {(i === 0 || i === points.length - 1 || i === Math.floor(points.length / 2)) && (
              <text
                x={xScale(i)}
                y={H - PAD_B + 14}
                textAnchor="middle"
                className="fill-current text-[9px]"
              >
                {p.week_start.slice(5)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
};

export default WeeklyTrendChart;
