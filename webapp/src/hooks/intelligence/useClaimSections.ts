import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Wave 9 — section listing for a claim, joined to ipd_doc so the FE can
 * resolve `section_id → document_id (ipd_doc.id) + file_name + mime_type`.
 *
 * The dossier projector stores `doc_sections_by_category` as
 * `{ category: [section_id, ...] }` — bare section ids only. That's
 * sufficient for the rules engine but useless for "preview the source
 * PDF/image" because the proxy endpoint takes ipd_doc.id, not the
 * section row id. This hook closes that gap.
 *
 * Cached aggressively (5 min stale / 15 min gc) — sections only change
 * when the segmenter/classifier re-runs.
 */

export interface ClaimSection {
  id: string;
  document_id: string | null;
  page_start: number | null;
  page_end: number | null;
  category: string | null;
  classification_confidence: number | null;
  status: string;
  extractor_model: string | null;
  extracted_fields_present: boolean;
  /** Full extracted_fields JSON. May be {} when extractor_model='no_schema'
   *  (no field schema for the category) or null when extraction hasn't run. */
  extracted_fields: Record<string, any> | null;
  /**
   * Per-field confidence map. May also carry a reserved `_validation_errors`
   * key (e.g. { aadhaar_number: "verhoeff_failed" }) inserted by the
   * post-extraction validator when a field failed its deterministic
   * invariant. Down-weighted confidence (≤0.3) on a field paired with an
   * entry here means "the LLM was confident but the checksum/format check
   * disagreed — human should verify".
   */
  extraction_confidence: Record<string, any> | null;
  file_name: string | null;
  mime_type: string | null;
  /**
   * Dedup metadata (Wave 12 layers 4 + 5). When set, this section is a
   * duplicate of another section in the same claim — its
   * extracted_fields are projected from the canonical and it should be
   * hidden from the main Documents tab. The "X duplicates identified"
   * header in DocumentsPanel uses these to drive the count.
   *   section_dedup_of    = canonical section's id
   *   section_dedup_method = 'text_exact' | 'phash_v1' | 'manual'
   *   doc_dedup_of        = the parent ipd_doc was marked as a whole-file duplicate
   */
  section_dedup_of?: string | null;
  section_dedup_method?: string | null;
  doc_dedup_of?: string | null;
  doc_dedup_method?: string | null;
}

export function useClaimSections(claimId: string | undefined | null) {
  const query = useQuery({
    queryKey: ['intelligence', 'claim-sections', claimId],
    enabled: !!claimId,
    // staleTime=0 (revised May 20, 2026): sections change every time the
    // bundle classifier finishes ANY of the claim's documents, which can
    // happen anywhere from seconds to minutes after a user navigates to a
    // patient. The previous 5-minute staleTime cached old (often empty)
    // section lists and caused two distinct user-visible bugs:
    //   - Kilpa Devi: user visited the patient before docs were uploaded,
    //     uploaded + ran AI later, came back to AI Summary and saw an
    //     empty "No documents uploaded yet" because RQ refused to refetch
    //     within the stale window.
    //   - Mohd Aslam: post-completion the table flickered between the
    //     dossier-fallback synthesized rows and the real /sections data
    //     because /sections never refreshed within the stale window.
    // With staleTime=0 + refetchOnMount='always', every navigation to the
    // AI Summary tab pulls a fresh section list. Cost: ~50ms per mount.
    // The dossier projector + harmoniser are the heavy data sources;
    // /sections is a single indexed query + LEFT JOIN, trivially cheap.
    staleTime: 0,
    refetchOnMount: 'always',
    gcTime: 15 * 60_000,
    queryFn: async (): Promise<ClaimSection[]> => {
      if (!claimId) return [];
      try {
        const res = await apiService.get(
          `/claims/${claimId}/intelligence/sections`,
        );
        const rows = res.data?.data ?? res.data ?? [];
        return Array.isArray(rows) ? rows : [];
      } catch (e: any) {
        if (e?.response?.status === 404) return [];
        throw e;
      }
    },
  });

  return {
    data: (query.data ?? []) as ClaimSection[],
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

export default useClaimSections;
