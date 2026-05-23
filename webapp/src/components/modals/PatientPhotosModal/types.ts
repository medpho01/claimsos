import { z } from "zod";
import { Patient } from "../../../types";

export interface MediaFile {
    id: string;
    name: string;
    mimeType: string;
    thumbnailLink?: string;
    webViewLink?: string;       // Presigned S3 URL (legacy key name retained for BE compat)
    createdTime?: string;
    type?: string;              // V2: category (e.g., "discharge_slip")
    fileSize?: number;          // V2: file size in bytes
    storageProvider?: string;   // V2: storage backend identifier
    proxyLink?: string;         // V2: Backend proxy link for CORS-free access
}

export interface PhotoCategory {
    id: string;
    name: string;
    displayName: string;
    photos: MediaFile[];
}

export interface PhotosData {
    rootPhotos: MediaFile[];
    categories: PhotoCategory[];
    admissionType?: "conservative" | "surgical";
}

export interface PatientPhotosModalProps {
    patient: Patient;
    onClose: (shouldRefresh?: boolean) => void;
    onUpdate?: (
        patientId: string,
        data: {
            firstName: string;
            lastName?: string;
            phone: string;
            admittedAt: string;
            admissionType?: "conservative" | "surgical";
            // IPD fields
            beneficiaryId?: string;
            // Claims fields
            treatmentPlan?: string;
            latestStatus?: string;
            claimAmount?: number;
            claimApproved?: number;
            incentive?: number;
            deduction?: number;
            deductionReason?: string;
            claimSettled?: number;
            claimSettledDate?: string;
        }
    ) => Promise<void>;
}

// Zod validation schemas
export const ipdFormSchema = z.object({
    phone: z
        .string()
        .refine(
            (val) => {
                const digits = val.replace(/\D/g, '');
                return val === "" || digits.length === 10;
            },
            { message: "Phone number must be exactly 10 digits" }
        ),
    beneficiaryId: z.string().optional(),
    admissionType: z.enum(["", "conservative", "surgical"]),
});

export const claimsFormSchema = z.object({
    treatmentPlan: z.string().optional(),
    latestStatus: z.string().optional(),
    claimAmount: z
        .string()
        .refine((val) => val === "" || (!isNaN(parseFloat(val)) && parseFloat(val) >= 0), {
            message: "Must be a valid positive number",
        })
        .optional(),
    claimApproved: z
        .string()
        .refine((val) => val === "" || (!isNaN(parseFloat(val)) && parseFloat(val) >= 0), {
            message: "Must be a valid positive number",
        })
        .optional(),
    incentive: z
        .string()
        .refine((val) => val === "" || (!isNaN(parseFloat(val)) && parseFloat(val) >= 0), {
            message: "Must be a valid positive number",
        })
        .optional(),
    deduction: z
        .string()
        .refine((val) => val === "" || (!isNaN(parseFloat(val)) && parseFloat(val) >= 0), {
            message: "Must be a valid positive number",
        })
        .optional(),
    deductionReason: z.string().optional(),
    claimSettled: z
        .string()
        .refine((val) => val === "" || (!isNaN(parseFloat(val)) && parseFloat(val) >= 0), {
            message: "Must be a valid positive number",
        })
        .optional(),
    claimSettledDate: z.string().optional(),
});

export type IpdFormData = z.infer<typeof ipdFormSchema>;
export type ClaimsFormData = z.infer<typeof claimsFormSchema>;

// Upload queue types
export interface UploadQueueItem {
    id: string;
    file: File;
    status: "pending" | "uploading" | "success" | "error";
    progress: number;
    error?: string;
    previewUrl?: string;
    customName?: string;
}
