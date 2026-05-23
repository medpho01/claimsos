import React from "react";
import { Button } from "../../../ui/button";
import { Patient } from "../../../../types";
import { PhotosData } from "../types";

interface HeaderProps {
    patient: Patient;
    photosData: PhotosData | null;
    loading: boolean;
    isCached: boolean;
    sortOrder: "asc" | "desc";
    setSortOrder: (order: "asc" | "desc") => void;

    onRefresh: () => void;

    photoCount: number;
    activeCategory: string;
    onToggleSelect: () => void;
    isSelectMode: boolean;
    onClose: () => void;

    mainTab: string
}

export const Header: React.FC<HeaderProps> = ({
    patient,
    photosData,
    loading,
    isCached,
    sortOrder,
    setSortOrder,
    onRefresh,

    photoCount,
    activeCategory,
    onToggleSelect,
    isSelectMode,
    onClose,
    mainTab
}) => {
    return (
        <div className="flex justify-between items-center p-6 border-b bg-white">
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
                            {photoCount} file{photoCount !== 1 ? "s" : ""}
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
                {/* Sort Button */}
                {!loading && photoCount > 0 && mainTab == "photos" && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
                        title={sortOrder === "asc" ? "Oldest first" : "Newest first"}
                        className="rounded-xl px-4 h-10 font-semibold transition-all text-slate-600 flex items-center gap-2"
                    >
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className={`transition-transform duration-200 ${sortOrder === "asc" ? "rotate-180" : ""}`}
                        >
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <polyline points="19 12 12 19 5 12"></polyline>
                        </svg>
                        <span className="hidden sm:inline">
                            {sortOrder === "asc" ? "Oldest" : "Newest"}
                        </span>
                    </Button>
                )}

                {/* Select Button */}
                {!loading && photoCount > 0 && mainTab == "photos" && (
                    <Button
                        variant={isSelectMode ? "secondary" : "outline"}
                        size="sm"
                        onClick={onToggleSelect}
                        className={`rounded-xl px-4 h-10 font-semibold transition-all ${isSelectMode ? "bg-slate-100 text-slate-900" : "text-slate-600"}`}
                    >
                        <span className="hidden sm:inline">{isSelectMode ? "Cancel" : "Select"}</span>
                        {!isSelectMode && <span className="sm:hidden">Select</span>}
                    </Button>
                )}

                {/* Upload Button Removed - Moved to FAB */}

                {mainTab == "photos" && <Button
                    variant="ghost"
                    size="icon"
                    onClick={onRefresh}
                    className="h-10 w-10 rounded-xl hover:bg-slate-100 text-slate-500"
                    disabled={loading}
                    title="Refresh photos"
                >
                    <svg
                        className={`w-5 h-5 ${loading ? "animate-spin" : ""}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                    >
                        <path d="M23 4v6h-6" />
                        <path d="M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                </Button>}

                {/* Close Button */}
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onClose()}
                    className="h-10 w-10 rounded-xl hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors"
                    title="Close"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </Button>
            </div>
        </div>
    );
};
