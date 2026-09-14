/**
 * "What is this document for?" — the upload dropdown.
 *
 * WHY THIS EXISTS
 * Documents for one claim arrive in bursts over 7-10 days, from four sources
 * (hospital upload, email, insurer portal, Finclarity admin). The claim moves
 * between bursts, so ARRIVAL TIME IS A POOR PROXY for which stage a document
 * is evidence for — a discharge summary handed over on day 9 may be the thing
 * that completes the day-2 pre-auth file.
 *
 * Asking the person holding the document is the cheapest accurate answer
 * available, and `declared` sits second in the precedence, above every guess
 * the pipeline makes (see documentStageAffinity.service.ts).
 *
 * WHAT IT WILL AND WON'T OFFER
 * The option list comes from GET /claim-stages/upload-options, which applies
 * the curation policy server-side: past stages are free (back-filling is
 * routine), the NEXT stage is offered but flagged `confirm` (hospitals do
 * prepare ahead), and anything further out is withheld — a clerk who can reach
 * it will eventually pick it by accident, and a mis-tagged document routes to
 * the wrong rule pack silently.
 *
 * Skipping is a first-class choice, not a failure. "Not sure" leaves the value
 * NULL and resolution falls through to category affinity, which is right far
 * more often than a guess made under time pressure at 7pm.
 */

import React, { useEffect, useState } from 'react';
import ApiService from '../../services/api';

export interface UploadStageOption {
    code: string;
    label: string;
    definition: string;
    relation: 'past' | 'current' | 'next';
    confirm: boolean;
}

interface StagePickerProps {
    /** The claim's current stage, so the server can rank the options. */
    currentStage?: string | null;
    value: string | null;
    onChange: (code: string | null) => void;
    disabled?: boolean;
}

const RELATION_HINT: Record<UploadStageOption['relation'], string> = {
    past: 'earlier',
    current: 'current',
    next: 'ahead',
};

export const StagePicker: React.FC<StagePickerProps> = ({
    currentStage,
    value,
    onChange,
    disabled,
}) => {
    const [options, setOptions] = useState<UploadStageOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const qs = currentStage ? `?current_stage=${encodeURIComponent(currentStage)}` : '';
                const res = await ApiService.get(`/claim-stages/upload-options${qs}`);
                if (cancelled) return;
                setOptions(res?.data?.data ?? res?.data ?? []);
            } catch {
                // A stage tag is metadata. If the registry is unreachable the
                // upload must still work — hide the control rather than block
                // the person holding the document.
                if (!cancelled) setFailed(true);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [currentStage]);

    if (failed || (!loading && options.length === 0)) return null;

    const selected = options.find((o) => o.code === value) ?? null;

    return (
        // Bounded width, and the hint text is absolutely positioned OUT of the
        // flow. Both matter: this sits in the same flex row as "Upload
        // documents", and letting either the longest stage label or the
        // confirm warning size the column pushes that button off the edge.
        <div className="relative flex w-48 shrink-0 flex-col gap-1">
            <label htmlFor="upload-stage" className="text-xs font-medium text-muted-foreground">
                What is this document for?
            </label>
            <select
                id="upload-stage"
                className="h-9 w-full truncate rounded-md border border-input bg-background px-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                value={value ?? ''}
                disabled={disabled || loading}
                onChange={(e) => onChange(e.target.value || null)}
            >
                <option value="">
                    {loading ? 'Loading stages…' : 'Not sure — decide automatically'}
                </option>
                {options.map((o) => (
                    <option key={o.code} value={o.code}>
                        {o.label}
                        {o.relation !== 'current' ? ` (${RELATION_HINT[o.relation]})` : ''}
                    </option>
                ))}
            </select>

            {selected?.confirm && (
                <p className="absolute left-0 top-full z-10 mt-1 w-64 text-xs text-amber-600 dark:text-amber-500">
                    That stage hasn’t started yet — only pick it if you’re filing ahead.
                </p>
            )}
            {selected && !selected.confirm && (
                <p className="absolute left-0 top-full z-10 mt-1 w-64 text-xs text-muted-foreground">
                    {selected.definition}
                </p>
            )}
        </div>
    );
};

export default StagePicker;
