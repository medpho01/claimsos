import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Wave 10 — AI corrections hook.
 *
 * Two read paths surface through the same module:
 *   - useAiCorrections({ claimId, surface, limit }) — list rows. If
 *     claimId is set, hits /claims/:claimId/ai-corrections (per-claim
 *     drawer). Otherwise hits /ai-corrections (admin list, optionally
 *     filtered by surface).
 *   - useCorrectionStats({ since_days }) — roll-up counts by surface.
 *
 * Stale times mirror the cadence of the underlying data: the admin list
 * doesn't need sub-minute freshness, the per-claim drawer benefits from
 * a shorter window because reviewers may bounce in and out.
 */

export type AiCorrectionSurface =
  | 'document_category'
  | 'extraction_field'
  | 'harmonised_field'
  | 'rule_override'
  | 'ai_draft_field'
  | 'audit_call_wrong';

export interface AiCorrectionRow {
  id: string;
  surface: AiCorrectionSurface;
  claim_id: string | null;
  target_id: string | null;
  target_kind: string | null;
  ai_value: unknown;
  human_value: unknown;
  reason: string | null;
  corrected_by: string;
  corrected_at: string;
  applied_to_kb: boolean;
  mined_pattern_id: string | null;
}

export interface CorrectionSurfaceCount {
  surface: AiCorrectionSurface;
  total: number;
  unmined: number;
}

export interface CorrectionStats {
  since_days: number;
  by_surface: CorrectionSurfaceCount[];
  totals: { total: number; unmined: number };
}

export interface UseAiCorrectionsOpts {
  claimId?: string;
  surface?: AiCorrectionSurface;
  since_days?: number;
  limit?: number;
}

export function useAiCorrections(opts: UseAiCorrectionsOpts = {}) {
  const { claimId, surface, since_days, limit } = opts;

  const query = useQuery({
    queryKey: [
      'intelligence',
      'ai-corrections',
      claimId ?? 'any',
      surface ?? 'any',
      since_days ?? 'default',
      limit ?? 'default',
    ],
    staleTime: claimId ? 30_000 : 5 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: async (): Promise<AiCorrectionRow[]> => {
      const params = new URLSearchParams();
      if (!claimId) {
        if (surface) params.set('surface', surface);
        if (since_days != null) params.set('since_days', String(since_days));
      }
      if (limit != null) params.set('limit', String(limit));
      const qs = params.toString() ? `?${params.toString()}` : '';
      const url = claimId
        ? `/claims/${claimId}/ai-corrections${qs}`
        : `/ai-corrections${qs}`;
      try {
        const res = await apiService.get(url);
        const rows = (res.data?.data ?? res.data ?? []) as AiCorrectionRow[];
        return Array.isArray(rows) ? rows : [];
      } catch (e: any) {
        if (e?.response?.status === 404) return [];
        throw e;
      }
    },
  });

  return {
    data: query.data ?? [],
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

export function useCorrectionStats(opts: { since_days?: number } = {}) {
  const since_days = opts.since_days;
  const query = useQuery({
    queryKey: ['intelligence', 'ai-corrections', 'stats', since_days ?? 'default'],
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: async (): Promise<CorrectionStats | null> => {
      const params = new URLSearchParams();
      if (since_days != null) params.set('since_days', String(since_days));
      const qs = params.toString() ? `?${params.toString()}` : '';
      try {
        const res = await apiService.get(`/ai-corrections/stats${qs}`);
        return (res.data?.data ?? res.data ?? null) as CorrectionStats | null;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });

  return {
    data: query.data ?? null,
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
