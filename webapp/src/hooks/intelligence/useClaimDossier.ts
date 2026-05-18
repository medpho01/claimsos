import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Sprint W1-C — FE Hooks Foundation.
 *
 * Fetches the consolidated "claim dossier" for one claim — the single
 * payload that hydrates the new claim-detail surface. The backend route
 * does not exist yet (Wave 1); this hook compiles + returns null on 404
 * so consumers can be wired in parallel with the BE work.
 */

export interface DossierAmount {
  label: string;
  amount_inr: number;
  source?: string;
}

export interface DossierDocSection {
  id: string;
  document_id: string;
  category: string;
  page_start: number;
  page_end: number;
  classification_confidence: number;
  status: 'pending' | 'classified' | 'reviewed' | 'rejected';
}

export interface DossierEventSummary {
  id: string;
  kind: string;
  occurred_at: string;
  actor?: string;
  summary: string;
}

export interface DossierInboundEmail {
  id: string;
  from_address: string;
  subject: string;
  received_at: string;
  matched: boolean;
}

export interface DossierOutboundSubmission {
  id: string;
  channel: 'email' | 'portal' | 'paper';
  stage: string;
  sent_at: string;
  status: string;
}

export interface DossierActiveQuery {
  id: string;
  raised_by: 'insurer' | 'hospital';
  text: string;
  raised_at: string;
  status: 'open' | 'responded';
}

export interface DossierPendingAction {
  id: string;
  kind: string;
  owner?: string;
  due_at?: string;
  description: string;
}

export interface DossierActiveAdjudication {
  id: string;
  readiness: number;
  recommended_action: string;
  generated_at: string;
}

export interface DossierAiDraft {
  id: string;
  kind: string;
  confidence: number;
  status: string;
  created_at: string;
}

export interface DossierKbPatternMatch {
  pattern_id: string;
  pattern_type: string;
  confidence: number;
  rationale?: string;
}

export interface ClaimDossier {
  claim_id: string;
  current_stage: string | null;
  amounts: DossierAmount[];
  doc_sections_by_category: Record<string, DossierDocSection[]>;
  events_summary: DossierEventSummary[];
  inbound_emails: DossierInboundEmail[];
  outbound_submissions: DossierOutboundSubmission[];
  active_queries: DossierActiveQuery[];
  pending_actions: DossierPendingAction[];
  active_adjudication: DossierActiveAdjudication | null;
  ai_drafts_pending: DossierAiDraft[];
  matched_kb_patterns: DossierKbPatternMatch[];
  closed_at: string | null;
  closure_outcome: string | null;
  retrospective_summary: string | null;
  updated_at: string;
}

// Module-level cache keyed by claimId (mirrors the useGmailHealth pattern).
// react-query owns the freshness/refetch story; this Map gives consumers a
// synchronous "have I seen this before?" handle for optimistic rendering.
const dossierCache = new Map<string, ClaimDossier>();

export function useClaimDossier(claimId: string | undefined | null) {
  const query = useQuery({
    queryKey: ['intelligence', 'claim-dossier', claimId],
    enabled: !!claimId,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<ClaimDossier | null> => {
      if (!claimId) return null;
      try {
        const res = await apiService.get(`/claims/${claimId}/dossier`);
        const payload = (res.data?.data ?? res.data) as ClaimDossier;
        if (payload) dossierCache.set(claimId, payload);
        return payload ?? null;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });

  return {
    data: (query.data ?? (claimId ? dossierCache.get(claimId) ?? null : null)) as ClaimDossier | null,
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
