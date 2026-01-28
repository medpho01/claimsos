import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import apiService from "../../services/api";
import { Patient } from "../../types";
import { Document, Page, pdfjs } from "react-pdf";
import { Dialog, DialogContent, DialogHeader } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

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
  admissionType?: "conservative" | "surgical";
}

interface PatientPhotosModalProps {
  patient: Patient;
  onClose: () => void;
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

// In-memory cache for patient photos (persists across modal opens during session)
const photosCache = new Map<string, { data: PhotosData; timestamp: number }>();
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const PatientPhotosModal: React.FC<PatientPhotosModalProps> = ({ patient, onClose, onUpdate }) => {
  const [photosData, setPhotosData] = useState<PhotosData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<DriveFile | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [isCached, setIsCached] = useState(false);

  const [mainTab, setMainTab] = useState<"photos" | "ipd" | "claims">("photos");

  // IPD form state
  const [ipdForm, setIpdForm] = useState({
    phone: patient.phone || "",
    beneficiaryId: patient.beneficiary_id || "",
    admissionType: patient.admission_type || "",
  });

  // Claims form state
  const [claimsForm, setClaimsForm] = useState({
    treatmentPlan: patient.treatment_plan || patient.treatment_procedure || "",
    latestStatus: patient.latest_status || "",
    claimAmount: patient.claim_amount?.toString() || "",
    claimApproved: patient.claim_approved?.toString() || "",
    incentive: patient.incentive?.toString() || "",
    deduction: patient.deduction?.toString() || "",
    deductionReason: patient.deduction_reason || "",
    claimSettled: patient.claim_settled?.toString() || "",
    claimSettledDate: patient.claim_settled_date || "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedPhoto) return;

      if (e.key === "ArrowLeft") {
        const photos = getActivePhotos();
        const currentIndex = photos.findIndex((p) => p.id === selectedPhoto.id);
        const prevIndex = currentIndex === 0 ? photos.length - 1 : currentIndex - 1;
        setSelectedPhoto(photos[prevIndex]);
      } else if (e.key === "ArrowRight") {
        const photos = getActivePhotos();
        const currentIndex = photos.findIndex((p) => p.id === selectedPhoto.id);
        const nextIndex = currentIndex === photos.length - 1 ? 0 : currentIndex + 1;
        setSelectedPhoto(photos[nextIndex]);
      }
    };

    if (selectedPhoto) {
      window.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedPhoto, activeCategory, photosData]); // Re-bind when selectedPhoto changes to ensure closure captures latest state if needed, though mostly depends on photosData

  useEffect(() => {
    fetchPhotos();
  }, [patient.id]);

  // Reset forms when patient changes
  useEffect(() => {
    setIpdForm({
      phone: patient.phone || "",
      beneficiaryId: patient.beneficiary_id || "",
      admissionType: patient.admission_type || "",
    });
    setClaimsForm({
      treatmentPlan: patient.treatment_plan || patient.treatment_procedure || "",
      latestStatus: patient.latest_status || "",
      claimAmount: patient.claim_amount?.toString() || "",
      claimApproved: patient.claim_approved?.toString() || "",
      incentive: patient.incentive?.toString() || "",
      deduction: patient.deduction?.toString() || "",
      deductionReason: patient.deduction_reason || "",
      claimSettled: patient.claim_settled?.toString() || "",
      claimSettledDate: patient.claim_settled_date || "",
    });
  }, [patient]);

  const fetchPhotos = async (forceRefresh = false) => {
    try {
      // Check cache first (unless forcing refresh)
      if (!forceRefresh) {
        const cached = photosCache.get(patient.id);
        if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
          console.log("[PHOTOS] Using cached data for patient:", patient.id);
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
        timestamp: Date.now(),
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
        admissionType: ipdForm.admissionType as "conservative" | "surgical" | undefined,
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
    const categoryCount =
      photosData.categories?.reduce((acc, cat) => acc + cat.photos.length, 0) || 0;
    return rootCount + categoryCount;
  };

  const getActivePhotos = (): DriveFile[] => {
    if (!photosData) return [];
    if (activeCategory === "all") {
      return photosData.rootPhotos || [];
    }
    const category = photosData.categories?.find((c) => c.name === activeCategory);
    return category?.photos || [];
  };

  const hasCategories = photosData?.categories && photosData.categories.length > 0;

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
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
    const selectedPhotos = getActivePhotos().filter((p) => selectedIds.has(p.id));
    try {
      for (const photo of selectedPhotos) {
        await downloadFile(photo);
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch (error) {
      console.log(error);
    } finally {
      setIsDownloading(false);
      setIsDownloading(false);
      setIsSelectMode(false);
      setSelectedIds(new Set());
    }
  };

  const togglePhotoSelection = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedIds(newSet);
  };
  return (
    <Dialog open={true} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-[1000px] h-[90vh] flex flex-col p-0 gap-0 overflow-hidden sm:rounded-xl [&>button.absolute.right-4.top-4]:hidden"
        onEscapeKeyDown={(e) => {
          if (selectedPhoto) {
            e.preventDefault();
            setSelectedPhoto(null);
          }
        }}
      >
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white flex items-center justify-center text-lg font-semibold uppercase">
              {patient.first_name?.charAt(0) || ""}
              {patient.last_name?.charAt(0) || ""}
            </div>
            <div>
              <h2 className="m-0 text-xl font-semibold text-slate-900">
                {patient.first_name} {patient.last_name}
              </h2>
              <div className="flex gap-3 items-center mt-1">
                <span className="text-sm text-slate-500">
                  {getTotalPhotoCount()} file{getTotalPhotoCount() !== 1 ? "s" : ""}
                </span>
                {photosData?.admissionType && (
                  <span
                    className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${photosData.admissionType === "conservative"
                      ? "bg-yellow-100 text-yellow-800"
                      : "bg-red-100 text-red-800"
                      }`}
                  >
                    {photosData.admissionType}
                  </span>
                )}
                {isCached && !loading && (
                  <span
                    className="inline-flex items-center gap-1 text-[11px] text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full font-medium"
                    title="Loaded from cache"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 6v6l4 2" />
                    </svg>
                    Cached
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            {mainTab === "photos" && !loading && getActivePhotos().length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsSelectMode(!isSelectMode);
                  setSelectedIds(new Set());
                }}
                className={`rounded-xl px-5 h-10 font-semibold transition-all ${isSelectMode ? "bg-indigo-50 text-indigo-600 border-indigo-200" : "text-slate-600"}`}
              >
                {isSelectMode ? "Cancel" : "Select"}
              </Button>
            )}
            {!loading && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRefresh}
                title="Refresh files"
                className="bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-900 rounded-xl h-10 w-10"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                </svg>
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-900 rounded-xl h-10 w-10"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </Button>
          </div>
        </div>

        {/* Main Tabs (Photos / IPD Details / Claims) */}
        {onUpdate && (
          <div className="flex gap-0 border-b border-slate-200 bg-slate-50 px-6">
            <button
              className={`flex items-center gap-2 px-6 py-4 border-b-2 text-[15px] font-medium transition-all ${mainTab === "photos" ? "border-indigo-600 text-indigo-600 bg-white" : "border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100"}`}
              onClick={() => setMainTab("photos")}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
              Files
            </button>
            <button
              className={`flex items-center gap-2 px-6 py-4 border-b-2 text-[15px] font-medium transition-all ${mainTab === "ipd" ? "border-indigo-600 text-indigo-600 bg-white" : "border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100"}`}
              onClick={() => setMainTab("ipd")}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              IPD Details
            </button>
            <button
              className={`flex items-center gap-2 px-6 py-4 border-b-2 text-[15px] font-medium transition-all ${mainTab === "claims" ? "border-indigo-600 text-indigo-600 bg-white" : "border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100"}`}
              onClick={() => setMainTab("claims")}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
              Claims
            </button>
          </div>
        )}
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
                    selectedIds.size === getActivePhotos().length
                      ? new Set()
                      : new Set(getActivePhotos().map((p) => p.id))
                  )
                }
              >
                {selectedIds.size === getActivePhotos().length ? "Deselect All" : "Select All"}
              </Button>
              <Button
                size="sm"
                disabled={selectedIds.size === 0}
                onClick={handleBulkDownload}
                className="bg-white text-indigo-600 hover:bg-indigo-50 rounded-full px-6 shadow-sm disabled:opacity-50"
              >
                {isDownloading ? "Downloading..." : "Download Selected"}
              </Button>
            </div>
          </div>
        )}
        {/* Category Tabs - only show when viewing photos */}
        {mainTab === "photos" && !loading && !error && hasCategories && !isSelectMode && (
          <div className="flex gap-2 px-6 py-4 border-b border-slate-200 bg-slate-50 overflow-x-auto">
            <button
              className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-[13px] font-medium whitespace-nowrap transition-all ${activeCategory === "all" ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-900"}`}
              onClick={() => setActiveCategory("all")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
              Admission Files
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${activeCategory === "all" ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"}`}
              >
                {photosData?.rootPhotos?.length || 0}
              </span>
            </button>
            {photosData?.categories?.map((category) => (
              <button
                key={category.id}
                className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-[13px] font-medium whitespace-nowrap transition-all ${activeCategory === category.name ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-900"}`}
                onClick={() => setActiveCategory(category.name)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                {category.displayName}
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${activeCategory === category.name ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"}`}
                >
                  {category.photos.length}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {mainTab === "photos" ? (
            <>
              {loading ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
                  {[...Array(8)].map((_, i) => (
                    <div
                      key={i}
                      className="relative aspect-square rounded-xl bg-slate-200 overflow-hidden"
                    >
                      <div
                        className="absolute inset-0 bg-gradient-to-r from-slate-200 via-slate-100 to-slate-200 animate-[shimmer_1.5s_infinite]"
                        style={{ backgroundSize: "200% 100%" }}
                      />
                    </div>
                  ))}
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-4 text-center">
                  <svg
                    width="48"
                    height="48"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v4M12 16h.01" />
                  </svg>
                  <span>{error}</span>
                  <Button onClick={() => fetchPhotos(true)} variant="default">
                    Try Again
                  </Button>
                </div>
              ) : getTotalPhotoCount() === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-4 text-center">
                  <svg
                    width="64"
                    height="64"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                  <span>No files uploaded yet</span>
                </div>
              ) : getActivePhotos().length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-4 text-center">
                  <svg
                    width="48"
                    height="48"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>No files in this category</span>
                </div>
              ) : (
                <motion.div
                  className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-6"
                  initial="hidden"
                  animate="visible"
                  variants={{
                    hidden: { opacity: 0 },
                    visible: {
                      opacity: 1,
                      transition: { staggerChildren: 0.05, delayChildren: 0.1 }
                    }
                  }}
                >
                  {getActivePhotos().map((photo, index) => (
                    <motion.div
                      key={photo.id}
                      variants={{
                        hidden: { opacity: 0, y: 20, scale: 0.95 },
                        visible: {
                          opacity: 1,
                          y: 0,
                          scale: 1,
                          transition: { duration: 0.3, ease: "easeOut" }
                        }
                      }}
                      className="group relative flex flex-col bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition-all cursor-pointer hover:-translate-y-0.5"
                      onClick={() => {
                        setSelectedPhoto(photo);
                      }}
                    >
                      <div className="relative aspect-[4/3] bg-slate-100 overflow-hidden border-b border-slate-100/50">
                        {photo.mimeType?.toLowerCase().includes("pdf") ? (
                          <div className="w-full h-full flex flex-col items-center justify-center bg-white gap-2">
                            <svg
                              width="40"
                              height="40"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="#ef4444"
                              strokeWidth="1.5"
                            >
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                              <path d="M10 12h-2v4h4" />
                              <path d="M10 12l2 4" />
                            </svg>
                          </div>
                        ) : (
                          <img
                            src={apiService.getThumbnailUrl(photo.id)}
                            alt={photo.name}
                            loading="lazy"
                            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                          />
                        )}

                        {/* Hover Overlay */}
                        <div className="absolute inset-0 bg-black/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>

                      {/* Card Footer with Name */}
                      <div className="p-3 flex items-center gap-3 bg-white">
                        <div className="shrink-0">
                          {photo.mimeType?.toLowerCase().includes("pdf") ? (
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="#ef4444"
                              strokeWidth="2"
                            >
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <path d="M14 2v6h6" />
                            </svg>
                          ) : (
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="#ef4444"
                              strokeWidth="2"
                            >
                              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                              <polyline points="14 2 14 8 20 8" />
                              <path d="M8.5 13l2 2.5 3-3.5" />
                            </svg>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p
                            className="text-[13px] font-medium text-slate-700 truncate"
                            title={photo.name}
                          >
                            {photo.name}
                          </p>
                        </div>
                      </div>
                      {isSelectMode && (
                        <div className="absolute top-3 right-3 z-10">
                          <div
                            className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${selectedIds.has(photo.id) ? "bg-indigo-600 border-indigo-600" : "bg-black/20 border-white"}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              togglePhotoSelection(photo.id);
                            }}
                          >
                            {selectedIds.has(photo.id) && (
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="white"
                                strokeWidth="4"
                              >
                                <path d="M20 6L9 17l-5-5" />
                              </svg>
                            )}
                          </div>
                        </div>
                      )}
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </>
          ) : (
            <form className="p-2" onSubmit={handleSaveDetails}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {mainTab === "ipd" ? (
                  <>
                    <div className="grid gap-2">
                      <Label>Patient Name</Label>
                      <Input
                        type="text"
                        value={`${patient.first_name} ${patient.last_name || ""}`}
                        disabled
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Phone Number</Label>
                      <Input
                        type="text"
                        value={ipdForm.phone}
                        onChange={(e) => setIpdForm({ ...ipdForm, phone: e.target.value })}
                        placeholder="e.g., 9876543210"
                        maxLength={10}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Beneficiary ID</Label>
                      <Input
                        type="text"
                        value={ipdForm.beneficiaryId}
                        onChange={(e) => setIpdForm({ ...ipdForm, beneficiaryId: e.target.value })}
                        placeholder="e.g., BEN123456789"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Admission Type</Label>
                      <select
                        value={ipdForm.admissionType}
                        onChange={(e) => setIpdForm({ ...ipdForm, admissionType: e.target.value })}
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <option value="">Select type</option>
                        <option value="conservative">Conservative</option>
                        <option value="surgical">Surgical</option>
                      </select>
                    </div>
                    <div className="grid gap-2">
                      <Label>Admitted At</Label>
                      <Input
                        type="text"
                        value={
                          patient.admitted_at
                            ? new Date(patient.admitted_at).toLocaleString("en-IN")
                            : "—"
                        }
                        disabled
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Discharged At</Label>
                      <Input
                        type="text"
                        value={
                          patient.discharged_at
                            ? new Date(patient.discharged_at).toLocaleString("en-IN")
                            : "Not discharged"
                        }
                        disabled
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Active Status</Label>
                      <Input
                        type="text"
                        value={patient.is_active ? "Active" : "Inactive"}
                        disabled
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Panel</Label>
                      <Input type="text" value={patient.panel_name || "Not assigned"} disabled />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="grid gap-2 col-span-1 md:col-span-2">
                      <Label>Treatment Plan</Label>
                      <textarea
                        value={claimsForm.treatmentPlan}
                        onChange={(e) =>
                          setClaimsForm({ ...claimsForm, treatmentPlan: e.target.value })
                        }
                        placeholder="e.g., Plate(SB071B-Implant Removal under RA / GA)"
                        rows={2}
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                    <div className="grid gap-2 col-span-1 md:col-span-2">
                      <Label>Latest Status</Label>
                      <Input
                        type="text"
                        value={claimsForm.latestStatus}
                        onChange={(e) =>
                          setClaimsForm({ ...claimsForm, latestStatus: e.target.value })
                        }
                        placeholder="e.g., Claim paid on 26/08/2025"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Claim Amount (₹)</Label>
                      <Input
                        type="number"
                        value={claimsForm.claimAmount}
                        onChange={(e) =>
                          setClaimsForm({ ...claimsForm, claimAmount: e.target.value })
                        }
                        placeholder="e.g., 122860"
                        step="0.01"
                        min="0"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Claim Approved (₹)</Label>
                      <Input
                        type="number"
                        value={claimsForm.claimApproved}
                        onChange={(e) =>
                          setClaimsForm({ ...claimsForm, claimApproved: e.target.value })
                        }
                        placeholder="e.g., 100000"
                        step="0.01"
                        min="0"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Incentive (₹)</Label>
                      <Input
                        type="number"
                        value={claimsForm.incentive}
                        onChange={(e) =>
                          setClaimsForm({ ...claimsForm, incentive: e.target.value })
                        }
                        placeholder="e.g., 5000"
                        step="0.01"
                        min="0"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Deduction (₹)</Label>
                      <Input
                        type="number"
                        value={claimsForm.deduction}
                        onChange={(e) =>
                          setClaimsForm({ ...claimsForm, deduction: e.target.value })
                        }
                        placeholder="e.g., 2000"
                        step="0.01"
                        min="0"
                      />
                    </div>
                    <div className="grid gap-2 col-span-1 md:col-span-2">
                      <Label>Deduction Reason</Label>
                      <Input
                        type="text"
                        value={claimsForm.deductionReason}
                        onChange={(e) =>
                          setClaimsForm({ ...claimsForm, deductionReason: e.target.value })
                        }
                        placeholder="e.g., Documentation incomplete"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Claim Settled (₹)</Label>
                      <Input
                        type="number"
                        value={claimsForm.claimSettled}
                        onChange={(e) =>
                          setClaimsForm({ ...claimsForm, claimSettled: e.target.value })
                        }
                        placeholder="e.g., 98000"
                        step="0.01"
                        min="0"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Settlement Date</Label>
                      <Input
                        type="date"
                        value={claimsForm.claimSettledDate}
                        onChange={(e) =>
                          setClaimsForm({ ...claimsForm, claimSettledDate: e.target.value })
                        }
                      />
                    </div>
                  </>
                )}
              </div>
              <div className="flex items-center justify-end gap-4 mt-6 pt-5 border-t border-slate-200">
                {saveSuccess && (
                  <span className="flex items-center gap-1.5 text-emerald-600 text-sm font-medium">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    Saved successfully
                  </span>
                )}
                <Button
                  type="submit"
                  disabled={isSaving}
                  className="bg-gradient-to-br from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 text-white shadow-md hover:shadow-lg transition-all"
                >
                  {isSaving ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </form>
          )}
        </div>
      </DialogContent>

      {/* Lightbox - Full Screen Overlay */}
      {selectedPhoto &&
        createPortal(
          <div
            className="fixed inset-0 z-[1050] pointer-events-auto bg-black/95 flex items-center justify-center"
            onClick={() => setSelectedPhoto(null)}
          >
            {/* Top Bar: Name & Date (Left) and Close (Right) */}
            <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-start z-[1060] pointer-events-none">
              <div className="flex flex-col text-white pointer-events-auto max-w-[70%]">
                <h3
                  className="text-lg font-semibold drop-shadow-md line-clamp-1"
                  title={selectedPhoto.name}
                >
                  {selectedPhoto.name}
                </h3>
                {selectedPhoto.createdTime && (
                  <p className="text-sm opacity-90 drop-shadow-md mt-0.5">
                    {new Date(selectedPhoto.createdTime).toLocaleString()}
                  </p>
                )}
              </div>

              <button
                className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors border-none cursor-pointer pointer-events-auto"
                onClick={() => setSelectedPhoto(null)}
              >
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div
              className="w-full h-full flex items-center justify-center p-4"
              onClick={(e) => e.stopPropagation()}
            >
              {selectedPhoto.mimeType?.toLowerCase().includes("pdf") ? (
                <div className="w-[90vw] h-[85vh] flex flex-col items-center justify-center">
                  <Document
                    file={apiService.getThumbnailUrl(selectedPhoto.id)}
                    onLoadSuccess={onDocumentLoadSuccess}
                    loading={
                      <div className="flex flex-col items-center gap-4 text-white">
                        <div className="w-10 h-10 border-4 border-slate-700 border-t-indigo-500 rounded-full animate-spin" />
                        <span>Loading PDF...</span>
                      </div>
                    }
                    error={
                      <div className="flex flex-col items-center gap-4 text-white">
                        <p>Failed to load PDF.</p>
                        <a
                          href={apiService.getThumbnailUrl(selectedPhoto.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-400 underline"
                        >
                          Download instead
                        </a>
                      </div>
                    }
                    className="flex flex-col items-center overflow-auto max-h-[calc(85vh-50px)] w-full"
                  >
                    {Array.from(new Array(numPages || 0), (el, index) => (
                      <Page
                        key={`page_${index + 1}`}
                        pageNumber={index + 1}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                        width={Math.min(window.innerWidth * 0.85, 800)}
                        className="mb-5 shadow-lg [&_canvas]:max-w-full [&_canvas]:h-auto! [&_canvas]:rounded-md"
                      />
                    ))}
                  </Document>
                </div>
              ) : (
                <img
                  src={apiService.getThumbnailUrl(selectedPhoto.id)}
                  alt={selectedPhoto.name}
                  className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg"
                />
              )}
            </div>

            {/* Bottom Action Buttons */}
            <div
              className="absolute bottom-8 left-1/2 -translate-x-1/2 flex gap-4 z-[1060]"
              onClick={(e) => e.stopPropagation()}
            >
              <a
                href={selectedPhoto.webViewLink || getDirectLink(selectedPhoto.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-5 py-3 bg-white/90 backdrop-blur-sm hover:bg-white text-slate-900 rounded-full font-medium transition-all shadow-lg hover:-translate-y-0.5"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                  <path d="M15 3h6v6" />
                  <path d="M10 14L21 3" />
                </svg>
                <span className="hidden sm:inline">Open in Drive</span>
              </a>
              <button
                className="flex items-center gap-2 px-5 py-3 bg-white/90 backdrop-blur-sm hover:bg-white text-slate-900 rounded-full font-medium transition-all shadow-lg hover:-translate-y-0.5 border-none cursor-pointer"
                onClick={async () => {
                  try {
                    const response = await fetch(apiService.getThumbnailUrl(selectedPhoto.id));
                    const blob = await response.blob();
                    const url = window.URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = selectedPhoto.name;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    window.URL.revokeObjectURL(url);
                  } catch (err) {
                    console.error("Failed to download:", err);
                    alert("Failed to download photo");
                  }
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span className="hidden sm:inline">Download</span>
              </button>
            </div>

            {/* Navigation Buttons for Lightbox */}
            {getActivePhotos().length > 1 && (
              <>
                <button
                  className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors border-none cursor-pointer z-[1060]"
                  onClick={(e) => {
                    e.stopPropagation();
                    const photos = getActivePhotos();
                    const currentIndex = photos.findIndex((p) => p.id === selectedPhoto.id);
                    const prevIndex = currentIndex === 0 ? photos.length - 1 : currentIndex - 1;
                    setSelectedPhoto(photos[prevIndex]);
                  }}
                >
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>

                <button
                  className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors border-none cursor-pointer z-[1060]"
                  onClick={(e) => {
                    e.stopPropagation();
                    const photos = getActivePhotos();
                    const currentIndex = photos.findIndex((p) => p.id === selectedPhoto.id);
                    const nextIndex = currentIndex === photos.length - 1 ? 0 : currentIndex + 1;
                    setSelectedPhoto(photos[nextIndex]);
                  }}
                >
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </Dialog>
  );
};

export default PatientPhotosModal;
