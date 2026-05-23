import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Sprint W1-C — FE Hooks Foundation.
 *
 * Stage requirements — "what docs and fields does this stage demand?".
 * Scope is hierarchical: most specific (procedureCode) overrides
 * insurer overrides panel. Backend computes the resolution; this hook
 * just forwards the scope params.
 */

export interface StageRequirement {
  id: string;
  stage_key: string;
  required_doc_category: string;
  required_fields: string[];
  severity: 'blocker' | 'warning' | 'info';
  scope: {
    panel_id?: string;
    insurer_id?: string;
    procedure_code?: string;
  };
  version: number;
}

export interface StageRequirementsScope {
  panelId?: string;
  insurerId?: string;
  procedureCode?: string;
}

const reqCache = new Map<string, StageRequirement[]>();

function scopeKey(scope: StageRequirementsScope): string {
  return `${scope.panelId ?? ''}::${scope.insurerId ?? ''}::${scope.procedureCode ?? ''}`;
}

export function useStageRequirements(scope: StageRequirementsScope) {
  const cacheKey = scopeKey(scope);

  const query = useQuery({
    queryKey: ['intelligence', 'stage-requirements', cacheKey],
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: async (): Promise<StageRequirement[]> => {
      const params = new URLSearchParams();
      if (scope.panelId) params.set('panel_id', scope.panelId);
      if (scope.insurerId) params.set('insurer_id', scope.insurerId);
      if (scope.procedureCode) params.set('procedure_code', scope.procedureCode);
      const qs = params.toString() ? `?${params.toString()}` : '';
      try {
        const res = await apiService.get(`/stage-requirements${qs}`);
        const rows = (res.data?.data ?? res.data ?? []) as StageRequirement[];
        const list = Array.isArray(rows) ? rows : [];
        reqCache.set(cacheKey, list);
        return list;
      } catch (e: any) {
        if (e?.response?.status === 404) return [];
        throw e;
      }
    },
  });

  return {
    data: (query.data ?? reqCache.get(cacheKey) ?? []) as StageRequirement[],
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
