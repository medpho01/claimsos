import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, File as FileIcon, Loader, ImageOff } from 'lucide-react';
import { Patient } from '@/types';
import { usePhotosData } from '@/components/modals/PatientPhotosModal/hooks/usePhotosData';
import { DriveFile } from '@/components/modals/PatientPhotosModal/types';
import apiService from '@/services/api';
import { toast } from 'sonner';

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
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { photosData, loading, error, fetchPhotos } = usePhotosData(
    patient.id,
    patient.admission_type
  );

  useEffect(() => {
    fetchPhotos();
  }, [fetchPhotos]);

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

  return (
    <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
      {/* Header: category pills + Upload CTA */}
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

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="h-9 px-3 inline-flex items-center gap-2 rounded-md bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-60 shrink-0"
        >
          {uploading ? <Loader className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {uploading ? 'Uploading…' : 'Upload documents'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

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
              <DocumentTile key={file.id} file={file} />
            ))}
            {/* Trailing "add more" tile so the upload affordance is visible
                even when the category has files */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="aspect-square rounded-md border-2 border-dashed border-slate-200 dark:border-slate-700 hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-700/10 transition-colors flex flex-col items-center justify-center text-slate-500 gap-1"
            >
              <Upload className="h-4 w-4" />
              <span className="text-xs font-medium">Add more</span>
            </button>
          </div>
        )}
      </div>
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

/**
 * Open the file in a new tab. Always goes through the auth-protected proxy
 * (Drive webViewLink also exists but it's a Google login wall; the proxy
 * works for both S3 and Drive-backed files).
 */
async function openDocument(file: DriveFile) {
  if (!file.proxyLink) {
    if (file.webViewLink) {
      window.open(file.webViewLink, '_blank', 'noopener,noreferrer');
      return;
    }
    toast.error('No preview URL available for this file.');
    return;
  }
  try {
    const url = await fetchAuthedBlob(file.proxyLink);
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    if (w) setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err: any) {
    toast.error('Could not open document: ' + (err?.message || 'fetch failed'));
  }
}

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

const DocumentTile: React.FC<{ file: DriveFile }> = ({ file }) => {
  const img = isImage(file);
  const displayName = file.name?.split('/').pop() || file.name || 'Untitled';

  return (
    <button
      type="button"
      onClick={() => openDocument(file)}
      className="group relative aspect-square rounded-md overflow-hidden border border-slate-200 dark:border-slate-700 hover:border-brand-600 transition-colors block bg-slate-50 dark:bg-slate-800 text-left w-full"
      title={displayName}
    >
      {img && file.proxyLink ? (
        <AuthedImage proxyLink={file.proxyLink} alt={displayName} />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 px-2 text-center">
          <FileIcon className="h-7 w-7 text-danger-600" />
          <span className="text-[10px] text-slate-500 truncate w-full">
            {displayName}
          </span>
        </div>
      )}
      {/* Filename overlay on hover */}
      <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-gradient-to-t from-black/70 to-transparent text-white text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity truncate">
        {displayName}
      </div>
    </button>
  );
};

export default PatientDocumentsPanel;
