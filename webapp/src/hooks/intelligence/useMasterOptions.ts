import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Sprint W1-C — FE Hooks Foundation.
 *
 * GENERIC ontology vocab lookup. Does NOT replace the legacy
 * `/hooks/useIpdStages.ts` — that hook stays for the IPD stage picker
 * which has its own windowing helpers. Existing hospital screens that
 * call useIpdStages will migrate to this generic hook in a later wave
 * once the API contract has settled.
 *
 * Vocab rarely changes mid-session: 30min stale, 1hr gc.
 */

export interface MasterOption {
  code: string;
  label: string;
  sort_order: number;
  is_active?: boolean;
}

const optionsCache = new Map<string, MasterOption[]>();

export function useMasterOptions(category: string | undefined | null) {
  const query = useQuery({
    queryKey: ['intelligence', 'master-options', category],
    enabled: !!category,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    queryFn: async (): Promise<MasterOption[]> => {
      if (!category) return [];
      try {
        const res = await apiService.getMasterOptionsByCategory(category);
        const rows = (res.data?.data ?? res.data ?? []) as any[];
        const list: MasterOption[] = (Array.isArray(rows) ? rows : [])
          .filter((r) => r.is_active !== false)
          .map((r) => ({
            code: r.code,
            label: r.label,
            sort_order: r.sort_order ?? 0,
            is_active: r.is_active !== false,
          }))
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        optionsCache.set(category, list);
        return list;
      } catch (e: any) {
        if (e?.response?.status === 404) return [];
        throw e;
      }
    },
  });

  return {
    data: (query.data ?? (category ? optionsCache.get(category) ?? [] : [])) as MasterOption[],
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
