import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { AlertCircle, Copy, Loader, Settings2 } from 'lucide-react';
import ApiService from '@/services/api';
import RuleSetEditor from './RuleSetEditor';
import CloneRuleSetModal from './CloneRuleSetModal';

/**
 * Rule Sets — the packs that decide what each claim is judged against.
 *
 * The authoring model, which the UI exists to make obvious:
 *
 *   live  →  clone  →  draft  →  shadow run  →  promote  →  live
 *
 * A live pack is never edited in place. It is what every in-flight claim is
 * being judged by right now, and changing it mid-flight would alter verdicts
 * with no diff and nothing to revert to. So "Edit" on a live pack offers a
 * clone instead — the server refuses the edit regardless, but a UI that lets
 * someone try and then fails them is a worse UI than one that explains first.
 */

export interface RuleSetSummary {
    id: string;
    rule_set_id: string;
    rule_set_name: string;
    version: string;
    status: 'draft' | 'live' | 'deprecated';
    insurer_code: string | null;
    applicable_schemes: string[];
    applicable_routes: string[];
    applicable_stages: string[];
    applicable_case_types: string[];
    applicable_treatments: string[];
    applicable_specialties: string[];
    rule_count: number;
    last_shadow_run_id: string | null;
    cloned_from: string | null;
    updated_at: string;
}

const STATUS_STYLES: Record<string, string> = {
    live: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
    draft: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
    deprecated: 'bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-400',
};

export default function RuleSetsManager() {
    const [sets, setSets] = useState<RuleSetSummary[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const [editing, setEditing] = useState<string | null>(null);
    const [cloning, setCloning] = useState<RuleSetSummary | null>(null);
    const [statusFilter, setStatusFilter] = useState<string>('');

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await ApiService.get(`/rule-sets${statusFilter ? `?status=${statusFilter}` : ''}`);
            setSets(res.data.data || []);
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not load rule sets');
        } finally {
            setLoading(false);
        }
    }, [statusFilter]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        if (!success) return;
        const t = setTimeout(() => setSuccess(null), 5000);
        return () => clearTimeout(t);
    }, [success]);

    if (editing) {
        return (
            <RuleSetEditor
                ruleSetId={editing}
                onBack={() => { setEditing(null); load(); }}
                onMessage={setSuccess}
            />
        );
    }

    const scopeChips = (s: RuleSetSummary) => {
        const chips: string[] = [];
        if (s.insurer_code) chips.push(s.insurer_code);
        for (const [label, arr] of [
            ['scheme', s.applicable_schemes], ['route', s.applicable_routes],
            ['stage', s.applicable_stages], ['case', s.applicable_case_types],
            ['treatment', s.applicable_treatments], ['specialty', s.applicable_specialties],
        ] as Array<[string, string[]]>) {
            if (arr?.length) chips.push(`${label}: ${arr.join('/')}`);
        }
        // An empty scope array is a WILDCARD, which is the least intuitive part
        // of the selection model — say so rather than showing nothing.
        return chips.length ? chips : ['applies to everything'];
    };

    return (
        <div className="space-y-4">
            {error && (
                <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}
            {success && (
                <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
                    {success}
                </div>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>Rule sets</CardTitle>
                    <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                        What each claim is judged against. A live pack is never edited directly —
                        clone it, change the draft, run it against past claims, then promote.
                        Promotion is blocked until a shadow run has been done since the last edit.
                    </p>
                </CardHeader>

                <CardContent>
                    <div className="mb-4 flex items-center gap-2">
                        {['', 'live', 'draft', 'deprecated'].map((s) => (
                            <Button
                                key={s || 'all'}
                                variant={statusFilter === s ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setStatusFilter(s)}
                            >
                                {s || 'All'}
                            </Button>
                        ))}
                    </div>

                    {loading ? (
                        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                            <Loader className="h-4 w-4 animate-spin" /> Loading rule sets…
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Rule set</TableHead>
                                    <TableHead className="w-28">Status</TableHead>
                                    <TableHead className="w-20 text-right">Rules</TableHead>
                                    <TableHead className="w-40 text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {sets.map((s) => (
                                    <TableRow key={s.rule_set_id}>
                                        <TableCell>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-medium">{s.rule_set_name}</span>
                                                <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                                    {s.rule_set_id}
                                                </code>
                                                <span className="text-xs text-muted-foreground">v{s.version}</span>
                                            </div>
                                            <div className="mt-1 flex flex-wrap gap-1">
                                                {scopeChips(s).map((c) => (
                                                    <Badge key={c} variant="outline" className="text-[10px] font-normal">
                                                        {c}
                                                    </Badge>
                                                ))}
                                            </div>
                                            {s.status === 'draft' && !s.last_shadow_run_id && (
                                                <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                                                    Not shadow-run since last edit — cannot be promoted yet.
                                                </p>
                                            )}
                                        </TableCell>

                                        <TableCell>
                                            <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[s.status]}`}>
                                                {s.status}
                                            </span>
                                        </TableCell>

                                        <TableCell className="text-right tabular-nums">{s.rule_count}</TableCell>

                                        <TableCell className="text-right">
                                            {s.status === 'live' ? (
                                                <Button variant="outline" size="sm" onClick={() => setCloning(s)}>
                                                    <Copy className="mr-1 h-3.5 w-3.5" /> Clone to edit
                                                </Button>
                                            ) : (
                                                <Button variant="outline" size="sm" onClick={() => setEditing(s.rule_set_id)}>
                                                    <Settings2 className="mr-1 h-3.5 w-3.5" /> Open
                                                </Button>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}

                    {!loading && sets.length === 0 && (
                        <p className="py-10 text-center text-sm text-muted-foreground">
                            No rule sets{statusFilter && ` with status "${statusFilter}"`}.
                        </p>
                    )}
                </CardContent>
            </Card>

            {cloning && (
                <CloneRuleSetModal
                    source={cloning}
                    onClose={() => setCloning(null)}
                    onCloned={(newId, msg) => { setCloning(null); setSuccess(msg); setEditing(newId); }}
                />
            )}
        </div>
    );
}
