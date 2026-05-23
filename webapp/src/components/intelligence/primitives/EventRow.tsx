import React from 'react';
import {
  Activity,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Info,
  Mail,
  Upload,
  MessageSquare,
  Clock,
  LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CitationLink, CitationKind } from './CitationLink';

/**
 * Intelligence Layer — Sprint 0 primitive.
 *
 * One row in a dense activity / event timeline. Two-column layout:
 *
 *   [ relative-time + icon ]  |  [ title + description + citations + children ]
 *
 * `tone` applies a left-border accent. `kind` drives the icon — known
 * kinds get a tailored Lucide icon, anything unknown falls back to
 * Activity. Citations render as inline CitationLink chips.
 */
export type EventTone = 'default' | 'info' | 'success' | 'warning' | 'danger';

export interface EventRowCitation {
  kind: CitationKind;
  id: string;
  label: string;
}

export interface EventRowProps {
  /** Timestamp. Date object or ISO string. */
  when: Date | string;
  /** Optional actor name ("Dr. Iyer", "System", "Care Health"). */
  actor?: string;
  /** Semantic kind. Drives the icon. Unknown values fall back to a generic icon. */
  kind: string;
  /** Bold title line. */
  title: string;
  /** Optional secondary line beneath the title. */
  description?: string;
  /** Left-border accent colour. Default 'default' (neutral). */
  tone?: EventTone;
  /** Inline citations rendered after the description. */
  citations?: EventRowCitation[];
  /** Rendered below description+citations, e.g. inline expansions. */
  children?: React.ReactNode;
  /** Optional click handler — the entire row becomes interactive. */
  onClick?: () => void;
  /** Optional callback wired into each citation chip. */
  onCitationOpen?: (kind: CitationKind, id: string) => void;
  className?: string;
}

const KIND_ICON: Record<string, LucideIcon> = {
  doc_upload: Upload,
  upload: Upload,
  document: FileText,
  email: Mail,
  message: MessageSquare,
  note: MessageSquare,
  warning: AlertTriangle,
  deficiency: AlertTriangle,
  approval: CheckCircle2,
  success: CheckCircle2,
  info: Info,
  timer: Clock,
};

const iconFor = (kind: string): LucideIcon => KIND_ICON[kind] ?? Activity;

const TONE_BORDER: Record<EventTone, string> = {
  default: 'border-l-slate-200 dark:border-l-slate-700',
  info: 'border-l-sky-400 dark:border-l-sky-500',
  success: 'border-l-emerald-400 dark:border-l-emerald-500',
  warning: 'border-l-amber-400 dark:border-l-amber-500',
  danger: 'border-l-red-400 dark:border-l-red-500',
};

const TONE_ICON: Record<EventTone, string> = {
  default: 'text-slate-500 dark:text-slate-400',
  info: 'text-sky-600 dark:text-sky-400',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
};

// Compact human relative time. Avoids pulling in a date library for a primitive.
const relTime = (when: Date | string): string => {
  const t = typeof when === 'string' ? new Date(when) : when;
  if (Number.isNaN(t.getTime())) return '';
  const diff = Date.now() - t.getTime();
  const abs = Math.abs(diff);
  const past = diff >= 0;
  const m = Math.round(abs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return past ? `${m}m ago` : `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return past ? `${h}h ago` : `in ${h}h`;
  const d = Math.round(h / 24);
  if (d < 14) return past ? `${d}d ago` : `in ${d}d`;
  const w = Math.round(d / 7);
  if (w < 8) return past ? `${w}w ago` : `in ${w}w`;
  const mo = Math.round(d / 30);
  if (mo < 12) return past ? `${mo}mo ago` : `in ${mo}mo`;
  const y = Math.round(d / 365);
  return past ? `${y}y ago` : `in ${y}y`;
};

const absTime = (when: Date | string): string => {
  const t = typeof when === 'string' ? new Date(when) : when;
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleString();
};

export const EventRow: React.FC<EventRowProps> = ({
  when,
  actor,
  kind,
  title,
  description,
  tone = 'default',
  citations,
  children,
  onClick,
  onCitationOpen,
  className,
}) => {
  const Icon = iconFor(kind);
  const interactive = !!onClick;
  const rel = relTime(when);
  const abs = absTime(when);

  const Container: 'div' | 'button' = interactive ? 'button' : 'div';

  return (
    <Container
      onClick={onClick}
      type={interactive ? 'button' : undefined}
      className={cn(
        'flex w-full gap-3 border-l-2 pl-3 pr-2 py-2 text-left',
        TONE_BORDER[tone],
        interactive &&
          'cursor-pointer rounded-r-md hover:bg-slate-50 dark:hover:bg-slate-800/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-slate-400 dark:focus-visible:ring-slate-500',
        className,
      )}
    >
      {/* Left rail: relative time + small icon */}
      <div className="flex flex-col items-start shrink-0 w-20 pt-0.5">
        <div
          className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums leading-tight truncate w-full"
          title={abs}
        >
          {rel}
        </div>
        <div className={cn('mt-1 inline-flex items-center gap-1', TONE_ICON[tone])}>
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 truncate">
            {kind}
          </span>
        </div>
      </div>

      {/* Right: content */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug">
            {title}
          </span>
          {actor && (
            <span className="text-[11px] text-slate-500 dark:text-slate-400">{actor}</span>
          )}
        </div>
        {description && (
          <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-300 leading-snug">
            {description}
          </div>
        )}
        {citations && citations.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {citations.map((c) => (
              <CitationLink
                key={`${c.kind}:${c.id}`}
                kind={c.kind}
                id={c.id}
                label={c.label}
                onOpen={onCitationOpen}
                inline
              />
            ))}
          </div>
        )}
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </Container>
  );
};

export default EventRow;
