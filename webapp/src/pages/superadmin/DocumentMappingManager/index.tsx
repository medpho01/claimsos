import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { AlertCircle, Infinity as InfinityIcon, Loader, Pencil, Search } from 'lucide-react';
import ApiService from '@/services/api';
import EditMappingModal from './EditMappingModal';

/**
 * Document Mapping — which stage each document category belongs to.
 *
 * Three facts per category, and they are genuinely different axes:
 *
 *   Evergreen    this document is EVIDENCE at every stage (identity, policy).
 *                Filed once, it satisfies every stage's requirement — which is
 *                what stops an Aadhaar filed at pre-auth being reported missing
 *                at final claim while sitting in the bundle.
 *
 *   Stage floor  the earliest stage the artefact can PHYSICALLY exist at. The
 *                only field permitted to reject a human's upload choice, and
 *                only ever to reject the impossible.
 *
 *   Affinity     the stage it is USUALLY evidence for. A hint for inbound
 *                documents nobody tagged. Never overrides a human.
 *
 * Most of the 246 categories correctly have NO mapping: no floor, not
 * evergreen, the uploader's choice stands unconditionally. Filling in rows we
 * cannot justify would be worse than leaving them blank, because a wrong floor
 * rejects a correct choice.
 */

export interface MappingRow {
    doc_category: string;
    label: string;
    group_code: string | null;
    is_evergreen: boolean;
    stage_floor: string | null;
    affinity_stage: string | null;
    required_when: string | null;
    notes: string | null;
    has_mapping: boolean;
}

interface Group { group_code: string; label: string; count: number }
interface Stage { code: string; label: string }

export default function DocumentMappingManager() {
    const [rows, setRows] = useState<MappingRow[]>([]);
    const [groups, setGroups] = useState<Group[]>([]);
    const [stages, setStages] = useState<Stage[]>([]);
    const [group, setGroup] = useState<string>('');
    const [search, setSearch] = useState('');
    const [onlyMapped, setOnlyMapped] = useState(false);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [editing, setEditing] = useState<MappingRow | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [mapRes, grpRes, stgRes] = await Promise.all([
                ApiService.get(`/document-stage-affinity${group ? `?group=${group}` : ''}`),
                ApiService.get('/document-stage-affinity/groups'),
                ApiService.get('/claim-stages'),
            ]);
            setRows(mapRes.data.data || []);
            setGroups(grpRes.data.data || []);
            setStages(stgRes.data.data || []);
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not load document mappings');
        } finally {
            setLoading(false);
        }
    }, [group]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (!success) return;
        const t = setTimeout(() => setSuccess(null), 4000);
        return () => clearTimeout(t);
    }, [success]);

    const stageLabel = useCallback(
        (code: string | null) => (code ? stages.find((s) => s.code === code)?.label ?? code : null),
        [stages],
    );

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return rows.filter((r) => {
            if (onlyMapped && !r.has_mapping) return false;
            if (!q) return true;
            return r.doc_category.includes(q) || r.label.toLowerCase().includes(q);
        });
    }, [rows, search, onlyMapped]);

    const mappedCount = rows.filter((r) => r.has_mapping).length;
    const evergreenCount = rows.filter((r) => r.is_evergreen).length;
    const flooredCount = rows.filter((r) => r.stage_floor).length;

    const bulkEvergreen = async (isEvergreen: boolean) => {
        if (!group) return;
        setError(null);
        try {
            const res = await ApiService.post('/document-stage-affinity/bulk-evergreen', {
                group, is_evergreen: isEvergreen,
            });
            setSuccess(res.data.message);
            load();
        } catch (err: any) {
            // The server refuses rather than silently clearing a stage floor,
            // and names the conflicting categories — surface that verbatim.
            setError(err?.response?.data?.error || 'Bulk update failed');
        }
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
                    <CardTitle>Document mapping</CardTitle>
                    <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                        Which stage each document belongs to. Most categories need no mapping —
                        a blank row means the uploader's choice stands unconditionally, which is
                        the safe default. Only fill in what you can justify: a wrong stage floor
                        rejects a correct choice.
                    </p>
                </CardHeader>

                <CardContent>
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                        <div className="relative min-w-[220px] flex-1">
                            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search 246 categories…"
                                className="pl-8"
                            />
                        </div>

                        <select
                            value={group}
                            onChange={(e) => setGroup(e.target.value)}
                            className="h-9 rounded-md border bg-background px-3 text-sm"
                        >
                            <option value="">All groups</option>
                            {groups.map((g) => (
                                <option key={g.group_code} value={g.group_code}>
                                    {g.label} ({g.count})
                                </option>
                            ))}
                        </select>

                        <Button
                            variant={onlyMapped ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setOnlyMapped((v) => !v)}
                        >
                            Mapped only
                        </Button>

                        {group && (
                            <div className="flex items-center gap-1">
                                <Button variant="outline" size="sm" onClick={() => bulkEvergreen(true)}>
                                    Mark group evergreen
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => bulkEvergreen(false)}>
                                    Clear
                                </Button>
                            </div>
                        )}
                    </div>

                    <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                        <span>{filtered.length} shown</span>
                        <span>{mappedCount} mapped</span>
                        <span>{evergreenCount} evergreen</span>
                        <span>{flooredCount} floored</span>
                    </div>

                    {loading ? (
                        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                            <Loader className="h-4 w-4 animate-spin" /> Loading mappings…
                        </div>
                    ) : (
                        <div className="max-h-[60vh] overflow-y-auto">
                            <Table>
                                <TableHeader className="sticky top-0 bg-background">
                                    <TableRow>
                                        <TableHead>Category</TableHead>
                                        <TableHead className="w-28">Evergreen</TableHead>
                                        <TableHead className="w-40">Stage floor</TableHead>
                                        <TableHead className="hidden w-40 lg:table-cell">Usual stage</TableHead>
                                        <TableHead className="w-16 text-right"> </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filtered.map((r) => (
                                        <TableRow key={r.doc_category} className={r.has_mapping ? undefined : 'opacity-70'}>
                                            <TableCell>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="font-medium">{r.label}</span>
                                                    <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                                        {r.doc_category}
                                                    </code>
                                                </div>
                                                {r.required_when && (
                                                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                                                        only when: {r.required_when}
                                                    </p>
                                                )}
                                            </TableCell>

                                            <TableCell>
                                                {r.is_evergreen ? (
                                                    <Badge variant="outline" className="gap-1">
                                                        <InfinityIcon className="h-3 w-3" /> Every stage
                                                    </Badge>
                                                ) : (
                                                    <span className="text-xs text-muted-foreground">—</span>
                                                )}
                                            </TableCell>

                                            <TableCell>
                                                {r.stage_floor ? (
                                                    <span className="text-xs">
                                                        not before <strong>{stageLabel(r.stage_floor)}</strong>
                                                    </span>
                                                ) : (
                                                    <span className="text-xs text-muted-foreground">—</span>
                                                )}
                                            </TableCell>

                                            <TableCell className="hidden lg:table-cell">
                                                <span className="text-xs text-muted-foreground">
                                                    {stageLabel(r.affinity_stage) ?? '—'}
                                                </span>
                                            </TableCell>

                                            <TableCell className="text-right">
                                                <Button
                                                    variant="ghost" size="icon" className="h-7 w-7"
                                                    onClick={() => setEditing(r)}
                                                    aria-label={`Edit mapping for ${r.label}`}
                                                >
                                                    <Pencil className="h-3.5 w-3.5" />
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>

                            {filtered.length === 0 && (
                                <p className="py-10 text-center text-sm text-muted-foreground">
                                    No categories match.
                                </p>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            {editing && (
                <EditMappingModal
                    row={editing}
                    stages={stages}
                    onClose={() => setEditing(null)}
                    onSaved={(msg) => { setEditing(null); setSuccess(msg); load(); }}
                />
            )}
        </div>
    );
}
