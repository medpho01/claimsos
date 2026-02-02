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
}

export const Lightbox: React.FC<LightboxProps> = ({ photo, onClose }) => {
    const [numPages, setNumPages] = useState<number | null>(null);

    const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
        setNumPages(numPages);
    };

    return createPortal(
        <div
            className="fixed inset-0 z-[1050] pointer-events-auto bg-black/95 flex items-center justify-center"
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
                    className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors border-none cursor-pointer pointer-events-auto"
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

            <div
                className="w-full h-full flex items-center justify-center p-4"
                onClick={(e) => e.stopPropagation()}
            >
                {photo.mimeType?.toLowerCase().includes("pdf") ? (
                    <div className="w-[90vw] h-[85vh] flex flex-col items-center justify-center">
                        <Document
                            file={apiService.getThumbnailUrl(photo.id)}
                            onLoadSuccess={onDocumentLoadSuccess}
                            loading={
                                <div className="flex flex-col items-center gap-4 text-white">
                                    <div className="w-10 h-10 border-4 border-slate-700 border-t-indigo-500 rounded-full animate-spin" />
                                    <span>Loading PDF...</span>
                                </div>
                            }
                            error={
                                <div className="flex flex-col items-center gap-4 text-white">
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
                            className="flex flex-col items-center overflow-auto max-h-[calc(85vh-50px)] w-full"
                        >
                            {Array.from(new Array(numPages || 0), (el, index) => (
                                <Page
                                    key={`page_${index + 1}`}
                                    pageNumber={index + 1}
                                    renderTextLayer={false}
                                    renderAnnotationLayer={false}
                                    width={Math.min(window.innerWidth * 0.85, 800)}
                                    className="mb-5 shadow-lg [&_canvas]:max-w-full [&_canvas]:h-auto! [&_canvas]:rounded-md"
                                />
                            ))}
                        </Document>
                    </div>
                ) : (
                    <img
                        src={apiService.getThumbnailUrl(photo.id)}
                        alt={photo.name}
                        className="max-w-full max-h-full object-contain drop-shadow-2xl rounded-sm"
                    />
                )}
            </div>
        </div>,
        document.body
    );
};
