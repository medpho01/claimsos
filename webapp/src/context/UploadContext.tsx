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

    // Upload a single file
    const uploadFile = useCallback(async (item: GlobalUploadQueueItem) => {
        setUploadQueue(prev => prev.map(i =>
            i.id === item.id ? { ...i, status: "uploading" as const, progress: 10 } : i
        ));

        try {
            // Simulate progress for better UX
            const progressInterval = setInterval(() => {
                setUploadQueue(prev => prev.map(i =>
                    i.id === item.id && i.status === "uploading"
                        ? { ...i, progress: Math.min(i.progress + 15, 85) }
                        : i
                ));
            }, 200);

            await apiService.uploadFilesAsAdmin(
                item.patientId,
                [item.file],
                item.category !== 'all' ? item.category : undefined,
                item.customName
            );

            clearInterval(progressInterval);
            setUploadQueue(prev => prev.map(i =>
                i.id === item.id ? { ...i, status: "success" as const, progress: 100 } : i
            ));

            // Execute success callback if provided (e.g., to refresh photo list)
            if (item.onSuccess) {
                await item.onSuccess();
            }

        } catch (error) {
            console.error('Upload error:', error);
            setUploadQueue(prev => prev.map(i =>
                i.id === item.id ? { ...i, status: "error" as const, error: 'Upload failed' } : i
            ));
        }
    }, []);

    // Process queue effect
    useEffect(() => {
        const pendingItems = uploadQueue.filter(i => i.status === 'pending');
        const uploadingItems = uploadQueue.filter(i => i.status === 'uploading');

        // Simple concurrency limit: 1 upload at a time
        if (pendingItems.length > 0 && uploadingItems.length === 0) {
            uploadFile(pendingItems[0]);
        }
    }, [uploadQueue, uploadFile]);

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
