import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Document, Page, pdfjs } from "react-pdf";
import { DriveFile } from "../types";
import apiService, { getBackendOrigin } from "../../../../services/api";

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
            // Sprint 1D: route through axios for refresh-token interceptor.
            apiService
                .downloadBlob(proxyLink)
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
            className="max-w-full max-h-full object-contain drop-shadow-2xl rounded-sm select-none"
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
    const [currentPage, setCurrentPage] = useState(1);
    const [isDownloading, setIsDownloading] = useState(false);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const pdfContainerRef = useRef<HTMLDivElement>(null);
    const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
    const scrollTimeoutRef = useRef<number | null>(null);

    // Reset zoom and pan when photo changes (next/prev)
    useEffect(() => {
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

    const isPdf = photo.mimeType?.toLowerCase().includes("pdf");

    const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
        setNumPages(numPages);
        setCurrentPage(1);
        pageRefs.current = new Array(numPages).fill(null);
    };

    // Calculate current page on scroll using absolute screen positions
    const handlePdfScroll = useCallback(() => {
        if (!numPages || !pdfContainerRef.current) return;

        // Use requestAnimationFrame to throttle to screen refresh rate
        if (scrollTimeoutRef.current) return;

        scrollTimeoutRef.current = requestAnimationFrame(() => {
            scrollTimeoutRef.current = null;
            const container = pdfContainerRef.current;
            if (!container) return;

            // Get absolute screen position of the scrollable container wrapper
            const containerRect = container.getBoundingClientRect();

            // Define the "target viewing line" as 30% down the visible scroll window
            const targetLineY = containerRect.top + (containerRect.height * 0.3);

            let closestPage = currentPage;
            let minDist = Infinity;

            for (let i = 0; i < numPages; i++) {
                const pageEl = pageRefs.current[i];
                if (!pageEl) continue;

                // Absolute screen position of this specific PDF page wrapper
                const rect = pageEl.getBoundingClientRect();

                // If our target line falls inside this page entirely, it's definitely the active one
                if (targetLineY >= rect.top && targetLineY <= rect.bottom) {
                    closestPage = i + 1;
                    break;
                }

                // Otherwise find which page's edge is nearest to our target line
                const distToTop = Math.abs(rect.top - targetLineY);
                const distToBottom = Math.abs(rect.bottom - targetLineY);
                const minEdgeDist = Math.min(distToTop, distToBottom);

                if (minEdgeDist < minDist) {
                    minDist = minEdgeDist;
                    closestPage = i + 1;
                }
            }

            if (closestPage !== currentPage) {
                setCurrentPage(closestPage);
            }
        });
    }, [numPages, currentPage]);

    // PDF page width based on zoom
    const pdfPageWidth = Math.min(window.innerWidth * 0.85, 800) * zoom;

    // Keyboard navigation
    useEffect(() => {
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

    // Scroll wheel / trackpad pinch to zoom (images only, PDFs scroll naturally)
    React.useEffect(() => {
        if (isPdf) return;

        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            const delta = -e.deltaY;
            const step = e.ctrlKey ? 0.05 : 0.1;

            setZoom(z => {
                const newZoom = Math.min(3, Math.max(1, z + (delta > 0 ? step : -step)));
                if (newZoom <= 1) setPan({ x: 0, y: 0 });
                return newZoom;
            });
        };

        window.addEventListener("wheel", handleWheel, { passive: false });
        return () => window.removeEventListener("wheel", handleWheel);
    }, [isPdf]);

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
            {/* Top Bar: Name & Date (Left) — Actions & Close (Right) */}
            <div className="absolute top-0 left-0 right-0 p-4 flex justify-between items-center z-[1060] pointer-events-none">
                <div className="flex flex-col text-white pointer-events-auto max-w-[50%]">
                    <h3
                        className="text-sm font-medium drop-shadow-md line-clamp-1"
                        title={photo.name}
                    >
                        {photo.name}
                    </h3>
                    {photo.createdTime && (
                        <p className="text-xs opacity-70 drop-shadow-md mt-0.5">
                            {new Date(photo.createdTime).toLocaleString()}
                        </p>
                    )}
                </div>

                {/* Right side: action icons */}
                <div className="flex items-center gap-1 pointer-events-auto">
                    {/* Open Original */}
                    {photo.webViewLink && (
                        <button
                            className="w-10 h-10 rounded-full hover:bg-white/15 text-white flex items-center justify-center transition-colors border-none cursor-pointer"
                            onClick={handleOpenOriginal}
                            title="Open original"
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M15 3h6v6" />
                                <path d="M10 14 21 3" />
                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            </svg>
                        </button>
                    )}

                    {/* Download */}
                    <button
                        className="w-10 h-10 rounded-full hover:bg-white/15 text-white flex items-center justify-center transition-colors border-none cursor-pointer disabled:opacity-40"
                        onClick={handleDownload}
                        disabled={isDownloading}
                        title="Download"
                    >
                        {isDownloading ? (
                            <div className="w-5 h-5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                        ) : (
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                        )}
                    </button>

                    {/* Close */}
                    <button
                        className="w-10 h-10 rounded-full hover:bg-white/15 text-white flex items-center justify-center transition-colors border-none cursor-pointer ml-1"
                        onClick={(e) => {
                            e.stopPropagation();
                            onClose();
                        }}
                        title="Close"
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>
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
                className="w-full h-full flex items-center justify-center p-4 pt-16 pb-24 overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {isPdf ? (
                    <div
                        ref={pdfContainerRef}
                        className="relative w-full h-full bg-transparent overflow-y-auto overflow-x-auto rounded-lg pdf-scroll-hide"
                        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                        onWheel={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onScroll={handlePdfScroll}
                    >
                        <style>{`.pdf-scroll-hide::-webkit-scrollbar { display: none; }`}</style>
                        <div className="flex flex-col items-center min-h-full pb-[10vh]">
                            <Document
                                file={
                                    photo.proxyLink
                                        ? {
                                            url: getBackendOrigin() + photo.proxyLink,
                                            httpHeaders: {
                                                Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
                                            },
                                        } as any
                                        : photo.webViewLink || ""
                                }
                                onLoadSuccess={onDocumentLoadSuccess}
                                loading={
                                    <div className="flex flex-col items-center gap-4 text-white mt-10">
                                        <div className="w-10 h-10 border-4 border-slate-700 border-t-brand-600 rounded-full animate-spin" />
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
                                            className="text-brand-50 underline"
                                        >
                                            Download instead
                                        </a>
                                    </div>
                                }
                                className="flex flex-col items-center w-full"
                            >
                                {Array.from(new Array(numPages || 0), (el, index) => (
                                    <div
                                        key={`page_${index + 1}`}
                                        ref={(el) => { pageRefs.current[index] = el; }}
                                        className="mb-8 relative"
                                    >
                                        <Page
                                            pageNumber={index + 1}
                                            renderTextLayer={false}
                                            renderAnnotationLayer={false}
                                            width={pdfPageWidth}
                                            className="shadow-2xl bg-white [&_canvas]:max-w-full [&_canvas]:h-auto! [&_canvas]:rounded-md"
                                        />
                                    </div>
                                ))}
                            </Document>
                        </div>
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

            {/* Bottom Controls — Google Drive style transparent pill */}
            <div
                className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1060] pointer-events-auto"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onWheel={(e) => e.stopPropagation()}
            >
                <div className="flex items-center bg-[#1E1E1E]/90 backdrop-blur-md rounded-[20px] px-3 py-2 shadow-2xl gap-3 text-white border border-white/10">
                    {/* PDF: Page indicator */}
                    {isPdf && numPages && (
                        <>
                            <span className="text-sm text-white/70 font-medium">Page</span>
                            <span className="text-sm text-white font-semibold bg-white/10 px-2.5 py-0.5 rounded">{currentPage}</span>
                            <span className="text-sm text-white/50">/</span>
                            <span className="text-sm text-white font-semibold">{numPages}</span>
                            <div className="w-px h-5 bg-white/20 mx-1" />
                        </>
                    )}

                    {/* Zoom controls — for both PDFs and images */}
                    <button
                        className="w-9 h-9 rounded-full hover:bg-white/15 text-white flex items-center justify-center transition-colors border-none cursor-pointer text-lg font-bold disabled:opacity-30"
                        onClick={(e) => { e.stopPropagation(); zoomOut(); }}
                        disabled={zoom <= 1}
                        title="Zoom out"
                    >
                        −
                    </button>
                    <button
                        className="w-9 h-9 rounded-full hover:bg-white/15 text-white/80 flex items-center justify-center transition-colors border-none cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); resetZoom(); }}
                        title="Reset zoom"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" />
                            <path d="M21 21l-4.35-4.35" />
                        </svg>
                    </button>
                    <button
                        className="w-9 h-9 rounded-full hover:bg-white/15 text-white flex items-center justify-center transition-colors border-none cursor-pointer text-lg font-bold disabled:opacity-30"
                        onClick={(e) => { e.stopPropagation(); zoomIn(); }}
                        disabled={zoom >= 3}
                        title="Zoom in"
                    >
                        +
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
};
