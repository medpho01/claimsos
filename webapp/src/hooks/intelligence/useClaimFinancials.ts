import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Claim financials — the four amounts (pre-auth & final × claimed & approved).
 *   - claimed  : admin-entered (setClaimed)
 *   - approved : extracted from the insurer email + confirmed on draft apply
 *                (read-only here; carries source email + confidence)
 */
export type FinancialStage = 'preauth' | 'final';

export interface ClaimFinancials {
  claim_id: string;
  preauth_claimed_amount: number | string | null;
  preauth_approved_amount: number | string | null;
  final_claimed_amount: number | string | null;
  final_approved_amount: number | string | null;
  preauth_deduction: number | string | null;
  final_deduction: number | string | null;
  preauth_approved_confidence: number | string | null;
  final_approved_confidence: number | string | null;
  preauth_approved_source_inbound_id: string | null;
  final_approved_source_inbound_id: string | null;
}

const num = (v: unknown): number | null =>
  v == null || v === '' ? null : Number(v);

export function useClaimFinancials(claimId: string | undefined | null) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['intelligence', 'financials', claimId],
    enabled: !!claimId,
    staleTime: 30_000,
    queryFn: async (): Promise<ClaimFinancials | null> => {
      if (!claimId) return null;
      try {
        const res = await apiService.get(`/claims/${claimId}/financials`);
        return (res.data?.data ?? null) as ClaimFinancials | null;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['intelligence', 'financials', claimId] });

  const setClaimed = useMutation({
    mutationFn: async (vars: { stage: FinancialStage; amount: number | null }) => {
      if (!claimId) throw new Error('claimId required');
      const res = await apiService.put(`/claims/${claimId}/financials/claimed`, vars);
      return res.data?.data ?? null;
    },
    onSuccess: invalidate,
  });

  const setApproved = useMutation({
    mutationFn: async (vars: { stage: FinancialStage; amount: number | null }) => {
      if (!claimId) throw new Error('claimId required');
      const res = await apiService.put(`/claims/${claimId}/financials/approved`, vars);
      return res.data?.data ?? null;
    },
    onSuccess: invalidate,
  });

  return {
    data: query.data ?? null,
    loading: query.isLoading,
    refetch: query.refetch,
    setClaimed: (stage: FinancialStage, amount: number | null) =>
      setClaimed.mutateAsync({ stage, amount }),
    setApproved: (stage: FinancialStage, amount: number | null) =>
      setApproved.mutateAsync({ stage, amount }),
    isSaving: setClaimed.isPending || setApproved.isPending,
    num,
  };
}

export default useClaimFinancials;
