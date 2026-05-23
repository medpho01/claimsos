/**
 * useIntelligenceStatus — polls the per-claim AI pipeline status endpoint
 * so the Claim AI Summary page can render a live "Analyzing…" banner +
 * ETA + auto-refresh data hooks when async work completes.
 *
 * Polls every `pollIntervalMs` (default 3500ms) WHEN status.is_pending=true,
 * otherwise sits idle. As soon as `is_pending` flips false, react-query
 * stops auto-refetching and the caller is expected to invalidate the
 * dependent hooks (harmonised episode, rules v2, audit trail).
 */

import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

export interface IntelligenceStatus {
  claim_id: string;
  sections: {
    total: number;
    classified: number;
    extracted: number;
  };
  segmenter: { pending: boolean };
  harmoniser: {
    status: 'fresh' | 'stale' | 'pending' | 'failed' | 'absent';
    generated_at: string | null;
    cost_inr: number | null;
    error_message: string | null;
  };
  adjudication: {
    latest_at: string | null;
    readiness_score: number | null;
    recommended_action: string | null;
  };
  rules_v2: {
    latest_at: string | null;
    total: number;
    failed: number;
    skipped: number;
    rule_set_id: string | null;
  };
  is_pending: boolean;
  pending_components: string[];
  eta_seconds: number | null;
  last_updated_at: string;
}

export function useIntelligenceStatus(
  claimId: string | null | undefined,
  opts?: { pollIntervalMs?: number; enabled?: boolean },
) {
  const pollMs = opts?.pollIntervalMs ?? 3500;
  const enabled = opts?.enabled !== false && !!claimId;
  return useQuery<IntelligenceStatus | null>({
    queryKey: ['intelligence-status', claimId],
    enabled,
    refetchInterval: (q) => {
      const data = q?.state?.data as IntelligenceStatus | null | undefined;
      // Poll while there's pending work; stop otherwise.
      return data?.is_pending ? pollMs : false;
    },
    refetchOnWindowFocus: true,
    staleTime: 0,
    gcTime: 60_000,
    queryFn: async () => {
      try {
        const res = await apiService.get(`/claims/${claimId}/intelligence/status`);
        return res.data as IntelligenceStatus;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });
}
