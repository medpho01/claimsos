import React, { useState, useRef, useEffect } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfidenceBadge } from '@/components/intelligence/primitives';
import type { HarmonisedProvenance } from '@/hooks/intelligence/useHarmonisedEpisode';

/**
 * Wave 9 — small "i" icon button that, on click, opens a popover showing
 * the provenance of an AI-extracted value: source section, confidence,
 * and the LLM provider/model/prompt_version that produced it.
 *
 * Intentionally light — uses an absolutely-positioned div rather than a
 * Radix popover so it can be embedded inside dense table rows without
 * portal/escape-key tax. Click-outside dismisses.
 */
export interface ProvenanceTagProps {
  provenance?: HarmonisedProvenance | null;
  className?: string;
}

export const ProvenanceTag: React.FC<ProvenanceTagProps> = ({ provenance, className }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!provenance) {
    return (
      <span
        className={cn(
          'inline-flex items-center text-slate-300 dark:text-slate-600',
          className,
        )}
        title="No provenance recorded"
      >
        <Info className="h-3 w-3" aria-hidden />
      </span>
    );
  }

  return (
    <span ref={wrapRef} className={cn('relative inline-flex', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center text-slate-400 hover:text-indigo-600',
          'dark:text-slate-500 dark:hover:text-indigo-300',
          'rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400',
        )}
        title="Show provenance"
        aria-label="Show provenance"
      >
        <Info className="h-3 w-3" aria-hidden />
      </button>
      {open && (
        <div
          role="dialog"
          className={cn(
            'absolute z-30 top-full left-0 mt-1 w-64 rounded-md border shadow-lg p-3 text-xs',
            'bg-white border-slate-200 text-slate-700',
            'dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200',
          )}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Provenance
            </span>
            {typeof provenance.confidence === 'number' && (
              <ConfidenceBadge confidence={provenance.confidence} mode="auto" size="sm" />
            )}
          </div>
          <dl className="space-y-1.5">
            {provenance.section_label && (
              <Row label="Source" value={provenance.section_label} />
            )}
            {provenance.section_id && !provenance.section_label && (
              <Row label="Section" value={provenance.section_id.slice(0, 12) + '…'} />
            )}
            {provenance.llm_provider && (
              <Row label="Provider" value={provenance.llm_provider} />
            )}
            {provenance.llm_model && <Row label="Model" value={provenance.llm_model} />}
            {provenance.prompt_version && (
              <Row label="Prompt" value={provenance.prompt_version} mono />
            )}
          </dl>
        </div>
      )}
    </span>
  );
};

const Row: React.FC<{ label: string; value: string; mono?: boolean }> = ({
  label,
  value,
  mono,
}) => (
  <div className="flex items-baseline gap-2">
    <dt className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {label}
    </dt>
    <dd
      className={cn(
        'text-xs text-slate-700 dark:text-slate-200 truncate',
        mono && 'font-mono',
      )}
      title={value}
    >
      {value}
    </dd>
  </div>
);

export default ProvenanceTag;
