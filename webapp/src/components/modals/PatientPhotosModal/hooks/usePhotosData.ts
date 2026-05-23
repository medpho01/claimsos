import { useState, useCallback } from "react";
import apiService from "../../../../services/api";
import { PhotosData, DriveFile, PhotoCategory } from "../types";
import { toast } from 'sonner';

// In-memory cache
export const photosCache = new Map<string, { data: PhotosData; timestamp: number }>();
const CACHE_DURATION_MS = 50 * 60 * 1000; // 50 minutes (presigned URLs expire in 1 hour)

// Category display names mapping. `insurer_response` was previously absent
// from this map, which meant every attachment auto-mirrored from an inbound
// insurer email landed in the "Admission Files" bucket — making it hard for
// ops to find the approval/query letter they were looking for. Adding it
// here surfaces a dedicated pill, regardless of admission_type.
//
// NOTE (Stage 1A — doc_taxonomy_expansion / migration 042): The canonical
// vocabulary now lives in hospital.master_options under category='doc_category'
// (~215 codes across 15 doc_category_group buckets). New code paths that need
// to render or validate document categories should fetch dynamically via
// `useMasterOptions('doc_category')` instead of relying on this static map.
// This map is intentionally NOT removed — existing PhotosModal callers depend
// on the narrow, admission-type-aware ordering it provides for the photo pills.
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
    insurer_response: 'Insurer Responses',
    others: 'Others',
};

const KNOWN_CATEGORIES = new Set(Object.keys(FIELD_NAMES));

/**
 * Group a flat array of photos (V2 response) into the PhotosData structure
 * that the webapp's category tabs expect.
 *
 * `insurer_response` is appended to both conservative + surgical lists so the
 * pill shows up regardless of admission type — attachments auto-saved from
 * inbound insurer email always have a visible home.
 */
const CONSERVATIVE_CATEGORIES = [
    'discharge_slip',
    'investigations',
    'treatment',
    'icps',
    'insurer_response',
    'others'
];

const SURGICAL_CATEGORIES = [
    'surgical_discharge_slip',
    'ot_notes_and_photos',
    'post_op_photos',
    'post_op_reports',
    'implant_invoice',
    'insurer_response',
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
        // LAYER 3 DEDUP: prefer AI-classified category over the upload-
        // time bucket. Backend ships `ai_category` (primary section's
        // category, ordered by page_start) when the doc has been
        // classified; falls back to `type` (upload bucket) otherwise.
        // Stops the "uploaded as surgical_discharge_slip but really an
        // implant_sticker" file from being counted in BOTH tabs.
        //
        // Multi-section PDFs carry an `ai_categories` array — we put
        // the file under its FIRST category here (so the count stays
        // 1-per-file) and the FE's expand affordance shows the rest.
        const aiCategory = ((photo as any).ai_category as string | null | undefined)?.toLowerCase().replaceAll(" ", "_");
        const uploadType = photo.type?.toLowerCase().replaceAll(" ", "_");
        const type = aiCategory || uploadType;
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

            // Fire BOTH requests in parallel — meta is fast, full has CloudFront URLs
            let metaHandled = false;
            const metaPromise = apiService.getPhotosMetaV2(patientId)
                .then(res => {
                    const metaData = res.data.data;
                    if (Array.isArray(metaData) && metaData.length > 0) {
                        const metaNormalized = groupPhotosIntoCategories(metaData, admissionType);
                        setPhotosData(metaNormalized);
                        setLoading(false); // Cards with names appear NOW
                        metaHandled = true;
                    }
                })
                .catch(() => { }); // Silent fail — full response will handle it

            const fullPromise = apiService.getPhotosV2(patientId);

            // Wait for both (meta finishes first → shows cards, full finishes → updates images)
            const [, fullResponse] = await Promise.all([metaPromise, fullPromise]);
            const data = fullResponse.data.data;

            let normalizedData: PhotosData;
            if (Array.isArray(data)) {
                normalizedData = groupPhotosIntoCategories(data, admissionType);
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
            toast.error(error.response?.data?.message || "An error occurred while deleting files.");
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
