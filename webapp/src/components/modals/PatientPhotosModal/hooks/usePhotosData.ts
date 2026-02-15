import { useState, useCallback } from "react";
import apiService from "../../../../services/api";
import { PhotosData, DriveFile, PhotoCategory } from "../types";

// In-memory cache
export const photosCache = new Map<string, { data: PhotosData; timestamp: number }>();
const CACHE_DURATION_MS = 50 * 60 * 1000; // 50 minutes (presigned URLs expire in 1 hour)

// Category display names mapping
const FIELD_NAMES: Record<string, string> = {
    discharge_slip: 'Discharge Slip',
    investigations: 'Investigations',
    treatment: 'Treatment',
    icps: 'ICPs',
    surgical_discharge_slip: 'Surgical Discharge Slip',
    ot_notes_and_photos: 'OT Notes and Photos',
    post_op_photos: 'Post Op Photos',
    post_op_reports: 'Post Op Reports',
    implant_invoice: 'Implant Invoice',
    others: 'Others',
};

const KNOWN_CATEGORIES = new Set(Object.keys(FIELD_NAMES));

/**
 * Group a flat array of photos (V2 response) into the PhotosData structure
 * that the webapp's category tabs expect.
 */
const CONSERVATIVE_CATEGORIES = [
    'discharge_slip',
    'investigations',
    'treatment',
    'icps',
    'others'
];

const SURGICAL_CATEGORIES = [
    'surgical_discharge_slip',
    'ot_notes_and_photos',
    'post_op_photos',
    'post_op_reports',
    'implant_invoice',
    'others'
];

/**
 * Group a flat array of photos (V2 response) into the PhotosData structure
 * that the webapp's category tabs expect.
 */
function groupPhotosIntoCategories(photos: DriveFile[], admissionType?: string): PhotosData {
    const rootPhotos: DriveFile[] = [];
    const categoryMap = new Map<string, DriveFile[]>();

    const targetCategories = admissionType === 'surgical'
        ? SURGICAL_CATEGORIES
        : CONSERVATIVE_CATEGORIES;

    // Filter KNOWN_CATEGORIES based on admission type
    const allowedCategories = new Set(targetCategories);

    for (const photo of photos) {
        const type = photo.type?.toLowerCase().replaceAll(" ", "_");
        // Only map if it's a known category AND allowed for this admission type
        if (type && KNOWN_CATEGORIES.has(type)) {
            if (allowedCategories.has(type)) {
                if (!categoryMap.has(type)) {
                    categoryMap.set(type, []);
                }
                categoryMap.get(type)!.push(photo);
            } else {

                rootPhotos.push(photo);
            }
        } else {
            // Photos without a known category go to root (admission files)
            rootPhotos.push(photo);
        }
    }

    const categories: PhotoCategory[] = [];
    // Add categories in the order defined by FIELD_NAMES
    for (const [key, displayName] of Object.entries(FIELD_NAMES)) {
        // Skip if not in allowed list
        if (!allowedCategories.has(key)) continue;

        const categoryPhotos = categoryMap.get(key) || [];
        categories.push({
            id: key,
            name: key,
            displayName,
            photos: categoryPhotos,
        });
    }

    return { rootPhotos, categories };
}

export const usePhotosData = (patientId: string, admissionType?: string) => {
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

            const response = await apiService.getPhotosV2(patientId);
            const data = response.data.data;

            let normalizedData: PhotosData;
            if (Array.isArray(data)) {
                // V2 returns a flat array → group into categories
                normalizedData = groupPhotosIntoCategories(data, admissionType);
            } else {
                // Fallback: already structured (V1 format)
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
    }, [patientId, admissionType]);

    const deleteFiles = useCallback(async (fileIds: string[]) => {
        if (fileIds.length === 0) return;
        setIsDeleting(true);

        try {
            // V2: batch delete in a single call
            await apiService.deletePhotosV2(patientId, fileIds);

            // Refresh
            photosCache.delete(patientId);
            await fetchPhotos(true);
        } catch (error: any) {
            console.error("Delete error:", error);
            alert(error.response?.data?.message || "An error occurred while deleting files.");
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
