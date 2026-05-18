import React, { useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfidenceBadge } from '@/components/intelligence/primitives';
import type { DocumentSection } from '@/hooks/intelligence/useDocumentSections';

/**
 * Wave 2D — Section Extraction Panel.
 *
 * Inline editor for the `extracted_fields` of a single document section.
 *
 * The field schema isn't shipped from the backend yet (Wave 2C wills carry
 * a `field_schema` on each section). Until then, we infer the input type
 * from the JS type of each value. A `extraction_confidence` map is
 * optional — when present, we render a per-field ConfidenceBadge.
 *
 * TODO(Wave 2C+): once `field_schema` lands, switch to schema-driven
 * inputs (enums, dates, currency, multi-line).
 */

type FieldKind = 'text' | 'number' | 'boolean' | 'json';

const inferKind = (v: unknown): FieldKind => {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'text';
  return 'json';
};

const inputCls =
  'w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300 disabled:bg-slate-50 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-slate-500 dark:focus:ring-slate-700';

type StatusKind = 'auto' | 'reviewed' | 'corrected';

const statusOf = (s: DocumentSection): StatusKind => {
  if (s.status === 'reviewed') return s.reviewed_by ? 'reviewed' : 'auto';
  if (s.status === 'rejected') return 'corrected';
  return 'auto';
};

const STATUS_LABEL: Record<StatusKind, string> = {
  auto: 'Auto',
  reviewed: 'Reviewed',
  corrected: 'Corrected',
};

const STATUS_DOT: Record<StatusKind, string> = {
  auto: 'bg-slate-400 dark:bg-slate-500',
  reviewed: 'bg-emerald-500 dark:bg-emerald-400',
  corrected: 'bg-amber-500 dark:bg-amber-400',
};

const STATUS_TEXT: Record<StatusKind, string> = {
  auto: 'text-slate-500 dark:text-slate-400',
  reviewed: 'text-emerald-700 dark:text-emerald-300',
  corrected: 'text-amber-700 dark:text-amber-300',
};

export interface SectionExtractionPanelProps {
  section: DocumentSection;
  /** Wave 3+ will wire this to a mutation. For now, caller can stub. */
  onSave?: (next: DocumentSection) => void;
  className?: string;
}

export const SectionExtractionPanel: React.FC<SectionExtractionPanelProps> = ({
  section,
  onSave,
  className,
}) => {
  const [fields, setFields] = useState<Record<string, any>>(
    () => section.extracted_fields ?? {},
  );
  const original = section.extracted_fields ?? {};

  // Per-field confidence is currently not in the shipped type. We look for
  // a sibling `extraction_confidence` map on the section if the BE adds it.
  const perFieldConfidence: Record<string, number> | undefined = (section as any)
    .extraction_confidence;

  const dirty = useMemo(
    () => JSON.stringify(fields) !== JSON.stringify(original),
    [fields, original],
  );

  const set = (k: string, v: any) => setFields((f) => ({ ...f, [k]: v }));

  const status = statusOf(section);

  const keys = Object.keys(fields);

  return (
    <div
      className={cn(
        'rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900',
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Extracted Fields
        </h4>
        <span
          className={cn('inline-flex items-center gap-1 text-xs font-medium', STATUS_TEXT[status])}
          title={section.reviewed_at ? `Reviewed at ${section.reviewed_at}` : undefined}
        >
          <span className={cn('inline-block h-1.5 w-1.5 rounded-full', STATUS_DOT[status])} />
          {STATUS_LABEL[status]}
        </span>
      </div>

      {keys.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 p-3 text-xs italic text-slate-500 dark:text-slate-400">
          No fields extracted from this section yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {keys.map((k) => {
            const kind = inferKind(original[k]);
            const v = fields[k];
            const conf = perFieldConfidence?.[k];
            return (
              <label key={k} className="block space-y-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {k}
                  </span>
                  {typeof conf === 'number' && (
                    <ConfidenceBadge confidence={conf} mode="auto" size="sm" />
                  )}
                </span>
                {kind === 'boolean' ? (
                  <select
                    value={String(!!v)}
                    onChange={(e) => set(k, e.target.value === 'true')}
                    className={inputCls}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : kind === 'number' ? (
                  <input
                    type="number"
                    value={v ?? ''}
                    onChange={(e) =>
                      set(k, e.target.value === '' ? null : Number(e.target.value))
                    }
                    className={inputCls}
                  />
                ) : kind === 'json' ? (
                  <textarea
                    rows={2}
                    value={typeof v === 'string' ? v : JSON.stringify(v ?? null)}
                    onChange={(e) => {
                      try {
                        set(k, JSON.parse(e.target.value));
                      } catch {
                        set(k, e.target.value);
                      }
                    }}
                    className={cn(inputCls, 'font-mono text-xs')}
                  />
                ) : (
                  <input
                    type="text"
                    value={v ?? ''}
                    onChange={(e) => set(k, e.target.value)}
                    className={inputCls}
                  />
                )}
              </label>
            );
          })}
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        {dirty && (
          <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
            Unsaved changes
          </span>
        )}
        <button
          type="button"
          disabled={!dirty || !onSave}
          onClick={() => onSave?.({ ...section, extracted_fields: fields })}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
        >
          <Save className="h-3.5 w-3.5" /> Save
        </button>
      </div>
    </div>
  );
};

export default SectionExtractionPanel;
