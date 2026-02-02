import { useState, useCallback } from "react";
import apiService from "../../../../services/api";
import { PhotosData } from "../types";

// In-memory cache
export const photosCache = new Map<string, { data: PhotosData; timestamp: number }>();
const CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const usePhotosData = (patientId: string) => {
    const [photosData, setPhotosData] = useState<PhotosData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isCached, setIsCached] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    const fetchPhotos = useCallback(async (forceRefresh = false) => {
        try {
            if (!forceRefresh) {
                const cached = photosCache.get(patientId);
                if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
                    console.log("[PHOTOS] Using cached data for patient:", patientId);
                    setPhotosData(cached.data);
                    setIsCached(true);
                    setLoading(false);
                    return;
                }
            }

            setLoading(true);
            setError(null);
            setIsCached(false);

            const response = await apiService.getPatientPhotos(patientId);
            const data = response.data.data;

            let normalizedData: PhotosData;
            if (Array.isArray(data)) {
                normalizedData = { rootPhotos: data, categories: [] };
            } else {
                normalizedData = data;
            }

            photosCache.set(patientId, {
                data: normalizedData,
                timestamp: Date.now(),
            });

            setPhotosData(normalizedData);
        } catch (err: any) {
            console.error("Failed to fetch photos:", err);
            setError(err.response?.data?.message || "Failed to load photos");
        } finally {
            setLoading(false);
        }
    }, [patientId]);

    const deleteFiles = useCallback(async (fileIds: string[]) => {
        if (fileIds.length === 0) return;
        setIsDeleting(true);
        let successCount = 0;
        let errorCount = 0;

        try {
            for (const id of fileIds) {
                try {
                    await apiService.deleteFile(id);
                    successCount++;
                } catch (err) {
                    console.error(`Failed to delete file ${id}:`, err);
                    errorCount++;
                }
                await new Promise((r) => setTimeout(r, 100)); // Rate limit
            }

            if (errorCount > 0) {
                alert(`Deleted ${successCount} file(s). Failed to delete ${errorCount} file(s).`);
            }

            // Refresh
            photosCache.delete(patientId);
            await fetchPhotos(true);
        } catch (error) {
            console.error("Delete error:", error);
            alert("An error occurred while deleting files.");
        } finally {
            setIsDeleting(false);
        }
    }, [patientId, fetchPhotos]);

    return {
        photosData,
        loading,
        error,
        isCached,
        isDeleting,
        fetchPhotos,
        deleteFiles
    };
};
