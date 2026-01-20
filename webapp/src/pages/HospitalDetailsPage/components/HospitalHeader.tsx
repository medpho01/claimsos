import React from "react";
import { Hospital, HospitalPanel, Patient } from "../../../types";

interface HospitalHeaderProps {
    hospital: Hospital | null;
    hospitalPanels: HospitalPanel[];
    patients: Patient[];
    selectedPanel: HospitalPanel | null;
    loading: boolean;
}

// Icon components
const LocationIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
        <circle cx="12" cy="10" r="3" />
    </svg>
);

const FolderIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
);

const PanelsIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 9h6M9 13h6M9 17h4" />
    </svg>
);

const UsersIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
);

const CheckCircleIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
);

/**
 * Hospital header component showing hospital info and stats badges
 */
const HospitalHeader: React.FC<HospitalHeaderProps> = ({
    hospital,
    hospitalPanels,
    patients,
    selectedPanel,
    loading,
}) => {
    const admittedCount = patients.filter((p) => !p.discharged_at).length;

    return (
        <header className="page-header enhanced">
            <div className="header-content">
                {loading ? (
                    <div className="header-skeleton">
                        <div className="skeleton-avatar"></div>
                        <div className="skeleton-text">
                            <div className="skeleton-line wide"></div>
                            <div className="skeleton-line narrow"></div>
                        </div>
                    </div>
                ) : (
                    hospital && (
                        <>
                            {/* Only show hospital info row when viewing panels list (not when viewing a panel's patients) */}
                            {!selectedPanel && (
                                <div className="header-info">
                                    <div className="hospital-avatar large">
                                        {hospital.name.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="hospital-meta">
                                        <h1>{hospital.name}</h1>
                                        <div className="hospital-subtitle">
                                            <span className="hospital-city">
                                                <LocationIcon />
                                                {hospital.city || "No city"}
                                            </span>
                                            {hospital.drive_folder_id && (
                                                <a
                                                    href={`https://drive.google.com/drive/folders/${hospital.drive_folder_id}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="hospital-drive-link"
                                                >
                                                    <FolderIcon />
                                                    Google Drive
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                            {/* Stats badges in header - only show when viewing panels list */}
                            {!selectedPanel && (
                                <div className="header-stats">
                                    <div className="stat-badge panels">
                                        <PanelsIcon />
                                        <span>
                                            {hospitalPanels.length} Panel{hospitalPanels.length !== 1 ? "s" : ""}
                                        </span>
                                    </div>
                                    <div className="stat-badge patients">
                                        <UsersIcon />
                                        <span>
                                            {patients.length} Patient{patients.length !== 1 ? "s" : ""}
                                        </span>
                                    </div>
                                    <div className="stat-badge admitted">
                                        <CheckCircleIcon />
                                        <span>{admittedCount} Admitted</span>
                                    </div>
                                </div>
                            )}
                        </>
                    )
                )}
            </div>
        </header>
    );
};

export default HospitalHeader;
