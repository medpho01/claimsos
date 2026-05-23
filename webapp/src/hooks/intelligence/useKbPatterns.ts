import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Sprint W1-C — FE Hooks Foundation.
 *
 * Knowledge-base patterns surfaced by the pattern miner. Admin-only
 * screen with low traffic, so cache aggressively (5min stale / 30min gc).
 * Promote moves a candidate to 'live' (used in adjudication); demote
 * sidelines a stale or wrong pattern with an audit reason.
 */

export type KbPatternStatus = 'candidate' | 'live' | 'demoted';

export interface KbPattern {
  id: string;
  pattern_type: string;
  scope: Record<string, any>;
  condition: Record<string, any>;
  prediction: Record<string, any>;
  evidence_count: number;
  confidence: number;
  status: KbPatternStatus;
  last_seen_at: string;
}

const patternsCache = new Map<string, KbPattern[]>();

function buildCacheKey(status?: string, patternType?: string): string {
  return `${status ?? 'any'}::${patternType ?? 'any'}`;
}

export function useKbPatterns(opts?: {
  status?: KbPatternStatus;
  patternType?: string;
}) {
  const qc = useQueryClient();
  const status = opts?.status;
  const patternType = opts?.patternType;
  const cacheKey = buildCacheKey(status, patternType);

  const query = useQuery({
    queryKey: ['intelligence', 'kb-patterns', status ?? 'any', patternType ?? 'any'],
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: async (): Promise<KbPattern[]> => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (patternType) params.set('pattern_type', patternType);
      const qs = params.toString() ? `?${params.toString()}` : '';
      try {
        const res = await apiService.get(`/kb-patterns${qs}`);
        const rows = (res.data?.data ?? res.data ?? []) as KbPattern[];
        const list = Array.isArray(rows) ? rows : [];
        patternsCache.set(cacheKey, list);
        return list;
      } catch (e: any) {
        if (e?.response?.status === 404) return [];
        throw e;
      }
    },
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['intelligence', 'kb-patterns'] });

  const promoteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiService.post(`/kb-patterns/${id}/promote`, {});
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
  });

  const demoteMutation = useMutation({
    mutationFn: async (vars: { id: string; reason: string }) => {
      const res = await apiService.post(`/kb-patterns/${vars.id}/demote`, {
        reason: vars.reason,
      });
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
  });

  return {
    data: (query.data ?? patternsCache.get(cacheKey) ?? []) as KbPattern[],
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    promotePattern: (id: string) => promoteMutation.mutateAsync(id),
    demotePattern: (id: string, reason: string) =>
      demoteMutation.mutateAsync({ id, reason }),
    promoting: promoteMutation.isPending,
    demoting: demoteMutation.isPending,
  };
}
