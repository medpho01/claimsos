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
      // Invalidate sections lists — we don't know which document this
      // section belongs to from the payload, so invalidate broadly.
      qc.invalidateQueries({ queryKey: ['intelligence', 'document-sections'] });
      qc.invalidateQueries({ queryKey: ['intelligence', 'claim-dossier'] });
      // Hint for downstream — variables consumed by the optimistic path.
      void variables;
    },
  });
}

export default useDocumentCategoryCorrection;
