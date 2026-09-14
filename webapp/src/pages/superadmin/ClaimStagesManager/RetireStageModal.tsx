import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AlertCircle, Loader } from 'lucide-react';
import ApiService from '@/services/api';
import type { ClaimStage } from './index';

interface StageUsage {
    claims: number;
    rule_sets: number;
    document_requirements: number;
    document_sections: number;
}

/**
 * Retire or reinstate a stage.
 *
 * Stages are never deleted — their codes are referenced by convention from four
 * columns and a TEXT[] with no real foreign key, so a delete would leave
 * dangling references that nothing reports.
 *
 * Retiring IS allowed while a stage is in use (an operator may need to stop
 * offering it while historical claims still sit in it), but the blast radius is
 * fetched and shown first. Asking for blind confirmation on a destructive-
 * looking action is how people learn to click through warnings.
 */
export default function RetireStageModal({
    stage, onClose, onDone,
}: {
    stage: ClaimStage;
    onClose: () => void;
    onDone: (message: string) => void;
}) {
    const retiring = stage.is_active;

    const [usage, setUsage] = useState<StageUsage | null>(null);
    const [loading, setLoading] = useState(retiring);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!retiring) return; // reinstating is always safe
        (async () => {
            try {
                const res = await ApiService.get(`/claim-stages/${stage.code}/usage`);
                setUsage(res.data.data);
            } catch (err: any) {
                setError(err?.response?.data?.error || 'Could not check what references this stage');
            } finally {
                setLoading(false);
            }
        })();
    }, [stage.code, retiring]);

    const submit = async () => {
        setSaving(true);
        setError(null);
        try {
            await ApiService.post(`/claim-stages/${stage.code}/retire`, { is_active: !retiring });
            onDone(`${stage.label} ${retiring ? 'retired' : 'reinstated'}`);
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Could not update the stage');
            setSaving(false);
        }
    };

    const total = usage
        ? usage.claims + usage.rule_sets + usage.document_requirements + usage.document_sections
        : 0;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-lg rounded-lg bg-background p-6 shadow-lg">
                <h2 className="text-lg font-semibold">
                    {retiring ? `Retire ${stage.label}?` : `Reinstate ${stage.label}?`}
                </h2>

                {retiring ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                        It stops appearing in the upload dropdown. Nothing is deleted, existing
                        claims are unaffected, and you can reinstate it at any time.
                    </p>
                ) : (
                    <p className="mt-1 text-sm text-muted-foreground">
                        It will appear in the upload dropdown again, in its existing lifecycle position.
                    </p>
                )}

                {error && (
                    <div className="mt-4 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {retiring && (
                    <div className="mt-4 rounded-md border bg-muted/40 p-3">
                        {loading ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Loader className="h-4 w-4 animate-spin" /> Checking what references this stage…
                            </div>
                        ) : usage ? (
                            <>
                                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    Currently referenced by
                                </p>
                                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                                    <dt className="text-muted-foreground">Claims</dt>
                                    <dd className="text-right font-medium">{usage.claims}</dd>
                                    <dt className="text-muted-foreground">Rule sets</dt>
                                    <dd className="text-right font-medium">{usage.rule_sets}</dd>
                                    <dt className="text-muted-foreground">Document requirements</dt>
                                    <dd className="text-right font-medium">{usage.document_requirements}</dd>
                                    <dt className="text-muted-foreground">Document sections</dt>
                                    <dd className="text-right font-medium">{usage.document_sections}</dd>
                                </dl>
                                {total > 0 ? (
                                    <p className="mt-3 text-xs text-muted-foreground">
                                        These keep working. Retiring only stops the stage being offered
                                        for new uploads — rules already written against it still evaluate.
                                    </p>
                                ) : (
                                    <p className="mt-3 text-xs text-muted-foreground">
                                        Nothing references this stage yet.
                                    </p>
                                )}
                                {stage.legacy_codes.length > 0 && (
                                    <p className="mt-2 text-xs text-muted-foreground">
                                        Counts include the legacy codes this stage absorbs
                                        ({stage.legacy_codes.join(', ')}), which live claims still carry.
                                    </p>
                                )}
                            </>
                        ) : null}
                    </div>
                )}

                <div className="mt-6 flex justify-end gap-2">
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button
                        variant={retiring ? 'destructive' : 'default'}
                        onClick={submit}
                        disabled={saving || loading}
                    >
                        {saving && <Loader className="mr-1 h-4 w-4 animate-spin" />}
                        {retiring ? 'Retire stage' : 'Reinstate stage'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
