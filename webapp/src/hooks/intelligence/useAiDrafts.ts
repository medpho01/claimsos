import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Sprint W1-C — FE Hooks Foundation.
 *
 * AI drafts pending human review on a claim. Drafts are produced by the
 * LLM bridge (Wave 0) — extracted_payload is the structured proposal, and
 * the ops user accepts/edits/rejects it through this hook's mutations.
 *
 * Real-time-ish: 15s staleTime / 1min gcTime — Kratika's inbox cares.
 */

export type AiDraftStatus = 'pending_review' | 'applied' | 'rejected' | 'expired';

export interface AiDraft {
  id: string;
  claim_id: string;
  /** Insurer-outcome category. The API column is `category`; we also expose
   *  it as `kind` for older consumers (AiDraftDrawer reads `kind`). */
  kind: string;
  category?: string;
  /** Classifier confidence 0..1. API column is `classifier_confidence`. */
  confidence: number;
  classifier_confidence?: number;
  inbound_email_id?: string | null;
  /** The insurer email the extraction was derived from — the reviewable
   *  "proof" (from / subject / body / attachments). Null if the source row
   *  is missing. */
  source_email?: {
    id: string;
    gmail_message_id?: string;
    gmail_thread_id?: string;
    from?: string;
    subject?: string;
    received_at?: string;
    body?: string;
    attachments?: Array<{
      id?: string;
      filename?: string;
      mime?: string;
      mime_type?: string;
      size_bytes?: number;
      s3_key?: string;
      view_url?: string | null;
    }>;
    classification?: string;
  } | null;
  extracted_payload: Record<string, any>;
  status: AiDraftStatus;
  created_at: string;
  llm_provider: string;
  llm_model: string;
}

const draftsCache = new Map<string, AiDraft[]>();

/**
 * The API (email_intelligence_drafts) returns `category` +
 * `classifier_confidence`; the FE type/components expect `kind` +
 * `confidence`. Normalise so both spellings are populated — without this the
 * AiDraftDrawer renders category "unknown" and an empty confidence badge.
 */
const normalizeDraft = (row: any): AiDraft => {
  const kind = row?.kind ?? row?.category ?? 'unknown';
  const confidence =
    row?.confidence ?? row?.classifier_confidence ?? 0;
  const source = row?.source_email ?? null;
  // The AiDraftDrawer reads the source email from extracted_payload.source —
  // mirror it there so the drawer's proof pane renders without further wiring.
  const payload = { ...(row?.extracted_payload ?? {}) };
  if (source && payload.source == null) {
    payload.source = {
      subject: source.subject,
      from: source.from,
      received_at: source.received_at,
      body: source.body,
      attachments: Array.isArray(source.attachments)
        ? source.attachments.map((a: any, i: number) => ({
            id: a?.id ?? a?.s3_key ?? String(i),
            filename: a?.filename ?? a?.name ?? `attachment-${i + 1}`,
            size_bytes: a?.size_bytes ?? a?.size,
            mime: a?.mime ?? a?.mime_type ?? null,
            view_url: a?.view_url ?? null,
          }))
        : [],
    };
  }
  return {
    ...row,
    kind,
    category: row?.category ?? kind,
    confidence,
    classifier_confidence: row?.classifier_confidence ?? confidence,
    source_email: source,
    extracted_payload: payload,
  } as AiDraft;
};

export function useAiDrafts(
  claimId: string | undefined | null,
  status?: AiDraftStatus,
) {
  const qc = useQueryClient();
  const cacheKey = `${claimId ?? ''}::${status ?? 'all'}`;

  const query = useQuery({
    queryKey: ['intelligence', 'ai-drafts', claimId, status ?? 'all'],
    enabled: !!claimId,
    staleTime: 15_000,
    gcTime: 60_000,
    queryFn: async (): Promise<AiDraft[]> => {
      if (!claimId) return [];
      const qs = status ? `?status=${encodeURIComponent(status)}` : '';
      try {
        const res = await apiService.get(`/claims/${claimId}/ai-drafts${qs}`);
        const rows = (res.data?.data ?? res.data ?? []) as any[];
        const list = (Array.isArray(rows) ? rows : []).map(normalizeDraft);
        draftsCache.set(cacheKey, list);
        return list;
      } catch (e: any) {
        if (e?.response?.status === 404) return [];
        throw e;
      }
    },
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['intelligence', 'ai-drafts', claimId] });

  // Applying a draft has side effects beyond the draft itself: it writes the
  // approved amount into claim_financials and may open claim_actions. Refresh
  // those queries too, otherwise the Overview "Claim Financials" card shows
  // stale data until a full reload.
  const invalidateAfterApply = () => {
    invalidate();
    qc.invalidateQueries({ queryKey: ['intelligence', 'financials', claimId] });
    qc.invalidateQueries({ queryKey: ['intelligence', 'actions', claimId] });
  };

  const applyMutation = useMutation({
    mutationFn: async (vars: { draftId: string; fieldOverrides?: Record<string, any> }) => {
      const res = await apiService.post(`/ai-drafts/${vars.draftId}/apply`, {
        field_overrides: vars.fieldOverrides ?? {},
      });
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidateAfterApply,
  });

  const rejectMutation = useMutation({
    mutationFn: async (vars: { draftId: string; reason: string }) => {
      const res = await apiService.post(`/ai-drafts/${vars.draftId}/reject`, {
        reason: vars.reason,
      });
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
  });

  return {
    data: (query.data ?? draftsCache.get(cacheKey) ?? []) as AiDraft[],
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    applyDraft: (draftId: string, fieldOverrides?: Record<string, any>) =>
      applyMutation.mutateAsync({ draftId, fieldOverrides }),
    rejectDraft: (draftId: string, reason: string) =>
      rejectMutation.mutateAsync({ draftId, reason }),
    applying: applyMutation.isPending,
    rejecting: rejectMutation.isPending,
  };
}
