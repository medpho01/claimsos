import React from "react";
import { HospitalPanel, Patient, User, Hospital } from "../../../types";
import PanelCard from "./PanelCard";

interface PanelsListProps {
    hospitalPanels: HospitalPanel[];
    patients: Patient[];
    loading: boolean;
    user: User | null;
    hospital: Hospital | null;
    onPanelSelect: (panel: HospitalPanel) => void;
    onLinkPanel: () => void;
}

// Icon components
const PanelsIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 9h6M9 13h6M9 17h4" />
    </svg>
);

const PlusIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 5v14M5 12h14" />
    </svg>
);

const EmptyPanelIcon = () => (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
);

/**
 * Panels list component with grid of panel cards, loading skeleton, and empty state
 */
const PanelsList: React.FC<PanelsListProps> = ({
    hospitalPanels,
    patients,
    loading,
    user,
    hospital,
    onPanelSelect,
    onLinkPanel,
}) => {
    const canLinkPanel =
        user?.role === "superadmin" ||
        user?.role === "hospital" ||
        (user?.role === "admin" && (hospital as any)?.can_edit);

    return (
        <>
            {/* Panel Section Header */}
            <div className="section-header">
                <div className="section-title">
                    <PanelsIcon />
                    <h3>Linked Panels</h3>
                    <span className="section-count">{hospitalPanels.length}</span>
                </div>
                {canLinkPanel && (
                    <button onClick={onLinkPanel} className="btn-add-patient">
                        <PlusIcon />
                        Link Panel
                    </button>
                )}
            </div>

            {loading ? (
                <div className="panels-grid">
                    {[...Array(3)].map((_, i) => (
                        <div key={i} className="panel-card skeleton">
                            <div className="skeleton-avatar"></div>
                            <div className="skeleton-content">
                                <div className="skeleton-line wide"></div>
                                <div className="skeleton-line narrow"></div>
                            </div>
                        </div>
                    ))}
                </div>
            ) : hospitalPanels.length === 0 ? (
                <div className="empty-state-card">
                    <div className="empty-icon">
                        <EmptyPanelIcon />
                    </div>
                    <h4>No panels linked yet</h4>
                    <p>
                        Link a panel to start managing patients under different insurance schemes or
                        categories.
                    </p>
                    {(user?.role === "superadmin" || user?.role === "hospital") && (
                        <button onClick={onLinkPanel} className="btn-primary-action">
                            <PlusIcon />
                            Link First Panel
                        </button>
                    )}
                </div>
            ) : (
                <div className="panels-grid">
                    {hospitalPanels.map((panel) => (
                        <PanelCard
                            key={panel.id}
                            panel={panel}
                            patients={patients}
                            onClick={() => onPanelSelect(panel)}
                        />
                    ))}
                </div>
            )}
        </>
    );
};

export default PanelsList;
