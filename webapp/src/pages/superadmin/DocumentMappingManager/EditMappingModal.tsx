import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertCircle, Loader } from 'lucide-react';
import ApiService from '@/services/api';
import type { MappingRow } from './index';

/**
 * Edit one category's stage mapping.
 *
 * The UI enforces the same contradiction the server and the seed both reject:
 * a category cannot be BOTH evergreen ("counts at every stage") and floored
 * ("cannot exist before stage X"). Ticking evergreen therefore disables the
 * floor rather than letting someone construct an invalid pair and discover it
 * on save.
 */
export default function EditMappingModal({
    row, stages, onClose, onSaved,
}: {
    row: MappingRow;
    stages: Array<{ code: string; label: string }>;
    onClose: () => void;
    onSaved: (message: string) => void;
}) {
    const [isEvergreen, setIsEvergreen] = useState(row.is_evergreen);
    const [stageFloor, setStageFloor] = useState(row.stage_floor ?? '');
    const [affinityStage, setAffinityStage] = useState(row.affinity_stage ?? '');
    const [requiredWhen, setRequiredWhen] = useState(row.required_when ?? '');
    const [notes, setNotes] = useState(row.notes ?? '');

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const toggleEvergreen = (next: boolean) => {
        setIsEvergreen(next);
        if (next) setStageFloor(''); // the two are mutually exclusive
    };

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            await ApiService.put(`/document-stage-affinity/${row.doc_category}`, {
                is_evergreen: isEvergreen,
                stage_floor: stageFloor || null,
                affinity_stage: affinityStage || null,
                required_when: requiredWhen.trim() || null,
                notes: notes.trim() || null,
            });
            onSaved(`Mapping saved for ${row.label}`);
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not save the mapping');
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-background p-6 shadow-lg">
                <h2 className="text-lg font-semibold">{row.label}</h2>
                <code className="text-xs text-muted-foreground">{row.doc_category}</code>

                {error && (
                    <div className="mt-4 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                <div className="mt-5 space-y-5">
                    <label className="flex cursor-pointer items-start gap-3">
                        <input
                            type="checkbox"
                            checked={isEvergreen}
                            onChange={(e) => toggleEvergreen(e.target.checked)}
                            className="mt-1"
                        />
                        <span>
                            <span className="text-sm font-medium">Evidence at every stage</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                                For facts about the person or the policy — identity, KYC, policy
                                card. Filed once, it satisfies every stage, so it is never reported
                                missing later. Not for anything specific to this admission.
                            </span>
                        </span>
                    </label>

                    <div>
                        <label className="text-sm font-medium">Stage floor</label>
                        <select
                            value={stageFloor}
                            onChange={(e) => setStageFloor(e.target.value)}
                            disabled={isEvergreen}
                            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-50"
                        >
                            <option value="">No floor — any stage is possible</option>
                            {stages.map((s) => (
                                <option key={s.code} value={s.code}>Not before {s.label}</option>
                            ))}
                        </select>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {isEvergreen
                                ? 'Not applicable — an evergreen document counts at every stage, so it cannot have a floor.'
                                : 'The earliest stage this document can physically exist at. This is the only setting that can reject an uploader’s choice, so set it only when a counter-example is impossible — a final bill cannot precede discharge.'}
                        </p>
                    </div>

                    <div>
                        <label className="text-sm font-medium">Usual stage</label>
                        <select
                            value={affinityStage}
                            onChange={(e) => setAffinityStage(e.target.value)}
                            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                        >
                            <option value="">None</option>
                            {stages.map((s) => (
                                <option key={s.code} value={s.code}>{s.label}</option>
                            ))}
                        </select>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Used only for documents that arrive with no stage chosen — insurer
                            email, portal, or an admin upload. Never overrides a person.
                        </p>
                    </div>

                    <div>
                        <label className="text-sm font-medium">Only relevant when</label>
                        <Input
                            value={requiredWhen}
                            onChange={(e) => setRequiredWhen(e.target.value)}
                            placeholder="implant billed / accident / claim ≥ ₹1 lakh"
                            className="mt-1"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                            Optional condition. Leave blank if it always applies.
                        </p>
                    </div>

                    <div>
                        <label className="text-sm font-medium">Why</label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={2}
                            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                            placeholder="The reasoning, for whoever reviews this in six months."
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                            A mapping nobody can justify is a mapping nobody should trust.
                        </p>
                    </div>
                </div>

                <div className="mt-6 flex justify-end gap-2">
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={save} disabled={saving}>
                        {saving && <Loader className="mr-1 h-4 w-4 animate-spin" />}
                        Save mapping
                    </Button>
                </div>
            </div>
        </div>
    );
}
