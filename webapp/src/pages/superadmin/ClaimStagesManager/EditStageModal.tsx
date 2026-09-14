import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, Loader, Lock } from 'lucide-react';
import ApiService from '@/services/api';
import type { ClaimStage } from './index';

const CYCLE_TYPES = [
    { value: 'initial', label: 'Initial submission', locked: true },
    { value: 'query_response', label: 'Query reply', locked: false },
];

/**
 * Create or edit a claim stage.
 *
 * `code` is editable ONLY when creating. On an existing stage it is shown
 * locked, because the code is referenced by convention from ipds.stage,
 * claim_context.stage, document_sections.stage and the
 * insurer_rule_sets.applicable_stages TEXT[] — none of which have a real
 * foreign key. A rename would detach rule packs from claims silently, so the
 * server rejects it too; this just explains why before the user tries.
 */
export default function EditStageModal({
    stage, nextSortOrder, onClose, onSaved,
}: {
    stage: ClaimStage | null;
    nextSortOrder: number;
    onClose: () => void;
    onSaved: (message: string) => void;
}) {
    const isNew = stage === null;

    const [code, setCode] = useState(stage?.code ?? '');
    const [label, setLabel] = useState(stage?.label ?? '');
    const [definition, setDefinition] = useState(stage?.definition ?? '');
    const [entryTrigger, setEntryTrigger] = useState(stage?.entry_trigger ?? '');
    const [exitTrigger, setExitTrigger] = useState(stage?.exit_trigger ?? '');
    const [expectedTat, setExpectedTat] = useState(stage?.expected_tat ?? '');
    const [cycleTypes, setCycleTypes] = useState<string[]>(stage?.cycle_types ?? ['initial']);

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const toggleCycle = (value: string) => {
        if (value === 'initial') return; // every stage has a first submission
        setCycleTypes((prev) =>
            prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value],
        );
    };

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            if (isNew) {
                await ApiService.post('/claim-stages', {
                    code: code.trim().toUpperCase(),
                    label: label.trim(),
                    definition: definition.trim(),
                    entry_trigger: entryTrigger.trim() || null,
                    exit_trigger: exitTrigger.trim() || null,
                    expected_tat: expectedTat.trim() || null,
                    sort_order: nextSortOrder,
                    cycle_types: cycleTypes,
                });
                onSaved(`Stage ${code.trim().toUpperCase()} created`);
            } else {
                await ApiService.patch(`/claim-stages/${stage!.code}`, {
                    label: label.trim(),
                    definition: definition.trim(),
                    entry_trigger: entryTrigger.trim() || null,
                    exit_trigger: exitTrigger.trim() || null,
                    expected_tat: expectedTat.trim() || null,
                    cycle_types: cycleTypes,
                });
                onSaved(`Stage ${stage!.code} updated`);
            }
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not save the stage');
        } finally {
            setSaving(false);
        }
    };

    const canSave = label.trim() && definition.trim() && (!isNew || code.trim());

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-background p-6 shadow-lg">
                <h2 className="text-lg font-semibold">
                    {isNew ? 'New claim stage' : `Edit ${stage!.label}`}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    A stage owns a document checklist. If the hospital files nothing during it,
                    it belongs in insurer outcomes instead.
                </p>

                {error && (
                    <div className="mt-4 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                <div className="mt-4 space-y-4">
                    <div>
                        <label className="text-sm font-medium">Code</label>
                        {isNew ? (
                            <>
                                <Input
                                    value={code}
                                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                                    placeholder="DEDUCTION_APPEAL"
                                    className="mt-1 font-mono"
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    SCREAMING_SNAKE_CASE. Permanent once claims reference it — choose carefully.
                                </p>
                            </>
                        ) : (
                            <div className="mt-1 flex items-center gap-2">
                                <code className="rounded bg-muted px-2 py-1 text-sm">{stage!.code}</code>
                                <Badge variant="outline" className="gap-1 text-[10px]">
                                    <Lock className="h-3 w-3" /> Immutable
                                </Badge>
                            </div>
                        )}
                        {!isNew && (
                            <p className="mt-1 text-xs text-muted-foreground">
                                Rule sets, document requirements and live claims reference this code.
                                To change it, retire this stage and create a new one.
                            </p>
                        )}
                    </div>

                    <div>
                        <label className="text-sm font-medium">Label</label>
                        <Input
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            placeholder="Deduction appeal"
                            className="mt-1"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                            What staff see in the upload dropdown. Safe to reword at any time — a
                            re-seed will not overwrite it.
                        </p>
                    </div>

                    <div>
                        <label className="text-sm font-medium">Definition</label>
                        <textarea
                            value={definition}
                            onChange={(e) => setDefinition(e.target.value)}
                            rows={2}
                            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                            placeholder="One line. Shown as help text under the dropdown option."
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                            This is what stops someone picking the wrong bucket at the end of a shift.
                        </p>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                            <label className="text-sm font-medium">Entry trigger</label>
                            <Input
                                value={entryTrigger}
                                onChange={(e) => setEntryTrigger(e.target.value)}
                                placeholder="What moves a claim in"
                                className="mt-1"
                            />
                        </div>
                        <div>
                            <label className="text-sm font-medium">Exit trigger</label>
                            <Input
                                value={exitTrigger}
                                onChange={(e) => setExitTrigger(e.target.value)}
                                placeholder="What moves it out"
                                className="mt-1"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="text-sm font-medium">Expected TAT</label>
                        <Input
                            value={expectedTat}
                            onChange={(e) => setExpectedTat(e.target.value)}
                            placeholder="e.g. Insurer must decide within 1 hour"
                            className="mt-1"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                            Guidance only. Binding deadlines are per-panel — TPAs disagree, and two
                            of them contradict their own published documents.
                        </p>
                    </div>

                    <div>
                        <label className="text-sm font-medium">Submission cycles</label>
                        <div className="mt-2 flex flex-wrap gap-2">
                            {CYCLE_TYPES.map((c) => {
                                const on = cycleTypes.includes(c.value);
                                return (
                                    <button
                                        key={c.value}
                                        type="button"
                                        onClick={() => toggleCycle(c.value)}
                                        disabled={c.locked}
                                        className={`rounded-md border px-3 py-1.5 text-xs transition ${
                                            on
                                                ? 'border-primary bg-primary/10 text-foreground'
                                                : 'border-border text-muted-foreground hover:bg-muted'
                                        } ${c.locked ? 'cursor-not-allowed opacity-70' : ''}`}
                                    >
                                        {c.label}{c.locked && ' (always)'}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            A query reply files different documents from the first submission, but
                            it is a repeat of this stage — not a separate one. Requirements are keyed
                            on stage plus cycle.
                        </p>
                    </div>
                </div>

                <div className="mt-6 flex justify-end gap-2">
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={save} disabled={saving || !canSave}>
                        {saving && <Loader className="mr-1 h-4 w-4 animate-spin" />}
                        {isNew ? 'Create stage' : 'Save changes'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
