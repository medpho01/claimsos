import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Per-claim "next steps" — the pending claim_actions for a claim (e.g.
 * documents the insurer asked for via a query email). These are created when a
 * `queried` draft is applied; today they otherwise only surface in the global
 * /hospital/actions queue, not on the claim itself.
 *
 * Query key is ['intelligence','actions', claimId] — the same key
 * useAiDrafts invalidates after an apply, so confirming a query draft makes
 * the new actions appear here without a manual refresh.
 */
export interface ClaimAction {
  id: string;
  claim_id: string;
  kind: string;
  status: string;
  source: string | null;
  created_at: string;
  payload: {
    doc_requested?: string | null;
    deficiency_type?: string | null;
    description?: string | null;
    source_inbound_id?: string | null;
  } | null;
}

export function useClaimNextSteps(claimId: string | undefined | null) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['intelligence', 'actions', claimId],
    enabled: !!claimId,
    staleTime: 15_000,
    queryFn: async (): Promise<ClaimAction[]> => {
      if (!claimId) return [];
      try {
        const res = await apiService.get(
          `/claim-actions?claim_id=${encodeURIComponent(claimId)}&status=pending`,
        );
        const rows = res.data?.data ?? res.data ?? [];
        return Array.isArray(rows) ? rows : [];
      } catch (e: any) {
        if (e?.response?.status === 404) return [];
        throw e;
      }
    },
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['intelligence', 'actions', claimId] });

  const ackMutation = useMutation({
    mutationFn: async (vars: { id: string; response?: Record<string, any> }) => {
      const res = await apiService.post(`/claim-actions/${vars.id}/ack`, {
        response: vars.response ?? {},
      });
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
  });

  const declineMutation = useMutation({
    mutationFn: async (vars: { id: string; reason: string }) => {
      const res = await apiService.post(`/claim-actions/${vars.id}/decline`, {
        reason: vars.reason,
      });
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
  });

  return {
    data: query.data ?? [],
    loading: query.isLoading,
    refetch: query.refetch,
    markDone: (id: string, response?: Record<string, any>) =>
      ackMutation.mutateAsync({ id, response }),
    dismiss: (id: string, reason: string) =>
      declineMutation.mutateAsync({ id, reason }),
    isBusy: ackMutation.isPending || declineMutation.isPending,
  };
}

export default useClaimNextSteps;
