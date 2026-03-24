import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import apiService from "../../../../services/api";
import { useAuth } from "../../../../context/AuthContext";
import {
    Building, Upload, Trash2, FileText, ChevronDown, Loader2, Save,
    MapPin, CreditCard, Phone, FileCheck, Info, Check, Filter, 
    CloudUpload, Eye, GripVertical
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { HospitalPanel } from "../../../../types";
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
            { name: "specialities", label: "Hospital Specialities", type: "text" },
            { name: "typeOfCare", label: "Type of Care", type: "text" },
            { name: "ownership", label: "Hospital Ownership", type: "text" },
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
            { name: "hfrId", label: "HFR ID", type: "text" },
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
            { name: "panNumber", label: "PAN Number", type: "text" },
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
            { name: "contactNumber", label: "Contact Number", type: "text" },
            { name: "hospitalEmail", label: "Hospital Email ID", type: "email" },
            { name: "tpaCoordinatorName", label: "TPA Coordinator Name", type: "text" },
            { name: "tpaCoordinatorContact", label: "TPA Coordinator Contact", type: "text" },
            { name: "tpaCoordinatorEmail", label: "TPA Coordinator Email", type: "email" },
            { name: "cmoName", label: "CEO / CMO Name", type: "text" },
            { name: "cmoContact", label: "CEO / CMO Contact", type: "text" },
            { name: "cmoEmail", label: "CEO / CMO Email", type: "email" },
        ],
    },
];

// ─── Sub-Components ─────────────────────────────────────────────────────────

/** Collapsible accordion section for Detail fields */
const DetailSection: React.FC<{
    section: FieldSection;
    details: any;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}> = ({ section, details, onChange }) => {
    const [expanded, setExpanded] = useState(true);

    const filledCount = section.fields.filter(f => details[f.name]?.toString().trim()).length;
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
                            <label className="detail-field__label" htmlFor={`field-${field.name}`}>
                                {field.label}
                            </label>
                            <input
                                id={`field-${field.name}`}
                                type={field.type}
                                name={field.name}
                                value={details[field.name] || ""}
                                onChange={onChange}
                                className="detail-field__input"
                                placeholder={`Enter ${field.label.toLowerCase()}`}
                            />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

/** Drag-and-drop upload zone */
const UploadZone: React.FC<{
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
    panels, selectedCategory, setSelectedCategory, selectedPanel, setSelectedPanel,
    filesToUpload, setFilesToUpload, onUpload, isUploading,
}) => {
    const [isDragging, setIsDragging] = useState(false);
    const dropRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        if (dropRef.current && !dropRef.current.contains(e.relatedTarget as Node)) {
            setIsDragging(false);
        }
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) setFilesToUpload(files);
    }, [setFilesToUpload]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) setFilesToUpload(Array.from(e.target.files));
    };

    const removeFile = (index: number) => {
        setFilesToUpload(filesToUpload.filter((_, i) => i !== index));
    };

    return (
        <div className="upload-zone-wrapper">
            {/* Category + Panel selectors */}
            <div className="upload-zone__selectors">
                <div className="upload-zone__select-group">
                    <label className="upload-zone__label">Document Category</label>
                    <select
                        className="upload-zone__select"
                        value={selectedCategory}
                        onChange={e => setSelectedCategory(e.target.value)}
                    >
                        {DOCUMENT_CATEGORIES.map(c => (
                            <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                    </select>
                </div>
                <div className="upload-zone__select-group">
                    <label className="upload-zone__label">Panel (Optional)</label>
                    <select
                        className="upload-zone__select"
                        value={selectedPanel}
                        onChange={e => setSelectedPanel(e.target.value)}
                    >
                        <option value="">-- General (Not Panel Specific) --</option>
                        {panels.map(p => (
                            <option key={p.panel_id} value={p.panel_id}>{p.panel_name}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Drop zone */}
            <div
                ref={dropRef}
                className={`upload-zone__drop ${isDragging ? "upload-zone__drop--active" : ""}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleFileChange}
                    className="upload-zone__hidden-input"
                />
                <div className="upload-zone__drop-content">
                    <div className={`upload-zone__drop-icon ${isDragging ? "upload-zone__drop-icon--active" : ""}`}>
                        <CloudUpload className="h-8 w-8" />
                    </div>
                    <p className="upload-zone__drop-title">
                        {isDragging ? "Drop files here" : "Drag & drop files here"}
                    </p>
                    <p className="upload-zone__drop-subtitle">
                        or <span className="upload-zone__browse-link">browse</span> to select files
                    </p>
                </div>
            </div>

            {/* Selected files list */}
            {filesToUpload.length > 0 && (
                <div className="upload-zone__files">
                    <p className="upload-zone__files-title">{filesToUpload.length} file{filesToUpload.length > 1 ? 's' : ''} selected</p>
                    <div className="upload-zone__files-list">
                        {filesToUpload.map((file, i) => (
                            <div key={i} className="upload-zone__file-chip">
                                <FileText className="h-3.5 w-3.5 text-slate-500" />
                                <span className="upload-zone__file-name">{file.name}</span>
                                <span className="upload-zone__file-size">{(file.size / 1024).toFixed(0)} KB</span>
                                <button
                                    type="button"
                                    className="upload-zone__file-remove"
                                    onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                                >×</button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Upload button */}
            <Button
                className="upload-zone__submit"
                onClick={onUpload}
                disabled={isUploading || filesToUpload.length === 0}
            >
                {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {isUploading ? "Uploading..." : "Upload Document"}
            </Button>
        </div>
    );
};

// ─── Main Component ─────────────────────────────────────────────────────────

const HospitalDocsAndDetails: React.FC<HospitalDocsAndDetailsProps> = ({
    hospitalId, hospital, panels, onRefresh, refreshing,
}) => {
    const { user } = useAuth();

    // Inner sub-tab
    const [activeSubTab, setActiveSubTab] = useState<"details" | "documents">("details");

    // Details State
    const [details, setDetails] = useState<any>(hospital?.details || {});
    const [isSavingDetails, setIsSavingDetails] = useState(false);

    // Docs State
    const [docs, setDocs] = useState<any[]>([]);
    const [isLoadingDocs, setIsLoadingDocs] = useState(false);
    const [categoryFilter, setCategoryFilter] = useState("all");

    // Upload State
    const [isUploading, setIsUploading] = useState(false);
    const [selectedCategory, setSelectedCategory] = useState("general_doc");
    const [selectedPanel, setSelectedPanel] = useState<string>("");
    const [filesToUpload, setFilesToUpload] = useState<File[]>([]);

    useEffect(() => {
        fetchDocs();
        if (hospital?.details) setDetails(hospital.details);
    }, [hospitalId, hospital]);

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

    const handleDetailChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setDetails((prev: any) => ({ ...prev, [name]: value }));
    };

    const saveDetails = async () => {
        setIsSavingDetails(true);
        try {
            await apiService.updateHospital(hospitalId, { details });
            toast.success("Hospital details updated successfully!");
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
        (sum, s) => sum + s.fields.filter(f => details[f.name]?.toString().trim()).length, 0
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
                                details={details}
                                onChange={handleDetailChange}
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
                                onClick={saveDetails}
                                disabled={isSavingDetails}
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
                    <div className="docs-tab__layout">
                        {/* Left: Upload Zone */}
                        <div className="docs-tab__upload-col">
                            <div className="docs-tab__card">
                                <div className="docs-tab__card-header">
                                    <Upload className="h-5 w-5 text-blue-500" />
                                    <h3>Upload Document</h3>
                                </div>
                                <UploadZone
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
                            </div>
                        </div>

                        {/* Right: Document List */}
                        <div className="docs-tab__list-col">
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
                                                {catDocs.map(doc => (
                                                    <div key={doc.id} className="docs-tab__doc-row">
                                                        <div className="docs-tab__doc-icon">
                                                            <FileText className="h-4 w-4" />
                                                        </div>
                                                        <div className="docs-tab__doc-info">
                                                            <a
                                                                href={doc.webViewLink}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="docs-tab__doc-name"
                                                            >
                                                                {doc.name}
                                                            </a>
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
                                                            <a
                                                                href={doc.webViewLink}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="docs-tab__doc-action-btn"
                                                                title="View Document"
                                                            >
                                                                <Eye className="h-4 w-4" />
                                                            </a>
                                                            {user?.role === "superadmin" && (
                                                                <button
                                                                    onClick={() => deleteDoc(doc.id)}
                                                                    className="docs-tab__doc-action-btn docs-tab__doc-action-btn--delete"
                                                                    title="Delete Document"
                                                                >
                                                                    <Trash2 className="h-4 w-4" />
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default HospitalDocsAndDetails;
