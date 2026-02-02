import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Document, Page, pdfjs } from "react-pdf";
import { DriveFile } from "../types";
import apiService from "../../../../services/api";

// Configure PDF worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface LightboxProps {
    photo: DriveFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    hasNext?: boolean;
    hasPrev?: boolean;
    onDownload?: (file: DriveFile) => void;
}

export const Lightbox: React.FC<LightboxProps> = ({
    photo,
    onClose,
    onNext,
    onPrev,
    hasNext = false,
    hasPrev = false,
    onDownload
}) => {
    const [numPages, setNumPages] = useState<number | null>(null);

    const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
        setNumPages(numPages);
    };

    // Keyboard navigation
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "ArrowRight" && hasNext && onNext) {
                onNext();
            } else if (e.key === "ArrowLeft" && hasPrev && onPrev) {
                onPrev();
            } else if (e.key === "Escape") {
                onClose();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [hasNext, hasPrev, onNext, onPrev, onClose]);

    const handleDownload = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (onDownload) {
            onDownload(photo);
        }
    };

    const handleOpenInDrive = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (photo.webViewLink) {
            window.open(photo.webViewLink, "_blank");
        }
    };

    return createPortal(
        <div
            className="fixed inset-0 z-[1050] pointer-events-auto bg-black/95 flex items-center justify-center animate-in fade-in duration-200"
            onClick={onClose}
        >
            {/* Top Bar: Name & Date (Left) and Close (Right) */}
            <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-start z-[1060] pointer-events-none">
                <div className="flex flex-col text-white pointer-events-auto max-w-[70%]">
                    <h3
                        className="text-lg font-semibold drop-shadow-md line-clamp-1"
                        title={photo.name}
                    >
                        {photo.name}
                    </h3>
                    {photo.createdTime && (
                        <p className="text-sm opacity-90 drop-shadow-md mt-0.5">
                            {new Date(photo.createdTime).toLocaleString()}
                        </p>
                    )}
                </div>

                <button
                    className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors border-none cursor-pointer pointer-events-auto backdrop-blur-sm"
                    onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                    }}
                >
                    <svg
                        width="32"
                        height="32"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                    >
                        <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                </button>
            </div>

            {/* Navigation Buttons */}
            {hasPrev && (
                <button
                    className="absolute left-4 top-1/2 -translate-y-1/2 z-[1060] w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all border-none cursor-pointer pointer-events-auto backdrop-blur-sm"
                    onClick={(e) => {
                        e.stopPropagation();
                        onPrev?.();
                    }}
                >
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M15 18l-6-6 6-6" />
                    </svg>
                </button>
            )}

            {hasNext && (
                <button
                    className="absolute right-4 top-1/2 -translate-y-1/2 z-[1060] w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all border-none cursor-pointer pointer-events-auto backdrop-blur-sm"
                    onClick={(e) => {
                        e.stopPropagation();
                        onNext?.();
                    }}
                >
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 18l6-6-6-6" />
                    </svg>
                </button>
            )}

            {/* Main Content */}
            <div
                className="w-full h-full flex items-center justify-center p-4 pb-20"
                onClick={(e) => e.stopPropagation()}
            >
                {photo.mimeType?.toLowerCase().includes("pdf") ? (
                    <div
                        className="w-[90vw] h-[85vh] bg-transparent overflow-y-auto overflow-x-hidden custom-scrollbar rounded-lg"
                        onWheel={(e) => e.stopPropagation()}
                    >
                        <Document
                            file={apiService.getThumbnailUrl(photo.id)}
                            onLoadSuccess={onDocumentLoadSuccess}
                            loading={
                                <div className="flex flex-col items-center gap-4 text-white mt-10">
                                    <div className="w-10 h-10 border-4 border-slate-700 border-t-indigo-500 rounded-full animate-spin" />
                                    <span>Loading PDF...</span>
                                </div>
                            }
                            error={
                                <div className="flex flex-col items-center gap-4 text-white mt-10">
                                    <p>Failed to load PDF.</p>
                                    <a
                                        href={apiService.getThumbnailUrl(photo.id)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-indigo-400 underline"
                                    >
                                        Download instead
                                    </a>
                                </div>
                            }
                            className="flex flex-col items-center min-h-full"
                        >
                            {Array.from(new Array(numPages || 0), (el, index) => (
                                <Page
                                    key={`page_${index + 1}`}
                                    pageNumber={index + 1}
                                    renderTextLayer={false}
                                    renderAnnotationLayer={false}
                                    width={Math.min(window.innerWidth * 0.85, 800)}
                                    className="mb-8 shadow-2xl [&_canvas]:max-w-full [&_canvas]:h-auto! [&_canvas]:rounded-md"
                                />
                            ))}
                        </Document>
                    </div>
                ) : (
                    <img
                        src={apiService.getThumbnailUrl(photo.id)}
                        alt={photo.name}
                        className="max-w-full max-h-[85vh] object-contain drop-shadow-2xl rounded-sm"
                    />
                )}
            </div>

            {/* Bottom Action Bar */}
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 z-[1060] pointer-events-auto">
                {photo.webViewLink && (
                    <button
                        className="flex items-center gap-2 px-6 py-3 rounded-full bg-white text-slate-900 font-medium shadow-lg hover:bg-slate-100 transition-colors"
                        onClick={handleOpenInDrive}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M15 3h6v6" />
                            <path d="M10 14 21 3" />
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        </svg>
                        Open in Drive
                    </button>
                )}

                <button
                    className="flex items-center gap-2 px-6 py-3 rounded-full bg-white text-slate-900 font-medium shadow-lg hover:bg-slate-100 transition-colors"
                    onClick={handleDownload}
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Download
                </button>
            </div>
        </div>,
        document.body
    );
};
