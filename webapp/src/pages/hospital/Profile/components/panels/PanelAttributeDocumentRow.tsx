import React from 'react';
import { Button } from '@/components/ui/button';
import { FileText, Eye, Star, Trash2 } from 'lucide-react';
import ApiService from '@/services/api';
import type { PanelAttributeDocument } from './types';

interface PanelAttributeDocumentRowProps {
  doc: PanelAttributeDocument;
  hospitalId: string;
  onPreview: (doc: PanelAttributeDocument) => void;
  /** If provided, renders a Remove (red trash) button. Used by the Edit dialog. */
  onRemove?: (docId: string) => void;
  /** If provided, renders a Download button. Used by the read-only list view. */
  enableDownload?: boolean;
  onError?: (message: string) => void;
}

/**
 * Single document row inside a panel attribute. Used by:
 *  - the read-only list (with Download)
 *  - the Edit dialog (with Remove)
 *
 * Extracted from PanelsManager.tsx during the M14 split.
 */
export function PanelAttributeDocumentRow({
  doc,
  hospitalId,
  onPreview,
  onRemove,
  enableDownload,
  onError,
}: PanelAttributeDocumentRowProps) {
  const handleDownload = async () => {
    try {
      const response = await ApiService.downloadDocument(
        hospitalId,
        doc.documentId,
      );
      const blob = new Blob([response.data], { type: doc.mimeType });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', doc.fileName);
      document.body.appendChild(link);
      link.click();
      window.URL.revokeObjectURL(url);
      link.remove();
    } catch (err) {
      console.error('Failed to download document:', err);
      onError?.('Failed to download document');
    }
  };

  return (
    <div className="flex items-center justify-between p-2 bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {doc.isPrimary && (
          <span title="Primary document">
            <Star className="h-4 w-4 fill-yellow-400 text-yellow-400 flex-shrink-0" />
          </span>
        )}
        <FileText className="h-4 w-4 text-slate-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{doc.fileName}</p>
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        onClick={() => onPreview(doc)}
        title="Preview document"
      >
        <Eye className="h-4 w-4" />
      </Button>
      {enableDownload && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={handleDownload}
          title="Download document"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
        </Button>
      )}
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={() => onRemove(doc.id)}
          title="Remove document from this attribute"
        >
          <Trash2 className="h-4 w-4 text-red-500" />
        </Button>
      )}
    </div>
  );
}
