import { useQuery } from '@tanstack/react-query';
import apiService from '@/services/api';

/**
 * Sprint W1-C — FE Hooks Foundation.
 *
 * Page-level sections discovered inside a single document by the OCR +
 * classifier pipeline (Wave 0). Sections rarely change once a doc has
 * been processed, so cache aggressively (10min gc / 1min stale).
 */

export type DocumentSectionStatus =
  | 'pending'
  | 'classified'
  | 'reviewed'
  | 'rejected';

export interface DocumentSection {
  id: string;
  document_id: string;
  page_start: number;
  page_end: number;
  category: string;
  classification_confidence: number;
  extracted_fields: Record<string, any>;
  status: DocumentSectionStatus;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
}

const sectionsCache = new Map<string, DocumentSection[]>();

export function useDocumentSections(documentId: string | undefined | null) {
  const query = useQuery({
    queryKey: ['intelligence', 'document-sections', documentId],
    enabled: !!documentId,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    queryFn: async (): Promise<DocumentSection[]> => {
      if (!documentId) return [];
      try {
        const res = await apiService.get(`/documents/${documentId}/sections`);
        const rows = (res.data?.data ?? res.data ?? []) as DocumentSection[];
        const list = Array.isArray(rows) ? rows : [];
        sectionsCache.set(documentId, list);
        return list;
      } catch (e: any) {
        if (e?.response?.status === 404) return [];
        throw e;
      }
    },
  });

  return {
    data: (query.data ?? (documentId ? sectionsCache.get(documentId) ?? [] : [])) as DocumentSection[],
    loading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
