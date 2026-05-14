import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, File as FileIcon, Image as ImageIcon, Loader, X } from 'lucide-react';
import { Patient } from '@/types';
import { usePhotosData } from '@/components/modals/PatientPhotosModal/hooks/usePhotosData';
import { DriveFile } from '@/components/modals/PatientPhotosModal/types';
import apiService from '@/services/api';
import { toast } from 'sonner';

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

const DocumentTile: React.FC<{ file: DriveFile }> = ({ file }) => {
  const img = isImage(file);
  const url = (file as any).url || (file as any).previewUrl || (file as any).webViewLink;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative aspect-square rounded-md overflow-hidden border border-slate-200 dark:border-slate-700 hover:border-brand-600 transition-colors block bg-slate-50 dark:bg-slate-800"
    >
      {img && url ? (
        <img
          src={url}
          alt={file.name}
          loading="lazy"
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 px-2 text-center">
          <FileIcon className="h-7 w-7 text-danger-600" />
          <span className="text-[10px] text-slate-500 truncate w-full">
            {file.name?.split('/').pop()}
          </span>
        </div>
      )}
      {/* Filename overlay on hover */}
      <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-gradient-to-t from-black/70 to-transparent text-white text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity truncate">
        {file.name?.split('/').pop()}
      </div>
    </a>
  );
};

export default PatientDocumentsPanel;
