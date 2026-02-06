import { z } from "zod";
import { Patient } from "../../../types";

export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    thumbnailLink?: string;
    webViewLink?: string;
    createdTime?: string;
}

export interface PhotoCategory {
    id: string;
    name: string;
    displayName: string;
    photos: DriveFile[];
}

export interface PhotosData {
    rootPhotos: DriveFile[];
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
            (val) => val === "" || /^[0-9]{10}$/.test(val),
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
