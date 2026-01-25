import React, { useState, useEffect } from "react";
import apiService from "../services/api";
import { Patient } from "../types";
import { Document, Page, pdfjs } from 'react-pdf';

/* 
 * Configure PDF worker. 
 * We use the CDN to avoid build issues with Vite/Webpack unless specifically configured 
 * but for Vite local dev, import.meta works. 
 * Let's try the CDN approach for maximum stability if local worker parsing fails, 
 * or the standard import approach. 
 * 'pdfjs-dist' comes with 'react-pdf'.
 */
/* 
 * Configure PDF worker. 
 * We use the CDN to avoid build issues with Vite/Webpack unless specifically configured 
 * but for Vite local dev, import.meta works. 
 * Let's try the CDN approach for maximum stability if local worker parsing fails, 
 * or the standard import approach. 
 * 'pdfjs-dist' comes with 'react-pdf'.
 */
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    thumbnailLink?: string;
    webViewLink?: string;
    createdTime?: string;
}

interface PhotoCategory {
    id: string;
    name: string;
    displayName: string;
    photos: DriveFile[];
}

interface PhotosData {
    rootPhotos: DriveFile[];
    categories: PhotoCategory[];
    admissionType?: 'conservative' | 'surgical';
}

interface PatientPhotosModalProps {
    patient: Patient;
    onClose: () => void;
    onUpdate?: (patientId: string, data: {
        firstName: string;
        lastName?: string;
        phone: string;
        admittedAt: string;
        admissionType?: 'conservative' | 'surgical';
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
    }) => Promise<void>;
}

// In-memory cache for patient photos (persists across modal opens during session)
const photosCache = new Map<string, { data: PhotosData; timestamp: number }>();
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const PatientPhotosModal: React.FC<PatientPhotosModalProps> = ({ patient, onClose, onUpdate }) => {
    const [photosData, setPhotosData] = useState<PhotosData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedPhoto, setSelectedPhoto] = useState<DriveFile | null>(null);
    const [activeCategory, setActiveCategory] = useState<string>('all');
    const [isCached, setIsCached] = useState(false);


    const [mainTab, setMainTab] = useState<'photos' | 'ipd' | 'claims'>(onUpdate ? 'ipd' : 'photos');

    // IPD form state
    const [ipdForm, setIpdForm] = useState({
        phone: patient.phone || '',
        beneficiaryId: patient.beneficiary_id || '',
        admissionType: patient.admission_type || '',
    });

    // Claims form state
    const [claimsForm, setClaimsForm] = useState({
        treatmentPlan: patient.treatment_plan || patient.treatment_procedure || '',
        latestStatus: patient.latest_status || '',
        claimAmount: patient.claim_amount?.toString() || '',
        claimApproved: patient.claim_approved?.toString() || '',
        incentive: patient.incentive?.toString() || '',
        deduction: patient.deduction?.toString() || '',
        deductionReason: patient.deduction_reason || '',
        claimSettled: patient.claim_settled?.toString() || '',
        claimSettledDate: patient.claim_settled_date || '',
    });
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);

    const [numPages, setNumPages] = useState<number | null>(null);
    const [pageNumber, setPageNumber] = useState(1);

    function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
        setNumPages(numPages);
        setPageNumber(1);
    }

    // Reset page number when selected photo changes
    useEffect(() => {
        if (selectedPhoto) {
            setPageNumber(1);
            setNumPages(null);
        }
    }, [selectedPhoto]);

    useEffect(() => {
        fetchPhotos();
    }, [patient.id]);

    // Reset forms when patient changes
    useEffect(() => {
        setIpdForm({
            phone: patient.phone || '',
            beneficiaryId: patient.beneficiary_id || '',
            admissionType: patient.admission_type || '',
        });
        setClaimsForm({
            treatmentPlan: patient.treatment_plan || patient.treatment_procedure || '',
            latestStatus: patient.latest_status || '',
            claimAmount: patient.claim_amount?.toString() || '',
            claimApproved: patient.claim_approved?.toString() || '',
            incentive: patient.incentive?.toString() || '',
            deduction: patient.deduction?.toString() || '',
            deductionReason: patient.deduction_reason || '',
            claimSettled: patient.claim_settled?.toString() || '',
            claimSettledDate: patient.claim_settled_date || '',
        });
    }, [patient]);

    const fetchPhotos = async (forceRefresh = false) => {
        try {
            // Check cache first (unless forcing refresh)
            if (!forceRefresh) {
                const cached = photosCache.get(patient.id);
                if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
                    console.log('[PHOTOS] Using cached data for patient:', patient.id);
                    setPhotosData(cached.data);
                    setIsCached(true);
                    setLoading(false);
                    return;
                }
            }

            setLoading(true);
            setError(null);
            setIsCached(false);

            const response = await apiService.getPatientPhotos(patient.id);
            const data = response.data.data;

            let normalizedData: PhotosData;
            // Handle both old format (array) and new format (object with categories)
            if (Array.isArray(data)) {
                normalizedData = { rootPhotos: data, categories: [] };
            } else {
                normalizedData = data;
            }

            // Store in cache
            photosCache.set(patient.id, {
                data: normalizedData,
                timestamp: Date.now()
            });

            setPhotosData(normalizedData);
        } catch (err: any) {
            console.error("Failed to fetch photos:", err);
            setError(err.response?.data?.message || "Failed to load photos");
        } finally {
            setLoading(false);
        }
    };

    const handleRefresh = () => {
        fetchPhotos(true);
    };

    const handleSaveDetails = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!onUpdate) return;

        try {
            setIsSaving(true);
            setSaveSuccess(false);

            await onUpdate(patient.id, {
                firstName: patient.first_name,
                lastName: patient.last_name,
                phone: ipdForm.phone,
                admittedAt: patient.admitted_at,
                admissionType: ipdForm.admissionType as 'conservative' | 'surgical' | undefined,
                // IPD fields
                beneficiaryId: ipdForm.beneficiaryId || undefined,
                // Claims fields
                treatmentPlan: claimsForm.treatmentPlan || undefined,
                latestStatus: claimsForm.latestStatus || undefined,
                claimAmount: claimsForm.claimAmount ? parseFloat(claimsForm.claimAmount) : undefined,
                claimApproved: claimsForm.claimApproved ? parseFloat(claimsForm.claimApproved) : undefined,
                incentive: claimsForm.incentive ? parseFloat(claimsForm.incentive) : undefined,
                deduction: claimsForm.deduction ? parseFloat(claimsForm.deduction) : undefined,
                deductionReason: claimsForm.deductionReason || undefined,
                claimSettled: claimsForm.claimSettled ? parseFloat(claimsForm.claimSettled) : undefined,
                claimSettledDate: claimsForm.claimSettledDate || undefined,
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

    const getDirectLink = (fileId: string) => {
        return `https://drive.google.com/uc?id=${fileId}`;
    };



    const getTotalPhotoCount = () => {
        if (!photosData) return 0;
        const rootCount = photosData.rootPhotos?.length || 0;
        const categoryCount = photosData.categories?.reduce((acc, cat) => acc + cat.photos.length, 0) || 0;
        return rootCount + categoryCount;
    };

    const getActivePhotos = (): DriveFile[] => {
        if (!photosData) return [];
        if (activeCategory === 'all') {
            return photosData.rootPhotos || [];
        }
        const category = photosData.categories?.find(c => c.name === activeCategory);
        return category?.photos || [];
    };

    const hasCategories = photosData?.categories && photosData.categories.length > 0;

    return (
        <div className="photos-modal-overlay">
            {/* ... existing header and body ... */}

            <div className="photos-modal-content" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="photos-modal-header">
                    <div className="patient-info">
                        <div className="patient-avatar-modal">
                            {patient.first_name?.charAt(0) || ''}{patient.last_name?.charAt(0) || ''}
                        </div>
                        <div>
                            <h2>{patient.first_name} {patient.last_name}</h2>
                            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                                <span className="photo-count">{getTotalPhotoCount()} file{getTotalPhotoCount() !== 1 ? 's' : ''}</span>
                                {photosData?.admissionType && (
                                    <span className={`admission-type-badge ${photosData.admissionType}`}>
                                        {photosData.admissionType}
                                    </span>
                                )}
                                {isCached && !loading && (
                                    <span className="cached-badge" title="Loaded from cache">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <circle cx="12" cy="12" r="10" />
                                            <path d="M12 6v6l4 2" />
                                        </svg>
                                        Cached
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        {!loading && (
                            <button className="refresh-btn" onClick={handleRefresh} title="Refresh files">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M23 4v6h-6M1 20v-6h6" />
                                    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                                </svg>
                            </button>
                        )}
                        <button className="photos-modal-close" onClick={onClose}>
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Main Tabs (Photos / IPD Details / Claims) */}
                {onUpdate && (
                    <div className="main-tabs">
                        <button
                            className={`main-tab ${mainTab === 'photos' ? 'active' : ''}`}
                            onClick={() => setMainTab('photos')}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                <circle cx="8.5" cy="8.5" r="1.5" />
                                <path d="M21 15l-5-5L5 21" />
                            </svg>
                            Files
                        </button>
                        <button
                            className={`main-tab ${mainTab === 'ipd' ? 'active' : ''}`}
                            onClick={() => setMainTab('ipd')}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <path d="M14 2v6h6" />
                                <line x1="16" y1="13" x2="8" y2="13" />
                                <line x1="16" y1="17" x2="8" y2="17" />
                            </svg>
                            IPD Details
                        </button>
                        <button
                            className={`main-tab ${mainTab === 'claims' ? 'active' : ''}`}
                            onClick={() => setMainTab('claims')}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                            </svg>
                            Claims
                        </button>
                    </div>
                )}

                {/* Category Tabs - only show when viewing photos */}
                {mainTab === 'photos' && !loading && !error && hasCategories && (
                    <div className="category-tabs">
                        <button
                            className={`category-tab ${activeCategory === 'all' ? 'active' : ''}`}
                            onClick={() => setActiveCategory('all')}
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                <circle cx="8.5" cy="8.5" r="1.5" />
                                <path d="M21 15l-5-5L5 21" />
                            </svg>
                            Admission Files
                            <span className="tab-count">{photosData?.rootPhotos?.length || 0}</span>
                        </button>
                        {photosData?.categories?.map((category) => (
                            <button
                                key={category.id}
                                className={`category-tab ${activeCategory === category.name ? 'active' : ''}`}
                                onClick={() => setActiveCategory(category.name)}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                </svg>
                                {category.displayName}
                                <span className="tab-count">{category.photos.length}</span>
                            </button>
                        ))}
                    </div>
                )}


                {/* Content */}
                <div className="photos-modal-body">
                    {mainTab === 'photos' ? (
                        <>
                            {loading ? (
                                <div className="photos-grid">
                                    {[...Array(8)].map((_, i) => (
                                        <div key={i} className="skeleton-photo-card">
                                            <div className="skeleton-shimmer" />
                                        </div>
                                    ))}
                                </div>
                            ) : error ? (
                                <div className="photos-error">
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <circle cx="12" cy="12" r="10" />
                                        <path d="M12 8v4M12 16h.01" />
                                    </svg>
                                    <span>{error}</span>
                                    <button onClick={() => fetchPhotos(true)} className="retry-btn">Try Again</button>
                                </div>
                            ) : getTotalPhotoCount() === 0 ? (
                                <div className="photos-empty">
                                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                        <circle cx="8.5" cy="8.5" r="1.5" />
                                        <path d="M21 15l-5-5L5 21" />
                                    </svg>
                                    <span>No files uploaded yet</span>
                                </div>
                            ) : getActivePhotos().length === 0 ? (
                                <div className="photos-empty">
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                    </svg>
                                    <span>No files in this category</span>
                                </div>
                            ) : (
                                <div className="photos-grid">
                                    {getActivePhotos().map((photo) => (
                                        <div
                                            key={photo.id}
                                            className="photo-card"
                                            onClick={() => {
                                                console.log("Selected photo:", photo);
                                                setSelectedPhoto(photo);
                                            }}
                                        >
                                            {photo.mimeType?.toLowerCase().includes('pdf') ? (
                                                <div className="pdf-thumbnail">
                                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="1.5">
                                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                        <polyline points="14 2 14 8 20 8" />
                                                        <path d="M10 12h-2v4h4" />
                                                        <path d="M10 12l2 4" />
                                                    </svg>
                                                    <span className="pdf-label">PDF</span>
                                                </div>
                                            ) : (
                                                <img
                                                    src={apiService.getThumbnailUrl(photo.id)}
                                                    alt={photo.name}
                                                    loading="lazy"
                                                />
                                            )}
                                            <div className="photo-overlay">
                                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                                                </svg>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    ) : mainTab === 'ipd' ? (
                        <form className="pmjay-form" onSubmit={handleSaveDetails}>
                            {/* ... IPD form content ... */}
                            <div className="pmjay-form-grid">
                                <div className="pmjay-field">
                                    <label>Patient Name</label>
                                    <input
                                        type="text"
                                        value={`${patient.first_name} ${patient.last_name || ''}`}
                                        disabled
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Phone Number</label>
                                    <input
                                        type="text"
                                        value={ipdForm.phone}
                                        onChange={(e) => setIpdForm({ ...ipdForm, phone: e.target.value })}
                                        placeholder="e.g., 9876543210"
                                        maxLength={10}
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Beneficiary ID</label>
                                    <input
                                        type="text"
                                        value={ipdForm.beneficiaryId}
                                        onChange={(e) => setIpdForm({ ...ipdForm, beneficiaryId: e.target.value })}
                                        placeholder="e.g., BEN123456789"
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Admission Type</label>
                                    <select
                                        value={ipdForm.admissionType}
                                        onChange={(e) => setIpdForm({ ...ipdForm, admissionType: e.target.value })}
                                    >
                                        <option value="">Select type</option>
                                        <option value="conservative">Conservative</option>
                                        <option value="surgical">Surgical</option>
                                    </select>
                                </div>
                                <div className="pmjay-field">
                                    <label>Admitted At</label>
                                    <input
                                        type="text"
                                        value={patient.admitted_at ? new Date(patient.admitted_at).toLocaleString('en-IN') : '—'}
                                        disabled
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Discharged At</label>
                                    <input
                                        type="text"
                                        value={patient.discharged_at ? new Date(patient.discharged_at).toLocaleString('en-IN') : 'Not discharged'}
                                        disabled
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Active Status</label>
                                    <input
                                        type="text"
                                        value={patient.is_active ? 'Active' : 'Inactive'}
                                        disabled
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Panel</label>
                                    <input
                                        type="text"
                                        value={patient.panel_name || 'Not assigned'}
                                        disabled
                                    />
                                </div>
                            </div>
                            <div className="pmjay-actions">
                                {saveSuccess && (
                                    <span className="save-success">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M20 6L9 17l-5-5" />
                                        </svg>
                                        Saved successfully
                                    </span>
                                )}
                                <button type="submit" className="save-pmjay-btn" disabled={isSaving}>
                                    {isSaving ? 'Saving...' : 'Save Changes'}
                                </button>
                            </div>
                        </form>
                    ) : (
                        <form className="pmjay-form" onSubmit={handleSaveDetails}>
                            {/* ... Claims form content ... */}
                            <div className="pmjay-form-grid">
                                <div className="pmjay-field full-width">
                                    <label>Treatment Plan</label>
                                    <textarea
                                        value={claimsForm.treatmentPlan}
                                        onChange={(e) => setClaimsForm({ ...claimsForm, treatmentPlan: e.target.value })}
                                        placeholder="e.g., Plate(SB071B-Implant Removal under RA / GA)"
                                        rows={2}
                                    />
                                </div>
                                <div className="pmjay-field full-width">
                                    <label>Latest Status</label>
                                    <input
                                        type="text"
                                        value={claimsForm.latestStatus}
                                        onChange={(e) => setClaimsForm({ ...claimsForm, latestStatus: e.target.value })}
                                        placeholder="e.g., Claim paid on 26/08/2025"
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Claim Amount (₹)</label>
                                    <input
                                        type="number"
                                        value={claimsForm.claimAmount}
                                        onChange={(e) => setClaimsForm({ ...claimsForm, claimAmount: e.target.value })}
                                        placeholder="e.g., 122860"
                                        step="0.01"
                                        min="0"
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Claim Approved (₹)</label>
                                    <input
                                        type="number"
                                        value={claimsForm.claimApproved}
                                        onChange={(e) => setClaimsForm({ ...claimsForm, claimApproved: e.target.value })}
                                        placeholder="e.g., 100000"
                                        step="0.01"
                                        min="0"
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Incentive (₹)</label>
                                    <input
                                        type="number"
                                        value={claimsForm.incentive}
                                        onChange={(e) => setClaimsForm({ ...claimsForm, incentive: e.target.value })}
                                        placeholder="e.g., 5000"
                                        step="0.01"
                                        min="0"
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Deduction (₹)</label>
                                    <input
                                        type="number"
                                        value={claimsForm.deduction}
                                        onChange={(e) => setClaimsForm({ ...claimsForm, deduction: e.target.value })}
                                        placeholder="e.g., 2000"
                                        step="0.01"
                                        min="0"
                                    />
                                </div>
                                <div className="pmjay-field full-width">
                                    <label>Deduction Reason</label>
                                    <input
                                        type="text"
                                        value={claimsForm.deductionReason}
                                        onChange={(e) => setClaimsForm({ ...claimsForm, deductionReason: e.target.value })}
                                        placeholder="e.g., Documentation incomplete"
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Claim Settled (₹)</label>
                                    <input
                                        type="number"
                                        value={claimsForm.claimSettled}
                                        onChange={(e) => setClaimsForm({ ...claimsForm, claimSettled: e.target.value })}
                                        placeholder="e.g., 98000"
                                        step="0.01"
                                        min="0"
                                    />
                                </div>
                                <div className="pmjay-field">
                                    <label>Settlement Date</label>
                                    <input
                                        type="date"
                                        value={claimsForm.claimSettledDate}
                                        onChange={(e) => setClaimsForm({ ...claimsForm, claimSettledDate: e.target.value })}
                                    />
                                </div>
                            </div>
                            <div className="pmjay-actions">
                                {saveSuccess && (
                                    <span className="save-success">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M20 6L9 17l-5-5" />
                                        </svg>
                                        Saved successfully
                                    </span>
                                )}
                                <button type="submit" className="save-pmjay-btn" disabled={isSaving}>
                                    {isSaving ? 'Saving...' : 'Save Changes'}
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            </div>

            {/* Lightbox */}
            {
                selectedPhoto && (
                    <div className="lightbox-overlay" onClick={(e) => {
                        e.stopPropagation();
                        setSelectedPhoto(null);
                    }}>
                        <button className="lightbox-close" onClick={() => setSelectedPhoto(null)}>
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                        </button>
                        <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
                            {selectedPhoto.mimeType?.toLowerCase().includes('pdf') ? (
                                <div className="pdf-viewer-container">
                                    <Document
                                        file={apiService.getThumbnailUrl(selectedPhoto.id)}
                                        onLoadSuccess={onDocumentLoadSuccess}
                                        loading={
                                            <div className="pdf-loading">
                                                <div className="photos-spinner" />
                                                <span>Loading PDF...</span>
                                            </div>
                                        }
                                        error={
                                            <div className="pdf-error">
                                                <p>Failed to load PDF.</p>
                                                <a href={apiService.getThumbnailUrl(selectedPhoto.id)} target="_blank" rel="noopener noreferrer">Download instead</a>
                                            </div>
                                        }
                                    >
                                        {Array.from(new Array(numPages || 0), (el, index) => (
                                            <Page
                                                key={`page_${index + 1}`}
                                                pageNumber={index + 1}
                                                renderTextLayer={false}
                                                renderAnnotationLayer={false}
                                                width={Math.min(window.innerWidth * 0.85, 800)}
                                            />
                                        ))}
                                    </Document>
                                </div>
                            ) : (
                                <img
                                    src={apiService.getThumbnailUrl(selectedPhoto.id)}
                                    alt={selectedPhoto.name}
                                />
                            )}
                        </div>
                        <div className="lightbox-actions" onClick={(e) => e.stopPropagation()}>
                            <a
                                href={selectedPhoto.webViewLink || getDirectLink(selectedPhoto.id)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="action-btn"
                                title="Open in Drive"
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                                    <path d="M15 3h6v6" />
                                    <path d="M10 14L21 3" />
                                </svg>
                                <span className="action-text">Open in Drive</span>
                            </a>
                            <button
                                className="action-btn"
                                title="Download"
                                onClick={async () => {
                                    try {
                                        const response = await fetch(apiService.getThumbnailUrl(selectedPhoto.id));
                                        const blob = await response.blob();
                                        const url = window.URL.createObjectURL(blob);
                                        const link = document.createElement('a');
                                        link.href = url;
                                        link.download = selectedPhoto.name;
                                        document.body.appendChild(link);
                                        link.click();
                                        document.body.removeChild(link);
                                        window.URL.revokeObjectURL(url);
                                    } catch (err) {
                                        console.error('Failed to download:', err);
                                        alert('Failed to download photo');
                                    }
                                }}
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <polyline points="7 10 12 15 17 10" />
                                    <line x1="12" y1="15" x2="12" y2="3" />
                                </svg>
                                <span className="action-text">Download</span>
                            </button>
                        </div>
                    </div>
                )
            }

            <style>{`
                .photos-modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.6);
                    backdrop-filter: blur(4px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 1000;
                    padding: 2rem;
                }

                .photos-modal-content {
                    background: white;
                    border-radius: 16px;
                    width: 100%;
                    max-width: 1000px;
                    max-height: 90vh;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
                }

                .photos-modal-header {
                    padding: 1.5rem;
                    border-bottom: 1px solid #e2e8f0;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .patient-info {
                    display: flex;
                    align-items: center;
                    gap: 1rem;
                }

                .patient-avatar-modal {
                    width: 48px;
                    height: 48px;
                    border-radius: 12px;
                    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
                    color: white;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 1rem;
                    font-weight: 600;
                    text-transform: uppercase;
                }

                .patient-info h2 {
                    margin: 0;
                    font-size: 1.25rem;
                    font-weight: 600;
                    color: #0f172a;
                }

                .photo-count {
                    font-size: 0.875rem;
                    color: #64748b;
                }

                .admission-type-badge {
                    font-size: 0.75rem;
                    font-weight: 500;
                    padding: 0.25rem 0.625rem;
                    border-radius: 999px;
                    text-transform: capitalize;
                }

                .admission-type-badge.conservative {
                    background: #fef9c3;
                    color: #a16207;
                }

                .admission-type-badge.surgical {
                    background: #fee2e2;
                    color: #b91c1c;
                }

                .cached-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.25rem;
                    font-size: 0.6875rem;
                    color: #10b981;
                    background: #d1fae5;
                    padding: 0.125rem 0.5rem;
                    border-radius: 999px;
                    font-weight: 500;
                }

                /* Main Tabs */
                .main-tabs {
                    display: flex;
                    gap: 0;
                    border-bottom: 1px solid #e2e8f0;
                    background: #f8fafc;
                }

                .main-tab {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 1rem 1.5rem;
                    border: none;
                    background: transparent;
                    font-size: 0.9375rem;
                    font-weight: 500;
                    color: #64748b;
                    cursor: pointer;
                    transition: all 0.2s;
                    border-bottom: 2px solid transparent;
                    margin-bottom: -1px;
                }

                .main-tab:hover {
                    color: #0f172a;
                    background: #f1f5f9;
                }

                .main-tab.active {
                    color: #4f46e5;
                    border-bottom-color: #4f46e5;
                    background: white;
                }

                /* PMJAY Form */
                .pmjay-form {
                    padding: 0.5rem;
                }

                .pmjay-form-grid {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 1.25rem;
                }

                .pmjay-field {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                }

                .pmjay-field.full-width {
                    grid-column: 1 / -1;
                }

                .pmjay-field label {
                    font-size: 0.875rem;
                    font-weight: 500;
                    color: #374151;
                }

                .pmjay-field input,
                .pmjay-field textarea {
                    padding: 0.75rem 1rem;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    font-size: 0.9375rem;
                    outline: none;
                    transition: all 0.2s;
                    font-family: inherit;
                }

                .pmjay-field input:focus,
                .pmjay-field textarea:focus {
                    border-color: #4f46e5;
                    box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
                }

                .pmjay-field textarea {
                    resize: vertical;
                    min-height: 80px;
                }

                .pmjay-actions {
                    display: flex;
                    align-items: center;
                    justify-content: flex-end;
                    gap: 1rem;
                    margin-top: 1.5rem;
                    padding-top: 1.25rem;
                    border-top: 1px solid #e2e8f0;
                }

                .save-success {
                    display: flex;
                    align-items: center;
                    gap: 0.375rem;
                    color: #16a34a;
                    font-size: 0.875rem;
                    font-weight: 500;
                }

                .save-pmjay-btn {
                    padding: 0.75rem 1.5rem;
                    background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
                    color: white;
                    border: none;
                    border-radius: 8px;
                    font-size: 0.9375rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .save-pmjay-btn:hover:not(:disabled) {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);
                }

                .save-pmjay-btn:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                }

                @media (max-width: 640px) {
                    .pmjay-form-grid {
                        grid-template-columns: 1fr;
                    }
                }

                .refresh-btn {
                    width: 40px;
                    height: 40px;
                    border-radius: 10px;
                    border: none;
                    background: #f1f5f9;
                    color: #64748b;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                }

                .refresh-btn:hover {
                    background: #e2e8f0;
                    color: #0f172a;
                }

                .photos-modal-close {
                    width: 40px;
                    height: 40px;
                    border-radius: 10px;
                    border: none;
                    background: #f1f5f9;
                    color: #64748b;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                }

                .photos-modal-close:hover {
                    background: #e2e8f0;
                    color: #0f172a;
                }

                /* Category Tabs */
                .category-tabs {
                    display: flex;
                    gap: 0.5rem;
                    padding: 1rem 1.5rem;
                    border-bottom: 1px solid #e2e8f0;
                    overflow-x: auto;
                    background: #f8fafc;
                }

                .category-tab {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.5rem 1rem;
                    border: 1px solid #e2e8f0;
                    background: white;
                    border-radius: 8px;
                    font-size: 0.8125rem;
                    font-weight: 500;
                    color: #64748b;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: all 0.2s;
                }

                .category-tab:hover {
                    border-color: #cbd5e1;
                    color: #0f172a;
                }

                .category-tab.active {
                    background: #0f172a;
                    border-color: #0f172a;
                    color: white;
                }

                .category-tab.active .tab-count {
                    background: rgba(255, 255, 255, 0.2);
                    color: white;
                }

                .tab-count {
                    background: #f1f5f9;
                    padding: 0.125rem 0.5rem;
                    border-radius: 999px;
                    font-size: 0.75rem;
                    color: #64748b;
                }

                .photos-modal-body {
                    flex: 1;
                    overflow-y: auto;
                    padding: 1.5rem;
                }

                .photos-loading,
                .photos-error,
                .photos-empty {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 4rem 2rem;
                    color: #64748b;
                    gap: 1rem;
                    text-align: center;
                }

                .photos-spinner {
                    width: 40px;
                    height: 40px;
                    border: 3px solid #e2e8f0;
                    border-top-color: #6366f1;
                    border-radius: 50%;
                    animation: spin 0.8s linear infinite;
                }

                @keyframes spin {
                    to { transform: rotate(360deg); }
                }

                .retry-btn {
                    margin-top: 0.5rem;
                    padding: 0.5rem 1rem;
                    background: #6366f1;
                    color: white;
                    border: none;
                    border-radius: 8px;
                    font-size: 0.875rem;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .retry-btn:hover {
                    background: #4f46e5;
                }

                .photos-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
                    gap: 1rem;
                }

                .photo-card {
                    position: relative;
                    aspect-ratio: 1;
                    border-radius: 12px;
                    overflow: hidden;
                    cursor: pointer;
                    background: #f1f5f9;
                    transition: transform 0.2s, box-shadow 0.2s;
                }

                .photo-card:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 8px 25px -5px rgba(0, 0, 0, 0.15);
                }

                .skeleton-photo-card {
                    position: relative;
                    aspect-ratio: 1;
                    border-radius: 12px;
                    overflow: hidden;
                    background: #e2e8f0;
                }

                .skeleton-shimmer {
                    position: absolute;
                    inset: 0;
                    background: linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%);
                    background-size: 200% 100%;
                    animation: shimmer 1.5s ease-in-out infinite;
                }

                @keyframes shimmer {
                    0% { background-position: -200% 0; }
                    100% { background-position: 200% 0; }
                }

                .photo-card img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }

                .photo-overlay {
                    position: absolute;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.4);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0;
                    transition: opacity 0.2s;
                    color: white;
                }

                .photo-card:hover .photo-overlay {
                    opacity: 1;
                }

                /* Drive Link Card */
                .drive-link-card {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 0.75rem;
                    padding: 1rem;
                    background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
                    border: 1px solid #e2e8f0;
                }

                .drive-link-card:hover {
                    background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%);
                    border-color: #c7d2fe;
                }

                .drive-icon {
                    color: #6366f1;
                }

                .photo-name {
                    font-size: 0.6875rem;
                    color: #64748b;
                    text-align: center;
                    word-break: break-word;
                    line-height: 1.3;
                    max-height: 2.6em;
                    overflow: hidden;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                }

                .open-drive-hint {
                    display: flex;
                    align-items: center;
                    gap: 0.25rem;
                    font-size: 0.625rem;
                    color: #6366f1;
                    font-weight: 500;
                    opacity: 0;
                    transition: opacity 0.2s;
                }

                .drive-link-card:hover .open-drive-hint {
                    opacity: 1;
                }

                /* Lightbox */
                .lightbox-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.95);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 2000;
                }

                .lightbox-content {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .lightbox-content img {
                    max-width: 90vw;
                    max-height: 85vh;
                    object-fit: contain;
                    border-radius: 8px;
                }

                .pdf-viewer-container {
                    width: 90vw;
                    height: 85vh;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    background: transparent;
                }

                .react-pdf__Document {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    overflow: auto;
                    max-height: calc(85vh - 50px);
                    width: 100%;
                }
                
                .react-pdf__Page {
                    margin-bottom: 20px;
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
                }
                
                .react-pdf__Page canvas {
                    max-width: 100% !important;
                    height: auto !important;
                    border-radius: 4px;
                }

                .pdf-controls {
                    display: flex;
                    align-items: center;
                    gap: 1rem;
                    margin-top: 1rem;
                    background: rgba(255, 255, 255, 0.1);
                    backdrop-filter: blur(4px);
                    padding: 0.5rem 1rem;
                    border-radius: 9999px;
                    color: white;
                }

                .pdf-controls button {
                    background: rgba(255, 255, 255, 0.2);
                    border: none;
                    color: white;
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                }

                .pdf-controls button:hover:not(:disabled) {
                    background: rgba(255, 255, 255, 0.3);
                }

                .pdf-controls button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                .pdf-loading, .pdf-error {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 1rem;
                    color: white;
                }

                .pdf-error a {
                    color: #818cf8;
                    text-decoration: underline;
                }
                
                .pdf-thumbnail {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    background: #fff;
                    gap: 0.5rem;
                }

                .pdf-label {
                    font-size: 0.75rem;
                    font-weight: 600;
                    color: #64748b;
                }

                .lightbox-close {
                    position: absolute;
                    top: 1.5rem;
                    right: 1.5rem;
                    width: 48px;
                    height: 48px;
                    border-radius: 50%;
                    border: none;
                    background: rgba(255, 255, 255, 0.1);
                    color: white;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                }

                .lightbox-close:hover {
                    background: rgba(255, 255, 255, 0.2);
                }

                .open-in-drive {
                    position: absolute;
                    bottom: 1.5rem;
                    right: 1.5rem;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.75rem 1.25rem;
                    background: rgba(255, 255, 255, 0.1);
                    color: white;
                    border-radius: 8px;
                    font-size: 0.875rem;
                    font-weight: 500;
                    text-decoration: none;
                    transition: all 0.2s;
                }

                .open-in-drive:hover {
                    background: rgba(255, 255, 255, 0.2);
                }
                .lightbox-actions {
                    position: absolute;
                    bottom: 2rem;
                    left: 50%;
                    transform: translateX(-50%);
                    display: flex;
                    gap: 1rem;
                    z-index: 10;
                }

                .action-btn {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.75rem 1.25rem;
                    background: rgba(255, 255, 255, 0.9);
                    backdrop-filter: blur(4px);
                    border: none;
                    border-radius: 999px;
                    color: #0f172a;
                    text-decoration: none;
                    font-size: 0.875rem;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
                }

                .action-btn:hover {
                    background: white;
                    transform: translateY(-2px);
                    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
                }

                @media (max-width: 640px) {
                    .action-text {
                        display: none;
                    }
                    .action-btn {
                        padding: 0.75rem;
                        border-radius: 50%;
                    }
                }
            `}</style>
        </div>
    );
};

export default PatientPhotosModal;
