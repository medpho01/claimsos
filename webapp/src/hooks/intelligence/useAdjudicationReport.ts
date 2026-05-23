import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Sprint W1-C — FE Hooks Foundation.
 *
 * Adjudication report (readiness gauge, blocking gaps, predicted outcome,
 * citations). Pass { history: true } to get the audit trail of every
 * adjudication run on a claim; default behaviour is the latest only.
 */

export interface AdjudicationBlockingGap {
  id: string;
  field?: string;
  doc_category?: string;
  severity: 'blocker' | 'warning';
  message: string;
  fix_hint?: string;
}

export interface AdjudicationWarning {
  id: string;
  message: string;
  severity?: 'low' | 'medium' | 'high';
  source?: string;
}

export interface AdjudicationPredictedOutcome {
  amount: number;
  p_query: number;
  p_approval?: number;
  p_partial?: number;
  expected_value_inr?: number;
}

export interface AdjudicationCitations {
  rule_ids: string[];
  pattern_ids: string[];
  case_ids: string[];
}

export interface AdjudicationReport {
  id: string;
  claim_id: string;
  readiness: number;
  recommended_action: string;
  blocking_gaps: AdjudicationBlockingGap[];
  warnings: AdjudicationWarning[];
  predicted_outcome: AdjudicationPredictedOutcome;
  citations: AdjudicationCitations;
  generated_at: string;
}

const reportCache = new Map<string, AdjudicationReport | AdjudicationReport[]>();

export function useAdjudicationReport(
  claimId: string | undefined | null,
  opts?: { history?: boolean },
) {
  const history = !!opts?.history;
  const cacheKey = `${claimId ?? ''}::${history ? 'history' : 'latest'}`;

  const query = useQuery({
    queryKey: ['intelligence', 'adjudication', claimId, history ? 'history' : 'latest'],
    enabled: !!claimId,
    staleTime: 30_000,
    gcTime: 2 * 60_000,
    queryFn: async (): Promise<AdjudicationReport | AdjudicationReport[] | null> => {
      if (!claimId) return null;
      const url = history
        ? `/claims/${claimId}/adjudication/history`
        : `/claims/${claimId}/adjudication`;
      try {
        const res = await apiService.get(url);
        const payload = (res.data?.data ?? res.data) as
          | AdjudicationReport
          | AdjudicationReport[];
        if (payload) reportCache.set(cacheKey, payload);
        return payload ?? null;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });

  return {
    data:
      (query.data ?? (reportCache.get(cacheKey) ?? null)) as
        | AdjudicationReport
        | AdjudicationReport[]
        | null,
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
