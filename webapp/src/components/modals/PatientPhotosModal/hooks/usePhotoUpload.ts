import { useState, useCallback, useRef, DragEvent, useEffect } from "react";
import apiService from "../../../../services/api";
import { UploadQueueItem } from "../types";
import { validateFile } from "../utils";

interface UsePhotoUploadProps {
    patientId: string;
    activeCategory: string;
    onUploadSuccess: () => Promise<void>;
}

export const usePhotoUpload = ({ patientId, activeCategory, onUploadSuccess }: UsePhotoUploadProps) => {
    const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
    const [isQueueVisible, setIsQueueVisible] = useState(false);
    const [isQueueMinimized, setIsQueueMinimized] = useState(false);
    const [isDragging, setIsDragging] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragCounter = useRef(0);

    // Upload functionality
    const processFiles = useCallback((files: File[]) => {
        if (files.length === 0) return;

        const newItems: UploadQueueItem[] = files.map(file => {
            const validation = validateFile(file);
            const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;

            return {
                id: Math.random().toString(36).substring(7),
                file,
                status: validation.valid ? "pending" as const : "error" as const,
                progress: validation.valid ? 0 : 100,
                error: validation.error,
                previewUrl
            };
        });

        setUploadQueue(prev => [...prev, ...newItems]);
        setIsQueueVisible(true);
        setIsQueueMinimized(false);
    }, []);

    const uploadFile = useCallback(async (item: UploadQueueItem) => {
        setUploadQueue(prev => prev.map(i =>
            i.id === item.id ? { ...i, status: "uploading" as const, progress: 10 } : i
        ));

        try {
            // Simulate progress
            const progressInterval = setInterval(() => {
                setUploadQueue(prev => prev.map(i =>
                    i.id === item.id && i.status === "uploading"
                        ? { ...i, progress: Math.min(i.progress + 15, 85) }
                        : i
                ));
            }, 200);

            await apiService.uploadPhotosV2(patientId, [item.file], activeCategory !== 'all' ? activeCategory : undefined);

            clearInterval(progressInterval);
            setUploadQueue(prev => prev.map(i =>
                i.id === item.id ? { ...i, status: "success" as const, progress: 100 } : i
            ));

            // Refresh photos after successful upload
            await onUploadSuccess();
        } catch (error) {
            console.error('Upload error:', error);
            setUploadQueue(prev => prev.map(i =>
                i.id === item.id ? { ...i, status: "error" as const, error: 'Upload failed' } : i
            ));
        }
    }, [patientId, activeCategory, onUploadSuccess]);

    // Process pending uploads
    useEffect(() => {
        const pendingItems = uploadQueue.filter(i => i.status === 'pending');
        const uploadingItems = uploadQueue.filter(i => i.status === 'uploading');

        // Upload one at a time
        if (pendingItems.length > 0 && uploadingItems.length === 0) {
            uploadFile(pendingItems[0]);
        }
    }, [uploadQueue, uploadFile]);

    // Cleanup preview URLs on unmount
    useEffect(() => {
        return () => {
            uploadQueue.forEach(item => {
                if (item.previewUrl) {
                    URL.revokeObjectURL(item.previewUrl);
                }
            });
        };
    }, []);

    const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current++;
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            setIsDragging(true);
        }
    }, []);

    const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current--;
        if (dragCounter.current === 0) {
            setIsDragging(false);
        }
    }, []);

    const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        dragCounter.current = 0;

        const files = Array.from(e.dataTransfer.files);
        processFiles(files);
    }, [processFiles]);

    const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            processFiles(Array.from(e.target.files));
            e.target.value = ''; // Reset input
        }
    };

    const retryUpload = useCallback((itemId: string) => {
        setUploadQueue(prev => prev.map(item =>
            item.id === itemId
                ? { ...item, status: "pending" as const, progress: 0, error: undefined }
                : item
        ));
    }, []);

    const cancelUpload = useCallback((itemId: string) => {
        setUploadQueue(prev => {
            const item = prev.find(i => i.id === itemId);
            if (item?.previewUrl) {
                URL.revokeObjectURL(item.previewUrl);
            }
            return prev.filter(i => i.id !== itemId);
        });
    }, []);

    const clearCompleted = useCallback(() => {
        setUploadQueue(prev => {
            prev.forEach(item => {
                if ((item.status === 'success' || item.status === 'error') && item.previewUrl) {
                    URL.revokeObjectURL(item.previewUrl);
                }
            });
            return prev.filter(i => i.status === 'uploading' || i.status === 'pending');
        });
    }, []);

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    return {
        uploadQueue,
        isQueueVisible,
        setIsQueueVisible,
        isQueueMinimized,
        setIsQueueMinimized,
        isDragging,
        fileInputRef,
        processFiles,
        handleDragEnter,
        handleDragLeave,
        handleDragOver,
        handleDrop,
        handleFileInputChange,
        retryUpload,
        cancelUpload,
        clearCompleted,
        handleUploadClick
    };
};
