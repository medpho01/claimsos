import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * M7 — Stage-aware Adjudication (FE hook).
 *
 * Surfaces the stage-aware adjudication engine (M0–M7 backend) that is
 * distinct from the legacy Wave-8 `rules-v2` and Wave-3B `adjudication`
 * engines. Reads the consolidated review payload from
 *   GET /claims/:id/stage-adjudication/review
 * and exposes:
 *   - evaluate():       POST /stage-adjudication/evaluate   (re-run the engine)
 *   - submitFeedback(): POST /stage-adjudication/feedback   (human-in-the-loop)
 *
 * Tolerates a missing endpoint (404 → null) so the panel can render its
 * empty state while the backend route rolls out.
 */

// ─── Layer / rule shapes (mirror the backend EvalResult + hypothesis) ────────

export type StageRuleStatus = 'PASS' | 'FAIL' | 'SKIP' | 'WARN' | 'ERROR';
export type StageRuleSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type StageRecommendedAction = 'file_now' | 'review' | 'request_doc';

/** One rule outcome — matches the backend EvalResult persisted in layer3_rules. */
export interface StageRuleResult {
  ruleId: string;
  kind: string;
  status: StageRuleStatus | string;
  severity: StageRuleSeverity | string;
  impact?: string;
  confidence?: number;
  message?: string;
  evidence?: Record<string, any>;
}

export interface StageLayer1 {
  stage?: string | null;
  present_categories?: string[];
}

export interface StageLayer2 {
  fields_by_category?: Record<string, Record<string, unknown>>;
  names?: Record<string, string> | Array<Record<string, unknown>>;
  dated_docs?: unknown;
  anchors?: unknown;
}

export interface StageLayer4 {
  readiness_score: number | null;
  blocking?: string[];
  warnings?: string[];
  errored?: string[];
  abstained?: string[];
  recommended_action?: StageRecommendedAction | string;
  rule_set?: string | null;
  /** Present when the selected set carried no deterministic (kind'd) rules. */
  no_kinded_rules?: boolean;
  applicable?: boolean;
  context?: Record<string, unknown>;
}

export interface StageHypothesis {
  stage: string;
  layer1_documents: StageLayer1 | null;
  layer2_content: StageLayer2 | null;
  layer3_rules: StageRuleResult[] | null;
  layer4_readiness: StageLayer4 | null;
  resolver_version?: string;
  updated_at?: string;
}

export interface StageContext {
  scheme?: string | null;
  route?: string | null;
  insurer_panel_id?: string | null;
  stage?: string | null;
  case_type?: string | null;
  flags?: unknown;
  resolver_version?: string | null;
}

export type StageFeedbackLayer = 'documents' | 'content' | 'rules' | 'readiness';
export type StageFeedbackVerdict = 'agree' | 'disagree' | 'correct';
export type StageFeedbackRootCause =
  | 'documents'
  | 'content'
  | 'rules'
  | 'context'
  | 'none';

export interface StageFeedbackRow {
  id: string;
  stage: string | null;
  layer: StageFeedbackLayer | string;
  target_ref: string | null;
  verdict: StageFeedbackVerdict | string;
  root_cause: StageFeedbackRootCause | string | null;
  corrected_value?: unknown;
  reviewer_id?: string | null;
  notes?: string | null;
  created_at: string;
}

export interface StageReview {
  claimId: string;
  context: StageContext | null;
  episode: {
    episode?: Record<string, any>;
    status?: string;
    confidence?: number;
    cost_inr?: number;
    generated_at?: string;
  } | null;
  documents: Array<Record<string, any>>;
  adjudication: {
    hypotheses: StageHypothesis[];
    evaluations: Array<Record<string, any>>;
  };
  feedback: StageFeedbackRow[];
}

export interface SubmitFeedbackPayload {
  stage?: string | null;
  layer: StageFeedbackLayer;
  targetRef?: string | null;
  verdict: StageFeedbackVerdict;
  rootCause?: StageFeedbackRootCause | null;
  correctedValue?: unknown;
  notes?: string | null;
}

const reviewCache = new Map<string, StageReview>();

export function useStageAdjudication(claimId: string | undefined | null) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['intelligence', 'stage-adjudication', claimId],
    enabled: !!claimId,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    queryFn: async (): Promise<StageReview | null> => {
      if (!claimId) return null;
      try {
        const res = await apiService.get(
          `/claims/${claimId}/stage-adjudication/review`,
        );
        const payload = (res.data?.data ?? res.data) as StageReview;
        if (payload) reviewCache.set(claimId, payload);
        return payload ?? null;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });

  const invalidate = () =>
    qc.invalidateQueries({
      queryKey: ['intelligence', 'stage-adjudication', claimId],
    });

  const evaluateMutation = useMutation({
    mutationFn: async () => {
      if (!claimId) throw new Error('claimId required');
      const res = await apiService.post(
        `/claims/${claimId}/stage-adjudication/evaluate`,
        {},
      );
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
  });

  const feedbackMutation = useMutation({
    mutationFn: async (payload: SubmitFeedbackPayload) => {
      if (!claimId) throw new Error('claimId required');
      const res = await apiService.post(
        `/claims/${claimId}/stage-adjudication/feedback`,
        payload,
      );
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
  });

  const data =
    query.data ?? (claimId ? reviewCache.get(claimId) ?? null : null);

  return {
    data: data as StageReview | null,
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    evaluate: () => evaluateMutation.mutateAsync(),
    isEvaluating: evaluateMutation.isPending,
    submitFeedback: (payload: SubmitFeedbackPayload) =>
      feedbackMutation.mutateAsync(payload),
    isSubmittingFeedback: feedbackMutation.isPending,
  };
}

export default useStageAdjudication;
