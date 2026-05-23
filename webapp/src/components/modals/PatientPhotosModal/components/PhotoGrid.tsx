import React, { ReactNode } from "react";
import { motion } from "framer-motion";
import { MediaFile } from "../types";
import { LazyImage } from "./LazyImage";

interface PhotoGridProps {
    photos: MediaFile[];
    loading: boolean;
    error: string | null;
    selectedIds: Set<string>;
    isSelectMode: boolean;
    onPhotoClick: (photo: MediaFile) => void;
    onSelectionToggle: (id: string) => void;
    onRetry: () => void;
    totalPhotoCount: number;
}

export const PhotoGrid: React.FC<PhotoGridProps> = ({
    photos,
    loading,
    error,
    selectedIds,
    isSelectMode,
    onPhotoClick,
    onSelectionToggle,
    onRetry,
    totalPhotoCount
}) => {

    return (
        <div
            className={`flex-1 overflow-y-auto p-6 relative transition-colors`}
        >
            {loading ? (
                <div className="flex-1 flex items-center justify-center py-16">
                    <div className="flex items-center gap-1.5">
                        {[0, 1, 2].map(i => (
                            <div
                                key={i}
                                className="w-2 h-2 rounded-full bg-indigo-400"
                                style={{
                                    animation: 'pulse 1.2s ease-in-out infinite',
                                    animationDelay: `${i * 0.2}s`,
                                }}
                            />
                        ))}
                    </div>
                </div>
            ) : error ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-4 text-center">
                    <svg
                        width="48"
                        height="48"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                    >
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 8v4M12 16h.01" />
                    </svg>
                    <span>{error}</span>
                    <button
                        onClick={onRetry}
                        className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors"
                    >
                        Try Again
                    </button>
                </div>
            ) : totalPhotoCount === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-4 text-center">
                    <svg
                        width="64"
                        height="64"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                    >
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <path d="M21 15l-5-5L5 21" />
                    </svg>
                    <span>No files uploaded yet</span>
                </div>
            ) : photos.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-4 text-center">
                    <svg
                        width="48"
                        height="48"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                    >
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span>No files in this category</span>
                </div>
            ) : (
                <motion.div
                    className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-6"
                    initial="hidden"
                    animate="visible"
                    variants={{
                        hidden: { opacity: 0 },
                        visible: {
                            opacity: 1,
                            transition: { staggerChildren: 0.05, delayChildren: 0.1 }
                        }
                    }}
                >
                    {photos.map((photo, index) => (
                        <motion.div
                            key={photo.id}
                            variants={{
                                hidden: { opacity: 0, y: 20, scale: 0.95 },
                                visible: {
                                    opacity: 1,
                                    y: 0,
                                    scale: 1,
                                    transition: { duration: 0.3, ease: "easeOut" }
                                }
                            }}
                            className="group relative flex flex-col bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition-all cursor-pointer hover:-translate-y-0.5"
                            onClick={() => {
                                if (photo.webViewLink) onPhotoClick(photo);
                            }}
                        >
                            <div className="relative aspect-[4/3] bg-slate-50 overflow-hidden border-b border-slate-100/50">
                                {photo.mimeType?.toLowerCase().includes("pdf") ? (
                                    <div className="w-full h-full flex flex-col items-center justify-center bg-white gap-2">
                                        <svg
                                            width="40"
                                            height="40"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="#ef4444"
                                            strokeWidth="1.5"
                                        >
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                            <polyline points="14 2 14 8 20 8" />
                                            <path d="M10 12h-2v4h4" />
                                            <path d="M10 12l2 4" />
                                        </svg>
                                    </div>
                                ) : !photo.thumbnailLink ? (
                                    <div className="w-full h-full animate-pulse bg-slate-100 flex items-center justify-center">
                                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.5" opacity="0.5">
                                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                            <circle cx="8.5" cy="8.5" r="1.5" />
                                            <path d="M21 15l-5-5L5 21" />
                                        </svg>
                                    </div>
                                ) : (
                                    <LazyImage
                                        thumbnailUrl={photo.thumbnailLink}
                                        proxyUrl={photo.proxyLink || photo.webViewLink || null}
                                        alt={photo.name}
                                        priority={index < 6}
                                    />
                                )}

                                {/* Hover Overlay */}
                                <div className="absolute inset-0 bg-black/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>

                            {/* Card Footer with Name */}
                            <div className="p-3 flex items-center gap-3 bg-white">
                                <div className="shrink-0">
                                    {photo.mimeType?.toLowerCase().includes("pdf") ? (
                                        <svg
                                            width="18"
                                            height="18"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="#ef4444"
                                            strokeWidth="2"
                                        >
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                            <path d="M14 2v6h6" />
                                        </svg>
                                    ) : (
                                        <svg
                                            width="18"
                                            height="18"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="#ef4444"
                                            strokeWidth="2"
                                        >
                                            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                                            <polyline points="14 2 14 8 20 8" />
                                            <path d="M8.5 13l2 2.5 3-3.5" />
                                        </svg>
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p
                                        className="text-[13px] font-medium text-slate-700 truncate"
                                        title={photo.name}
                                    >
                                        {photo.name}
                                    </p>
                                </div>
                            </div>
                            {isSelectMode && (
                                <div className="absolute top-3 right-3 z-10">
                                    <div
                                        className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${selectedIds.has(photo.id) ? "bg-indigo-600 border-indigo-600" : "bg-black/20 border-white"}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onSelectionToggle(photo.id);
                                        }}
                                    >
                                        {selectedIds.has(photo.id) && (
                                            <svg
                                                width="14"
                                                height="14"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="white"
                                                strokeWidth="4"
                                            >
                                                <path d="M20 6L9 17l-5-5" />
                                            </svg>
                                        )}
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    ))}
                </motion.div>
            )}
        </div>
    );
};
