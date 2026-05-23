import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Sprint W1-C — FE Hooks Foundation.
 *
 * Action queue (Kratika's inbox). Each action is a piece of work flagged
 * by the system that needs a human response — request a doc from the
 * hospital, ping ops, kick off an approval, etc.
 *
 * Freshness matters: 10s stale / 30s gc.
 */

export type ClaimActionKind = 'request_doc' | 'notify_ops' | 'approval_request';
export type ClaimActionStatus = 'pending' | 'acked' | 'declined' | 'expired';

export interface ClaimAction {
  id: string;
  claim_id: string;
  kind: ClaimActionKind;
  target: string;
  payload: Record<string, any>;
  status: ClaimActionStatus;
  created_at: string;
}

const queueCache = new Map<string, ClaimAction[]>();

function buildCacheKey(userId?: string, status?: string): string {
  return `${userId ?? 'any'}::${status ?? 'pending'}`;
}

export function useActionQueue(opts?: {
  userId?: string;
  status?: 'pending' | 'all';
}) {
  const qc = useQueryClient();
  const userId = opts?.userId;
  const status = opts?.status ?? 'pending';
  const cacheKey = buildCacheKey(userId, status);

  const query = useQuery({
    queryKey: ['intelligence', 'action-queue', userId ?? 'any', status],
    staleTime: 10_000,
    gcTime: 30_000,
    queryFn: async (): Promise<ClaimAction[]> => {
      const params = new URLSearchParams();
      if (userId) params.set('user_id', userId);
      if (status && status !== 'pending') params.set('status', status);
      const qs = params.toString() ? `?${params.toString()}` : '';
      try {
        const res = await apiService.get(`/claim-actions${qs}`);
        const rows = (res.data?.data ?? res.data ?? []) as ClaimAction[];
        const list = Array.isArray(rows) ? rows : [];
        queueCache.set(cacheKey, list);
        return list;
      } catch (e: any) {
        if (e?.response?.status === 404) return [];
        throw e;
      }
    },
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['intelligence', 'action-queue'] });

  const ackMutation = useMutation({
    mutationFn: async (vars: { id: string; response: Record<string, any> }) => {
      const res = await apiService.post(`/claim-actions/${vars.id}/ack`, {
        response: vars.response,
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
    data: (query.data ?? queueCache.get(cacheKey) ?? []) as ClaimAction[],
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    ackAction: (id: string, response: Record<string, any>) =>
      ackMutation.mutateAsync({ id, response }),
    declineAction: (id: string, reason: string) =>
      declineMutation.mutateAsync({ id, reason }),
    acking: ackMutation.isPending,
    declining: declineMutation.isPending,
  };
}
