import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, IndianRupee, Loader } from 'lucide-react';
import ApiService from '@/services/api';

/**
 * Rule editor — a form per evaluator kind.
 *
 * The people who know the rules are not engineers, so this must not be a JSON
 * textarea. Each `kind` gets the fields that kind actually takes, and the
 * abstention threshold is explained in words rather than named after the
 * column.
 *
 * The kind list comes from the SERVER (`/rule-sets/kinds`), not a constant
 * here. The registry is frozen in Services/rules/types.ts and a hard-coded
 * copy in the UI would drift from it the first time a kind is added — the
 * exact failure mode that left docMixStageClass matching six slugs that do not
 * exist.
 */

const SEVERITIES = [
    { value: 'CRITICAL', help: 'Blocks. The claim should not be filed like this.' },
    { value: 'HIGH', help: 'Blocks. Very likely to be deducted or queried.' },
    { value: 'MEDIUM', help: 'Warns. Worth fixing before filing.' },
    { value: 'LOW', help: 'Warns. Minor.' },
    { value: 'INFO', help: 'Recorded only — never affects readiness.' },
];

const CATEGORIES = [
    'DOCUMENT_COMPLETENESS', 'POLICY_ELIGIBILITY', 'CLINICAL_APPROPRIATENESS',
    'FINANCIAL_LIMITS', 'PROCEDURAL_COMPLIANCE', 'TEMPORAL_VALIDITY',
];
const IMPACTS = ['CLAIM_REJECTION', 'DEDUCTION', 'QUERY', 'WARNING', 'INFO'];

/** Per-kind parameter help, in the words an ops lead would use. */
const KIND_HELP: Record<string, { blurb: string; fields: Array<{ key: string; label: string; placeholder: string }> }> = {
    DOCUMENT_PRESENCE: {
        blurb: 'Checks a document is in the bundle for this stage.',
        fields: [{ key: 'category', label: 'Document category', placeholder: 'implant_sticker' }],
    },
    REQUIRED_FIELDS: {
        blurb: 'Checks named fields were actually extracted from a document.',
        fields: [
            { key: 'category', label: 'Document category', placeholder: 'final_bill' },
            { key: 'fields', label: 'Required fields (comma separated)', placeholder: 'bill_number, bill_date' },
        ],
    },
    FUZZY_NAME: {
        blurb: 'Checks the patient name agrees across documents. Tolerates initials, word order and spelling — Indian ID documents legitimately vary.',
        fields: [{ key: 'maxDistance', label: 'Max name distance (0-1)', placeholder: '0.3' }],
    },
    TEMPORAL_WINDOW: {
        blurb: 'Checks a document date falls in the right window relative to admission or discharge.',
        fields: [
            { key: 'category', label: 'Document category', placeholder: 'pre_authorization_form' },
            { key: 'anchor', label: 'Anchor (admission | discharge)', placeholder: 'admission' },
            { key: 'maxDaysBefore', label: 'Max days before anchor', placeholder: '7' },
            { key: 'maxDaysAfter', label: 'Max days after anchor', placeholder: '0' },
        ],
    },
    LLM_COHERENCE: {
        blurb: 'Asks a model whether two documents tell the same story. Costs money per claim.',
        fields: [{ key: 'assertion', label: 'What must be true', placeholder: 'The discharge summary diagnosis matches the pre-auth diagnosis' }],
    },
    EVIDENCE_CHECK: {
        blurb: 'Asks a model whether one document is actually supported by another. Costs money per claim.',
        fields: [{ key: 'assertion', label: 'What must be supported', placeholder: 'Every implant billed has a matching sticker' }],
    },
};

export default function RuleEditorDrawer({
    ruleSetId, rule, kinds, onClose, onSaved,
}: {
    ruleSetId: string;
    rule: any | null;
    kinds: Array<{ kind: string; semantic: boolean }>;
    onClose: () => void;
    onSaved: () => void;
}) {
    const isNew = !rule;
    const [ruleId, setRuleId] = useState(rule?.rule_id ?? '');
    const [ruleName, setRuleName] = useState(rule?.rule_name ?? '');
    const [description, setDescription] = useState(rule?.rule_description ?? '');
    const [kind, setKind] = useState(rule?.kind ?? 'DOCUMENT_PRESENCE');
    const [severity, setSeverity] = useState(rule?.severity ?? 'MEDIUM');
    const [category, setCategory] = useState(rule?.category ?? 'DOCUMENT_COMPLETENESS');
    const [impact, setImpact] = useState(rule?.impact ?? 'QUERY');
    const [enabled, setEnabled] = useState(rule?.enabled !== false);
    const [minConfidence, setMinConfidence] = useState(
        rule?.min_confidence != null ? String(rule.min_confidence) : '',
    );
    const [failureMessage, setFailureMessage] = useState(rule?.failure_message ?? '');
    const [params, setParams] = useState<Record<string, string>>(() => {
        const src = rule?.validation_logic ?? {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(src)) {
            out[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        }
        return out;
    });

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const spec = KIND_HELP[kind];
    const isSemantic = kinds.find((k) => k.kind === kind)?.semantic;

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            const validationLogic: Record<string, unknown> = {};
            for (const f of spec?.fields ?? []) {
                const raw = params[f.key];
                if (raw === undefined || raw === '') continue;
                validationLogic[f.key] = f.key === 'fields'
                    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
                    : raw;
            }
            await ApiService.put(`/rule-sets/${ruleSetId}/rules`, {
                rule_id: ruleId.trim(),
                rule_name: ruleName.trim(),
                rule_description: description.trim() || null,
                kind, severity, category, impact, enabled,
                min_confidence: minConfidence === '' ? null : Number(minConfidence),
                failure_message: failureMessage.trim() || null,
                validation_logic: validationLogic,
            });
            onSaved();
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not save the rule');
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-background p-6 shadow-lg">
                <h2 className="text-lg font-semibold">{isNew ? 'New rule' : `Edit ${rule.rule_name}`}</h2>

                {error && (
                    <div className="mt-4 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                <div className="mt-4 space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                            <label className="text-sm font-medium">Rule ID</label>
                            <Input
                                value={ruleId}
                                onChange={(e) => setRuleId(e.target.value.toUpperCase())}
                                disabled={!isNew}
                                placeholder="IMPLANT_STICKER_PRESENT"
                                className="mt-1 font-mono"
                            />
                        </div>
                        <div>
                            <label className="text-sm font-medium">Name</label>
                            <Input
                                value={ruleName}
                                onChange={(e) => setRuleName(e.target.value)}
                                placeholder="Implant sticker present"
                                className="mt-1"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="text-sm font-medium">What it checks</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={2}
                            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                            placeholder="Plain English. This is what a reviewer sees next to the finding."
                        />
                    </div>

                    <div>
                        <label className="text-sm font-medium">Check type</label>
                        <select
                            value={kind}
                            onChange={(e) => { setKind(e.target.value); setParams({}); }}
                            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                        >
                            {kinds.map((k) => (
                                <option key={k.kind} value={k.kind}>{k.kind}</option>
                            ))}
                        </select>
                        {spec && <p className="mt-1 text-xs text-muted-foreground">{spec.blurb}</p>}
                        {isSemantic && (
                            <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                                <IndianRupee className="h-3 w-3" />
                                This type calls a model on every claim. Deterministic checks are free —
                                use one if it can answer the question.
                            </p>
                        )}
                    </div>

                    {spec?.fields.map((f) => (
                        <div key={f.key}>
                            <label className="text-sm font-medium">{f.label}</label>
                            <Input
                                value={params[f.key] ?? ''}
                                onChange={(e) => setParams((p) => ({ ...p, [f.key]: e.target.value }))}
                                placeholder={f.placeholder}
                                className="mt-1"
                            />
                        </div>
                    ))}

                    <div className="grid gap-4 sm:grid-cols-3">
                        <div>
                            <label className="text-sm font-medium">Severity</label>
                            <select
                                value={severity}
                                onChange={(e) => setSeverity(e.target.value)}
                                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                            >
                                {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.value}</option>)}
                            </select>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {SEVERITIES.find((s) => s.value === severity)?.help}
                            </p>
                        </div>
                        <div>
                            <label className="text-sm font-medium">Category</label>
                            <select
                                value={category}
                                onChange={(e) => setCategory(e.target.value)}
                                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                            >
                                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="text-sm font-medium">If it fails</label>
                            <select
                                value={impact}
                                onChange={(e) => setImpact(e.target.value)}
                                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                            >
                                {IMPACTS.map((i) => <option key={i} value={i}>{i}</option>)}
                            </select>
                        </div>
                    </div>

                    <div>
                        <label className="text-sm font-medium">Abstain below confidence</label>
                        <Input
                            value={minConfidence}
                            onChange={(e) => setMinConfidence(e.target.value)}
                            placeholder="0.8"
                            className="mt-1 max-w-[160px]"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                            Optional, 0 to 1. Below this the rule says "I can't tell" instead of
                            passing or failing. An abstaining CRITICAL or HIGH rule goes to human
                            review — it is never counted as a pass.
                        </p>
                    </div>

                    <div>
                        <label className="text-sm font-medium">Message when it fails</label>
                        <Input
                            value={failureMessage}
                            onChange={(e) => setFailureMessage(e.target.value)}
                            placeholder="Implant sticker missing — the insurer will deduct the implant cost."
                            className="mt-1"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                            Say what is wrong and what it costs. This is what lands on someone's worklist.
                        </p>
                    </div>

                    <label className="flex items-center gap-2">
                        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                        <span className="text-sm">Enabled</span>
                        {!enabled && <Badge variant="secondary">will not run</Badge>}
                    </label>
                </div>

                <div className="mt-6 flex justify-end gap-2">
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={save} disabled={saving || !ruleId.trim() || !ruleName.trim()}>
                        {saving && <Loader className="mr-1 h-4 w-4 animate-spin" />}
                        Save rule
                    </Button>
                </div>
            </div>
        </div>
    );
}
