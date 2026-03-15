import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Document, Page, pdfjs } from "react-pdf";
import { DriveFile } from "../types";

// Configure PDF worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
const API_V2_BASE_URL =
    process.env.NODE_ENV === "production"
        ? ""
        : "http://localhost:8000";

interface LightboxProps {
    photo: DriveFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    hasNext?: boolean;
    hasPrev?: boolean;
    onDownload?: (file: DriveFile) => void;
}

/** Sub-component: loads full-size image, with auth-fetch fallback for proxy URLs + drag-to-pan */
const LightboxImage: React.FC<{
    webViewLink: string;
    proxyLink?: string | null;
    name: string;
    zoom: number;
    pan: { x: number; y: number };
    onPanChange: (pan: { x: number; y: number }) => void;
}> = ({ webViewLink, proxyLink, name, zoom, pan, onPanChange }) => {
    const [src, setSrc] = React.useState<string>(webViewLink);
    const [hasError, setHasError] = React.useState(false);
    const [isDragging, setIsDragging] = React.useState(false);
    const dragStart = React.useRef({ x: 0, y: 0, panX: 0, panY: 0 });
    const imgRef = React.useRef<HTMLImageElement>(null);

    // Reset when photo changes (next/prev navigation)
    React.useEffect(() => {
        setSrc(webViewLink);
        setHasError(false);
    }, [webViewLink, proxyLink]);

    const handleError = () => {
        if (proxyLink && !hasError) {
            setHasError(true);
            const token = localStorage.getItem("accessToken");
            fetch(`${API_V2_BASE_URL}${proxyLink}`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            })
                .then(r => r.blob())
                .then(blob => setSrc(URL.createObjectURL(blob)))
                .catch(() => { });
        }
    };

    // Calculate max allowed pan based on image size and zoom
    const clampPanY = React.useCallback((newY: number) => {
        if (!imgRef.current) return newY;
        const imgHeight = imgRef.current.offsetHeight; // pre-transform CSS height
        const containerHeight = window.innerHeight;
        const scaledHeight = imgHeight * zoom;
        const overflow = Math.max(0, (scaledHeight - containerHeight) / 2);
        if (overflow <= 0) return 0;
        return Math.max(-overflow, Math.min(overflow, newY));
    }, [zoom]);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (zoom <= 1) return;
        e.preventDefault();
        setIsDragging(true);
        dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    };

    React.useEffect(() => {
        if (!isDragging) return;

        const handleMouseMove = (e: MouseEvent) => {
            const dy = e.clientY - dragStart.current.y;
            const newY = clampPanY(dragStart.current.panY + dy);
            onPanChange({ x: 0, y: newY });
        };

        const handleMouseUp = () => setIsDragging(false);

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, onPanChange, clampPanY]);

    return (
        <img
            ref={imgRef}
            src={src}
            alt={name}
            onError={handleError}
            onMouseDown={handleMouseDown}
            className="max-w-full max-h-[85vh] object-contain drop-shadow-2xl rounded-sm select-none"
            style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transition: isDragging ? 'none' : 'transform 0.2s ease',
                cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
            }}
            draggable={false}
        />
    );
};

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
    const [isDownloading, setIsDownloading] = useState(false);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });

    // Reset zoom and pan when photo changes (next/prev)
    React.useEffect(() => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
    }, [photo.id]);

    const zoomIn = () => setZoom(z => Math.min(z + 0.25, 3));
    const zoomOut = () => {
        setZoom(z => {
            const newZoom = Math.max(z - 0.25, 1);
            if (newZoom <= 1) setPan({ x: 0, y: 0 });
            return newZoom;
        });
    };
    const resetZoom = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

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
            } else if (e.key === "+" || e.key === "=") {
                zoomIn();
            } else if (e.key === "-") {
                zoomOut();
            } else if (e.key === "0") {
                resetZoom();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [hasNext, hasPrev, onNext, onPrev, onClose]);

    // Scroll wheel / trackpad pinch to zoom
    React.useEffect(() => {
        const handleWheel = (e: WheelEvent) => {
            // Only zoom for images, not PDFs
            if (photo.mimeType?.toLowerCase().includes("pdf")) return;

            e.preventDefault();
            const delta = -e.deltaY;
            const step = e.ctrlKey ? 0.05 : 0.1; // finer control for pinch gestures

            setZoom(z => {
                const newZoom = Math.min(3, Math.max(1, z + (delta > 0 ? step : -step)));
                if (newZoom <= 1) setPan({ x: 0, y: 0 });
                return newZoom;
            });
        };

        window.addEventListener("wheel", handleWheel, { passive: false });
        return () => window.removeEventListener("wheel", handleWheel);
    }, [photo.mimeType]);

    const handleDownload = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (onDownload) {
            setIsDownloading(true);
            try {
                await onDownload(photo);
            } finally {
                setIsDownloading(false);
            }
        }
    };

    const handleOpenOriginal = (e: React.MouseEvent) => {
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
                className="w-full h-full flex items-center justify-center p-4 pb-20 overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {photo.mimeType?.toLowerCase().includes("pdf") ? (
                    <div
                        className="w-[90vw] h-[85vh] bg-transparent overflow-y-auto overflow-x-hidden custom-scrollbar rounded-lg"
                        onWheel={(e) => e.stopPropagation()}
                    >
                        <Document
                            file={
                                photo.proxyLink
                                    ? {
                                        url: API_V2_BASE_URL + photo.proxyLink,
                                        httpHeaders: {
                                            Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
                                        },
                                    } as any
                                    : photo.webViewLink || ""
                            }
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
                                        href={photo.webViewLink || ""}
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
                    <LightboxImage
                        webViewLink={photo.webViewLink || ""}
                        proxyLink={photo.proxyLink}
                        name={photo.name}
                        zoom={zoom}
                        pan={pan}
                        onPanChange={setPan}
                    />
                )}
            </div>

            {/* Bottom Action Bar */}
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 z-[1060] pointer-events-auto">
                {photo.webViewLink && (
                    <button
                        className="flex items-center gap-2 px-6 py-3 rounded-full bg-white text-slate-900 font-medium shadow-lg hover:bg-slate-100 transition-colors"
                        onClick={handleOpenOriginal}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M15 3h6v6" />
                            <path d="M10 14 21 3" />
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        </svg>
                        Open Original
                    </button>
                )}

                {/* Zoom Controls */}
                {!photo.mimeType?.toLowerCase().includes("pdf") && (
                    <div className="flex items-center gap-1 bg-white rounded-full shadow-lg px-2 py-1.5">
                        <button
                            className="w-9 h-9 rounded-full hover:bg-slate-100 text-slate-900 flex items-center justify-center transition-colors border-none cursor-pointer text-lg font-bold disabled:opacity-30"
                            onClick={(e) => { e.stopPropagation(); zoomOut(); }}
                            disabled={zoom <= 1}
                            title="Zoom out (-)"
                        >
                            −
                        </button>
                        <button
                            className="px-2 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-md transition-colors cursor-pointer border-none min-w-[48px]"
                            onClick={(e) => { e.stopPropagation(); resetZoom(); }}
                            title="Reset zoom (0)"
                        >
                            {Math.round(zoom * 100)}%
                        </button>
                        <button
                            className="w-9 h-9 rounded-full hover:bg-slate-100 text-slate-900 flex items-center justify-center transition-colors border-none cursor-pointer text-lg font-bold disabled:opacity-30"
                            onClick={(e) => { e.stopPropagation(); zoomIn(); }}
                            disabled={zoom >= 3}
                            title="Zoom in (+)"
                        >
                            +
                        </button>
                    </div>
                )}

                <button
                    className="flex items-center gap-2 px-6 py-3 rounded-full bg-white text-slate-900 font-medium shadow-lg hover:bg-slate-100 transition-colors disabled:opacity-60"
                    onClick={handleDownload}
                    disabled={isDownloading}
                >
                    {isDownloading ? (
                        <div className="w-5 h-5 border-2 border-slate-400 border-t-slate-900 rounded-full animate-spin" />
                    ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                    )}
                    {isDownloading ? "Downloading..." : "Download"}
                </button>
            </div>
        </div>,
        document.body
    );
};
