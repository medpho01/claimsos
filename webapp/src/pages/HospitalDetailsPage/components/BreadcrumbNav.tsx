import React from "react";
import { User, Hospital, HospitalPanel } from "../../../types";

interface BreadcrumbNavProps {
    user: User | null;
    hospital: Hospital | null;
    selectedPanel: HospitalPanel | null;
    loading: boolean;
    onNavigateHome: () => void;
    onNavigateToHospital: () => void;
}

// Icon components
const HomeIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
);

const ChevronRight = () => (
    <svg className="breadcrumb-separator" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6" />
    </svg>
);

/**
 * Breadcrumb navigation component for hospital details page
 */
const BreadcrumbNav: React.FC<BreadcrumbNavProps> = ({
    user,
    hospital,
    selectedPanel,
    loading,
    onNavigateHome,
    onNavigateToHospital,
}) => {
    return (
        <nav className="breadcrumb-nav">
            <button onClick={onNavigateHome} className="breadcrumb-link">
                <HomeIcon />
                {user?.role === "admin" ? "Dashboard" : "All Hospitals"}
            </button>
            <ChevronRight />
            {!loading && hospital && (
                <>
                    {selectedPanel ? (
                        <>
                            <button onClick={onNavigateToHospital} className="breadcrumb-link">
                                {hospital.name}
                            </button>
                            <ChevronRight />
                            <span className="breadcrumb-current">{selectedPanel.panel_name}</span>
                        </>
                    ) : (
                        <span className="breadcrumb-current">{hospital.name}</span>
                    )}
                </>
            )}
            {loading && <span className="breadcrumb-current">Loading...</span>}
        </nav>
    );
};

export default BreadcrumbNav;
