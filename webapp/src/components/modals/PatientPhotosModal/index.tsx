import React, { useState, useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import apiService from "../../../services/api";
import { Patient } from "../../../types";
import {
    PatientPhotosModalProps,
    DriveFile,
    ipdFormSchema,
    claimsFormSchema,
    IpdFormData,
    ClaimsFormData
} from "./types";
import { formatDateForInput, formatFileSize } from "./utils";
import { usePhotosData } from "./hooks/usePhotosData";
import { useUploadContext } from "../../../context/UploadContext";
import { Header } from "./components/Header";
import { PhotoGrid } from "./components/PhotoGrid";
import { UploadQueuePanel } from "./components/UploadQueuePanel";
import { Lightbox } from "./components/Lightbox";
import { IPDFields } from "./components/IPDFields";
import { ClaimsFields } from "./components/ClaimsFields";
import { Dialog, DialogContent } from "../../ui/dialog";
import { FlexibleDialogContent } from "../../ui/flexible-dialog";
import { Button } from "../../ui/button";

const PatientPhotosModal: React.FC<PatientPhotosModalProps> = ({ patient, onClose, onUpdate }) => {
    // --- UI State ---
    const [mainTab, setMainTab] = useState<'photos' | 'ipd' | 'claims'>('photos');
    const [activeCategory, setActiveCategory] = useState<string>("all");
    const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
    const [selectedPhoto, setSelectedPhoto] = useState<DriveFile | null>(null);
    const [isSelectMode, setIsSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    // --- Form State ---
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);

    // --- Data & Upload Hooks ---
    const { photosData, loading, error, isCached, isDeleting, fetchPhotos, deleteFiles } = usePhotosData(patient.id);

    const handleUploadSuccess = async () => {
        // Clear cache and refresh
        await fetchPhotos(true);
    };

    const { startUpload } = useUploadContext();

    // Mock drag handlers (simplified, or we can move drag logic to a separate hook if we want to keep it local)
    // For now, let's keep the drag handlers simple from the original hook or just context
    // Actually, drag handlers are local UI logic for the drop zone, but the drop action connects to global context.

    // We need to re-implement local drag state since we removed the hook that provided it
    // Or we can keep `usePhotoUpload` but strip it down to just UI/Drag logic and have it call context?
    // Let's implement local drag logic here for simplicity as we refactor.

    const [isLocalDragging, setIsLocalDragging] = useState(false);
    const dragCounter = React.useRef(0);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const handleDragEnter = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current++;
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            setIsLocalDragging(true);
        }
    }, []);

    const handleDragLeave = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current--;
        if (dragCounter.current === 0) {
            setIsLocalDragging(false);
        }
    }, []);

    const handleDragOver = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDrop = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsLocalDragging(false);
        dragCounter.current = 0;

        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            startUpload(files, patient.id, activeCategory, handleUploadSuccess);
        }
    }, [startUpload, patient.id, activeCategory]);

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            startUpload(Array.from(e.target.files), patient.id, activeCategory, handleUploadSuccess);
            e.target.value = '';
        }
    };

    // --- Initial Fetch ---
    useEffect(() => {
        fetchPhotos();
    }, [fetchPhotos]);

    // --- Forms Setup ---
    const ipdForm = useForm<IpdFormData>({
        resolver: zodResolver(ipdFormSchema),
        defaultValues: {
            phone: patient.phone || "",
            beneficiaryId: patient.beneficiary_id || "",
            admissionType: (patient.admission_type as any) || "",
        },
    });

    const claimsForm = useForm<ClaimsFormData>({
        resolver: zodResolver(claimsFormSchema),
        defaultValues: {
            treatmentPlan: patient.treatment_plan || "",
            latestStatus: patient.latest_status || "",
            claimAmount: patient.claim_amount?.toString() || "",
            claimApproved: patient.claim_approved?.toString() || "",
            incentive: patient.incentive?.toString() || "",
            deduction: patient.deduction?.toString() || "",
            deductionReason: patient.deduction_reason || "",
            claimSettled: patient.claim_settled?.toString() || "",
            claimSettledDate: formatDateForInput(patient.claim_settled_date),
        },
    });

    // Reset forms when patient changes
    useEffect(() => {
        ipdForm.reset({
            phone: patient.phone || "",
            beneficiaryId: patient.beneficiary_id || "",
            admissionType: (patient.admission_type as any) || "",
        });
        claimsForm.reset({
            treatmentPlan: patient.treatment_plan || "",
            latestStatus: patient.latest_status || "",
            claimAmount: patient.claim_amount?.toString() || "",
            claimApproved: patient.claim_approved?.toString() || "",
            incentive: patient.incentive?.toString() || "",
            deduction: patient.deduction?.toString() || "",
            deductionReason: patient.deduction_reason || "",
            claimSettled: patient.claim_settled?.toString() || "",
            claimSettledDate: formatDateForInput(patient.claim_settled_date),
        });
    }, [patient, ipdForm, claimsForm]);


    // --- Helper Functions ---
    const getActivePhotos = useMemo(() => {
        if (!photosData) return [];
        let photos: DriveFile[] = [];
        if (activeCategory === "all") {
            photos = photosData.rootPhotos || [];
        } else {
            const category = photosData.categories?.find((c) => c.name === activeCategory);
            photos = category?.photos || [];
        }

        return [...photos].sort((a, b) => {
            const dateA = a.createdTime ? new Date(a.createdTime).getTime() : 0;
            const dateB = b.createdTime ? new Date(b.createdTime).getTime() : 0;
            return sortOrder === "asc" ? dateA - dateB : dateB - dateA;
        });
    }, [photosData, activeCategory, sortOrder]);

    const totalPhotoCount = useMemo(() => {
        if (!photosData) return 0;
        const rootCount = photosData.rootPhotos?.length || 0;
        const categoryCount =
            photosData.categories?.reduce((acc, cat) => acc + cat.photos.length, 0) || 0;
        return rootCount + categoryCount;
    }, [photosData]);

    const togglePhotoSelection = (id: string) => {
        const newSet = new Set(selectedIds);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedIds(newSet);
    };

    const handleBulkDelete = async () => {
        if (selectedIds.size === 0) return;
        const confirmDelete = window.confirm(
            `Are you sure you want to delete ${selectedIds.size} file(s)? This action cannot be undone.`
        );
        if (!confirmDelete) return;

        await deleteFiles(Array.from(selectedIds));
        setIsSelectMode(false);
        setSelectedIds(new Set());
    };

    const downloadFile = async (file: DriveFile) => {
        try {
            const response = await fetch(apiService.getThumbnailUrl(file.id));
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = file.name + (file.name?.includes(".") ? "" : "." + file.mimeType.split("/")[1]);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);
        } catch (err) {
            console.error("Download error", err);
        }
    };

    const handleBulkDownload = async () => {
        setIsDownloading(true);
        const selectedPhotos = getActivePhotos.filter((p) => selectedIds.has(p.id));
        try {
            for (const photo of selectedPhotos) {
                await downloadFile(photo);
                await new Promise((r) => setTimeout(r, 100));
            }
        } catch (error) {
            console.log(error);
        } finally {
            setIsDownloading(false);
            setIsSelectMode(false);
            setSelectedIds(new Set());
        }
    };

    const handleSaveDetails = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!onUpdate) return;

        const ipdValues = ipdForm.getValues();
        const claimsValues = claimsForm.getValues();
        const isIpdValid = await ipdForm.trigger();
        const isClaimsValid = await claimsForm.trigger();

        if (!isIpdValid || !isClaimsValid) return;

        try {
            setIsSaving(true);
            setSaveSuccess(false);

            await onUpdate(patient.id, {
                firstName: patient.first_name,
                lastName: patient.last_name,
                phone: ipdValues.phone,
                admittedAt: patient.admitted_at,
                admissionType: ipdValues.admissionType as "conservative" | "surgical" | undefined,
                beneficiaryId: ipdValues.beneficiaryId || undefined,
                treatmentPlan: claimsValues.treatmentPlan || undefined,
                latestStatus: claimsValues.latestStatus || undefined,
                claimAmount: claimsValues.claimAmount ? parseFloat(claimsValues.claimAmount) : undefined,
                claimApproved: claimsValues.claimApproved ? parseFloat(claimsValues.claimApproved) : undefined,
                incentive: claimsValues.incentive ? parseFloat(claimsValues.incentive) : undefined,
                deduction: claimsValues.deduction ? parseFloat(claimsValues.deduction) : undefined,
                deductionReason: claimsValues.deductionReason || undefined,
                claimSettled: claimsValues.claimSettled ? parseFloat(claimsValues.claimSettled) : undefined,
                claimSettledDate: claimsValues.claimSettledDate || undefined,
            });

            setSaveSuccess(true);
            setTimeout(() => setSaveSuccess(false), 3000);
        } catch (err) {
            console.error("Failed to save details:", err);
            alert("Failed to save details");
        } finally {
            setIsSaving(false);
        }
    };

    const handleOpenChange = (open: boolean) => {
        if (!open) onClose();
    };

    // --- Render ---
    return (
        <Dialog open={true} onOpenChange={handleOpenChange}>
            <FlexibleDialogContent
                className="max-w-[1000px] h-[90vh] flex flex-col p-0 gap-0 overflow-hidden sm:rounded-xl [&>button.absolute.right-4.top-4]:hidden"
                onEscapeKeyDown={(e) => {
                    if (selectedPhoto) {
                        e.preventDefault();
                        setSelectedPhoto(null);
                    }
                }}
            >
                <Header
                    patient={patient}
                    photosData={photosData}
                    loading={loading}
                    isCached={isCached}
                    sortOrder={sortOrder}
                    setSortOrder={setSortOrder}
                    onRefresh={() => fetchPhotos(true)}
                    onUploadClick={handleUploadClick}
                    driveFolderId={patient.folder_id || (patient as any).drive_folder_id}
                    photoCount={totalPhotoCount}
                    activeCategory={activeCategory}
                    isSelectMode={isSelectMode}
                    onToggleSelect={() => setIsSelectMode(!isSelectMode)}
                    onClose={onClose}
                />

                {/* Hidden File Input (controlled by hook) */}
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,application/pdf"
                    onChange={handleFileInputChange}
                    className="hidden"
                />

                {/* Main Tabs Navigation */}
                {onUpdate && (
                    <div className="flex gap-0 border-b border-slate-200 bg-slate-50 px-6">
                        <button
                            className={`flex items-center gap-2 px-6 py-4 border-b-2 text-[15px] font-medium transition-all ${mainTab === "photos" ? "border-indigo-600 text-indigo-600 bg-white" : "border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100"}`}
                            onClick={() => setMainTab("photos")}
                        >
                            {/* ... Icon ... */}
                            Files
                        </button>
                        <button
                            className={`flex items-center gap-2 px-6 py-4 border-b-2 text-[15px] font-medium transition-all ${mainTab === "ipd" ? "border-indigo-600 text-indigo-600 bg-white" : "border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100"}`}
                            onClick={() => setMainTab("ipd")}
                        >
                            IPD Details
                        </button>
                        <button
                            className={`flex items-center gap-2 px-6 py-4 border-b-2 text-[15px] font-medium transition-all ${mainTab === "claims" ? "border-indigo-600 text-indigo-600 bg-white" : "border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100"}`}
                            onClick={() => setMainTab("claims")}
                        >
                            Claims
                        </button>
                    </div>
                )}

                {/* Action Bar (Select Mode) */}
                {isSelectMode && mainTab === "photos" && (
                    <div className="bg-indigo-600 text-white px-6 py-3 flex justify-between items-center animate-in fade-in slide-in-from-top-2">
                        <span className="text-sm font-medium">{selectedIds.size} files selected</span>
                        <div className="flex gap-3">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="text-white hover:bg-white/10"
                                onClick={() =>
                                    setSelectedIds(
                                        selectedIds.size === getActivePhotos.length
                                            ? new Set()
                                            : new Set(getActivePhotos.map((p) => p.id))
                                    )
                                }
                            >
                                {selectedIds.size === getActivePhotos.length ? "Deselect All" : "Select All"}
                            </Button>
                            <Button
                                size="sm"
                                disabled={selectedIds.size === 0 || isDeleting}
                                onClick={handleBulkDelete}
                                className="bg-red-500 text-white hover:bg-red-600 rounded-full px-6 shadow-sm disabled:opacity-50"
                            >
                                {isDeleting ? "Deleting..." : "Delete"}
                            </Button>
                            <Button
                                size="sm"
                                disabled={selectedIds.size === 0 || isDownloading}
                                onClick={handleBulkDownload}
                                className="bg-white text-indigo-600 hover:bg-indigo-50 rounded-full px-6 shadow-sm disabled:opacity-50"
                            >
                                {isDownloading ? "Downloading..." : "Download"}
                            </Button>
                        </div>
                    </div>
                )}

                {/* Category Tabs */}
                {mainTab === "photos" && !loading && !error && (photosData?.categories?.length || 0) > 0 && !isSelectMode && (
                    <div className="flex gap-2 px-6 py-4 border-b border-slate-200 bg-slate-50 overflow-x-auto">
                        <button
                            className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-[13px] font-medium whitespace-nowrap transition-all ${activeCategory === "all" ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-900"}`}
                            onClick={() => setActiveCategory("all")}
                        >
                            Admission Files
                            <span className={`text-xs px-2 py-0.5 rounded-full ${activeCategory === "all" ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"}`}>
                                {photosData?.rootPhotos?.length || 0}
                            </span>
                        </button>
                        {photosData?.categories?.map((category) => (
                            <button
                                key={category.id}
                                className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-[13px] font-medium whitespace-nowrap transition-all ${activeCategory === category.name ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-900"}`}
                                onClick={() => setActiveCategory(category.name)}
                            >
                                {category.displayName}
                                <span className={`text-xs px-2 py-0.5 rounded-full ${activeCategory === category.name ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"}`}>
                                    {category.photos.length}
                                </span>
                            </button>
                        ))}
                    </div>
                )}

                {/* Content Area */}
                <div className="flex-1 overflow-hidden flex flex-col relative">
                    {mainTab === 'photos' ? (
                        <PhotoGrid
                            photos={getActivePhotos}
                            loading={loading}
                            error={error}
                            selectedIds={selectedIds}
                            isSelectMode={isSelectMode}
                            onPhotoClick={setSelectedPhoto}
                            onSelectionToggle={togglePhotoSelection}
                            onRetry={() => fetchPhotos(true)}
                            isDragging={isLocalDragging}
                            dragHandlers={{
                                onDragEnter: handleDragEnter,
                                onDragLeave: handleDragLeave,
                                onDragOver: handleDragOver,
                                onDrop: handleDrop
                            }}
                            totalPhotoCount={totalPhotoCount}
                        />
                    ) : (
                        <div className="flex-1 overflow-y-auto p-6 bg-slate-50/50">
                            <form onSubmit={handleSaveDetails} className="max-w-4xl mx-auto bg-white p-6 rounded-xl border border-slate-200 shadow-sm grid grid-cols-1 md:grid-cols-2 gap-6">
                                {mainTab === 'ipd' ? (
                                    <IPDFields form={ipdForm} patient={patient} />
                                ) : (
                                    <ClaimsFields form={claimsForm} />
                                )}
                                <div className="col-span-1 md:col-span-2 flex items-center justify-end gap-4 mt-6 pt-5 border-t border-slate-200">
                                    {saveSuccess && (
                                        <span className="flex items-center gap-1.5 text-emerald-600 text-sm font-medium">Saved successfully</span>
                                    )}
                                    <Button
                                        type="submit"
                                        disabled={isSaving}
                                        className="bg-gradient-to-br from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 text-white"
                                    >
                                        {isSaving ? "Saving..." : "Save Changes"}
                                    </Button>
                                </div>
                            </form>
                        </div>
                    )}
                </div>

                {/* Upload FAB */}
                <div className="absolute bottom-6 right-6 z-50">
                    <Button
                        onClick={() => fileInputRef.current?.click()}
                        className="h-14 w-14 rounded-full bg-violet-600 hover:bg-violet-700 text-white shadow-lg shadow-violet-200 flex items-center justify-center transition-transform hover:scale-105"
                        title="Upload Photos"
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </Button>
                </div>

                {selectedPhoto && (
                    <Lightbox photo={selectedPhoto} onClose={() => setSelectedPhoto(null)} />
                )}
            </FlexibleDialogContent>
        </Dialog>
    );
};

export default PatientPhotosModal;
