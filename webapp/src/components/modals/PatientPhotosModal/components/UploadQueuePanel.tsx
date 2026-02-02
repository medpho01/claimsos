import React from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { UploadQueueItem } from "../types";
import { formatFileSize } from "../utils";

interface UploadQueuePanelProps {
    uploadQueue: UploadQueueItem[];
    isVisible: boolean;
    isMinimized: boolean;
    setIsMinimized: (val: boolean) => void;
    setIsVisible: (val: boolean) => void;
    onRetry: (id: string) => void;
    onCancel: (id: string) => void;
    onClear: () => void;
    usePortal?: boolean;
}

export const UploadQueuePanel: React.FC<UploadQueuePanelProps> = ({
    uploadQueue,
    isVisible,
    isMinimized,
    setIsMinimized,
    setIsVisible,
    onRetry,
    onCancel,
    onClear,
    usePortal = true
}) => {
    const show = isVisible && uploadQueue.length > 0;

    const content = (
        <AnimatePresence>
            {show && (
                <motion.div
                    key="upload-queue-panel"
                    initial={{ opacity: 0, y: 20, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 20, scale: 0.95 }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    className="fixed bottom-6 right-6 z-[9999] w-[380px] max-w-[calc(100vw-48px)] pointer-events-auto shadow-2xl"
                >
                    <div className="bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-slate-200/80 overflow-hidden">
                        {/* Header */}
                        <div className="px-4 py-3 bg-gradient-to-r from-slate-50 to-slate-100/80 border-b border-slate-200/60 flex justify-between items-center">
                            <div className="flex items-center gap-3">
                                <div className="relative">
                                    {/* Circular progress indicator */}
                                    <svg className="w-8 h-8 -rotate-90" viewBox="0 0 36 36">
                                        <path
                                            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                            fill="none"
                                            stroke="#e2e8f0"
                                            strokeWidth="3"
                                        />
                                        <motion.path
                                            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                            fill="none"
                                            stroke="#6366f1"
                                            strokeWidth="3"
                                            strokeLinecap="round"
                                            initial={{ strokeDasharray: "0 100" }}
                                            animate={{
                                                strokeDasharray: `${(uploadQueue.filter(i => i.status === 'success').length / uploadQueue.length) * 100} 100`
                                            }}
                                            transition={{ duration: 0.5, ease: "easeOut" }}
                                        />
                                    </svg>
                                    <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-slate-600">
                                        {uploadQueue.filter(i => i.status === 'success').length}/{uploadQueue.length}
                                    </span>
                                </div>
                                <div>
                                    <h3 className="font-semibold text-sm text-slate-800">Uploading Files</h3>
                                    <p className="text-xs text-slate-500">
                                        {uploadQueue.some(i => i.status === 'uploading' || i.status === 'pending')
                                            ? `${uploadQueue.filter(i => i.status === 'pending').length} remaining...`
                                            : 'All uploads complete'}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-1">
                                {/* Minimize button */}
                                <button
                                    onClick={() => setIsMinimized(!isMinimized)}
                                    className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        {isMinimized ? (
                                            <polyline points="18 15 12 9 6 15" />
                                        ) : (
                                            <polyline points="6 9 12 15 18 9" />
                                        )}
                                    </svg>
                                </button>
                                {/* Close button - only when done */}
                                {!uploadQueue.some(i => i.status === 'uploading' || i.status === 'pending') && (
                                    <button
                                        onClick={() => {
                                            onClear();
                                            setIsVisible(false);
                                        }}
                                        className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <line x1="18" y1="6" x2="6" y2="18"></line>
                                            <line x1="6" y1="6" x2="18" y2="18"></line>
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Queue items - collapsible */}
                        <motion.div
                            initial={false}
                            animate={{ height: isMinimized ? 0 : 'auto' }}
                            className="overflow-hidden"
                        >
                            <div className="max-h-[50vh] overflow-y-auto p-3 space-y-2">
                                <AnimatePresence initial={false} mode="popLayout">
                                    {uploadQueue.map((item) => (
                                        <motion.div
                                            key={item.id}
                                            initial={{ opacity: 0, x: 20 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                                            layout
                                            className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${item.status === 'success' ? 'bg-emerald-50/50 border-emerald-100' :
                                                item.status === 'error' ? 'bg-red-50/50 border-red-100' :
                                                    item.status === 'uploading' ? 'bg-indigo-50/50 border-indigo-100' :
                                                        'bg-slate-50/50 border-slate-100'
                                                }`}
                                        >
                                            {/* File preview/icon */}
                                            <div className="w-11 h-11 rounded-lg overflow-hidden flex-shrink-0 bg-slate-100 border border-slate-200/50">
                                                {item.previewUrl ? (
                                                    <img
                                                        src={item.previewUrl}
                                                        alt=""
                                                        className="w-full h-full object-cover"
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center">
                                                        {item.file.type.includes('pdf') ? (
                                                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="1.5">
                                                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                                <polyline points="14 2 14 8 20 8" />
                                                            </svg>
                                                        ) : (
                                                            <span className="text-[10px] font-bold text-slate-400 uppercase">
                                                                {item.file.name.split('.').pop()}
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                            </div>

                                            {/* File info */}
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium text-slate-700 truncate" title={item.file.name}>
                                                    {item.file.name}
                                                </p>
                                                <div className="flex items-center gap-2 mt-0.5">
                                                    <span className="text-xs text-slate-400">{formatFileSize(item.file.size)}</span>
                                                    {item.error && (
                                                        <span className="text-xs text-red-500">{item.error}</span>
                                                    )}
                                                </div>
                                                {/* Progress bar for uploading items */}
                                                {item.status === 'uploading' && (
                                                    <div className="mt-2 h-1 w-full bg-slate-200 rounded-full overflow-hidden">
                                                        <motion.div
                                                            className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full"
                                                            initial={{ width: 0 }}
                                                            animate={{ width: `${item.progress}%` }}
                                                            transition={{ type: "spring", stiffness: 100, damping: 20 }}
                                                        />
                                                    </div>
                                                )}
                                            </div>

                                            {/* Status/Actions */}
                                            <div className="flex-shrink-0 flex items-center gap-1">
                                                {item.status === 'success' && (
                                                    <div className="w-7 h-7 rounded-full bg-emerald-100 flex items-center justify-center">
                                                        <svg className="text-emerald-600" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                                            <polyline points="20 6 9 17 4 12"></polyline>
                                                        </svg>
                                                    </div>
                                                )}
                                                {item.status === 'error' && (
                                                    <>
                                                        <button
                                                            onClick={() => onRetry(item.id)}
                                                            className="p-1.5 text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                                                            title="Retry upload"
                                                        >
                                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                <path d="M23 4v6h-6M1 20v-6h6" />
                                                                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                                                            </svg>
                                                        </button>
                                                        <button
                                                            onClick={() => onCancel(item.id)}
                                                            className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                                                            title="Remove"
                                                        >
                                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                                                <line x1="6" y1="6" x2="18" y2="18"></line>
                                                            </svg>
                                                        </button>
                                                    </>
                                                )}
                                                {item.status === 'uploading' && (
                                                    <div className="w-7 h-7 flex items-center justify-center">
                                                        <svg className="animate-spin text-indigo-500" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                            <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                                                        </svg>
                                                    </div>
                                                )}
                                                {item.status === 'pending' && (
                                                    <button
                                                        onClick={() => onCancel(item.id)}
                                                        className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                                                        title="Cancel"
                                                    >
                                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                            <line x1="18" y1="6" x2="6" y2="18"></line>
                                                            <line x1="6" y1="6" x2="18" y2="18"></line>
                                                        </svg>
                                                    </button>
                                                )}
                                            </div>
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                            </div>

                            {/* Footer with clear button */}
                            {uploadQueue.some(i => i.status === 'success' || i.status === 'error') &&
                                !uploadQueue.some(i => i.status === 'uploading') && (
                                    <div className="px-3 pb-3">
                                        <button
                                            onClick={onClear}
                                            className="w-full py-2 text-sm font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-lg transition-colors"
                                        >
                                            Clear completed
                                        </button>
                                    </div>
                                )}
                        </motion.div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );

    if (usePortal) {
        return createPortal(content, document.body);
    }

    return content;
};
