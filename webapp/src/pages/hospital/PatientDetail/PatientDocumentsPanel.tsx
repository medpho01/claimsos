import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload,
  File as FileIcon,
  Loader,
  ImageOff,
  Download,
  Trash2,
  FileText,
  CheckSquare,
  X,
  Check,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import imageCompression from 'browser-image-compression';
import { Document, Page, pdfjs } from 'react-pdf';
import { Patient } from '@/types';
import { usePhotosData } from '@/components/modals/PatientPhotosModal/hooks/usePhotosData';
import { DriveFile } from '@/components/modals/PatientPhotosModal/types';
import { generateSmallPDF } from '@/services/pdfGenerator';
import apiService from '@/services/api';
import { toast } from 'sonner';
import { useConfirm } from '@/lib/confirm';

// Configure pdf.js worker once. Mirrors the legacy Lightbox setup so
// thumbnails and the inline preview viewer share the same worker.
if (typeof window !== 'undefined' && !(pdfjs.GlobalWorkerOptions as any).workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
}

/**
 * Resolve the auth-protected proxy URL against the running backend.
 * - Production: same origin, proxyLink is already absolute-from-root (/api/v2/...).
 * - Development: backend container is exposed on the same hostname at port 6001.
 *   Earlier code hardcoded localhost:8000 (the IN-container port) which is
 *   not reachable from the browser.
 */
function resolveProxyUrl(proxyLink: string): string {
  if (process.env.NODE_ENV === 'production') return proxyLink;
  const protocol = window.location.protocol;
  const hostname = window.location.hostname;
  return `${protocol}//${hostname}:6001${proxyLink}`;
}

/**
 * UI Revamp — inline patient documents panel for the Patient Detail Documents tab.
 *
 * Replaces the popup-based PatientPhotosModal flow with a wireframe-aligned
 * inline view:
 *   - Header: category pills (Admission Files / Discharge Slip / Investigations /
 *     Treatment / ICPs / Others) with file counts.
 *   - Right side: prominent "Upload documents" CTA with hidden multi-file input.
 *   - Grid of thumbnails (images) or file tiles (PDFs / other). Click opens
 *     the file in a new tab. Hover shows a quick remove.
 *
 * Data flows through the existing usePhotosData hook so the cache shared with
 * the legacy modal is unified.
 */
interface PatientDocumentsPanelProps {
  patient: Patient;
}

const isImage = (file: DriveFile) =>
  (file.mimeType || '').startsWith('image/') ||
  /\.(jpg|jpeg|png|gif|webp|heic|bmp)$/i.test(file.name || '');

const PatientDocumentsPanel: React.FC<PatientDocumentsPanelProps> = ({ patient }) => {
  const confirm = useConfirm();
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Selection / bulk-action state
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | 'download' | 'pdf' | 'delete'>(null);

  // Preview state — when a tile is clicked outside select mode
  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null);

  const { photosData, loading, error, fetchPhotos, deleteFiles } = usePhotosData(
    patient.id,
    patient.admission_type
  );

  useEffect(() => {
    fetchPhotos();
  }, [fetchPhotos]);

  // Drop selection when leaving a category
  useEffect(() => {
    setSelectedIds(new Set());
  }, [activeCategory]);

  const categories = useMemo(() => {
    const root = photosData?.rootPhotos || [];
    const cats = photosData?.categories || [];
    return [
      { id: 'all', label: 'Admission Files', count: root.length, photos: root },
      ...cats.map((c) => ({
        id: c.id,
        label: c.displayName,
        count: c.photos.length,
        photos: c.photos,
      })),
    ];
  }, [photosData]);

  const activePhotos = useMemo(
    () => categories.find((c) => c.id === activeCategory)?.photos || [],
    [categories, activeCategory]
  );

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(activePhotos.map((p) => p.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setIsSelectMode(false);
  };

  /** Download a single file via the proxy. Images are re-compressed to JPEG
   *  (matches legacy behaviour); PDFs are downloaded as-is. */
  const downloadOne = async (file: DriveFile) => {
    if (!file.proxyLink) {
      toast.error('No download URL available.');
      return;
    }
    const url = resolveProxyUrl(file.proxyLink);
    const token = localStorage.getItem('accessToken');
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();

    let downloadUrl = '';
    let fileName = file.name?.split('/').pop() || file.name || 'document';

    if (file.mimeType?.startsWith('image/') && file.mimeType !== 'application/pdf') {
      // Compress to a reasonable size, mirror legacy modal
      const imageFile = new File([blob], fileName, { type: file.mimeType });
      const compressed = await imageCompression(imageFile, {
        maxSizeMB: 1,
        maxWidthOrHeight: 1400,
        useWebWorker: true,
        fileType: 'image/jpeg',
      });
      downloadUrl = await imageCompression.getDataUrlFromFile(compressed);
      fileName = fileName.split('.')[0] + '.jpeg';
    } else {
      downloadUrl = URL.createObjectURL(blob);
      if (file.mimeType === 'application/pdf' && !/\.pdf$/i.test(fileName)) {
        fileName += '.pdf';
      }
    }
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (downloadUrl.startsWith('blob:')) URL.revokeObjectURL(downloadUrl);
  };

  const handleBulkDownload = async () => {
    const selected = activePhotos.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0) return;
    setBusy('download');
    try {
      for (const photo of selected) {
        // eslint-disable-next-line no-await-in-loop
        await downloadOne(photo);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
      }
      toast.success(`Downloaded ${selected.length} file${selected.length === 1 ? '' : 's'}.`);
    } catch (err: any) {
      toast.error(err?.message || 'Download failed.');
    } finally {
      setBusy(null);
    }
  };

  const handleGeneratePDF = async () => {
    const selected = activePhotos.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0) return;
    setBusy('pdf');
    try {
      await generateSmallPDF(selected, patient.first_name);
      toast.success(`PDF generated from ${selected.length} file${selected.length === 1 ? '' : 's'}.`);
    } catch (err: any) {
      toast.error(err?.message || 'PDF generation failed.');
    } finally {
      setBusy(null);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!(await confirm({
      title: `Delete ${selectedIds.size} file${selectedIds.size === 1 ? '' : 's'}?`,
      message: 'This cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    }))) return;
    setBusy('delete');
    try {
      await deleteFiles(Array.from(selectedIds));
      toast.success('Deleted.');
      clearSelection();
    } catch (err: any) {
      toast.error(err?.message || 'Delete failed.');
    } finally {
      setBusy(null);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      await apiService.uploadPhotosV2(
        patient.id,
        Array.from(files),
        activeCategory !== 'all' ? activeCategory : undefined
      );
      await fetchPhotos(true);
      toast.success(
        `${files.length} document${files.length === 1 ? '' : 's'} uploaded.`
      );
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const allSelected =
    activePhotos.length > 0 && activePhotos.every((p) => selectedIds.has(p.id));

  return (
    <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
      {/* Header: category pills + Upload CTA + Select toggle */}
      <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveCategory(c.id)}
              className={
                `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ` +
                (activeCategory === c.id
                  ? 'bg-brand-700 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700')
              }
            >
              {c.label}
              <span
                className={
                  `text-[10px] font-semibold rounded-full px-1.5 py-0.5 ` +
                  (activeCategory === c.id
                    ? 'bg-white/20 text-white'
                    : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300')
                }
              >
                {c.count}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {activePhotos.length > 0 && (
            <button
              onClick={() => {
                setIsSelectMode((v) => !v);
                setSelectedIds(new Set());
              }}
              className={
                `h-9 px-3 inline-flex items-center gap-2 rounded-md text-sm font-medium border transition-colors ` +
                (isSelectMode
                  ? 'border-brand-600 text-brand-700 bg-brand-50 dark:bg-brand-700/20 dark:text-brand-50'
                  : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800')
              }
            >
              <CheckSquare className="h-3.5 w-3.5" />
              {isSelectMode ? 'Done' : 'Select'}
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="h-9 px-3 inline-flex items-center gap-2 rounded-md bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-60"
          >
            {uploading ? <Loader className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {uploading ? 'Uploading…' : 'Upload documents'}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {/* Selection action bar */}
      {isSelectMode && (
        <div className="px-5 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-brand-50 dark:bg-brand-700/10 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={allSelected ? clearSelection : selectAll}
              className="text-xs font-medium text-brand-700 dark:text-brand-50 hover:underline"
            >
              {allSelected ? 'Clear selection' : 'Select all'}
            </button>
            <span className="text-xs text-slate-600 dark:text-slate-300">
              {selectedIds.size} of {activePhotos.length} selected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleBulkDownload}
              disabled={selectedIds.size === 0 || !!busy}
              className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              {busy === 'download' ? (
                <Loader className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Download
            </button>
            <button
              onClick={handleGeneratePDF}
              disabled={selectedIds.size === 0 || !!busy}
              className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              {busy === 'pdf' ? (
                <Loader className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileText className="h-3.5 w-3.5" />
              )}
              Generate PDF
            </button>
            <button
              onClick={handleBulkDelete}
              disabled={selectedIds.size === 0 || !!busy}
              className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-danger-700 hover:bg-danger-50 dark:hover:bg-danger-700/20 disabled:opacity-50"
            >
              {busy === 'delete' ? (
                <Loader className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete
            </button>
            <button
              onClick={clearSelection}
              className="h-8 w-8 flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Close selection"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="p-5">
        {loading && !photosData ? (
          <div className="py-14 flex items-center justify-center text-slate-500">
            <Loader className="h-5 w-5 animate-spin mr-2" />
            Loading documents…
          </div>
        ) : error ? (
          <div className="py-14 text-center">
            <p className="text-sm text-danger-700 mb-3">{error}</p>
            <button
              onClick={() => fetchPhotos(true)}
              className="text-sm text-brand-600 hover:underline"
            >
              Try again
            </button>
          </div>
        ) : activePhotos.length === 0 ? (
          /* Wireframe-aligned empty state: subtle drop zone */
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-14 rounded-md border-2 border-dashed border-slate-200 dark:border-slate-700 hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-700/10 transition-colors flex flex-col items-center justify-center gap-2 text-slate-500"
          >
            <div className="h-12 w-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
              <Upload className="h-5 w-5" />
            </div>
            <div className="text-sm font-medium text-slate-700 dark:text-slate-300">
              {activeCategory === 'all'
                ? 'No documents yet'
                : `No documents in ${categories.find((c) => c.id === activeCategory)?.label}`}
            </div>
            <div className="text-xs text-slate-500">
              Drop files here or click to upload · images and PDFs
            </div>
          </button>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {activePhotos.map((file) => (
              <DocumentTile
                key={file.id}
                file={file}
                isSelectMode={isSelectMode}
                isSelected={selectedIds.has(file.id)}
                onToggleSelect={() => toggleSelected(file.id)}
                onPreview={() => setPreviewFile(file)}
              />
            ))}
            {/* Trailing "add more" tile so the upload affordance is visible
                even when the category has files. Hidden in select mode. */}
            {!isSelectMode && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded-md border-2 border-dashed border-slate-200 dark:border-slate-700 hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-700/10 transition-colors flex flex-col items-center justify-center text-slate-500 gap-1"
              >
                <Upload className="h-4 w-4" />
                <span className="text-xs font-medium">Add more</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* In-app preview lightbox */}
      <PreviewLightbox
        files={activePhotos}
        current={previewFile}
        onClose={() => setPreviewFile(null)}
        onPrev={(f) => setPreviewFile(f)}
        onDownload={downloadOne}
      />
    </div>
  );
};

/**
 * Fetch a backend-proxied file as a blob, with auth.
 * Returns an object URL the caller is responsible for revoking
 * (or accept the auto-revoke we do for tab opens).
 */
async function fetchAuthedBlob(proxyLink: string): Promise<string> {
  const token = localStorage.getItem('accessToken');
  const url = resolveProxyUrl(proxyLink);
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/* In-app preview takes over; openDocument removed in favour of state-driven
   PreviewLightbox below. */

/**
 * PDF thumbnail tile — renders the first page of the PDF as an image via
 * react-pdf. Fetches the proxy URL with auth and passes the blob to
 * <Document>. The aspect-square parent constrains it; we set a width
 * that scales the first page to fit.
 */
const PdfThumbnail: React.FC<{ proxyLink: string; fileName: string }> = ({
  proxyLink,
  fileName,
}) => {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let revoke: string | null = null;
    fetchAuthedBlob(proxyLink)
      .then((url) => {
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        revoke = url;
        setSrc(url);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [proxyLink]);

  if (failed) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 px-2 text-center">
        <FileIcon className="h-7 w-7 text-danger-600" />
        <span className="text-[10px] text-slate-500 truncate w-full">{fileName}</span>
      </div>
    );
  }
  if (!src) {
    return <div className="w-full h-full animate-pulse bg-slate-100 dark:bg-slate-800" />;
  }
  return (
    <div className="relative w-full h-full overflow-hidden bg-white flex items-start justify-center">
      <Document
        file={src}
        loading={
          <div className="w-full h-full animate-pulse bg-slate-100 dark:bg-slate-800" />
        }
        error={
          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 px-2 text-center">
            <FileIcon className="h-7 w-7 text-danger-600" />
            <span className="text-[10px] text-slate-500 truncate w-full">{fileName}</span>
          </div>
        }
        onLoadError={() => setFailed(true)}
      >
        <Page
          pageNumber={1}
          width={260}
          renderAnnotationLayer={false}
          renderTextLayer={false}
        />
      </Document>
      {/* Small PDF badge in the bottom-left corner */}
      <span className="absolute bottom-1.5 left-1.5 text-[9px] font-semibold tracking-wider bg-danger-600 text-white px-1.5 py-0.5 rounded">
        PDF
      </span>
    </div>
  );
};

/**
 * Inline image preview that fetches the proxy URL with auth and shows the
 * resulting blob. Avoids the broken `thumbnailLink` (which is actually a
 * Drive /view HTML URL, not an image) and the legacy localhost:8000 base.
 */
const AuthedImage: React.FC<{ proxyLink: string; alt: string }> = ({ proxyLink, alt }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let revoke: string | null = null;
    fetchAuthedBlob(proxyLink)
      .then((url) => {
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        revoke = url;
        setSrc(url);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [proxyLink]);

  if (failed) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-400">
        <ImageOff className="h-6 w-6" />
      </div>
    );
  }
  if (!src) {
    return <div className="w-full h-full animate-pulse bg-slate-100 dark:bg-slate-800" />;
  }
  return <img src={src} alt={alt} className="w-full h-full object-cover" />;
};

interface DocumentTileProps {
  file: DriveFile;
  isSelectMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  onPreview?: () => void;
}

const DocumentTile: React.FC<DocumentTileProps> = ({
  file,
  isSelectMode = false,
  isSelected = false,
  onToggleSelect,
  onPreview,
}) => {
  const img = isImage(file);
  const displayName = file.name?.split('/').pop() || file.name || 'Untitled';

  const handleClick = () => {
    if (isSelectMode) onToggleSelect?.();
    else onPreview?.();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={
        `group relative aspect-square rounded-md overflow-hidden border transition-colors block bg-slate-50 dark:bg-slate-800 text-left w-full ` +
        (isSelected
          ? 'border-brand-600 ring-2 ring-brand-600/30'
          : 'border-slate-200 dark:border-slate-700 hover:border-brand-600')
      }
      title={displayName}
    >
      {img && file.proxyLink ? (
        <AuthedImage proxyLink={file.proxyLink} alt={displayName} />
      ) : file.mimeType === 'application/pdf' && file.proxyLink ? (
        <PdfThumbnail proxyLink={file.proxyLink} fileName={displayName} />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 px-2 text-center">
          <FileIcon className="h-7 w-7 text-danger-600" />
          <span className="text-[10px] text-slate-500 truncate w-full">
            {displayName}
          </span>
        </div>
      )}

      {/* Selection checkbox overlay (top-left), visible in select mode */}
      {isSelectMode && (
        <div
          className={
            `absolute top-2 left-2 h-5 w-5 rounded flex items-center justify-center transition-colors ` +
            (isSelected
              ? 'bg-brand-600 text-white'
              : 'bg-white/90 dark:bg-slate-900/90 text-transparent border border-slate-300 dark:border-slate-600')
          }
        >
          <Check className="h-3 w-3" />
        </div>
      )}

      {/* Filename overlay on hover (hidden in select mode for clarity) */}
      {!isSelectMode && (
        <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-gradient-to-t from-black/70 to-transparent text-white text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity truncate">
          {displayName}
        </div>
      )}
    </button>
  );
};

// ────────────────── Preview Lightbox ──────────────────

interface PreviewLightboxProps {
  files: DriveFile[];
  current: DriveFile | null;
  onClose: () => void;
  onPrev: (f: DriveFile) => void;
  onDownload: (f: DriveFile) => Promise<void>;
}

/**
 * In-app preview for a single document (image or PDF). Uses the
 * auth-protected proxy URL fetched as a blob; renders images via <img>
 * and PDFs via <iframe>, which uses the browser's built-in PDF viewer
 * (avoids react-pdf bundle and worker setup).
 *
 * Has prev/next navigation across `files` (the currently visible
 * category) and a Download action that calls into the parent's
 * downloadOne helper.
 */
const PreviewLightbox: React.FC<PreviewLightboxProps> = ({
  files,
  current,
  onClose,
  onPrev,
  onDownload,
}) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const currentIdx = useMemo(
    () => (current ? files.findIndex((f) => f.id === current.id) : -1),
    [files, current]
  );

  const isPdf = current?.mimeType === 'application/pdf';
  const isImg = !!current && (current.mimeType?.startsWith('image/') || false);

  // Fetch the blob whenever the current file changes
  useEffect(() => {
    if (!current?.proxyLink) {
      setBlobUrl(null);
      setLoadError(current ? 'No preview URL available for this file.' : null);
      return;
    }
    let revoke: string | null = null;
    let cancelled = false;
    setBlobUrl(null);
    setLoadError(null);
    fetchAuthedBlob(current.proxyLink)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        revoke = url;
        setBlobUrl(url);
      })
      .catch((err: any) =>
        !cancelled && setLoadError(err?.message || 'Failed to load preview.')
      );
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [current]);

  // Keyboard navigation
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (!current) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && currentIdx > 0)
        onPrev(files[currentIdx - 1]);
      else if (e.key === 'ArrowRight' && currentIdx >= 0 && currentIdx < files.length - 1)
        onPrev(files[currentIdx + 1]);
    },
    [current, currentIdx, files, onClose, onPrev]
  );

  useEffect(() => {
    if (!current) return;
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [current, handleKey]);

  if (!current) return null;

  const displayName = current.name?.split('/').pop() || current.name || 'Untitled';
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx >= 0 && currentIdx < files.length - 1;

  return (
    <div
      className="fixed inset-0 z-[60] bg-slate-950/90 backdrop-blur-sm flex flex-col"
      onClick={(e) => {
        // Close only when clicking the backdrop, not content
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-slate-800 bg-slate-900/80 text-slate-100">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{displayName}</div>
          <div className="text-xs text-slate-400">
            {current.mimeType || 'Unknown type'}
            {currentIdx >= 0 && files.length > 1 && (
              <> · {currentIdx + 1} of {files.length}</>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={async () => {
              setDownloading(true);
              try {
                await onDownload(current);
              } catch (err: any) {
                toast.error(err?.message || 'Download failed.');
              } finally {
                setDownloading(false);
              }
            }}
            disabled={downloading}
            className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md text-xs font-medium bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:opacity-60"
          >
            {downloading ? <Loader className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Download
          </button>
          <button
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center rounded-md text-slate-300 hover:bg-slate-800"
            aria-label="Close preview"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div
        className="flex-1 relative overflow-auto flex items-center justify-center p-6"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {/* Prev/Next nav (when there's more than one file in the category) */}
        {hasPrev && (
          <button
            onClick={() => onPrev(files[currentIdx - 1])}
            className="absolute left-4 top-1/2 -translate-y-1/2 h-10 w-10 flex items-center justify-center rounded-full bg-slate-900/70 hover:bg-slate-800 text-slate-100 backdrop-blur-sm"
            aria-label="Previous"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {hasNext && (
          <button
            onClick={() => onPrev(files[currentIdx + 1])}
            className="absolute right-4 top-1/2 -translate-y-1/2 h-10 w-10 flex items-center justify-center rounded-full bg-slate-900/70 hover:bg-slate-800 text-slate-100 backdrop-blur-sm"
            aria-label="Next"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}

        {/* Content */}
        {loadError ? (
          <div className="text-slate-300 text-center max-w-md">
            <ImageOff className="h-8 w-8 mx-auto mb-2 opacity-60" />
            <p className="text-sm">{loadError}</p>
          </div>
        ) : !blobUrl ? (
          <div className="text-slate-300 text-sm inline-flex items-center gap-2">
            <Loader className="h-4 w-4 animate-spin" />
            Loading preview…
          </div>
        ) : isImg ? (
          <img
            src={blobUrl}
            alt={displayName}
            className="max-w-full max-h-full object-contain rounded-md shadow-2xl"
          />
        ) : isPdf ? (
          <iframe
            src={blobUrl}
            title={displayName}
            className="w-full h-full bg-white rounded-md shadow-2xl"
          />
        ) : (
          /* Unknown type — offer to open the blob in a new tab as a fallback */
          <div className="text-slate-300 text-center max-w-md">
            <FileIcon className="h-8 w-8 mx-auto mb-2 opacity-60" />
            <p className="text-sm mb-3">
              In-app preview isn't supported for this file type.
            </p>
            <a
              href={blobUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-brand-50 underline"
            >
              Open in a new tab
            </a>
          </div>
        )}
      </div>
    </div>
  );
};

export default PatientDocumentsPanel;
