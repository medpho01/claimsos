import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Wave 9 — FE Claim AI Summary.
 *
 * Per-claim LLM audit trail: every LLM/AI call that touched this claim,
 * with tokens + cost + latency + outcome. Sourced from llm_cost_log on
 * the backend. The endpoint is not live at the time this hook ships;
 * 404 → empty list so the timeline panel renders an empty state cleanly.
 */

export interface AiAuditTrailRow {
  id: string;
  task: string;
  provider: string;
  model: string;
  prompt_version?: string;
  cost_inr?: number;
  latency_ms?: number;
  tokens_input_uncached?: number;
  tokens_input_cached?: number;
  tokens_output?: number;
  created_at: string;
  succeeded: boolean;
  error_message?: string | null;
  confidence?: number | null;
  /** Free-form metadata bag the backend may include (e.g. linked draft_id). */
  meta?: Record<string, any>;
}

export interface AiAuditTrailOpts {
  /** Filter to a single task code (server-side filter). */
  task?: string;
  /** ISO datetime — server-side filter. */
  since?: string;
  /** ISO datetime — server-side filter. */
  until?: string;
}

const trailCache = new Map<string, AiAuditTrailRow[]>();

export function useAiAuditTrail(
  claimId: string | undefined | null,
  opts?: AiAuditTrailOpts,
) {
  const cacheKey = `${claimId ?? ''}::${opts?.task ?? ''}::${opts?.since ?? ''}::${opts?.until ?? ''}`;

  const query = useQuery({
    queryKey: ['intelligence', 'ai-audit-trail', claimId, opts ?? {}],
    enabled: !!claimId,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<AiAuditTrailRow[]> => {
      if (!claimId) return [];
      const qsParts: string[] = [];
      if (opts?.task) qsParts.push(`task=${encodeURIComponent(opts.task)}`);
      if (opts?.since) qsParts.push(`since=${encodeURIComponent(opts.since)}`);
      if (opts?.until) qsParts.push(`until=${encodeURIComponent(opts.until)}`);
      const qs = qsParts.length ? `?${qsParts.join('&')}` : '';
      try {
        const res = await apiService.get(`/claims/${claimId}/ai-audit-trail${qs}`);
        // Controller returns { rollup, entries }. Also tolerate older
        // shapes ({ data: [...] } or bare array) for forward compat.
        const rows = (res.data?.entries ?? res.data?.data ?? res.data ?? []) as AiAuditTrailRow[];
        const list = Array.isArray(rows) ? rows : [];
        trailCache.set(cacheKey, list);
        return list;
      } catch (e: any) {
        if (e?.response?.status === 404) {
          // Endpoint not yet implemented — graceful empty list.
          return [];
        }
        throw e;
      }
    },
  });

  return {
    data: (query.data ?? trailCache.get(cacheKey) ?? []) as AiAuditTrailRow[],
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

export default useAiAuditTrail;
