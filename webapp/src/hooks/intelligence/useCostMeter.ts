import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Sprint W1-C — FE Hooks Foundation.
 *
 * LLM cost-meter rollup — total spend, per-task and per-model breakdown,
 * tier-escalation rate (how often we fell back to a more expensive
 * model), cache hit rate, p95 cost per claim, and any threshold alerts.
 */

export type CostMeterPeriod = 'today' | 'week' | 'month' | 'all';

export interface CostMeterAlert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  triggered_at: string;
}

export interface CostMeterData {
  spend_inr: number;
  claim_count: number;
  avg_per_claim_inr: number;
  breakdown_by_task: Record<string, number>;
  breakdown_by_model: Record<string, number>;
  tier_escalation_rate: number;
  cache_hit_rate: number;
  p95_per_claim_inr: number;
  alerts: CostMeterAlert[];
}

const meterCache = new Map<string, CostMeterData>();

function buildCacheKey(hospitalId?: string, period?: string): string {
  return `${hospitalId ?? 'all'}::${period ?? 'month'}`;
}

export function useCostMeter(opts?: {
  hospitalId?: string;
  period: CostMeterPeriod;
}) {
  const hospitalId = opts?.hospitalId;
  const period = opts?.period ?? 'month';
  const cacheKey = buildCacheKey(hospitalId, period);

  const query = useQuery({
    queryKey: ['intelligence', 'cost-meter', hospitalId ?? 'all', period],
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<CostMeterData | null> => {
      const params = new URLSearchParams();
      if (hospitalId) params.set('hospital_id', hospitalId);
      params.set('period', period);
      try {
        const res = await apiService.get(`/cost/meter?${params.toString()}`);
        const payload = (res.data?.data ?? res.data) as CostMeterData;
        if (payload) meterCache.set(cacheKey, payload);
        return payload ?? null;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });

  return {
    data: (query.data ?? meterCache.get(cacheKey) ?? null) as CostMeterData | null,
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
