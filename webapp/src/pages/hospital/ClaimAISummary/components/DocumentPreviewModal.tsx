import React, { useEffect, useState } from 'react';
import { Loader2, ExternalLink, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { getBackendOrigin } from '@/services/api';

/**
 * Wave 9 — Document preview modal for the Claim AI Summary page.
 *
 * The Documents panel synthesises section rows from the dossier's
 * `doc_sections_by_category` map but doesn't give the reviewer a way
 * to *see* the source PDF/image before deciding whether the classifier
 * called it right. This modal closes that loop:
 *
 *   1. Hit `/api/v2/uploads/proxy/:fileId` (auth via bearer token).
 *   2. Convert the response to a blob → object URL.
 *   3. Render PDFs in an <iframe>, images in an <img>.
 *
 * Falls back to a "Download" CTA when the mime type isn't browser-
 * previewable.
 */
export interface DocumentPreviewModalProps {
  open: boolean;
  documentId: string | null;
  fileName?: string;
  /** Highlight a particular section (page range / category) when known. */
  pageHint?: string;
  category?: string;
  onClose: () => void;
}

export const DocumentPreviewModal: React.FC<DocumentPreviewModalProps> = ({
  open,
  documentId,
  fileName,
  pageHint,
  category,
  onClose,
}) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !documentId) return;
    let revoked = false;
    let currentUrl: string | null = null;
    setLoading(true);
    setError(null);
    setBlobUrl(null);
    setMimeType(null);

    const token = localStorage.getItem('accessToken');
    const url = `${getBackendOrigin()}/api/v2/uploads/proxy/${documentId}`;

    fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? 'Source file not found in storage.'
              : `Failed to load (HTTP ${res.status}).`,
          );
        }
        const ct = res.headers.get('Content-Type') ?? 'application/octet-stream';
        const blob = await res.blob();
        if (revoked) return;
        const objectUrl = URL.createObjectURL(blob);
        currentUrl = objectUrl;
        setMimeType(ct);
        setBlobUrl(objectUrl);
        setLoading(false);
      })
      .catch((err) => {
        if (revoked) return;
        setError(err?.message ?? 'Failed to load preview');
        setLoading(false);
      });

    return () => {
      revoked = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [open, documentId]);

  const isPdf = mimeType?.includes('pdf');
  const isImage = mimeType?.startsWith('image/');

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-5xl w-[95vw] h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <DialogTitle className="text-base">
            {fileName ?? 'Source document'}
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            {category ? `Category: ${category}` : null}
            {category && pageHint ? ' · ' : null}
            {pageHint ? `Pages ${pageHint}` : null}
            {!category && !pageHint ? 'Original uploaded file' : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 bg-slate-50 dark:bg-slate-950">
          {loading && (
            <div className="h-full flex items-center justify-center text-sm text-slate-500">
              <Loader2 className="size-4 mr-2 animate-spin" />
              Loading preview…
            </div>
          )}
          {error && !loading && (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
              <AlertTriangle className="size-6 text-amber-500" />
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                Preview unavailable
              </div>
              <div className="text-xs text-slate-500">{error}</div>
            </div>
          )}
          {blobUrl && !loading && !error && isPdf && (
            <iframe
              // PDF URL-fragment standard (Adobe "Open Parameters"): browsers'
              // built-in PDF viewer respects `#page=N` and seeks to that
              // page on load. When the caller passed a `pageHint` like
              // "2" or "2–3", we extract the first integer and pre-position
              // the viewer there. Without this, multi-document bundles
              // always opened at page 1 even when the section under review
              // was on page 4.
              src={pdfSrcWithPage(blobUrl, pageHint)}
              title={fileName ?? 'document preview'}
              className="w-full h-full border-0"
            />
          )}
          {blobUrl && !loading && !error && isImage && (
            <div className="w-full h-full overflow-auto flex items-center justify-center p-4">
              <img
                src={blobUrl}
                alt={fileName ?? 'document preview'}
                className="max-w-full max-h-full object-contain"
              />
            </div>
          )}
          {blobUrl && !loading && !error && !isPdf && !isImage && (
            <div className="h-full flex flex-col items-center justify-center gap-3">
              <div className="text-sm text-slate-600 dark:text-slate-300">
                This file type ({mimeType ?? 'unknown'}) can&apos;t be previewed inline.
              </div>
              <a
                href={blobUrl}
                download={fileName ?? 'document'}
                className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
              >
                <ExternalLink className="size-3.5" />
                Download to view
              </a>
            </div>
          )}
        </div>

        <DialogFooter className="px-6 py-3 border-t border-slate-200 dark:border-slate-800">
          {blobUrl && (
            <a
              href={blobUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-50"
            >
              <ExternalLink className="size-3.5" />
              Open in new tab
            </a>
          )}
          <Button variant="outline" size="sm" onClick={onClose} className="ml-auto">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Build the PDF iframe src, optionally appending the `#page=N` fragment so
 * Chrome / Edge / Safari built-in PDF viewers seek to that page on load.
 *
 * `pageHint` formats handled: "4", "2-3", "2–3" (en-dash), undefined.
 * The fragment is appended verbatim — if pageHint already contains `#page=`
 * (defensive), we don't double-prepend.
 */
function pdfSrcWithPage(blobUrl: string, pageHint?: string): string {
  if (!pageHint) return blobUrl;
  const firstInt = String(pageHint).match(/\d+/)?.[0];
  if (!firstInt) return blobUrl;
  // Object URLs from createObjectURL look like `blob:http://...UUID` and
  // accept `#page=N` like any URL.
  return `${blobUrl}#page=${firstInt}`;
}

export default DocumentPreviewModal;
