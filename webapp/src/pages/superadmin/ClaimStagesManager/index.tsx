import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
    AlertCircle, ArrowDown, ArrowUp, Loader, Pencil, Plus, RotateCcw, EyeOff,
} from 'lucide-react';
import ApiService from '@/services/api';
import EditStageModal from './EditStageModal';
import RetireStageModal from './RetireStageModal';

/**
 * Claim Stages — superadmin configurator for the claim lifecycle.
 *
 * The taxonomy this screen owns is referenced by the upload dropdown, by
 * `insurer_rule_sets.applicable_stages`, and by
 * `insurer_document_requirements.stage`. None of those are real foreign keys,
 * so the UI carries the guard rails the database does not:
 *
 *   - `code` is shown but never editable. Renaming one would silently detach
 *     rule packs from claims with nothing reporting the break.
 *   - Stages are RETIRED, never deleted, and retirement shows the blast radius
 *     first rather than asking for blind confirmation.
 *   - Legacy codes are surfaced, because until the cutover migration runs live
 *     claims still carry the old migration-024 spellings and an admin needs to
 *     see which stage absorbs which.
 */

export interface ClaimStage {
    code: string;
    label: string;
    definition: string;
    entry_trigger: string | null;
    exit_trigger: string | null;
    expected_tat: string | null;
    sort_order: number;
    cycle_types: string[];
    legacy_codes: string[];
    is_active: boolean;
}

export default function ClaimStagesManager() {
    const [stages, setStages] = useState<ClaimStage[]>([]);
    const [loading, setLoading] = useState(false);
    const [savingOrder, setSavingOrder] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const [editing, setEditing] = useState<ClaimStage | null>(null);
    const [creating, setCreating] = useState(false);
    const [retiring, setRetiring] = useState<ClaimStage | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await ApiService.get('/claim-stages?include_retired=true');
            setStages(res.data.data || []);
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not load claim stages');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    // Auto-clear the success banner; errors stay until the next action so a
    // failed save cannot scroll away unnoticed.
    useEffect(() => {
        if (!success) return;
        const t = setTimeout(() => setSuccess(null), 4000);
        return () => clearTimeout(t);
    }, [success]);

    /**
     * Move a stage one position. The server requires the COMPLETE ordered list
     * (a partial list would strand the omitted stages), so we always send every
     * code, active and retired alike.
     */
    const move = async (index: number, direction: -1 | 1) => {
        const target = index + direction;
        if (target < 0 || target >= stages.length) return;

        const next = [...stages];
        [next[index], next[target]] = [next[target], next[index]];
        setStages(next); // optimistic — reverted below if the server disagrees

        setSavingOrder(true);
        setError(null);
        try {
            const res = await ApiService.put('/claim-stages/order', {
                codes: next.map((s) => s.code),
            });
            setStages(res.data.data || next);
            setSuccess('Lifecycle order updated');
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not reorder stages');
            load(); // resync rather than leave the optimistic order showing
        } finally {
            setSavingOrder(false);
        }
    };

    const activeCount = stages.filter((s) => s.is_active).length;

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
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div>
                        <CardTitle>Claim lifecycle</CardTitle>
                        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                            The stages a claim moves through. Each one owns a document checklist —
                            if the hospital files nothing during a step, it belongs in insurer
                            outcomes, not here. Order drives the upload dropdown.
                        </p>
                    </div>
                    <Button onClick={() => setCreating(true)} className="shrink-0">
                        <Plus className="mr-1 h-4 w-4" /> New stage
                    </Button>
                </CardHeader>

                <CardContent>
                    {loading ? (
                        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                            <Loader className="h-4 w-4 animate-spin" /> Loading stages…
                        </div>
                    ) : (
                        <>
                            <div className="mb-3 text-xs text-muted-foreground">
                                {activeCount} active
                                {stages.length !== activeCount && `, ${stages.length - activeCount} retired`}
                                {savingOrder && ' · saving order…'}
                            </div>

                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="w-20">Order</TableHead>
                                        <TableHead>Stage</TableHead>
                                        <TableHead className="hidden lg:table-cell">Cycles</TableHead>
                                        <TableHead className="hidden xl:table-cell">Expected TAT</TableHead>
                                        <TableHead className="w-28 text-right">Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {stages.map((s, i) => (
                                        <TableRow
                                            key={s.code}
                                            className={s.is_active ? undefined : 'opacity-55'}
                                        >
                                            <TableCell>
                                                <div className="flex items-center gap-0.5">
                                                    <Button
                                                        variant="ghost" size="icon"
                                                        className="h-6 w-6"
                                                        disabled={i === 0 || savingOrder}
                                                        onClick={() => move(i, -1)}
                                                        aria-label={`Move ${s.label} earlier`}
                                                    >
                                                        <ArrowUp className="h-3.5 w-3.5" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost" size="icon"
                                                        className="h-6 w-6"
                                                        disabled={i === stages.length - 1 || savingOrder}
                                                        onClick={() => move(i, 1)}
                                                        aria-label={`Move ${s.label} later`}
                                                    >
                                                        <ArrowDown className="h-3.5 w-3.5" />
                                                    </Button>
                                                </div>
                                            </TableCell>

                                            <TableCell>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="font-medium">{s.label}</span>
                                                    <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                                        {s.code}
                                                    </code>
                                                    {!s.is_active && <Badge variant="secondary">Retired</Badge>}
                                                </div>
                                                <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                                                    {s.definition}
                                                </p>
                                                {s.legacy_codes.length > 0 && (
                                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                                        absorbs:{' '}
                                                        {s.legacy_codes.map((c) => (
                                                            <code key={c} className="mr-1 rounded bg-muted px-1 py-0.5">{c}</code>
                                                        ))}
                                                    </p>
                                                )}
                                            </TableCell>

                                            <TableCell className="hidden lg:table-cell">
                                                <div className="flex flex-wrap gap-1">
                                                    {s.cycle_types.map((c) => (
                                                        <Badge key={c} variant="outline" className="text-[10px]">
                                                            {c === 'query_response' ? 'query reply' : c}
                                                        </Badge>
                                                    ))}
                                                </div>
                                            </TableCell>

                                            <TableCell className="hidden max-w-xs xl:table-cell">
                                                <span className="text-xs text-muted-foreground">
                                                    {s.expected_tat || '—'}
                                                </span>
                                            </TableCell>

                                            <TableCell className="text-right">
                                                <Button
                                                    variant="ghost" size="icon" className="h-7 w-7"
                                                    onClick={() => setEditing(s)}
                                                    aria-label={`Edit ${s.label}`}
                                                >
                                                    <Pencil className="h-3.5 w-3.5" />
                                                </Button>
                                                <Button
                                                    variant="ghost" size="icon" className="h-7 w-7"
                                                    onClick={() => setRetiring(s)}
                                                    aria-label={s.is_active ? `Retire ${s.label}` : `Reinstate ${s.label}`}
                                                >
                                                    {s.is_active
                                                        ? <EyeOff className="h-3.5 w-3.5" />
                                                        : <RotateCcw className="h-3.5 w-3.5" />}
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>

                            {stages.length === 0 && (
                                <p className="py-10 text-center text-sm text-muted-foreground">
                                    No stages configured. Run <code>npm run seed</code> to load the baseline lifecycle.
                                </p>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>

            {(editing || creating) && (
                <EditStageModal
                    stage={editing}
                    nextSortOrder={(stages[stages.length - 1]?.sort_order ?? 0) + 10}
                    onClose={() => { setEditing(null); setCreating(false); }}
                    onSaved={(msg) => {
                        setEditing(null); setCreating(false);
                        setSuccess(msg); load();
                    }}
                />
            )}

            {retiring && (
                <RetireStageModal
                    stage={retiring}
                    onClose={() => setRetiring(null)}
                    onDone={(msg) => { setRetiring(null); setSuccess(msg); load(); }}
                />
            )}
        </div>
    );
}
