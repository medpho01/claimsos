import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertCircle, Loader } from 'lucide-react';
import ApiService from '@/services/api';
import type { RuleSetSummary } from './index';

/**
 * Clone a live pack into an editable draft.
 *
 * This is the only way to change a live pack, and the copy is deep — rules,
 * document requirements and financial limits all come across — so the draft
 * starts from something that already works rather than a blank form.
 */
export default function CloneRuleSetModal({
    source, onClose, onCloned,
}: {
    source: RuleSetSummary;
    onClose: () => void;
    onCloned: (newRuleSetId: string, message: string) => void;
}) {
    // Suggest a v-next id rather than making someone invent one; ids are the
    // lineage key that ties a draft back to the pack it will replace.
    const suggestedId = source.rule_set_id.replace(/_V(\d+)$/i, (_m, n) => `_V${Number(n) + 1}`);
    const [ruleSetId, setRuleSetId] = useState(
        suggestedId === source.rule_set_id ? `${source.rule_set_id}_V2` : suggestedId,
    );
    const [name, setName] = useState(`${source.rule_set_name} (draft)`);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        setSaving(true);
        setError(null);
        try {
            await ApiService.post(`/rule-sets/${source.rule_set_id}/clone`, {
                new_rule_set_id: ruleSetId.trim(),
                new_name: name.trim(),
            });
            onCloned(ruleSetId.trim(), `Draft ${ruleSetId.trim()} created from ${source.rule_set_id}`);
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not clone the rule set');
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-lg rounded-lg bg-background p-6 shadow-lg">
                <h2 className="text-lg font-semibold">Clone {source.rule_set_name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    Copies every rule, document requirement and financial limit into a new draft.
                    The live pack keeps running untouched until you promote the copy.
                </p>

                {error && (
                    <div className="mt-4 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                <div className="mt-4 space-y-4">
                    <div>
                        <label className="text-sm font-medium">New rule set ID</label>
                        <Input
                            value={ruleSetId}
                            onChange={(e) => setRuleSetId(e.target.value.toUpperCase())}
                            className="mt-1 font-mono"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                            Must be unique. Kept as the lineage key, so the draft knows which live
                            pack it replaces on promotion.
                        </p>
                    </div>
                    <div>
                        <label className="text-sm font-medium">Name</label>
                        <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
                    </div>
                </div>

                <div className="mt-6 flex justify-end gap-2">
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={submit} disabled={saving || !ruleSetId.trim() || !name.trim()}>
                        {saving && <Loader className="mr-1 h-4 w-4 animate-spin" />}
                        Create draft
                    </Button>
                </div>
            </div>
        </div>
    );
}
