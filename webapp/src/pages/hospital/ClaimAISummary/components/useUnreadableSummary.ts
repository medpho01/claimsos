/**
 * useUnreadableSummary — the consolidated end-of-run decision (contract §C.4).
 *
 * /status carries only a compact roll-up (how many pages, how many docs,
 * decision_required). The grouping the user actually acts on — which pages of
 * which document, why, and what section was lost — lives behind
 * GET /claims/:claimId/intelligence/runs/:runId/unreadable. We fetch it lazily:
 * only once a run exists AND the roll-up says there is something to show.
 *
 * Not polled. The summary describes a run that has stopped moving; the page
 * re-fetches it explicitly after a resume/cancel/acknowledge.
 */

import { useQuery } from '@tanstack/react-query';
import { fetchUnreadableSummary, type RunUnreadableSummary } from './runConsentApi';

export function useUnreadableSummary(
  claimId: string | null | undefined,
  runId: string | null | undefined,
  opts?: { enabled?: boolean },
) {
  const enabled = opts?.enabled !== false && !!claimId && !!runId;
  return useQuery<RunUnreadableSummary | null>({
    queryKey: ['intelligence-unreadable', claimId, runId],
    enabled,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => fetchUnreadableSummary(claimId as string, runId as string),
  });
}
