import { useMutation, useQueryClient } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Step 1 — Per-field correction on a section's extracted_fields.
 *
 * Sibling to useDocumentCategoryCorrection. Targets the new
 * `POST /document-sections/:sectionId/fields/:fieldKey` endpoint, which
 * writes to `document_section_corrections` (action='edit_fields') +
 * `ai_corrections` (surface='extracted_field') so Wave-10's KB miner
 * picks up field-level correction patterns.
 *
 * The backend marks the field as human-corrected via a reserved
 * `_corrected_fields` list inside extraction_confidence; the extractor's
 * persist step honours that list and won't overwrite the value on a
 * forced re-run.
 */

export interface ExtractedFieldCorrectionPayload {
  sectionId: string;
  fieldKey: string;
  /**
   * The new value. Pass `null` to CLEAR the field (removes the key from
   * extracted_fields and also removes it from the corrected list so a
   * future re-run can re-attempt).
   */
  new_value: unknown;
  reason?: string;
}

export function useExtractedFieldCorrection() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (payload: ExtractedFieldCorrectionPayload) => {
      try {
        const res = await apiService.post(
          `/document-sections/${payload.sectionId}/fields/${encodeURIComponent(payload.fieldKey)}`,
          {
            new_value: payload.new_value,
            reason: payload.reason ?? '',
          },
        );
        return res.data?.data ?? res.data;
      } catch (e: any) {
        const status = e?.response?.status;
        if (status === 404 || status === 501) {
          console.warn(
            `[useExtractedFieldCorrection] backend endpoint not live (status=${status}). ` +
              `Section ${payload.sectionId} field ${payload.fieldKey} not persisted.`,
          );
          return { ok: false, persisted: false };
        }
        throw e;
      }
    },
    onSuccess: () => {
      // Same invalidation surface as the category-correction hook —
      // the section listing carries extracted_fields inline now
      // (intelligenceStatus.controller#getSections), so refreshing
      // 'claim-sections' is what updates the table + JSON viewer.
      qc.invalidateQueries({ queryKey: ['intelligence', 'document-sections'] });
      qc.invalidateQueries({ queryKey: ['intelligence', 'claim-dossier'] });
      qc.invalidateQueries({ queryKey: ['intelligence', 'claim-sections'] });
      qc.invalidateQueries({ queryKey: ['intelligence', 'status'] });
    },
  });
}

export default useExtractedFieldCorrection;
