import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertCircle, Loader } from 'lucide-react';
import ApiService from '@/services/api';

/**
 * Per-panel deadlines and vocabulary.
 *
 * Blank means UNKNOWN, and unknown means the timeliness rule is SKIPPED rather
 * than passed. That distinction is stated in the UI because the alternative —
 * a blank field quietly meaning "no limit" — would have the system telling a
 * hospital it filed on time when nobody knows whether it did.
 */
export default function PanelConfigModal({
    panel, onClose, onSaved,
}: {
    panel: any;
    onClose: () => void;
    onSaved: (message: string) => void;
}) {
    const [form, setForm] = useState({
        preauth_decision_hours: panel.preauth_decision_hours ?? '',
        enhancement_decision_hours: panel.enhancement_decision_hours ?? '',
        final_auth_decision_hours: panel.final_auth_decision_hours ?? '',
        claim_file_days: panel.claim_file_days ?? '',
        query_reply_days: panel.query_reply_days ?? '',
        source_note: panel.source_note ?? '',
    });
    const [silenceIsDenial, setSilenceIsDenial] = useState(Boolean(panel.enhancement_silence_is_denial));
    const [exemptHeads, setExemptHeads] = useState((panel.proportionate_exempt_heads ?? []).join(', '));
    const [aliases, setAliases] = useState(
        Object.entries(panel.terminology_aliases ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const num = (v: any) => (v === '' || v == null ? null : Number(v));

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            const aliasMap: Record<string, string> = {};
            for (const line of aliases.split('\n')) {
                const [k, ...rest] = line.split('=');
                if (k?.trim() && rest.length) aliasMap[k.trim()] = rest.join('=').trim();
            }
            await ApiService.put(`/adjudication-config/panels/${panel.panel_id}`, {
                preauth_decision_hours: num(form.preauth_decision_hours),
                enhancement_decision_hours: num(form.enhancement_decision_hours),
                final_auth_decision_hours: num(form.final_auth_decision_hours),
                claim_file_days: num(form.claim_file_days),
                query_reply_days: num(form.query_reply_days),
                enhancement_silence_is_denial: silenceIsDenial,
                terminology_aliases: aliasMap,
                proportionate_exempt_heads: exemptHeads.split(',').map((s) => s.trim()).filter(Boolean),
                source_note: form.source_note.trim() || null,
            });
            onSaved(`${panel.panel_name} configuration saved`);
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not save the configuration');
            setSaving(false);
        }
    };

    const field = (key: keyof typeof form, label: string, placeholder: string, help?: string) => (
        <div>
            <label className="text-sm font-medium">{label}</label>
            <Input
                value={(form as any)[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                placeholder={placeholder}
                className="mt-1"
            />
            {help && <p className="mt-1 text-xs text-muted-foreground">{help}</p>}
        </div>
    );

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-background p-6 shadow-lg">
                <h2 className="text-lg font-semibold">{panel.panel_name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    Leave a field blank if you do not know it for this panel. Blank means the
                    timeliness check is skipped — never that there is no deadline.
                </p>

                {error && (
                    <div className="mt-4 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
                    </div>
                )}

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    {field('preauth_decision_hours', 'Pre-auth decision (hours)', '1', 'IRDAI mandates 1 hour.')}
                    {field('final_auth_decision_hours', 'Discharge authorisation (hours)', '3', 'IRDAI mandates 3 hours.')}
                    {field('enhancement_decision_hours', 'Enhancement decision (hours)', '24', 'Not regulated. MDIndia uses 24h.')}
                    {field('query_reply_days', 'Query reply window (days)', '10', 'Varies widely: 1 to 10 working days.')}
                    {field('claim_file_days', 'Claim file window (days)', '7', 'Verified range 2 to 30 across four TPAs.')}
                </div>

                <label className="mt-4 flex items-start gap-2">
                    <input type="checkbox" checked={silenceIsDenial}
                        onChange={(e) => setSilenceIsDenial(e.target.checked)} className="mt-1" />
                    <span>
                        <span className="text-sm font-medium">No answer to an enhancement counts as a denial</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                            MDIndia works this way. A silent forfeiture, so it is worth an alert
                            before the window closes rather than after.
                        </span>
                    </span>
                </label>

                <div className="mt-4">
                    <label className="text-sm font-medium">Heads exempt from proportionate deduction</label>
                    <Input value={exemptHeads} onChange={(e) => setExemptHeads(e.target.value)}
                        placeholder="pharmacy, implants, diagnostics" className="mt-1" />
                    <p className="mt-1 text-xs text-muted-foreground">
                        On a room-rent breach these heads should NOT be scaled. Insurers routinely
                        scale everything unless challenged — this is what makes the over-application
                        detectable and recoverable.
                    </p>
                </div>

                <div className="mt-4">
                    <label className="text-sm font-medium">Terminology aliases</label>
                    <textarea
                        value={aliases} onChange={(e) => setAliases(e.target.value)} rows={3}
                        className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                        placeholder={'FINAL_AUTH=enhancement\nquery=shortfall'}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                        One per line, <code>canonical=what this panel calls it</code>. Vidal calls
                        the discharge decision "the enhancement" — everyone else means a mid-stay
                        top-up by that word, so without a mapping Vidal claims mis-file
                        systematically.
                    </p>
                </div>

                <div className="mt-4">
                    <label className="text-sm font-medium">Where these numbers came from</label>
                    <Input value={form.source_note}
                        onChange={(e) => setForm((f) => ({ ...f, source_note: e.target.value }))}
                        placeholder="MOU dated March 2026, clause 7.4" className="mt-1" />
                    <p className="mt-1 text-xs text-muted-foreground">
                        A deadline nobody can source is a deadline nobody should enforce against a hospital.
                    </p>
                </div>

                <div className="mt-6 flex justify-end gap-2">
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={save} disabled={saving}>
                        {saving && <Loader className="mr-1 h-4 w-4 animate-spin" />}
                        Save configuration
                    </Button>
                </div>
            </div>
        </div>
    );
}
