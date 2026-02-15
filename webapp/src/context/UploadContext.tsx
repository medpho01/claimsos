import React, { createContext, useContext, useState, useCallback, useRef, useEffect, ReactNode } from 'react';
import apiService from '../services/api';
import { validateFile } from '../components/modals/PatientPhotosModal/utils';
import { UploadQueueItem } from '../components/modals/PatientPhotosModal/types';

// Extended type to include metadata needed for global context (like patientId)
export interface GlobalUploadQueueItem extends UploadQueueItem {
    patientId: string;
    category?: string;
    onSuccess?: () => Promise<void>; // Optional callback to refresh data in specific components
}

export interface UploadContextType {
    uploadQueue: GlobalUploadQueueItem[];
    isQueueVisible: boolean;
    isQueueMinimized: boolean;
    setIsQueueVisible: (visible: boolean) => void;
    setIsQueueMinimized: (minimized: boolean) => void;
    startUpload: (files: File[], patientId: string, category: string, onSuccess?: () => Promise<void>, customName?: string) => void;
    retryUpload: (itemId: string) => void;
    cancelUpload: (itemId: string) => void;
    clearCompleted: () => void;
}

const UploadContext = createContext<UploadContextType | undefined>(undefined);

export const UploadProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [uploadQueue, setUploadQueue] = useState<GlobalUploadQueueItem[]>([]);
    const [isQueueVisible, setIsQueueVisible] = useState(false);
    const [isQueueMinimized, setIsQueueMinimized] = useState(false);

    // Batch upload logic
    const uploadBatch = useCallback(async (items: GlobalUploadQueueItem[]) => {
        if (items.length === 0) return;
        const itemIds = items.map(i => i.id);
        const firstItem = items[0];

        // 1. Set status to uploading
        setUploadQueue(prev => prev.map(i =>
            itemIds.includes(i.id) ? { ...i, status: "uploading" as const, progress: 10 } : i
        ));

        let progressInterval: NodeJS.Timeout;

        try {
            // Simulate progress for better UX
            progressInterval = setInterval(() => {
                setUploadQueue(prev => prev.map(i =>
                    itemIds.includes(i.id) && i.status === "uploading"
                        ? { ...i, progress: Math.min(i.progress + 15, 85) }
                        : i
                ));
            }, 200);

            await apiService.uploadPhotosV2(
                firstItem.patientId,
                items.map(i => i.file),
                firstItem.category !== 'all' ? firstItem.category : undefined
            );

            clearInterval(progressInterval);

            // 2. Set status to success
            setUploadQueue(prev => prev.map(i =>
                itemIds.includes(i.id) ? { ...i, status: "success" as const, progress: 100 } : i
            ));

            // 3. Execute success callback ONCE for the batch
            if (firstItem.onSuccess) {
                await firstItem.onSuccess();
            }

        } catch (error) {
            console.error('Batch upload error:', error);
            if (progressInterval!) clearInterval(progressInterval);

            setUploadQueue(prev => prev.map(i =>
                itemIds.includes(i.id) ? { ...i, status: "error" as const, error: 'Upload failed' } : i
            ));
        }
    }, []);

    // Process queue effect
    useEffect(() => {
        const pendingItems = uploadQueue.filter(i => i.status === 'pending');
        const uploadingItems = uploadQueue.filter(i => i.status === 'uploading');

        // Simple concurrency limit: 1 batch at a time
        if (pendingItems.length > 0 && uploadingItems.length === 0) {
            const firstItem = pendingItems[0];
            // Group all compatible pending items into one batch
            const batchItems = pendingItems.filter(i =>
                i.patientId === firstItem.patientId &&
                i.category === firstItem.category
            );

            uploadBatch(batchItems);
        }
    }, [uploadQueue, uploadBatch]);

    // Cleanup URLs on unmount
    useEffect(() => {
        return () => {
            uploadQueue.forEach(item => {
                if (item.previewUrl) {
                    URL.revokeObjectURL(item.previewUrl);
                }
            });
        };
    }, []);

    const startUpload = useCallback((files: File[], patientId: string, category: string, onSuccess?: () => Promise<void>, customName?: string) => {
        if (files.length === 0) return;

        const newItems: GlobalUploadQueueItem[] = files.map(file => {
            const validation = validateFile(file);
            const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;

            return {
                id: Math.random().toString(36).substring(7),
                file,
                patientId,
                category,
                onSuccess,
                customName,
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

    return (
        <UploadContext.Provider value={{
            uploadQueue,
            isQueueVisible,
            isQueueMinimized,
            setIsQueueVisible,
            setIsQueueMinimized,
            startUpload,
            retryUpload,
            cancelUpload,
            clearCompleted
        }}>
            {children}
        </UploadContext.Provider>
    );
};

export const useUploadContext = () => {
    const context = useContext(UploadContext);
    if (context === undefined) {
        throw new Error('useUploadContext must be used within an UploadProvider');
    }
    return context;
};
