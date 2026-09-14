import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { AlertCircle, Loader, TrendingDown } from 'lucide-react';
import ApiService from '@/services/api';

/**
 * Calibration — what reviewers think of each rule.
 *
 * The point of this screen: an over-strict rule never announces itself. It
 * quietly produces findings people learn to dismiss, and within a few weeks
 * the whole panel is being scrolled past — including the findings that were
 * right. The product fails silently and nobody files a bug.
 *
 * So disagreement is surfaced as a first-class number, and the per-layer root
 * cause from the feedback table is shown alongside it, because that is what
 * separates "fix the extraction" from "fix the rule" from "fix the context".
 * A bare thumbs-down cannot tell you which, so it cannot tell you what to do.
 */

interface CalibrationRow {
    rule_id: string;
    rule_name: string | null;
    severity: string | null;
    rule_set_id: string | null;
    evaluated: number;
    fired: number;
    fire_rate: number;
    feedback_count: number;
    agreed: number;
    disagreed: number;
    agreement_rate: number | null;
    root_causes: Record<string, number>;
    verdict: 'healthy' | 'over_strict' | 'never_fires' | 'unreviewed' | 'watch';
}

const VERDICT: Record<CalibrationRow['verdict'], { label: string; className: string; help: string }> = {
    over_strict: {
        label: 'Over-strict',
        className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
        help: 'Reviewers overrule this more often than they accept it. Re-tune or retire.',
    },
    watch: {
        label: 'Watch',
        className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
        help: 'Fires on almost every claim, which usually means miscalibrated rather than strict.',
    },
    never_fires: {
        label: 'Never fires',
        className: 'bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-400',
        help: 'Evaluated but never failed. Either everything genuinely passes, or the rule cannot match.',
    },
    unreviewed: {
        label: 'Unreviewed',
        className: 'bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-400',
        help: 'No reviewer feedback yet — no evidence either way.',
    },
    healthy: {
        label: 'Healthy',
        className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
        help: 'Firing at a sane rate and reviewers largely agree.',
    },
};

const ROOT_CAUSE_ACTION: Record<string, string> = {
    content: 'the extraction was wrong — fix the model, not the rule',
    rules: 'the rule itself is wrong — re-tune or retire it',
    context: 'the claim context was wrong — check the resolver',
    documents: 'the wrong documents were considered — check stage tagging',
    none: 'no fault found',
};

export default function CalibrationManager() {
    const [rows, setRows] = useState<CalibrationRow[]>([]);
    const [rootCauses, setRootCauses] = useState<Array<{ root_cause: string; layer: string; n: number }>>([]);
    const [days, setDays] = useState(90);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [calRes, rcRes] = await Promise.all([
                ApiService.get(`/rule-calibration?days=${days}`),
                ApiService.get(`/rule-calibration/root-causes?days=${days}`),
            ]);
            setRows(calRes.data.data || []);
            setRootCauses(rcRes.data.data || []);
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not load calibration data');
        } finally {
            setLoading(false);
        }
    }, [days]);

    useEffect(() => { load(); }, [load]);

    const problems = rows.filter((r) => r.verdict === 'over_strict' || r.verdict === 'watch');
    const totalFeedback = rows.reduce((a, r) => a + r.feedback_count, 0);

    return (
        <div className="space-y-4">
            {error && (
                <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
                </div>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>Rule calibration</CardTitle>
                    <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                        How often each rule fires, and how often reviewers overrule it. An
                        over-strict rule does not announce itself — it produces findings people
                        learn to scroll past, and takes the good findings down with it.
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                        {[30, 90, 180, 365].map((d) => (
                            <Button key={d} size="sm" variant={days === d ? 'default' : 'outline'}
                                onClick={() => setDays(d)}>
                                {d}d
                            </Button>
                        ))}
                    </div>
                </CardHeader>

                <CardContent>
                    {loading ? (
                        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                            <Loader className="h-4 w-4 animate-spin" /> Loading calibration…
                        </div>
                    ) : rows.length === 0 ? (
                        <p className="py-10 text-center text-sm text-muted-foreground">
                            No rule evaluations in this window. Calibration needs claims to have been
                            adjudicated first.
                        </p>
                    ) : (
                        <>
                            {totalFeedback === 0 && (
                                <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                                    No reviewer feedback yet, so every rule reads as unreviewed. Fire
                                    rates below are still meaningful; agreement rates are not.
                                </p>
                            )}

                            {problems.length > 0 && (
                                <div className="mb-4 rounded-md border p-3">
                                    <p className="flex items-center gap-1.5 text-sm font-medium">
                                        <TrendingDown className="h-4 w-4" />
                                        {problems.length} rule{problems.length > 1 ? 's need' : ' needs'} attention
                                    </p>
                                    <ul className="mt-1 text-xs text-muted-foreground">
                                        {problems.slice(0, 5).map((p) => (
                                            <li key={p.rule_id}>
                                                <code>{p.rule_id}</code> — {VERDICT[p.verdict].help}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Rule</TableHead>
                                        <TableHead className="w-28 text-right">Fires</TableHead>
                                        <TableHead className="w-32 text-right">Reviewers agree</TableHead>
                                        <TableHead className="w-32">Status</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {rows.map((r) => (
                                        <TableRow key={`${r.rule_set_id}-${r.rule_id}`}>
                                            <TableCell>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="text-sm font-medium">
                                                        {r.rule_name || r.rule_id}
                                                    </span>
                                                    <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                                        {r.rule_id}
                                                    </code>
                                                    {r.severity && (
                                                        <Badge variant="outline" className="text-[10px]">{r.severity}</Badge>
                                                    )}
                                                </div>
                                                {r.rule_set_id && (
                                                    <p className="mt-0.5 text-[11px] text-muted-foreground">{r.rule_set_id}</p>
                                                )}
                                                {Object.keys(r.root_causes).length > 0 && (
                                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                                        blamed on:{' '}
                                                        {Object.entries(r.root_causes).map(([cause, n]) => (
                                                            <span key={cause} className="mr-2" title={ROOT_CAUSE_ACTION[cause]}>
                                                                {cause} ×{n}
                                                            </span>
                                                        ))}
                                                    </p>
                                                )}
                                            </TableCell>

                                            <TableCell className="text-right">
                                                <span className="text-sm tabular-nums">
                                                    {Math.round(r.fire_rate * 100)}%
                                                </span>
                                                <p className="text-[11px] text-muted-foreground">
                                                    {r.fired}/{r.evaluated}
                                                </p>
                                            </TableCell>

                                            <TableCell className="text-right">
                                                {r.agreement_rate === null ? (
                                                    // Deliberately not 0% — nobody has judged it, which
                                                    // is a different fact from everybody rejecting it.
                                                    <span className="text-xs text-muted-foreground">no feedback</span>
                                                ) : (
                                                    <>
                                                        <span className="text-sm tabular-nums">
                                                            {Math.round(r.agreement_rate * 100)}%
                                                        </span>
                                                        <p className="text-[11px] text-muted-foreground">
                                                            {r.agreed}/{r.feedback_count}
                                                        </p>
                                                    </>
                                                )}
                                            </TableCell>

                                            <TableCell>
                                                <span
                                                    className={`rounded px-2 py-0.5 text-[11px] font-medium ${VERDICT[r.verdict].className}`}
                                                    title={VERDICT[r.verdict].help}
                                                >
                                                    {VERDICT[r.verdict].label}
                                                </span>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </>
                    )}
                </CardContent>
            </Card>

            {rootCauses.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Where the errors actually come from</CardTitle>
                        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                            Across every disagreement, what reviewers said was at fault. This is the
                            number that decides where effort goes: if most of it roots in extraction,
                            no amount of rule tuning helps.
                        </p>
                    </CardHeader>
                    <CardContent>
                        <ul className="space-y-1">
                            {rootCauses.map((rc) => (
                                <li key={`${rc.layer}-${rc.root_cause}`} className="flex items-center gap-3 text-sm">
                                    <span className="w-28 font-medium">{rc.root_cause}</span>
                                    <Badge variant="outline" className="text-[10px]">{rc.layer}</Badge>
                                    <span className="tabular-nums">{rc.n}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {ROOT_CAUSE_ACTION[rc.root_cause] ?? ''}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
