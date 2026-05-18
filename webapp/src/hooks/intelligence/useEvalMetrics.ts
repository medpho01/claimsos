import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Sprint W1-C — FE Hooks Foundation.
 *
 * Eval metrics for the intelligence layer — prediction accuracy by task,
 * confidence calibration (are our 80% confidence predictions actually
 * right 80% of the time?), weekly trend.
 */

export type EvalMetricsPeriod = 'week' | 'month' | 'all';

export interface EvalTaskBreakdown {
  precision: number;
  recall: number;
  mean_error: number;
  sample_size?: number;
}

export interface EvalWeeklyPoint {
  week_start: string;
  accuracy_pct: number;
  sample_size: number;
}

export interface EvalMetricsData {
  prediction_accuracy_pct: number;
  sample_size: number;
  breakdown_by_task: Record<string, EvalTaskBreakdown>;
  /**
   * Shape is intentionally `any` here — the calibration plot data format
   * isn't finalized yet (might be {bucket, predicted, actual}[] or a
   * Brier-score scalar or both). FE consumers should narrow at the call
   * site once Wave 1 freezes the contract.
   */
  confidence_calibration: any;
  weekly_trend: EvalWeeklyPoint[];
}

const evalCache = new Map<string, EvalMetricsData>();

function buildCacheKey(period?: string, task?: string): string {
  return `${period ?? 'month'}::${task ?? 'all'}`;
}

export function useEvalMetrics(opts?: {
  period: EvalMetricsPeriod;
  task?: string;
}) {
  const period = opts?.period ?? 'month';
  const task = opts?.task;
  const cacheKey = buildCacheKey(period, task);

  const query = useQuery({
    queryKey: ['intelligence', 'eval-metrics', period, task ?? 'all'],
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: async (): Promise<EvalMetricsData | null> => {
      const params = new URLSearchParams();
      params.set('period', period);
      if (task) params.set('task', task);
      try {
        const res = await apiService.get(`/eval/metrics?${params.toString()}`);
        const payload = (res.data?.data ?? res.data) as EvalMetricsData;
        if (payload) evalCache.set(cacheKey, payload);
        return payload ?? null;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });

  return {
    data: (query.data ?? evalCache.get(cacheKey) ?? null) as EvalMetricsData | null,
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
