import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Wave 9 — FE Claim AI Summary.
 *
 * Mirrors the Wave 8 rules-v2 backend evaluation result on the FE.
 * The hook tolerates a missing endpoint (404 → null) so the panel can
 * render its "no rule set matched" empty state during backend rollout.
 */

export type RuleCategory =
  | 'POLICY_ELIGIBILITY'
  | 'DOCUMENT_COMPLETENESS'
  | 'CLINICAL_APPROPRIATENESS'
  | 'FINANCIAL_LIMITS'
  | 'PROCEDURAL_COMPLIANCE'
  | 'TEMPORAL_VALIDITY';

export type RuleSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export type RuleStatus = 'PASS' | 'FAIL' | 'SKIP' | 'WARN' | 'OVERRIDDEN';

export interface RuleEvaluation {
  rule_id: string;
  rule_code?: string;
  rule_name?: string;
  rule_description?: string;
  category: RuleCategory | string;
  severity: RuleSeverity | string;
  status: RuleStatus | string;
  /** Evidence object — arbitrary JSON; UI renders as pretty-printed. */
  evidence?: Record<string, any>;
  message?: string;
  remediation_guidance?: string;
  required_documents?: string[];
  query_template?: string;
  estimated_deduction_amount?: number;
  /** Set when status === 'OVERRIDDEN'. */
  override?: {
    overridden_by?: string;
    overridden_at?: string;
    reason?: string;
  };
}

export interface RulesV2Result {
  /** ID of the rule set that was applied. Null when nothing matched. */
  rule_set_id: string | null;
  rule_set_name?: string;
  insurer_code?: string;
  treatment_type?: string;
  /** 0..100 — derived readiness score from rule outcomes. */
  readiness_score?: number;
  evaluations: RuleEvaluation[];
  evaluated_at?: string;
  /** True when no rule set was found for the claim's insurer/treatment combo. */
  no_match?: boolean;
}

export interface OverrideRulePayload {
  rule_id: string;
  reason: string;
}

const rulesCache = new Map<string, RulesV2Result>();

export function useRulesV2(claimId: string | undefined | null) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['intelligence', 'rules-v2', claimId],
    enabled: !!claimId,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    queryFn: async (): Promise<RulesV2Result | null> => {
      if (!claimId) return null;
      try {
        const res = await apiService.get(`/claims/${claimId}/rules-v2`);
        const payload = (res.data?.data ?? res.data) as RulesV2Result;
        if (payload) rulesCache.set(claimId, payload);
        return payload ?? null;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['intelligence', 'rules-v2', claimId] });

  const evaluateMutation = useMutation({
    mutationFn: async () => {
      if (!claimId) throw new Error('claimId required');
      const res = await apiService.post(`/claims/${claimId}/rules-v2/evaluate`, {});
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
  });

  const overrideMutation = useMutation({
    mutationFn: async (payload: OverrideRulePayload) => {
      if (!claimId) throw new Error('claimId required');
      const res = await apiService.post(
        `/claims/${claimId}/rules-v2/${encodeURIComponent(payload.rule_id)}/override`,
        { reason: payload.reason },
      );
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
  });

  return {
    data:
      (query.data ?? (claimId ? rulesCache.get(claimId) ?? null : null)) as
        | RulesV2Result
        | null,
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    evaluate: () => evaluateMutation.mutateAsync(),
    overrideRule: (payload: OverrideRulePayload) => overrideMutation.mutateAsync(payload),
    isEvaluating: evaluateMutation.isPending,
    isOverriding: overrideMutation.isPending,
  };
}

export default useRulesV2;
