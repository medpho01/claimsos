import { useCallback, useEffect, useState } from 'react';
import ApiService from '@/services/api';
import type { FleetPanel } from '@/pages/hospital/Profile/components/PanelsFleetTable';

/**
 * Hook: fetch the panel fleet (all linked panels + their attributes) for a
 * hospital in a single round-trip. Powers the Overview tab's fleet table.
 *
 * Extracted from PanelsManager.tsx during the M14 split. The returned
 * `refresh` is stable and safe to pass to children.
 */
export function usePanelFleet(hospitalId: string) {
  const [fleet, setFleet] = useState<FleetPanel[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchFleet = useCallback(async () => {
    if (!hospitalId) return;
    try {
      setLoading(true);
      const res = await ApiService.get(`/hospitals/${hospitalId}/panels-fleet`);
      setFleet(res.data?.data || []);
    } catch (err) {
      console.error('Error fetching panel fleet:', err);
    } finally {
      setLoading(false);
    }
  }, [hospitalId]);

  useEffect(() => {
    fetchFleet();
  }, [fetchFleet]);

  return { fleet, loading, refresh: fetchFleet };
}
