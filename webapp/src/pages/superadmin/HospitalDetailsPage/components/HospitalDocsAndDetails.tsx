import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import apiService from "../../../../services/api";
import { useAuth } from "../../../../context/AuthContext";
import {
    Building, Upload, Trash2, FileText, ChevronDown, Loader2, Save,
    MapPin, CreditCard, Phone, FileCheck, Info, Check, Filter, 
    CloudUpload, Eye, GripVertical
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Lightbox } from "../../../../components/modals/PatientPhotosModal/components/Lightbox";
import { toast } from "sonner";
import { HospitalPanel } from "../../../../types";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import "./HospitalDocsAndDetails.css";

// ─── Constants ──────────────────────────────────────────────────────────────

interface HospitalDocsAndDetailsProps {
    hospitalId: string;
    hospital: any;
    panels: HospitalPanel[];
    onRefresh: () => void;
    refreshing?: boolean;
}

const DOCUMENT_CATEGORIES = [
    { value: "general_doc", label: "General Document" },
    { value: "cancelled_cheque", label: "Cancelled Cheque" },
    { value: "registration_certificate", label: "Valid Registration Certificate" },
    { value: "rohini_certificate", label: "Valid Rohini Certificate" },
    { value: "bmw_certificate", label: "Bio-Medical Waste Certificate(BMW)" },
    { value: "fire_noc", label: "Fire NOC" },
    { value: "cmo_license", label: "CMO License" },
    { value: "msme_certificate", label: "MSME Certificate" },
    { value: "gstin_copy", label: "GSTIN Copy" },
    { value: "tds_certificate", label: "TDS Certificate" },
    { value: "mou", label: "MOU / Letter of Consent" },
    { value: "room_rent_template", label: "Room Rent Template" },
    { value: "neft_mandate", label: "NEFT Mandate Form" },
    { value: "pan_declaration", label: "PAN Declaration" },
];

interface FieldDef {
    name: string;
    label: string;
    type: string;
    options?: { label: string; value: string }[];
    placeholder?: string;
    maxLength?: number;
}

interface FieldSection {
    id: string;
    title: string;
    icon: React.ReactNode;
    color: string;
    bgColor: string;
    fields: FieldDef[];
}

const FIELD_SECTIONS: FieldSection[] = [
    {
        id: "location",
        title: "Location & Address",
        icon: <MapPin className="h-[18px] w-[18px]" />,
        color: "#2563eb",
        bgColor: "#eff6ff",
        fields: [
            { name: "address", label: "Address", type: "text" },
            { name: "locality", label: "Locality / Landmark", type: "text" },
            { name: "region", label: "Region / Zone", type: "text" },
            { name: "state", label: "State", type: "text" },
            { name: "district", label: "District", type: "text" },
            { name: "pinCode", label: "PIN Code", type: "text" },
        ],
    },
    {
        id: "hospital-info",
        title: "Hospital Information",
        icon: <Building className="h-[18px] w-[18px]" />,
        color: "#7c3aed",
        bgColor: "#f5f3ff",
        fields: [
            { name: "totalBeds", label: "Total No. of Beds", type: "number" },
            { 
                name: "specialities", 
                label: "Hospital Specialities", 
                type: "select",
                options: [
                    { label: "Multispeciality", value: "Multispeciality" },
                    { label: "Single speciality", value: "Single speciality" },
                    { label: "Super speciality", value: "Super speciality" },
                    { label: "Medical College", value: "Medical College" }
                ]
            },
            { 
                name: "typeOfCare", 
                label: "Type of Care", 
                type: "select",
                options: [
                    { label: "Primary", value: "Primary" },
                    { label: "Secondary", value: "Secondary" },
                    { label: "Tertiary", value: "Tertiary" }
                ]
            },
            { 
                name: "ownership", 
                label: "Hospital Ownership", 
                type: "select",
                options: [
                    { label: "Individual", value: "Individual" },
                    { label: "Partnership", value: "Partnership" },
                    { label: "Corporate", value: "Corporate" },
                    { label: "Private Limited", value: "Private Limited" },
                    { label: "Government", value: "Government" },
                    { label: "Trust", value: "Trust" }
                ]
            },
            { name: "validFromDate", label: "Valid From Date", type: "date" },
        ],
    },
    {
        id: "registration",
        title: "Registration & Compliance",
        icon: <FileCheck className="h-[18px] w-[18px]" />,
        color: "#059669",
        bgColor: "#ecfdf5",
        fields: [
            { name: "hfrId", label: "HFR ID", type: "text", placeholder: "Health Facility Registry" },
            { name: "rohiniId", label: "ROHINI ID", type: "text" },
            { name: "registrationNumber", label: "Hospital Registration Number", type: "text" },
            { name: "registeringAuthority", label: "Registering Authority", type: "text" },
        ],
    },
    {
        id: "financial",
        title: "Financial Details",
        icon: <CreditCard className="h-[18px] w-[18px]" />,
        color: "#d97706",
        bgColor: "#fffbeb",
        fields: [
            { name: "panNumber", label: "PAN Number", type: "text", maxLength: 10, placeholder: "Enter 10-character PAN" },
            { name: "discountDeclaration", label: "Discount Declaration", type: "text" },
        ],
    },
    {
        id: "contacts",
        title: "Contact Information",
        icon: <Phone className="h-[18px] w-[18px]" />,
        color: "#dc2626",
        bgColor: "#fef2f2",
        fields: [
            { name: "contactPersonName", label: "Contact Person Name", type: "text" },
            { name: "contactNumber", label: "Contact Number", type: "tel", placeholder: "Enter 10-digit number" },
            { name: "hospitalEmail", label: "Hospital Email ID", type: "email" },
            { name: "tpaCoordinatorName", label: "TPA Coordinator Name", type: "text" },
            { name: "tpaCoordinatorContact", label: "TPA Coordinator Contact", type: "tel", placeholder: "Enter 10-digit number" },
            { name: "tpaCoordinatorEmail", label: "TPA Coordinator Email", type: "email" },
            { name: "cmoName", label: "CEO / CMO Name", type: "text" },
            { name: "cmoContact", label: "CEO / CMO Contact", type: "tel", placeholder: "Enter 10-digit number" },
            { name: "cmoEmail", label: "CEO / CMO Email", type: "email" },
        ],
    },
];

// ─── Validation Schema ──────────────────────────────────────────────────────

const optionalString = z.union([z.string(), z.number(), z.null(), z.undefined()]).transform(v => v ? String(v) : "");

const hospitalDetailsSchema = z.object({
    address: optionalString,
    locality: optionalString,
    region: optionalString,
    state: optionalString,
    district: optionalString,
    pinCode: optionalString,
    totalBeds: optionalString,
    specialities: optionalString,
    typeOfCare: optionalString,
    ownership: optionalString,
    validFromDate: optionalString,
    hfrId: optionalString,
    rohiniId: optionalString,
    registrationNumber: optionalString,
    registeringAuthority: optionalString,
    panNumber: z.string()
        .refine(val => !val || val.length === 10, { message: "PAN must be exactly 10 characters" })
        .optional().or(z.literal("")),
    discountDeclaration: optionalString,
    contactPersonName: optionalString,
    contactNumber: z.string()
        .refine(val => !val || val.length === 10, { message: "Contact must be exactly 10 digits" })
        .optional().or(z.literal("")),
    hospitalEmail: z.union([z.string().email("Invalid email"), z.literal(""), z.undefined()]),
    tpaCoordinatorName: optionalString,
    tpaCoordinatorContact: z.string()
        .refine(val => !val || val.length === 10, { message: "Contact must be exactly 10 digits" })
        .optional().or(z.literal("")),
    tpaCoordinatorEmail: z.union([z.string().email("Invalid email"), z.literal(""), z.undefined()]),
    cmoName: optionalString,
    cmoContact: z.string()
        .refine(val => !val || val.length === 10, { message: "Contact must be exactly 10 digits" })
        .optional().or(z.literal("")),
    cmoEmail: z.union([z.string().email("Invalid email"), z.literal(""), z.undefined()]),
});

// ─── Sub-Components ─────────────────────────────────────────────────────────

/** Collapsible accordion section for Detail fields */
const DetailSection: React.FC<{
    section: FieldSection;
    register: any;
    errors: any;
    setValue: any;
    filledValues: Record<string, any>;
}> = ({ section, register, errors, setValue, filledValues }) => {
    const [expanded, setExpanded] = useState(true);

    const filledCount = section.fields.filter(f => filledValues?.[f.name]?.toString().trim()).length;
    const totalCount = section.fields.length;

    return (
        <div className={`detail-section ${expanded ? "detail-section--expanded" : ""}`}>
            <button
                type="button"
                className="detail-section__header"
                onClick={() => setExpanded(prev => !prev)}
            >
                <div className="detail-section__icon" style={{ background: section.bgColor, color: section.color }}>
                    {section.icon}
                </div>
                <span className="detail-section__title">{section.title}</span>
                <span className={`detail-section__badge ${filledCount === totalCount ? "detail-section__badge--complete" : ""}`}>
                    {filledCount === totalCount ? (
                        <><Check className="h-3 w-3" /> All filled</>
                    ) : (
                        <>{filledCount}/{totalCount} filled</>
                    )}
                </span>
                <ChevronDown className={`detail-section__chevron ${expanded ? "detail-section__chevron--open" : ""}`} />
            </button>

            <div className={`detail-section__body ${expanded ? "detail-section__body--open" : ""}`}>
                <div className="detail-section__grid">
                    {section.fields.map(field => (
                        <div key={field.name} className="detail-field">
                            <div className="relative pb-5">
                                <label className="detail-field__label" htmlFor={`field-${field.name}`}>
                                    {field.label}
                                </label>
                                {field.type === "select" ? (
                                    <select
                                        id={`field-${field.name}`}
                                        className={`detail-field__input ${errors[field.name] ? 'border-red-500 bg-red-50 focus:ring-red-500' : ''}`}
                                        {...register(field.name)}
                                    >
                                        <option value="" disabled>Select {field.label.toLowerCase()}</option>
                                        {field.options?.map(opt => (
                                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        id={`field-${field.name}`}
                                        type={field.type}
                                        className={`detail-field__input ${errors[field.name] ? 'border-red-500 bg-red-50 focus:ring-red-500' : ''}`}
                                        placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
                                        maxLength={field.maxLength}
                                        {...register(field.name, {
                                            onChange: (e: any) => {
                                                if (field.type === "tel" || field.name === "panNumber") {
                                                    let val = e.target.value;
                                                    if (field.type === "tel") val = val.replace(/\D/g, '').slice(0, 10);
                                                    if (field.name === "panNumber") val = val.toUpperCase().replace(/\s/g, '').slice(0, 10);
                                                    setValue(field.name, val, { shouldValidate: true, shouldDirty: true });
                                                }
                                            }
                                        })}
                                    />
                                )}
                                {errors[field.name] && (
                                    <p className="text-red-500 text-[10px] mt-0.5 absolute bottom-0 left-0 leading-tight">
                                        {errors[field.name]?.message as string}
                                    </p>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

/** Drag-and-drop upload zone replaced with modal */
const UploadModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    panels: HospitalPanel[];
    selectedCategory: string;
    setSelectedCategory: (v: string) => void;
    selectedPanel: string;
    setSelectedPanel: (v: string) => void;
    filesToUpload: File[];
    setFilesToUpload: (files: File[]) => void;
    onUpload: () => void;
    isUploading: boolean;
}> = ({
    isOpen, onClose, panels, selectedCategory, setSelectedCategory, selectedPanel, setSelectedPanel,
    filesToUpload, setFilesToUpload, onUpload, isUploading,
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) setFilesToUpload(Array.from(e.target.files));
    };

    const removeFile = (index: number) => {
        setFilesToUpload(filesToUpload.filter((_, i) => i !== index));
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Upload Document</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <label className="text-sm font-medium">Document Category</label>
                        <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                            value={selectedCategory}
                            onChange={e => setSelectedCategory(e.target.value)}
                        >
                            {DOCUMENT_CATEGORIES.map(c => (
                                <option key={c.value} value={c.value}>{c.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="grid gap-2">
                        <label className="text-sm font-medium">Panel (Optional)</label>
                        <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                            value={selectedPanel}
                            onChange={e => setSelectedPanel(e.target.value)}
                        >
                            <option value="">-- General (Not Panel Specific) --</option>
                            {panels.map(p => (
                                <option key={p.panel_id} value={p.panel_id}>{p.panel_name}</option>
                            ))}
                        </select>
                    </div>

                    <div className="grid gap-2 pt-2">
                        <label className="text-sm font-medium">Select File(s)</label>
                        <div className="flex gap-2 items-center">
                           <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
                               Browse Files
                           </Button>
                           <span className="text-sm text-slate-500">
                               {filesToUpload.length} file(s) selected
                           </span>
                        </div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            onChange={handleFileChange}
                            className="hidden"
                        />
                    </div>

                    {filesToUpload.length > 0 && (
                        <div className="max-h-32 overflow-y-auto space-y-2 mt-2">
                            {filesToUpload.map((file, i) => (
                                <div key={i} className="flex items-center justify-between text-sm bg-slate-50 p-2 rounded border">
                                    <div className="flex items-center gap-2 overflow-hidden">
                                        <FileText className="h-4 w-4 shrink-0 text-slate-500" />
                                        <span className="truncate">{file.name}</span>
                                        <span className="text-xs text-slate-400 shrink-0">{(file.size / 1024).toFixed(0)} KB</span>
                                    </div>
                                    <button
                                        type="button"
                                        className="text-slate-400 hover:text-red-500 p-1"
                                        onClick={() => removeFile(i)}
                                    >&times;</button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={isUploading}>Cancel</Button>
                    <Button onClick={onUpload} disabled={isUploading || filesToUpload.length === 0}>
                        {isUploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                        {isUploading ? "Uploading..." : "Upload Document"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

// ─── Main Component ─────────────────────────────────────────────────────────

const HospitalDocsAndDetails: React.FC<HospitalDocsAndDetailsProps> = ({
    hospitalId, hospital, panels, onRefresh, refreshing,
}) => {
    const { user } = useAuth();

    // Inner sub-tab
    const [activeSubTab, setActiveSubTab] = useState<"details" | "documents">("details");

    // RHF
    const {
        register,
        handleSubmit,
        setValue,
        watch,
        reset,
        formState: { errors, isDirty }
    } = useForm({
        resolver: zodResolver(hospitalDetailsSchema),
        defaultValues: hospital?.details || {},
        mode: "onChange"
    });

    const watchedDetails = watch();
    const [isSavingDetails, setIsSavingDetails] = useState(false);

    // Docs State
    const [docs, setDocs] = useState<any[]>([]);
    const [isLoadingDocs, setIsLoadingDocs] = useState(false);
    const [categoryFilter, setCategoryFilter] = useState("all");

    // Upload State
    const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [selectedCategory, setSelectedCategory] = useState("general_doc");
    const [selectedPanel, setSelectedPanel] = useState<string>("");
    const [filesToUpload, setFilesToUpload] = useState<File[]>([]);

    // Lightbox State
    const [selectedPhotoForLightbox, setSelectedPhotoForLightbox] = useState<any | null>(null);

    const API_V2_BASE_URL = process.env.NODE_ENV === "production" ? "" : "http://localhost:8000";

    useEffect(() => {
        fetchDocs();
        if (hospital?.details) reset(hospital.details);
    }, [hospitalId, hospital, reset]);

    const fetchDocs = async () => {
        setIsLoadingDocs(true);
        try {
            const res = await apiService.getHospitalDocs(hospitalId);
            setDocs(res.data.data || []);
        } catch (error) {
            console.error(error);
            toast.error("Failed to fetch hospital documents");
        } finally {
            setIsLoadingDocs(false);
        }
    };

    const onSubmit = async (data: any) => {
        setIsSavingDetails(true);
        try {
            await apiService.updateHospital(hospitalId, { details: data });
            toast.success("Hospital details updated successfully!");
            reset(data); // Resets isDirty
            onRefresh();
        } catch (error) {
            console.error(error);
            toast.error("Failed to update hospital details");
        } finally {
            setIsSavingDetails(false);
        }
    };

    const uploadFiles = async () => {
        if (filesToUpload.length === 0) { toast.error("Please select a file to upload"); return; }
        setIsUploading(true);
        try {
            await apiService.uploadHospitalDocs(hospitalId, filesToUpload, selectedCategory, selectedPanel);
            toast.success("Documents uploaded successfully!");
            setFilesToUpload([]);
            setIsUploadModalOpen(false);
            fetchDocs();
        } catch (error) {
            console.error(error);
            toast.error("Failed to upload documents");
        } finally {
            setIsUploading(false);
        }
    };

    const deleteDoc = async (docId: string) => {
        if (!window.confirm("Are you sure you want to delete this document?")) return;
        try {
            await apiService.deleteHospitalDoc(docId);
            toast.success("Document deleted");
            fetchDocs();
        } catch (error) {
            console.error(error);
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

    const getPanelName = (id: string) => {
        if (!id) return "General";
        const panel = panels.find(p => p.panel_id === id);
        return panel ? panel.panel_name : "Unknown Panel";
    };

    const getCategoryName = (val: string) => {
        const cat = DOCUMENT_CATEGORIES.find(c => c.value === val);
        return cat ? cat.label : val;
    };

    // Compute overall detail completion
    const totalFields = FIELD_SECTIONS.reduce((sum, s) => sum + s.fields.length, 0);
    const filledFields = FIELD_SECTIONS.reduce(
        (sum, s) => sum + s.fields.filter(f => watchedDetails[f.name]?.toString().trim()).length, 0
    );

    // Filtered docs
    const filteredDocs = useMemo(() => {
        if (categoryFilter === "all") return docs;
        return docs.filter(d => d.type === categoryFilter);
    }, [docs, categoryFilter]);

    // Group filtered docs by category
    const groupedDocs = useMemo(() => {
        const groups: Record<string, any[]> = {};
        filteredDocs.forEach(doc => {
            const cat = doc.type || "general_doc";
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(doc);
        });
        return groups;
    }, [filteredDocs]);

    return (
        <div className="docs-details-root">
            {/* Inner sub-tab pills */}
            <div className="docs-details__nav">
                <div className="docs-details__pills">
                    <button
                        type="button"
                        className={`docs-details__pill ${activeSubTab === "details" ? "docs-details__pill--active" : ""}`}
                        onClick={() => setActiveSubTab("details")}
                    >
                        <Info className="h-4 w-4" />
                        Details
                        <span className="docs-details__pill-badge">{filledFields}/{totalFields}</span>
                    </button>
                    <button
                        type="button"
                        className={`docs-details__pill ${activeSubTab === "documents" ? "docs-details__pill--active" : ""}`}
                        onClick={() => setActiveSubTab("documents")}
                    >
                        <FileText className="h-4 w-4" />
                        Documents
                        <span className="docs-details__pill-badge">{docs.length}</span>
                    </button>
                </div>
            </div>

            {/* ═══════ DETAILS SUB-TAB ═══════ */}
            {activeSubTab === "details" && (
                <div className="docs-details__details-tab">
                    {/* Accordion sections */}
                    <div className="details-sections">
                        {FIELD_SECTIONS.map(section => (
                            <DetailSection
                                key={section.id}
                                section={section}
                                register={register}
                                errors={errors}
                                setValue={setValue}
                                filledValues={watchedDetails}
                            />
                        ))}
                    </div>

                    {/* Sticky Save Bar */}
                    <div className="details-save-bar">
                        <div className="details-save-bar__inner">
                            <span className="details-save-bar__hint">
                                {filledFields}/{totalFields} fields filled
                            </span>
                            <Button
                                onClick={handleSubmit(onSubmit)}
                                disabled={isSavingDetails || !isDirty}
                                className="details-save-bar__btn"
                            >
                                {isSavingDetails ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                {isSavingDetails ? "Saving..." : "Save All Details"}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══════ DOCUMENTS SUB-TAB ═══════ */}
            {activeSubTab === "documents" && (
                <div className="docs-details__docs-tab">
                    <div className="docs-tab__layout docs-tab__layout--full">
                        {/* Document List */}
                        <div className="docs-tab__list-col w-full" style={{ maxWidth: '100%' }}>
                            <div className="docs-tab__card docs-tab__card--list">
                                <div className="docs-tab__card-header">
                                    <div className="docs-tab__card-header-left">
                                        <FileText className="h-5 w-5 text-emerald-500" />
                                        <h3>Uploaded Documents</h3>
                                        <span className="docs-tab__doc-count">{docs.length}</span>
                                    </div>
                                    <div className="docs-tab__filter">
                                        <Filter className="h-3.5 w-3.5" />
                                        <select
                                            className="docs-tab__filter-select"
                                            value={categoryFilter}
                                            onChange={e => setCategoryFilter(e.target.value)}
                                        >
                                            <option value="all">All Categories</option>
                                            {DOCUMENT_CATEGORIES.map(c => (
                                                <option key={c.value} value={c.value}>{c.label}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>

                                <div className="docs-tab__list-body">
                                    {isLoadingDocs ? (
                                        <div className="docs-tab__empty">
                                            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                                            <p>Loading documents...</p>
                                        </div>
                                    ) : filteredDocs.length === 0 ? (
                                        <div className="docs-tab__empty">
                                            <FileText className="h-10 w-10 text-slate-300" />
                                            <p>{docs.length === 0 ? "No documents uploaded yet." : "No documents match this filter."}</p>
                                        </div>
                                    ) : (
                                        Object.entries(groupedDocs).map(([catKey, catDocs]) => (
                                            <div key={catKey} className="docs-tab__category-group">
                                                <div className="docs-tab__category-header">
                                                    <span className="docs-tab__category-label">{getCategoryName(catKey)}</span>
                                                    <span className="docs-tab__category-count">{catDocs.length}</span>
                                                </div>
                                                <div className="docs-tab__list-grid">
                                                    {catDocs.map((doc) => {
                                                        const isPdf = doc.name?.toLowerCase().endsWith('.pdf');
                                                        return (
                                                             <div 
                                                                key={doc.id} 
                                                                className="docs-tab__doc-card cursor-pointer"
                                                                onClick={() => {
                                                                    setSelectedPhotoForLightbox({
                                                                        id: doc.id,
                                                                        name: doc.name,
                                                                        mimeType: isPdf ? 'application/pdf' : 'image/jpeg',
                                                                        webViewLink: doc.webViewLink,
                                                                        proxyLink: null,
                                                                    });
                                                                }}
                                                            >
                                                                <div className={`docs-tab__doc-icon ${isPdf ? 'docs-tab__doc-icon--pdf' : 'docs-tab__doc-icon--img'}`}>
                                                                    <FileText className="h-6 w-6" />
                                                                </div>
                                                                <div className="docs-tab__doc-info">
                                                                    <div
                                                                        className="docs-tab__doc-name"
                                                                        title={doc.name}
                                                                    >
                                                                        {doc.name}
                                                                    </div>
                                                                    <div className="docs-tab__doc-meta">
                                                                        {doc.panelId && (
                                                                            <span className="docs-tab__doc-panel-badge">
                                                                                {getPanelName(doc.panelId)}
                                                                            </span>
                                                                        )}
                                                                        <span>{(doc.fileSize / 1024).toFixed(1)} KB</span>
                                                                    </div>
                                                                </div>
                                                                <div className="docs-tab__doc-actions">
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            setSelectedPhotoForLightbox({
                                                                                id: doc.id,
                                                                                name: doc.name,
                                                                                mimeType: isPdf ? 'application/pdf' : 'image/jpeg',
                                                                                webViewLink: doc.webViewLink,
                                                                                proxyLink: null,
                                                                            });
                                                                        }}
                                                                        className="docs-tab__doc-action-btn"
                                                                        title="View Document"
                                                                    >
                                                                        <Eye className="h-4 w-4" />
                                                                    </button>
                                                                    {user?.role === "superadmin" && (
                                                                        <button
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                deleteDoc(doc.id);
                                                                            }}
                                                                            className="docs-tab__doc-action-btn docs-tab__doc-action-btn--delete"
                                                                            title="Delete Document"
                                                                        >
                                                                            <Trash2 className="h-4 w-4" />
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* FAB for Upload */}
                    <div className="fixed bottom-8 right-8 z-40 flex items-center gap-3">
                        <Button
                            onClick={() => setIsUploadModalOpen(true)}
                            className="h-14 w-14 rounded-full bg-violet-600 hover:bg-violet-700 text-white shadow-lg shadow-violet-200 flex items-center justify-center transition-transform hover:scale-105"
                            title="Upload Document"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                <line x1="12" y1="5" x2="12" y2="19"></line>
                                <line x1="5" y1="12" x2="19" y2="12"></line>
                            </svg>
                        </Button>
                    </div>

                    {/* Modals */}
                    <UploadModal
                        isOpen={isUploadModalOpen}
                        onClose={() => setIsUploadModalOpen(false)}
                        panels={panels}
                        selectedCategory={selectedCategory}
                        setSelectedCategory={setSelectedCategory}
                        selectedPanel={selectedPanel}
                        setSelectedPanel={setSelectedPanel}
                        filesToUpload={filesToUpload}
                        setFilesToUpload={setFilesToUpload}
                        onUpload={uploadFiles}
                        isUploading={isUploading}
                    />

                    {selectedPhotoForLightbox && (
                        <Lightbox
                            photo={selectedPhotoForLightbox}
                            onClose={() => setSelectedPhotoForLightbox(null)}
                            onDownload={downloadFile}
                            onNext={() => {
                                const currentIndex = filteredDocs.findIndex(p => p.id === selectedPhotoForLightbox.id);
                                if (currentIndex < filteredDocs.length - 1) {
                                    const nextDoc = filteredDocs[currentIndex + 1];
                                    setSelectedPhotoForLightbox({
                                        id: nextDoc.id,
                                        name: nextDoc.name,
                                        mimeType: nextDoc.name?.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
                                        webViewLink: nextDoc.webViewLink,
                                        proxyLink: null,
                                    });
                                }
                            }}
                            onPrev={() => {
                                const currentIndex = filteredDocs.findIndex(p => p.id === selectedPhotoForLightbox.id);
                                if (currentIndex > 0) {
                                    const prevDoc = filteredDocs[currentIndex - 1];
                                    setSelectedPhotoForLightbox({
                                        id: prevDoc.id,
                                        name: prevDoc.name,
                                        mimeType: prevDoc.name?.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
                                        webViewLink: prevDoc.webViewLink,
                                        proxyLink: null,
                                    });
                                }
                            }}
                            hasNext={filteredDocs.findIndex(p => p.id === selectedPhotoForLightbox.id) < filteredDocs.length - 1}
                            hasPrev={filteredDocs.findIndex(p => p.id === selectedPhotoForLightbox.id) > 0}
                        />
                    )}
                </div>
            )}
        </div>
    );
};

export default HospitalDocsAndDetails;
