import React, { useState, useCallback, useRef } from "react";
import { UploadContextType } from "../../../../context/UploadContext";

interface UseLocalDragDropProps {
    patientId: string;
    activeCategory: string;
    startUpload: UploadContextType["startUpload"];
    onUploadSuccess: () => Promise<void>;
}

export const useLocalDragDrop = ({
    patientId,
    activeCategory,
    startUpload,
    onUploadSuccess
}: UseLocalDragDropProps) => {
    const [isLocalDragging, setIsLocalDragging] = useState(false);
    const dragCounter = useRef(0);

    const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current++;
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            setIsLocalDragging(true);
        }
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current--;
        if (dragCounter.current === 0) {
            setIsLocalDragging(false);
        }
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsLocalDragging(false);
        dragCounter.current = 0;

        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            startUpload(files, patientId, activeCategory, onUploadSuccess);
        }
    }, [startUpload, patientId, activeCategory, onUploadSuccess]);

    return {
        isLocalDragging,
        dragHandlers: {
            onDragEnter: handleDragEnter,
            onDragLeave: handleDragLeave,
            onDragOver: handleDragOver,
            onDrop: handleDrop
        }
    };
};
