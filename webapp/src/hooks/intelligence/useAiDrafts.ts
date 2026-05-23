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
  kind: string;
  confidence: number;
  extracted_payload: Record<string, any>;
  status: AiDraftStatus;
  created_at: string;
  llm_provider: string;
  llm_model: string;
}

const draftsCache = new Map<string, AiDraft[]>();

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
        const rows = (res.data?.data ?? res.data ?? []) as AiDraft[];
        const list = Array.isArray(rows) ? rows : [];
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

  const applyMutation = useMutation({
    mutationFn: async (vars: { draftId: string; fieldOverrides?: Record<string, any> }) => {
      const res = await apiService.post(`/ai-drafts/${vars.draftId}/apply`, {
        field_overrides: vars.fieldOverrides ?? {},
      });
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
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
