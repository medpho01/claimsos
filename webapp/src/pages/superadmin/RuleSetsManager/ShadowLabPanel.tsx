import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, FlaskConical, Loader } from 'lucide-react';
import ApiService from '@/services/api';

/**
 * Shadow Lab — run a draft against past claims before promoting it.
 *
 * This panel is the safety gate. A rule authored in a form is a guess until it
 * has met real data, and the cost of a wrong guess is a claim held while the
 * 3-hour discharge authorisation clock runs.
 *
 * It reports, it never decides. "Passed" means the run completed, not that the
 * numbers are acceptable — a threshold here would just get tuned until it went
 * green. The judgement stays with the person reading it.
 */

interface ShadowResults {
    run_id?: string;
    claims_evaluated: number;
    semantic_rules_skipped: number;
    readiness_distribution: Record<string, number>;
    rule_fire_rates: Array<{ rule_id: string; fired: number; rate: number; severity: string }>;
    delta_vs_live: {
        live_rule_set_id: string | null;
        mean_readiness_draft: number | null;
        mean_readiness_live: number | null;
        newly_blocking: string[];
        no_longer_blocking: string[];
    };
    sample: Array<{ claim_id: string; readiness: number; blocking: string[] }>;
}

export default function ShadowLabPanel({
    ruleSetId, onRunComplete,
}: {
    ruleSetId: string;
    onRunComplete: () => void;
}) {
    const [limit, setLimit] = useState('100');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<ShadowResults | null>(null);
    const [history, setHistory] = useState<any[]>([]);

    const loadHistory = useCallback(async () => {
        try {
            const res = await ApiService.get(`/rule-sets/${ruleSetId}/shadow-runs`);
            setHistory(res.data.data || []);
        } catch { /* history is informational; a failure here must not block a run */ }
    }, [ruleSetId]);

    useEffect(() => { loadHistory(); }, [loadHistory]);

    const run = async () => {
        setRunning(true);
        setError(null);
        try {
            const res = await ApiService.post(`/rule-sets/${ruleSetId}/shadow-run`, {
                limit: Number(limit) || 100,
                from: from || null,
                to: to || null,
            });
            setResults(res.data.data);
            onRunComplete();
            loadHistory();
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Shadow run failed');
        } finally {
            setRunning(false);
        }
    };

    const delta = results?.delta_vs_live;
    const meanDraft = delta?.mean_readiness_draft;
    const meanLive = delta?.mean_readiness_live;

    return (
        <div className="space-y-5">
            <div className="rounded-md border bg-muted/40 p-4">
                <p className="text-sm">
                    Run this draft against past claims. Nothing is written to those claims — it
                    reports what <em>would</em> have happened. Deterministic checks are free to
                    replay, so run it as often as you like.
                </p>

                <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div>
                        <label className="text-xs font-medium">Claims</label>
                        <Input value={limit} onChange={(e) => setLimit(e.target.value)} className="mt-1 w-24" />
                    </div>
                    <div>
                        <label className="text-xs font-medium">From</label>
                        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1" />
                    </div>
                    <div>
                        <label className="text-xs font-medium">To</label>
                        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1" />
                    </div>
                    <Button onClick={run} disabled={running}>
                        {running
                            ? <Loader className="mr-1 h-4 w-4 animate-spin" />
                            : <FlaskConical className="mr-1 h-4 w-4" />}
                        Run shadow
                    </Button>
                </div>
            </div>

            {error && (
                <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {results && (
                <div className="space-y-4">
                    <div className="flex flex-wrap gap-4 text-sm">
                        <span><strong>{results.claims_evaluated}</strong> claims evaluated</span>
                        {results.semantic_rules_skipped > 0 && (
                            <span className="text-amber-700 dark:text-amber-400">
                                {results.semantic_rules_skipped} rule(s) not evaluated (model-backed or legacy)
                            </span>
                        )}
                    </div>

                    {/* The promotion decision. Everything else is supporting detail. */}
                    <div className="rounded-md border p-4">
                        <h4 className="text-sm font-semibold">What changes if you promote this</h4>
                        {delta?.live_rule_set_id ? (
                            <>
                                <p className="mt-2 text-sm">
                                    Mean readiness{' '}
                                    <strong>{meanLive ?? '—'}</strong> (live) →{' '}
                                    <strong>{meanDraft ?? '—'}</strong> (draft)
                                    {meanDraft != null && meanLive != null && (
                                        <span className="ml-1 text-muted-foreground">
                                            ({meanDraft - meanLive >= 0 ? '+' : ''}{meanDraft - meanLive})
                                        </span>
                                    )}
                                </p>
                                {delta.newly_blocking.length > 0 && (
                                    <p className="mt-2 text-sm">
                                        <span className="text-red-700 dark:text-red-400">Newly blocking:</span>{' '}
                                        {delta.newly_blocking.join(', ')}
                                    </p>
                                )}
                                {delta.no_longer_blocking.length > 0 && (
                                    <p className="mt-1 text-sm">
                                        <span className="text-emerald-700 dark:text-emerald-400">No longer blocking:</span>{' '}
                                        {delta.no_longer_blocking.join(', ')}
                                    </p>
                                )}
                                {!delta.newly_blocking.length && !delta.no_longer_blocking.length && (
                                    <p className="mt-2 text-sm text-muted-foreground">
                                        No change to which rules block.
                                    </p>
                                )}
                            </>
                        ) : (
                            <p className="mt-2 text-sm text-muted-foreground">
                                No live pack to compare against — this would be the first.
                            </p>
                        )}
                    </div>

                    <div className="rounded-md border p-4">
                        <h4 className="text-sm font-semibold">Readiness spread</h4>
                        <div className="mt-2 space-y-1">
                            {Object.entries(results.readiness_distribution).map(([bucket, n]) => {
                                const pct = results.claims_evaluated
                                    ? Math.round((n / results.claims_evaluated) * 100) : 0;
                                return (
                                    <div key={bucket} className="flex items-center gap-2 text-xs">
                                        <span className="w-16 text-muted-foreground">{bucket}</span>
                                        <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                                            <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                                        </div>
                                        <span className="w-16 text-right tabular-nums">{n} ({pct}%)</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div className="rounded-md border p-4">
                        <h4 className="text-sm font-semibold">How often each rule fires</h4>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            A rule firing on almost every claim is usually miscalibrated rather than strict.
                        </p>
                        <div className="mt-2 space-y-1">
                            {results.rule_fire_rates.slice(0, 15).map((r) => (
                                <div key={r.rule_id} className="flex items-center gap-2 text-xs">
                                    <code className="w-56 truncate">{r.rule_id}</code>
                                    <Badge variant="outline" className="text-[10px]">{r.severity}</Badge>
                                    <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                                        <div
                                            className={`h-full ${r.rate > 0.9 ? 'bg-red-500' : 'bg-primary'}`}
                                            style={{ width: `${Math.round(r.rate * 100)}%` }}
                                        />
                                    </div>
                                    <span className="w-20 text-right tabular-nums">
                                        {r.fired} ({Math.round(r.rate * 100)}%)
                                    </span>
                                </div>
                            ))}
                            {results.rule_fire_rates.length === 0 && (
                                <p className="text-xs text-muted-foreground">No rule failed on any claim in the cohort.</p>
                            )}
                        </div>
                    </div>

                    {results.sample.length > 0 && (
                        <details className="rounded-md border p-4">
                            <summary className="cursor-pointer text-sm font-semibold">
                                Spot-check {results.sample.length} claims
                            </summary>
                            <ul className="mt-2 space-y-1 text-xs">
                                {results.sample.map((s) => (
                                    <li key={s.claim_id} className="flex items-center gap-2">
                                        <code className="w-72 truncate text-muted-foreground">{s.claim_id}</code>
                                        <span className="tabular-nums">{s.readiness}</span>
                                        <span className="truncate text-muted-foreground">
                                            {s.blocking.join(', ') || '—'}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}
                </div>
            )}

            {history.length > 0 && (
                <div>
                    <h4 className="text-sm font-semibold">Previous runs</h4>
                    <ul className="mt-2 space-y-1 text-xs">
                        {history.map((h) => (
                            <li key={h.id} className="flex flex-wrap items-center gap-2">
                                <span className="text-muted-foreground">
                                    {new Date(h.started_at).toLocaleString()}
                                </span>
                                <span>{h.claims_evaluated} claims</span>
                                {h.passed
                                    ? <Badge variant="outline" className="text-[10px]">completed</Badge>
                                    : <Badge variant="secondary" className="text-[10px]">failed</Badge>}
                                {h.error && <span className="text-red-600 dark:text-red-400">{h.error}</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
