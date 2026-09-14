import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { AlertCircle, AlertTriangle, Loader, Pencil, Plus, Search } from 'lucide-react';
import ApiService from '@/services/api';
import PanelConfigModal from './PanelConfigModal';

/**
 * Adjudication config — per-panel deadlines, and the non-payables catalog.
 *
 * Both tabs exist because the domain refuses to be a constant. Four TPAs
 * publish four different claim-file windows and two contradict themselves, so
 * every deadline is per-panel. And billing systems never write the circular's
 * wording, so non-payable matching is an alias problem learned from real bills.
 *
 * Combined into one screen with two tabs rather than two sidebar entries: they
 * are both reference data a superadmin visits occasionally, and nav length has
 * its own cost.
 */

interface PanelRow {
    panel_id: string;
    panel_name: string;
    panel_type: string | null;
    preauth_decision_hours: number | null;
    enhancement_decision_hours: number | null;
    final_auth_decision_hours: number | null;
    claim_file_days: number | null;
    query_reply_days: number | null;
    enhancement_silence_is_denial: boolean;
    terminology_aliases: Record<string, string>;
    proportionate_exempt_heads: string[];
    non_payable_lists: string[];
    source_note: string | null;
    configured: boolean;
}

interface NonPayable {
    id: string;
    item_name: string;
    list_number: string;
    aliases: string[];
    notes: string | null;
}

interface Coverage {
    seeded: number;
    irdai_total: number;
    complete: boolean;
}

const LIST_HELP: Record<string, string> = {
    I: 'Optional cover — non-payable unless the policy bought it',
    II: 'Subsumed into room charges — must not be billed at all on a network cashless claim',
    III: 'Subsumed into procedure charges — must not be billed at all on a network cashless claim',
    IV: 'Subsumed into treatment cost — must not be billed at all on a network cashless claim',
    PANEL: 'Added for a specific panel',
};

export default function AdjudicationConfigManager() {
    const [tab, setTab] = useState<'panels' | 'nonPayables'>('panels');
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    useEffect(() => {
        if (!success) return;
        const t = setTimeout(() => setSuccess(null), 4000);
        return () => clearTimeout(t);
    }, [success]);

    return (
        <div className="space-y-4">
            {error && (
                <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
                </div>
            )}
            {success && (
                <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
                    {success}
                </div>
            )}

            <div className="flex gap-1 border-b">
                {([['panels', 'Panel deadlines'], ['nonPayables', 'Non-payables']] as Array<[typeof tab, string]>).map(
                    ([key, label]) => (
                        <button
                            key={key}
                            onClick={() => setTab(key)}
                            className={`px-3 py-2 text-sm transition ${
                                tab === key ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            {label}
                        </button>
                    ),
                )}
            </div>

            {tab === 'panels'
                ? <PanelsTab onError={setError} onSuccess={setSuccess} />
                : <NonPayablesTab onError={setError} onSuccess={setSuccess} />}
        </div>
    );
}

function PanelsTab({ onError, onSuccess }: { onError: (m: string | null) => void; onSuccess: (m: string) => void }) {
    const [panels, setPanels] = useState<PanelRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<PanelRow | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await ApiService.get('/adjudication-config/panels');
            setPanels(res.data.data || []);
            onError(null);
        } catch (err: any) {
            onError(err?.response?.data?.error || 'Could not load panel configuration');
        } finally { setLoading(false); }
    }, [onError]);

    useEffect(() => { load(); }, [load]);

    const unconfigured = panels.filter((p) => !p.configured).length;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Panel deadlines</CardTitle>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                    Every deadline is per-panel. Four TPAs publish four different claim-file
                    windows — 2, 7, 15 and 30 days — and two of them contradict themselves inside
                    their own documents. These come from your empanelment agreements, not from
                    anything public.
                </p>
                {unconfigured > 0 && (
                    <p className="mt-2 flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-4 w-4" />
                        {unconfigured} panel{unconfigured > 1 ? 's have' : ' has'} no deadlines set —
                        timeliness rules are skipped for {unconfigured > 1 ? 'them' : 'it'}, not passed.
                    </p>
                )}
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                        <Loader className="h-4 w-4 animate-spin" /> Loading panels…
                    </div>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Panel</TableHead>
                                <TableHead className="w-28 text-right">Pre-auth</TableHead>
                                <TableHead className="w-28 text-right">Enhancement</TableHead>
                                <TableHead className="w-28 text-right">Claim file</TableHead>
                                <TableHead className="w-16 text-right"> </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {panels.map((p) => (
                                <TableRow key={p.panel_id} className={p.configured ? undefined : 'opacity-70'}>
                                    <TableCell>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-medium">{p.panel_name}</span>
                                            {!p.configured && <Badge variant="secondary">not configured</Badge>}
                                            {p.enhancement_silence_is_denial && (
                                                <Badge variant="outline" className="text-[10px]">
                                                    silence = denial
                                                </Badge>
                                            )}
                                        </div>
                                        {Object.keys(p.terminology_aliases || {}).length > 0 && (
                                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                                                aliases: {Object.entries(p.terminology_aliases)
                                                    .map(([k, v]) => `${k} → ${v}`).join(', ')}
                                            </p>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-right text-xs tabular-nums">
                                        {p.preauth_decision_hours != null ? `${p.preauth_decision_hours}h` : '—'}
                                    </TableCell>
                                    <TableCell className="text-right text-xs tabular-nums">
                                        {p.enhancement_decision_hours != null ? `${p.enhancement_decision_hours}h` : '—'}
                                    </TableCell>
                                    <TableCell className="text-right text-xs tabular-nums">
                                        {p.claim_file_days != null ? `${p.claim_file_days}d` : '—'}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <Button variant="ghost" size="icon" className="h-7 w-7"
                                            onClick={() => setEditing(p)} aria-label={`Configure ${p.panel_name}`}>
                                            <Pencil className="h-3.5 w-3.5" />
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>

            {editing && (
                <PanelConfigModal
                    panel={editing}
                    onClose={() => setEditing(null)}
                    onSaved={(msg) => { setEditing(null); onSuccess(msg); load(); }}
                />
            )}
        </Card>
    );
}

function NonPayablesTab({ onError, onSuccess }: { onError: (m: string | null) => void; onSuccess: (m: string) => void }) {
    const [items, setItems] = useState<NonPayable[]>([]);
    const [coverage, setCoverage] = useState<Coverage | null>(null);
    const [unmatched, setUnmatched] = useState<Array<{ particulars: string; occurrences: number }>>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [listRes, unRes] = await Promise.all([
                ApiService.get(`/adjudication-config/non-payables${search ? `?search=${encodeURIComponent(search)}` : ''}`),
                ApiService.get('/adjudication-config/non-payables/unmatched?limit=25'),
            ]);
            setItems(listRes.data.items || []);
            setCoverage(listRes.data.coverage || null);
            setUnmatched(unRes.data.data || []);
            onError(null);
        } catch (err: any) {
            onError(err?.response?.data?.error || 'Could not load the non-payables catalog');
        } finally { setLoading(false); }
    }, [search, onError]);

    useEffect(() => { load(); }, [load]);

    const addAlias = async (item: NonPayable, alias: string) => {
        try {
            await ApiService.put('/adjudication-config/non-payables', {
                ...item, aliases: [...item.aliases, alias],
            });
            onSuccess(`"${alias}" now matches ${item.item_name}`);
            load();
        } catch (err: any) {
            onError(err?.response?.data?.error || 'Could not add the alias');
        }
    };

    return (
        <div className="space-y-4">
            {coverage && !coverage.complete && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        <strong>Partial catalog: {coverage.seeded} of {coverage.irdai_total} IRDAI items.</strong>{' '}
                        The remainder need importing from circular IRDAI/HLT/REG/CIR/176/09/2019.
                        Until then, a bill line matching nothing here is <em>not</em> evidence it is payable.
                    </span>
                </div>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>Non-payable items</CardTitle>
                    <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                        Items an insurer will not pay. For a network cashless claim, Lists II, III
                        and IV must not be billed to the patient at all — so a match is a breach of
                        your own empanelment agreement, not just a deduction.
                    </p>
                </CardHeader>
                <CardContent>
                    <div className="relative mb-4 max-w-md">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search items and aliases…"
                            className="pl-8"
                        />
                    </div>

                    {loading ? (
                        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                            <Loader className="h-4 w-4 animate-spin" /> Loading catalog…
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Item</TableHead>
                                    <TableHead className="w-24">List</TableHead>
                                    <TableHead>Also billed as</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {items.map((i) => (
                                    <TableRow key={i.id}>
                                        <TableCell>
                                            <span className="text-sm font-medium">{i.item_name}</span>
                                            {i.notes && (
                                                <p className="mt-0.5 text-[11px] text-muted-foreground">{i.notes}</p>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline" title={LIST_HELP[i.list_number]}>
                                                {i.list_number}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex flex-wrap gap-1">
                                                {i.aliases.map((a) => (
                                                    <span key={a} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{a}</span>
                                                ))}
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            {unmatched.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Bill lines matching nothing</CardTitle>
                        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                            Descriptions from your real bills that the catalog does not recognise,
                            most frequent first. Some are legitimately payable; the rest are aliases
                            waiting to be attached. This is how the catalog learns what your
                            hospitals actually write.
                        </p>
                    </CardHeader>
                    <CardContent>
                        <ul className="space-y-1">
                            {unmatched.map((u) => (
                                <li key={u.particulars} className="flex items-center gap-3 text-xs">
                                    <span className="w-16 text-right tabular-nums text-muted-foreground">
                                        ×{u.occurrences}
                                    </span>
                                    <span className="flex-1 truncate">{u.particulars}</span>
                                    <select
                                        defaultValue=""
                                        onChange={(e) => {
                                            const item = items.find((i) => i.id === e.target.value);
                                            if (item) addAlias(item, u.particulars);
                                            e.target.value = '';
                                        }}
                                        className="h-7 rounded border bg-background px-2 text-[11px]"
                                    >
                                        <option value="">Attach to…</option>
                                        {items.map((i) => (
                                            <option key={i.id} value={i.id}>{i.item_name}</option>
                                        ))}
                                    </select>
                                </li>
                            ))}
                        </ul>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
