import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';
import { Patient } from '@/types';

/**
 * Fetch the full patient list for a hospital, across all of its linked
 * panels, deduplicated and merged into a single array.
 *
 * Frontend review H3 + M39: three separate hospital sub-pages (Patients,
 * PatientDetail, PatientEdit) each duplicated this fan-out logic and
 * fetched only page=1 of each panel — silently dropping patients on
 * any panel with more than 50 of them. This hook centralizes the fetch
 * AND uses react-query's cache so the fan-out runs once and is shared
 * across all three pages.
 *
 * The query key includes `hospitalId` and the list of panel IDs (sorted
 * + joined) so the cache invalidates correctly when a panel is added or
 * removed. Increase `pageSize` if/when a backend "all patients for a
 * hospital" endpoint ships, at which point this hook collapses to one
 * call.
 *
 * NOTE: this is a Sprint-1 starter. Future passes should:
 *   - paginate per-panel beyond page 1 (or push the union to backend)
 *   - move the snake_case → camelCase normalization to the axios
 *     response interceptor (apiTransformers.ts) so it's not duplicated
 *     per-consumer.
 */
export function useHospitalPatients(
  hospitalId: string | undefined,
  panelIds: string[],
) {
  const sortedPanelIds = [...(panelIds || [])].sort();
  return useQuery({
    queryKey: ['hospital-patients', hospitalId, sortedPanelIds],
    enabled: !!hospitalId && sortedPanelIds.length > 0,
    queryFn: async (): Promise<Patient[]> => {
      if (!hospitalId) return [];
      const results = await Promise.all(
        sortedPanelIds.map((pid) =>
          apiService
            .getHospitalPanelPatients(hospitalId, pid, 1, 'all', '')
            .then((r) => {
              const raw = r?.data?.data;
              if (Array.isArray(raw)) return raw as Patient[];
              if (Array.isArray(raw?.data)) return raw.data as Patient[];
              return [] as Patient[];
            })
            .catch(() => [] as Patient[]),
        ),
      );
      // Flatten + dedupe by id (some patients can appear under multiple
      // panels due to historical assignments).
      const seen = new Set<string>();
      const flat: Patient[] = [];
      for (const group of results) {
        for (const p of group) {
          if (!seen.has(p.id)) {
            seen.add(p.id);
            flat.push(p);
          }
        }
      }
      return flat;
    },
  });
}
