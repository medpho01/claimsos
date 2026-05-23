import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Wave 9 — FE Claim AI Summary.
 *
 * Hydrates the canonical `medical_episode.v2` harmonised payload for one
 * claim. The backend route may not exist yet — 404 → null so the panels
 * can render an "Not yet harmonised" empty state without throwing.
 *
 * Types below intentionally cover *only* the keys the UI renders directly
 * (top-level sections + a few well-known leaves). Everything else is
 * passed through as `Record<string, any>` so we don't have to keep the
 * type model in lockstep with the canonical schema during evolution.
 */

// ─── Inline canonical types (UI-driven shape) ─────────────────────────────

export interface HarmonisedProvenance {
  /** Source document_section.id (FK into document_sections). */
  section_id?: string;
  /** Human-readable hint of the section ("Discharge Summary p.2"). */
  section_label?: string;
  /** 0..1 confidence of the extraction that produced this field. */
  confidence?: number;
  /** Provider/model that produced the value (audit-trail hook companion). */
  llm_provider?: string;
  llm_model?: string;
  prompt_version?: string;
}

export interface HarmonisedMeta {
  schema_version?: string;
  episode_id?: string;
  episode_type?: string;
  episode_subtype?: string;
  episode_category?: string;
  treatment_intent?: string;
  created_at?: string;
  last_updated_at?: string;
  data_completeness_score?: number;
  verification_status?: string;
  source_system?: Record<string, any>;
}

export interface HarmonisedPatientContext {
  patient_id?: string;
  uhid?: string;
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  age?: number;
  age_unit?: string;
  date_of_birth?: string;
  gender?: string;
  blood_group?: string;
  contact?: Record<string, any>;
  address?: Record<string, any>;
  [key: string]: any;
}

export interface HarmonisedHospitalContext {
  hospital_id?: string;
  hospital_registration_id?: string;
  ipd_number?: string;
  name?: string;
  type?: string;
  specialties?: string[];
  accreditation?: Record<string, any>;
  treating_team?: Record<string, any>;
  [key: string]: any;
}

export interface HarmonisedInsuranceContext {
  policy_number?: string;
  insurer_name?: string;
  insurer_code?: string;
  insurer_tpa?: string;
  tpa_code?: string;
  policy_type?: string;
  scheme_name?: string;
  sum_insured?: { amount?: number; currency?: string };
  copay_percentage?: number;
  policy_start_date?: string;
  policy_end_date?: string;
  pre_authorization?: Record<string, any>;
  [key: string]: any;
}

export interface HarmonisedTimelinePhase {
  phase_code: string;
  phase_number?: number;
  phase_name?: string;
  location?: string;
  start_datetime?: string;
  end_datetime?: string;
  duration?: { value?: number; unit?: string };
  presentation?: Record<string, any>;
  admission_details?: Record<string, any>;
  clinical_assessment?: Record<string, any>;
  interventions?: any[];
  diagnostics_ordered?: any[];
  diagnostics_performed?: any[];
  procedures_performed?: any[];
  daily_progress?: any[];
  outcome?: Record<string, any>;
  [key: string]: any;
}

export interface HarmonisedDiagnosis {
  primary_diagnosis?: {
    icd_code?: string;
    diagnosis_name?: string;
    certainty?: string;
    diagnosis_date?: string;
    [key: string]: any;
  };
  secondary_diagnosis?: any[];
  complications?: any[];
  comorbidities?: any[];
  pre_existing_diseases?: any[];
  [key: string]: any;
}

export interface HarmonisedStaySummary {
  admission_datetime?: string;
  discharge_datetime?: string;
  total_los?: { value?: number; unit?: string };
  breakdown?: any[];
  los_benchmark?: Record<string, any>;
  [key: string]: any;
}

export interface HarmonisedFinancialSummary {
  currency?: string;
  estimated_total_cost?: number;
  actual_total_cost?: number;
  breakdown?: Record<string, any>;
  package_details?: Record<string, any>;
  insurance_coverage?: Record<string, any>;
  payment_details?: Record<string, any>;
  [key: string]: any;
}

export interface HarmonisedDischargeSummary {
  discharge_date?: string;
  discharge_time?: string;
  discharge_type?: string;
  discharge_condition?: string;
  final_diagnosis?: string[];
  procedures_performed_summary?: string[];
  course_in_hospital?: string;
  condition_at_discharge?: string;
  discharge_medications?: any[];
  follow_up_instructions?: string[];
  [key: string]: any;
}

/**
 * The harmonised payload. `_provenance` is a parallel object that maps
 * a JSON pointer/path string ("/diagnosis/primary_diagnosis/icd_code") to
 * the provenance record for that field. The backend may not always send
 * this map — UI degrades gracefully when entries are absent.
 */
export interface HarmonisedEpisode {
  meta?: HarmonisedMeta;
  patient_context?: HarmonisedPatientContext;
  hospital_context?: HarmonisedHospitalContext;
  insurance_context?: HarmonisedInsuranceContext;
  clinical_timeline?: HarmonisedTimelinePhase[];
  diagnosis?: HarmonisedDiagnosis;
  stay_summary?: HarmonisedStaySummary;
  financial_summary?: HarmonisedFinancialSummary;
  discharge_summary?: HarmonisedDischargeSummary;
  documents?: Record<string, any>;
  validation_metadata?: Record<string, any>;
  claim_processing_metadata?: Record<string, any>;
  audit_trail?: any[];
  /** Parallel provenance map, keyed by json_path. */
  _provenance?: Record<string, HarmonisedProvenance>;
  /** Anything else the backend wants to ship — pass-through. */
  [key: string]: any;
}

export interface CorrectionPayload {
  /** json_path-style location of the field being corrected. */
  json_path: string;
  /** The value the human is asserting. */
  human_value: any;
  /** Optional free-text reason for audit. */
  reason?: string;
}

const episodeCache = new Map<string, HarmonisedEpisode>();

export function useHarmonisedEpisode(claimId: string | undefined | null) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['intelligence', 'harmonised-episode', claimId],
    enabled: !!claimId,
    // staleTime=0 (revised May 20, 2026): the harmonised episode is
    // re-generated every time the AI pipeline runs for the claim. The
    // previous 5-minute staleTime cached pre-run state and showed
    // outdated harmonised JSON (or none at all) after the user
    // triggered a re-run — same family of bug that hit useClaimSections.
    // See useClaimSections.ts for the full rationale.
    staleTime: 0,
    refetchOnMount: 'always',
    gcTime: 30 * 60_000,
    queryFn: async (): Promise<HarmonisedEpisode | null> => {
      if (!claimId) return null;
      try {
        const res = await apiService.get(`/claims/${claimId}/harmonised`);
        // Backend wrapper shape: { success, data: row, message }
        // where `row` is the claim_harmonised_episodes table row:
        // { claim_id, episode (JSONB!), provenance, confidence, cost_inr,
        //   tokens_used, llm_model, status, generated_at, ... }
        //
        // The actual canonical episode lives at row.episode. We unwrap +
        // merge it with select metadata fields so consumers can read both
        // `patient_context` directly AND `_meta.cost_inr` / `_provenance`
        // when they want them.
        const rawData = res.data?.data ?? res.data;
        if (!rawData) return null;
        const episode = rawData?.episode ?? rawData;
        const payload: HarmonisedEpisode = {
          ...episode,
          _provenance: rawData?.provenance ?? episode?._provenance,
          _meta: {
            status: rawData?.status,
            confidence: rawData?.confidence,
            cost_inr: rawData?.cost_inr,
            tokens_used: rawData?.tokens_used,
            llm_provider: rawData?.llm_provider,
            llm_model: rawData?.llm_model,
            prompt_version: rawData?.prompt_version,
            schema_version: rawData?.schema_version,
            generated_at: rawData?.generated_at,
            last_corrected_at: rawData?.last_corrected_at,
            error_message: rawData?.error_message,
          },
        } as HarmonisedEpisode;
        episodeCache.set(claimId, payload);
        return payload;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['intelligence', 'harmonised-episode', claimId] });

  const correctionMutation = useMutation({
    mutationFn: async (payload: CorrectionPayload) => {
      if (!claimId) throw new Error('claimId required');
      const res = await apiService.post(
        `/claims/${claimId}/harmonised/corrections`,
        payload,
      );
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
  });

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      if (!claimId) throw new Error('claimId required');
      const res = await apiService.post(`/claims/${claimId}/harmonised/regenerate`, {});
      return res.data?.data ?? res.data;
    },
    onSuccess: invalidate,
  });

  return {
    data:
      (query.data ?? (claimId ? episodeCache.get(claimId) ?? null : null)) as
        | HarmonisedEpisode
        | null,
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    applyCorrection: (payload: CorrectionPayload) => correctionMutation.mutateAsync(payload),
    regenerate: () => regenerateMutation.mutateAsync(),
    isApplyingCorrection: correctionMutation.isPending,
    isRegenerating: regenerateMutation.isPending,
  };
}

export default useHarmonisedEpisode;
