import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
    AlertCircle, ArrowLeft, FlaskConical, Loader, Pencil, Plus, Rocket, Trash2,
} from 'lucide-react';
import ApiService from '@/services/api';
import RuleEditorDrawer from './RuleEditorDrawer';
import ShadowLabPanel from './ShadowLabPanel';

/**
 * Rule Set Editor — the draft's contents, and the road to live.
 *
 * The promotion button is deliberately gated in the UI as well as the server.
 * The server's refusal ("this draft has not been shadow-run since it was last
 * edited") is the real guarantee; showing it as a disabled button with the
 * reason attached means nobody has to discover the rule by hitting it.
 */

const SEVERITY_STYLES: Record<string, string> = {
    CRITICAL: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
    HIGH: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200',
    MEDIUM: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
    LOW: 'bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300',
    INFO: 'bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-400',
};

export default function RuleSetEditor({
    ruleSetId, onBack, onMessage,
}: {
    ruleSetId: string;
    onBack: () => void;
    onMessage: (msg: string) => void;
}) {
    const [set, setSet] = useState<any>(null);
    const [kinds, setKinds] = useState<Array<{ kind: string; semantic: boolean }>>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<'rules' | 'documents' | 'shadow' | 'history'>('rules');
    const [editingRule, setEditingRule] = useState<any | null>(null);
    const [creatingRule, setCreatingRule] = useState(false);
    const [promoting, setPromoting] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [setRes, kindRes] = await Promise.all([
                ApiService.get(`/rule-sets/${ruleSetId}`),
                ApiService.get('/rule-sets/kinds'),
            ]);
            setSet(setRes.data.data);
            setKinds(kindRes.data.data || []);
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not load the rule set');
        } finally {
            setLoading(false);
        }
    }, [ruleSetId]);

    useEffect(() => { load(); }, [load]);

    const promote = async () => {
        const note = window.prompt(
            'What changed, and why? This is stored with the version snapshot — it is what answers "why does this claim have a hold?" in six months.',
        );
        if (!note?.trim()) return;
        setPromoting(true);
        setError(null);
        try {
            await ApiService.post(`/rule-sets/${ruleSetId}/promote`, { change_note: note.trim() });
            onMessage(`${ruleSetId} is now live`);
            onBack();
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not promote');
            setPromoting(false);
        }
    };

    const deleteRule = async (rid: string) => {
        if (!window.confirm(`Delete rule ${rid}?`)) return;
        try {
            await ApiService.delete(`/rule-sets/${ruleSetId}/rules/${rid}`);
            load();
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not delete the rule');
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader className="h-4 w-4 animate-spin" /> Loading rule set…
            </div>
        );
    }
    if (!set) return <p className="py-10 text-sm text-muted-foreground">Rule set not found.</p>;

    const isLive = set.status === 'live';
    const shadowed = Boolean(set.last_shadow_run_id);

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onBack}>
                    <ArrowLeft className="mr-1 h-4 w-4" /> All rule sets
                </Button>
            </div>

            {error && (
                <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div>
                        <CardTitle className="flex flex-wrap items-center gap-2">
                            {set.rule_set_name}
                            <Badge variant="outline">{set.status}</Badge>
                            <span className="text-sm font-normal text-muted-foreground">v{set.version}</span>
                        </CardTitle>
                        <code className="mt-1 block text-xs text-muted-foreground">{set.rule_set_id}</code>
                        {isLive && (
                            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                                This pack is live and read-only. Clone it to make changes.
                            </p>
                        )}
                    </div>

                    {!isLive && (
                        <div className="flex shrink-0 flex-col items-end gap-1">
                            <Button onClick={promote} disabled={!shadowed || promoting}>
                                {promoting
                                    ? <Loader className="mr-1 h-4 w-4 animate-spin" />
                                    : <Rocket className="mr-1 h-4 w-4" />}
                                Promote to live
                            </Button>
                            {!shadowed && (
                                <span className="max-w-[16rem] text-right text-[11px] text-muted-foreground">
                                    Run this against past claims first — the Shadow Lab tab. Any edit
                                    since the last run resets this.
                                </span>
                            )}
                        </div>
                    )}
                </CardHeader>

                <CardContent>
                    <div className="mb-4 flex flex-wrap gap-1 border-b">
                        {([
                            ['rules', `Rules (${set.rules?.length ?? 0})`],
                            ['documents', `Documents (${set.document_requirements?.length ?? 0})`],
                            ['shadow', 'Shadow Lab'],
                            ['history', 'History'],
                        ] as Array<[typeof tab, string]>).map(([key, label]) => (
                            <button
                                key={key}
                                onClick={() => setTab(key)}
                                className={`px-3 py-2 text-sm transition ${
                                    tab === key
                                        ? 'border-b-2 border-primary font-medium'
                                        : 'text-muted-foreground hover:text-foreground'
                                }`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    {tab === 'rules' && (
                        <>
                            {!isLive && (
                                <div className="mb-3">
                                    <Button size="sm" onClick={() => setCreatingRule(true)}>
                                        <Plus className="mr-1 h-4 w-4" /> Add rule
                                    </Button>
                                </div>
                            )}
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Rule</TableHead>
                                        <TableHead className="w-40">Kind</TableHead>
                                        <TableHead className="w-24">Severity</TableHead>
                                        <TableHead className="w-20 text-right">Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {(set.rules ?? []).map((r: any) => (
                                        <TableRow key={r.rule_id} className={r.enabled ? undefined : 'opacity-55'}>
                                            <TableCell>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="font-medium">{r.rule_name}</span>
                                                    <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                                        {r.rule_id}
                                                    </code>
                                                    {!r.enabled && <Badge variant="secondary">disabled</Badge>}
                                                </div>
                                                {r.rule_description && (
                                                    <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
                                                        {r.rule_description}
                                                    </p>
                                                )}
                                                {r.min_confidence != null && (
                                                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                                                        abstains below {r.min_confidence} confidence
                                                    </p>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                {r.kind ? (
                                                    <code className="text-[11px]">{r.kind}</code>
                                                ) : (
                                                    <span className="text-[11px] text-amber-700 dark:text-amber-400">
                                                        legacy — not evaluated
                                                    </span>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${SEVERITY_STYLES[r.severity] ?? ''}`}>
                                                    {r.severity}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                {!isLive && (
                                                    <>
                                                        <Button variant="ghost" size="icon" className="h-7 w-7"
                                                            onClick={() => setEditingRule(r)} aria-label={`Edit ${r.rule_id}`}>
                                                            <Pencil className="h-3.5 w-3.5" />
                                                        </Button>
                                                        <Button variant="ghost" size="icon" className="h-7 w-7"
                                                            onClick={() => deleteRule(r.rule_id)} aria-label={`Delete ${r.rule_id}`}>
                                                            <Trash2 className="h-3.5 w-3.5" />
                                                        </Button>
                                                    </>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                            {(set.rules ?? []).length === 0 && (
                                <p className="py-8 text-center text-sm text-muted-foreground">
                                    No rules in this pack yet.
                                </p>
                            )}
                        </>
                    )}

                    {tab === 'documents' && (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Document</TableHead>
                                    <TableHead className="w-40">Stage</TableHead>
                                    <TableHead className="w-28">Mandatory</TableHead>
                                    <TableHead>Only when</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {(set.document_requirements ?? []).map((d: any, i: number) => (
                                    <TableRow key={`${d.document_type}-${d.stage}-${i}`}>
                                        <TableCell><code className="text-xs">{d.document_type}</code></TableCell>
                                        <TableCell>
                                            {d.stage === 'ALL'
                                                ? <Badge variant="outline" className="text-[10px]">every stage</Badge>
                                                : <span className="text-xs">{d.stage}</span>}
                                        </TableCell>
                                        <TableCell className="text-xs">{d.mandatory ? 'Yes' : 'No'}</TableCell>
                                        <TableCell className="text-xs text-muted-foreground">
                                            {d.required_when || '—'}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}

                    {tab === 'shadow' && (
                        <ShadowLabPanel
                            ruleSetId={ruleSetId}
                            onRunComplete={() => { onMessage('Shadow run complete'); load(); }}
                        />
                    )}

                    {tab === 'history' && <VersionHistory ruleSetId={ruleSetId} />}
                </CardContent>
            </Card>

            {(editingRule || creatingRule) && (
                <RuleEditorDrawer
                    ruleSetId={ruleSetId}
                    rule={editingRule}
                    kinds={kinds}
                    onClose={() => { setEditingRule(null); setCreatingRule(false); }}
                    onSaved={() => { setEditingRule(null); setCreatingRule(false); load(); }}
                />
            )}
        </div>
    );
}

function VersionHistory({ ruleSetId }: { ruleSetId: string }) {
    const [versions, setVersions] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const res = await ApiService.get(`/rule-sets/${ruleSetId}/versions`);
                setVersions(res.data.data || []);
            } finally { setLoading(false); }
        })();
    }, [ruleSetId]);

    if (loading) return <p className="py-6 text-sm text-muted-foreground">Loading history…</p>;
    if (!versions.length) {
        return (
            <p className="py-6 text-sm text-muted-foreground">
                No promotions yet. A snapshot is written each time this pack goes live.
            </p>
        );
    }

    return (
        <ul className="space-y-3">
            {versions.map((v) => (
                <li key={v.id} className="rounded-md border p-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">v{v.version}</span>
                        <span className="text-xs text-muted-foreground">
                            {new Date(v.created_at).toLocaleString()}
                        </span>
                    </div>
                    <p className="mt-1 text-sm">{v.change_note || <em className="text-muted-foreground">no note</em>}</p>
                    {v.shadow_run_id && (
                        <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                            <FlaskConical className="h-3 w-3" /> shadow-run before promotion
                        </p>
                    )}
                </li>
            ))}
        </ul>
    );
}
