import React, { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import { Loader2, FileText, Eye, Trash2, Upload, UserCog } from "lucide-react";

import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { FlexibleDialogContent } from "@/components/ui/flexible-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import apiService from "../../../../services/api";
import { Doctor } from "../../../../types";
import { Lightbox } from "../../../../components/modals/PatientPhotosModal/components/Lightbox";
import { DoctorDocsUploadModal } from "./DoctorDocsModal";

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

    if (!doctor) return null;

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogTitle></DialogTitle>
            <FlexibleDialogContent className="max-w-[800px] h-[80vh] flex flex-col p-0 overflow-hidden sm:rounded-xl">
                
                {/* Header Section */}
                <div className="bg-slate-900 text-white p-6 relative flex-shrink-0">
                    <div className="flex items-start justify-between">
                        <div className="flex items-center gap-4">
                            <div className="h-14 w-14 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center font-bold text-xl border border-indigo-500/30">
                                {doctor.first_name?.[0]}{doctor.last_name?.[0]}
                            </div>
                            <div>
                                <h2 className="text-xl font-bold">Dr. {doctor.first_name} {doctor.last_name}</h2>
                                <div className="text-slate-300 text-sm flex items-center gap-2 mt-1">
                                    <span>{doctor.speciality || 'General Practitioner'}</span>
                                    {doctor.years_of_exp && (
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
                        className={`flex items-center gap-2 px-6 py-4 border-b-2 text-[15px] font-medium transition-all ${mainTab === "details" ? "border-indigo-600 text-indigo-600 bg-white" : "border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100"}`}
                        onClick={() => setMainTab("details")}
                    >
                        <UserCog className="h-4 w-4" />
                        Details
                    </button>
                    <button
                        className={`flex items-center gap-2 px-6 py-4 border-b-2 text-[15px] font-medium transition-all ${mainTab === "docs" ? "border-indigo-600 text-indigo-600 bg-white" : "border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100"}`}
                        onClick={() => setMainTab("docs")}
                    >
                        <FileText className="h-4 w-4" />
                        Documents
                        <span className={`text-xs px-2 py-0.5 rounded-full ${mainTab === "docs" ? "bg-indigo-100 text-indigo-600" : "bg-slate-200 text-slate-500"}`}>
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
                            <div className="flex justify-between items-center bg-slate-50 p-4 rounded-xl border border-slate-200 mb-6 shrink-0">
                                <div>
                                    <h3 className="font-semibold text-slate-800">Doctor Documents</h3>
                                    <p className="text-sm text-slate-500 mt-1">Manage certificates, IDs, and other relevant documents.</p>
                                </div>
                                <Button onClick={() => setIsUploadModalOpen(true)} className="gap-2 bg-indigo-600 hover:bg-indigo-700">
                                    <Upload className="h-4 w-4" /> Upload Docs
                                </Button>
                            </div>

                            <div className="flex-1">
                                {isLoadingDocs ? (
                                    <div className="flex items-center justify-center h-48">
                                        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
                                    </div>
                                ) : doctorDocs.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center p-12 text-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50">
                                        <FileText className="h-12 w-12 text-slate-300 mb-4" />
                                        <h4 className="text-slate-700 font-medium mb-1">No documents found</h4>
                                        <p className="text-slate-500 text-sm max-w-sm">
                                            Upload documents such as registration certificates or identity proofs.
                                        </p>
                                        <Button variant="outline" className="mt-6 gap-2" onClick={() => setIsUploadModalOpen(true)}>
                                            <Upload className="h-4 w-4" /> Upload Now
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {doctorDocs.map(doc => {
                                            const isPdf = doc.fileName?.toLowerCase().endsWith('.pdf');
                                            return (
                                                <div key={doc.id} className="group relative flex items-start gap-4 p-4 rounded-xl border border-slate-200 hover:border-indigo-300 hover:shadow-md transition-all bg-white">
                                                    <div className={`mt-0.5 p-3 rounded-lg flex-shrink-0 ${isPdf ? 'bg-red-50 text-red-500' : 'bg-blue-50 text-blue-500'}`}>
                                                        <FileText className="h-5 w-5" />
                                                    </div>
                                                    <div className="flex-1 min-w-0 pr-8">
                                                        <p className="text-sm font-semibold text-slate-800 truncate" title={doc.name}>
                                                            {doc.name}
                                                        </p>
                                                        <p className="text-xs text-slate-500 capitalize mt-1.5 flex items-center gap-2">
                                                            <span className="font-medium">{(doc.fileSize / 1024).toFixed(1)} KB</span>
                                                            <span className="h-1 w-1 rounded-full bg-slate-300"></span>
                                                            <span>{doc.storageProvider}</span>
                                                        </p>
                                                    </div>
                                                    
                                                    <div className="absolute top-3 right-3 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <button 
                                                            className="p-2 bg-slate-50 text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-colors shadow-sm border border-slate-200"
                                                            title="View"
                                                            onClick={() => setSelectedPhotoForLightbox({
                                                                id: doc.id,
                                                                name: doc.name,
                                                                mimeType: doc.mimeType,
                                                                webViewLink: doc.webViewLink,
                                                                proxyLink: doc.proxyLink
                                                            })}
                                                        >
                                                            <Eye className="h-4 w-4" />
                                                        </button>
                                                        <button 
                                                            className="p-2 bg-slate-50 text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors shadow-sm border border-slate-200"
                                                            title="Delete"
                                                            onClick={() => handleDeleteDoc(doc.id)}
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
                    />
                )}
            </FlexibleDialogContent>
        </Dialog>
    );
};
