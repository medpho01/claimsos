import { useMutation, useQueryClient } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Wave 9 — FE Claim AI Summary.
 *
 * Mutation hook for the per-section category correction action in the
 * Documents panel. The backend route is not live yet — on 404/501 we
 * log a console.warn so the UI doesn't blow up; the optimistic UX still
 * happens but the server change is a no-op.
 */

export interface DocumentCategoryCorrectionPayload {
  sectionId: string;
  new_category: string;
  reason?: string;
}

export function useDocumentCategoryCorrection() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (payload: DocumentCategoryCorrectionPayload) => {
      try {
        const res = await apiService.post(
          `/document-sections/${payload.sectionId}/category`,
          {
            new_category: payload.new_category,
            reason: payload.reason ?? '',
          },
        );
        return res.data?.data ?? res.data;
      } catch (e: any) {
        const status = e?.response?.status;
        if (status === 404 || status === 501) {
          // Endpoint not yet implemented — degrade quietly.

          console.warn(
            `[useDocumentCategoryCorrection] backend endpoint not live (status=${status}). ` +
              `Section ${payload.sectionId} category change to "${payload.new_category}" was not persisted.`,
          );
          return { ok: false, persisted: false };
        }
        throw e;
      }
    },
    onSuccess: (_data, variables) => {
      // Invalidate every cached view that derives from document_sections:
      // - 'document-sections'  → per-document expand-row JSON view
      // - 'claim-dossier'      → dossier carries doc_sections_by_category
      // - 'claim-sections'     → Wave-9 listing joined to ipd_doc; THIS is
      //   what drives the Documents-panel table rows. Without invalidating
      //   it, the table keeps showing the pre-correction category for up
      //   to 5 minutes (staleTime) → looks like the save didn't take.
      // - 'intelligence', 'status' → counters change when status flips to
      //   'corrected' on a previously-pending section
      qc.invalidateQueries({ queryKey: ['intelligence', 'document-sections'] });
      qc.invalidateQueries({ queryKey: ['intelligence', 'claim-dossier'] });
      qc.invalidateQueries({ queryKey: ['intelligence', 'claim-sections'] });
      qc.invalidateQueries({ queryKey: ['intelligence', 'status'] });
      // Hint for downstream — variables consumed by the optimistic path.
      void variables;
    },
  });
}

export default useDocumentCategoryCorrection;
