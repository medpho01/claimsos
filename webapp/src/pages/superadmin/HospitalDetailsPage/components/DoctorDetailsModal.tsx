import React, { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import { Loader2, FileText, Trash2, UserCog } from "lucide-react";

import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { FlexibleDialogContent } from "@/components/ui/flexible-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import apiService from "../../../../services/api";
import { Doctor } from "../../../../types";
import { Lightbox } from "../../../../components/modals/PatientPhotosModal/components/Lightbox";
import { LazyImage } from "../../../../components/modals/PatientPhotosModal/components/LazyImage";
import { DoctorDocsUploadModal } from "./DoctorDocsModal";

const API_V2_BASE_URL = process.env.NODE_ENV === "production" ? "" : "http://localhost:8000";

const doctorSchema = z.object({
    firstName: z.string().min(2, "First Name must be at least 2 characters"),
    lastName: z.string().optional(),
    age: z.string().optional().transform(v => v ? parseInt(v) : undefined),
    speciality: z.string().optional(),
    phone: z.string().refine(val => !val || val.length === 10, { message: "Phone must be 10 digits" }).optional(),
    yearsOfExp: z.string().optional().transform(v => v ? parseInt(v) : undefined),
});

type DoctorFormValues = z.infer<typeof doctorSchema>;

interface DoctorDetailsModalProps {
    isOpen: boolean;
    doctor: Doctor | null;
    onClose: () => void;
    onRefresh: () => void;
}

export const DoctorDetailsModal: React.FC<DoctorDetailsModalProps> = ({
    isOpen,
    doctor,
    onClose,
    onRefresh
}) => {
    const [mainTab, setMainTab] = useState<'details' | 'docs'>('details');

    // Form state
    const [isSubmitting, setIsSubmitting] = useState(false);
    
    // Docs state
    const [doctorDocs, setDoctorDocs] = useState<any[]>([]);
    const [isLoadingDocs, setIsLoadingDocs] = useState(false);
    const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [selectedPhotoForLightbox, setSelectedPhotoForLightbox] = useState<any | null>(null);

    const {
        register,
        handleSubmit,
        reset,
        formState: { errors, isDirty }
    } = useForm<DoctorFormValues>({
        resolver: zodResolver(doctorSchema),
        defaultValues: {
            firstName: "",
            lastName: "",
            age: undefined,
            speciality: "",
            phone: "",
            yearsOfExp: undefined
        }
    });

    useEffect(() => {
        if (isOpen && doctor) {
            reset({
                firstName: doctor.first_name || "",
                lastName: doctor.last_name || "",
                age: doctor.age ? doctor.age : undefined,
                speciality: doctor.speciality || "",
                phone: doctor.phone || "",
                yearsOfExp: doctor.years_of_exp ? doctor.years_of_exp : undefined,
            } as any);
            fetchDoctorDocs(doctor.id);
        } else {
            setMainTab('details');
        }
    }, [isOpen, doctor, reset]);

    const handleFormSubmit = async (data: any) => {
        if (!doctor) return;
        setIsSubmitting(true);
        try {
            await apiService.updateDoctor(doctor.id, data);
            toast.success("Doctor updated successfully");
            onRefresh();
            reset(data); // Sync form state
        } catch (error: any) {
            toast.error(error.response?.data?.message || "Failed to update doctor");
        } finally {
            setIsSubmitting(false);
        }
    };

    const fetchDoctorDocs = async (doctorId: string) => {
        setIsLoadingDocs(true);
        try {
            const res = await apiService.getDoctorDocs(doctorId);
            setDoctorDocs(res.data.data || []);
        } catch (error) {
            toast.error("Failed to fetch documents");
        } finally {
            setIsLoadingDocs(false);
        }
    };

    const handleUploadDocs = async (files: File[], customNames: string[]) => {
        if (!doctor) return;
        setIsUploading(true);
        try {
            await apiService.uploadDoctorDocs(doctor.id, files, customNames);
            toast.success("Documents uploaded successfully");
            setIsUploadModalOpen(false);
            fetchDoctorDocs(doctor.id);
        } catch (error: any) {
             toast.error(error.response?.data?.message || "Failed to upload documents");
        } finally {
            setIsUploading(false);
        }
    };

    const handleDeleteDoc = async (docId: string) => {
        if (!window.confirm("Delete this document?")) return;
        try {
            await apiService.deleteDoctorDoc(docId);
            toast.success("Document deleted");
            if (doctor) fetchDoctorDocs(doctor.id);
        } catch (error) {
            toast.error("Failed to delete document");
        }
    };

    const downloadFile = async (file: any) => {
        try {
            let fetchUrl = file.webViewLink || "";
            const headers: HeadersInit = {};

            if (file.proxyLink) {
                fetchUrl = file.proxyLink;
                const token = localStorage.getItem("accessToken");
                if (token) {
                    headers["Authorization"] = `Bearer ${token}`;
                }
            }

            const response = await fetch(API_V2_BASE_URL + fetchUrl, { headers });
            const blob = await response.blob();
            let fileName = file.name;

            if (file.mimeType != "application/pdf") {
                fileName = fileName.split(".")[0] + ".jpeg";
            } else if (file.mimeType === "application/pdf") {
                fileName = fileName.split(".")[0] + ".pdf";
            }

            const url = window.URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);
        } catch (err) {
            console.error("Download error", err);
        }
    };

    if (!doctor) return null;

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogTitle></DialogTitle>
            <FlexibleDialogContent className="max-w-[800px] h-[80vh] flex flex-col p-0 overflow-hidden sm:rounded-xl">
                
                {/* Header Section */}
                <div className="bg-slate-900 text-white p-6 relative flex-shrink-0">
                    <div className="flex items-start justify-between">
                        <div className="flex items-center gap-4">
                            <div className="h-14 w-14 rounded-full bg-brand-500/20 text-brand-50 flex items-center justify-center font-bold text-xl border border-brand-600/30">
                                {doctor.first_name?.[0]}{doctor.last_name?.[0]}
                            </div>
                            <div>
                                <h2 className="text-xl font-bold">Dr. {doctor.first_name} {doctor.last_name}</h2>
                                <div className="text-slate-300 text-sm flex items-center gap-2 mt-1">
                                    <span>{doctor.speciality || 'General Practitioner'}</span>
                                    {doctor.years_of_exp !== undefined && doctor.years_of_exp !== null && (
                                        <>
                                            <span className="w-1 h-1 rounded-full bg-slate-500"></span>
                                            <span>{doctor.years_of_exp} Years Exp</span>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-0 border-b border-slate-200 bg-slate-50 px-6 shrink-0">
                    <button
                        className={`flex items-center gap-2 px-6 py-4 border-b-2 text-[15px] font-medium transition-all ${mainTab === "details" ? "border-brand-600 text-brand-600 bg-white" : "border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100"}`}
                        onClick={() => setMainTab("details")}
                    >
                        <UserCog className="h-4 w-4" />
                        Details
                    </button>
                    <button
                        className={`flex items-center gap-2 px-6 py-4 border-b-2 text-[15px] font-medium transition-all ${mainTab === "docs" ? "border-brand-600 text-brand-600 bg-white" : "border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100"}`}
                        onClick={() => setMainTab("docs")}
                    >
                        <FileText className="h-4 w-4" />
                        Documents
                        <span className={`text-xs px-2 py-0.5 rounded-full ${mainTab === "docs" ? "bg-brand-50 text-brand-600" : "bg-slate-200 text-slate-500"}`}>
                            {doctorDocs.length}
                        </span>
                    </button>
                </div>

                {/* Content Area */}
                <div className="flex-1 overflow-y-auto w-full">
                    {mainTab === 'details' ? (
                        <div className="p-6">
                            <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-6 max-w-2xl mx-auto">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <Label htmlFor="firstName">First Name <span className="text-red-500">*</span></Label>
                                        <Input
                                            id="firstName"
                                            placeholder="John"
                                            {...register("firstName")}
                                            className={errors.firstName ? 'border-red-500' : ''}
                                        />
                                        {errors.firstName && <p className="text-red-500 text-xs">{errors.firstName.message}</p>}
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="lastName">Last Name</Label>
                                        <Input
                                            id="lastName"
                                            placeholder="Doe"
                                            {...register("lastName")}
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <Label htmlFor="age">Age</Label>
                                        <Input
                                            id="age"
                                            type="number"
                                            placeholder="e.g. 45"
                                            {...register("age")}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="phone">Phone Number</Label>
                                        <Input
                                            id="phone"
                                            type="tel"
                                            maxLength={10}
                                            placeholder="10-digit number"
                                            {...register("phone", {
                                                onChange: (e) => {
                                                    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10);
                                                }
                                            })}
                                            className={errors.phone ? 'border-red-500' : ''}
                                        />
                                        {errors.phone && <p className="text-red-500 text-xs">{errors.phone.message}</p>}
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <Label htmlFor="speciality">Speciality</Label>
                                        <Input
                                            id="speciality"
                                            placeholder="e.g. Cardiologist"
                                            {...register("speciality")}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="yearsOfExp">Years of Experience</Label>
                                        <Input
                                            id="yearsOfExp"
                                            type="number"
                                            placeholder="e.g. 15"
                                            {...register("yearsOfExp")}
                                        />
                                    </div>
                                </div>
                                
                                <div className="flex justify-end pt-4 border-t border-slate-100">
                                    <Button type="submit" disabled={!isDirty || isSubmitting} className="min-w-[120px]">
                                        {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                        {isSubmitting ? "Saving..." : "Save Changes"}
                                    </Button>
                                </div>
                            </form>
                        </div>
                    ) : (
                        <div className="p-6 h-full flex flex-col">
                            <div className="flex-1 h-full pt-2">
                                {isLoadingDocs ? (
                                    <div className="flex items-center justify-center h-48">
                                        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
                                    </div>
                                ) : doctorDocs.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center p-12 text-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50">
                                        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-slate-300 mb-4">
                                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                            <circle cx="8.5" cy="8.5" r="1.5" />
                                            <path d="M21 15l-5-5L5 21" />
                                        </svg>
                                        <h4 className="text-slate-700 font-medium mb-1">No documents found</h4>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-6 p-2">
                                        {doctorDocs.map((doc, index) => {
                                            const isPdf = doc.fileName?.toLowerCase().endsWith('.pdf') || doc.mimeType?.toLowerCase().includes("pdf");
                                            return (
                                                <div 
                                                    key={doc.id}
                                                    className="group relative flex flex-col bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition-all cursor-pointer hover:-translate-y-0.5"
                                                    onClick={() => setSelectedPhotoForLightbox({
                                                        id: doc.id,
                                                        name: doc.name,
                                                        mimeType: doc.mimeType,
                                                        webViewLink: doc.webViewLink,
                                                        proxyLink: doc.proxyLink
                                                    })}
                                                >
                                                    <div className="relative aspect-[4/3] bg-slate-50 overflow-hidden border-b border-slate-100/50">
                                                        {isPdf ? (
                                                            <div className="w-full h-full flex flex-col items-center justify-center bg-white gap-2">
                                                                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="1.5">
                                                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                                    <polyline points="14 2 14 8 20 8" />
                                                                    <path d="M10 12h-2v4h4" />
                                                                    <path d="M10 12l2 4" />
                                                                </svg>
                                                            </div>
                                                        ) : (
                                                            <LazyImage
                                                                thumbnailUrl={doc.thumbnailLink}
                                                                proxyUrl={doc.proxyLink || doc.webViewLink || null}
                                                                alt={doc.name}
                                                                priority={index < 6}
                                                            />
                                                        )}
                                                        {/* Hover Overlay */}
                                                        <div className="absolute inset-0 bg-black/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                                                    </div>

                                                    {/* Card Footer with Name */}
                                                    <div className="p-3 flex flex-col bg-white">
                                                        <div className="flex items-center gap-3">
                                                            <div className="shrink-0">
                                                                {isPdf ? (
                                                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
                                                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                                        <path d="M14 2v6h6" />
                                                                    </svg>
                                                                ) : (
                                                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
                                                                        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                                                                        <polyline points="14 2 14 8 20 8" />
                                                                        <path d="M8.5 13l2 2.5 3-3.5" />
                                                                    </svg>
                                                                )}
                                                            </div>
                                                            <div className="min-w-0 flex-1">
                                                                <p className="text-[13px] font-medium text-slate-700 truncate" title={doc.name}>
                                                                    {doc.name}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-2 mt-1 pl-7">
                                                            <p className="text-[11px] text-slate-500 capitalize">
                                                                <span className="font-medium">{(doc.fileSize / 1024).toFixed(1)} KB</span>
                                                                <span className="mx-1">•</span>
                                                                <span>{doc.storageProvider || 'Drive'}</span>
                                                            </p>
                                                        </div>
                                                    </div>
                                                    
                                                    <div className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <button 
                                                            className="p-1.5 bg-white/90 text-slate-600 hover:text-red-600 rounded-lg transition-colors shadow-sm border border-slate-200"
                                                            title="Delete"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleDeleteDoc(doc.id);
                                                            }}
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Upload FAB */}
                {mainTab === 'docs' && (
                    <div className="absolute bottom-6 right-6 z-50 flex items-center gap-3">
                        <Button
                            onClick={() => setIsUploadModalOpen(true)}
                            className="h-14 w-14 rounded-full bg-violet-600 hover:bg-violet-700 text-white shadow-lg shadow-violet-200 flex items-center justify-center transition-transform hover:scale-105"
                            title="Upload Docs"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                <line x1="12" y1="5" x2="12" y2="19"></line>
                                <line x1="5" y1="12" x2="19" y2="12"></line>
                            </svg>
                        </Button>
                    </div>
                )}

                {/* Modals placed inside so they overlay correctly */}
                {isUploadModalOpen && (
                    <DoctorDocsUploadModal
                        isOpen={isUploadModalOpen}
                        onClose={() => setIsUploadModalOpen(false)}
                        onUpload={handleUploadDocs}
                        isUploading={isUploading}
                        doctorName={`${doctor.first_name} ${doctor.last_name || ''}`}
                    />
                )}

                {selectedPhotoForLightbox && (
                    <Lightbox
                        photo={selectedPhotoForLightbox}
                        onClose={() => setSelectedPhotoForLightbox(null)}
                        onDownload={downloadFile}
                        onNext={() => {
                            const currentIndex = doctorDocs.findIndex(p => p.id === selectedPhotoForLightbox.id);
                            if (currentIndex < doctorDocs.length - 1) {
                                const nextDoc = doctorDocs[currentIndex + 1];
                                setSelectedPhotoForLightbox({
                                    id: nextDoc.id,
                                    name: nextDoc.name,
                                    mimeType: nextDoc.mimeType,
                                    webViewLink: nextDoc.webViewLink,
                                    proxyLink: nextDoc.proxyLink
                                });
                            }
                        }}
                        onPrev={() => {
                            const currentIndex = doctorDocs.findIndex(p => p.id === selectedPhotoForLightbox.id);
                            if (currentIndex > 0) {
                                const prevDoc = doctorDocs[currentIndex - 1];
                                setSelectedPhotoForLightbox({
                                    id: prevDoc.id,
                                    name: prevDoc.name,
                                    mimeType: prevDoc.mimeType,
                                    webViewLink: prevDoc.webViewLink,
                                    proxyLink: prevDoc.proxyLink
                                });
                            }
                        }}
                        hasNext={doctorDocs.findIndex(p => p.id === selectedPhotoForLightbox.id) < doctorDocs.length - 1}
                        hasPrev={doctorDocs.findIndex(p => p.id === selectedPhotoForLightbox.id) > 0}
                    />
                )}
            </FlexibleDialogContent>
        </Dialog>
    );
};
