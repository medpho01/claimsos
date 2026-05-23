import { useCallback, useEffect, useState } from 'react';
import ApiService from '@/services/api';
import type {
  Panel,
  PanelAttribute,
} from '@/pages/hospital/Profile/components/panels/types';

/**
 * Hook: load and refresh a single panel's attributes (with linked documents).
 *
 * Background — fixes FE H12 (duplicated N+1 fan-out):
 * Previously PanelsManager.tsx had two near-identical code paths (the initial
 * load `useEffect` and `refreshPanelAttributes()`) that:
 *   1. Fetched attributes for the panel
 *   2. For each attribute lacking `documents[]` but having `document_id`,
 *      fired an extra `getDocument()` call (legacy/backward-compat fan-out)
 *
 * Both copies have been folded into the single `fetchWithLegacyDocs` helper
 * below. Change here, change everywhere.
 */
export function usePanelAttributes(
  hospitalId: string,
  selectedPanel: Panel | null,
) {
  const [attributes, setAttributes] = useState<PanelAttribute[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchWithLegacyDocs = useCallback(
    async (panel: Panel): Promise<PanelAttribute[]> => {
      const actualPanelId =
        panel.panelId || (panel as any).panel_id;
      if (!actualPanelId) {
        throw new Error('Panel ID not found');
      }

      const res = await ApiService.getPanelAttributes(hospitalId, actualPanelId);
      const raw: any[] = res.data.data || [];

      // For each attribute: prefer backend-provided `documents[]`, otherwise
      // fall back to fetching the single legacy `document_id`.
      return Promise.all(
        raw.map(async (attr: any) => {
          if (attr.documents && Array.isArray(attr.documents)) {
            return attr;
          }
          if (attr.data_type === 'file' && attr.document_id) {
            try {
              const docResponse = await ApiService.getDocument(
                hospitalId,
                attr.document_id,
              );
              const docData = docResponse.data.data || docResponse.data;
              return {
                ...attr,
                documents: [
                  {
                    id: attr.document_id,
                    documentId: attr.document_id,
                    fileName:
                      docData.file_name || docData.fileName || 'Document',
                    fileSize:
                      docData.file_size_bytes || docData.fileSize || 0,
                    mimeType:
                      docData.mime_type ||
                      docData.mimeType ||
                      'application/octet-stream',
                    uploadedAt:
                      docData.created_at ||
                      docData.uploadedAt ||
                      new Date().toISOString(),
                    isPrimary: true,
                  },
                ],
              };
            } catch (err) {
              console.error(
                'Failed to fetch document for attribute:',
                attr.id,
                err,
              );
              return attr;
            }
          }
          return attr;
        }),
      );
    },
    [hospitalId],
  );

  const refresh = useCallback(async () => {
    if (!selectedPanel) return;
    try {
      setError(null);
      const result = await fetchWithLegacyDocs(selectedPanel);
      setAttributes(result);
    } catch (err: any) {
      console.error('Error refreshing panel attributes:', err);
      const message =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        'Failed to refresh attributes';
      setError(message);
    }
  }, [selectedPanel, fetchWithLegacyDocs]);

  // Initial / panel-switch load. Tracks `selectedPanel?.id` so reselecting
  // the same panel after refresh is a no-op.
  useEffect(() => {
    if (!selectedPanel) {
      setAttributes([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        const result = await fetchWithLegacyDocs(selectedPanel);
        if (!cancelled) setAttributes(result);
      } catch (err: any) {
        console.error('Error loading panel data:', err);
        const message =
          err?.response?.data?.error ||
          err?.response?.data?.message ||
          'Failed to load panel attributes';
        if (!cancelled) {
          setError(
            message.includes('not found')
              ? 'Panel relationship not found. This panel may not be properly linked to this hospital.'
              : message,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPanel?.id, hospitalId]);

  return { attributes, error, setError, refresh };
}
