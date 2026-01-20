import React from "react";
import { HospitalPanel, Patient } from "../../../types";

interface PanelCardProps {
    panel: HospitalPanel;
    patients: Patient[];
    onClick: () => void;
}

// Icon components
const PhoneIcon = () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
);

const ChevronRight = () => (
    <svg className="panel-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6" />
    </svg>
);

const FolderIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
);

/**
 * Panel card component showing panel info and patient stats
 */
const PanelCard: React.FC<PanelCardProps> = ({ panel, patients, onClick }) => {
    const panelPatientCount = patients.filter((p) => p.panel_id === panel.panel_id).length;
    const admittedInPanel = patients.filter(
        (p) => p.panel_id === panel.panel_id && !p.discharged_at
    ).length;

    return (
        <div className="panel-card" onClick={onClick}>
            <div className="panel-card-header">
                <div className="panel-icon">
                    {panel.panel_name?.charAt(0).toUpperCase() || "P"}
                </div>
                <div className="panel-info">
                    <h4>{panel.panel_name}</h4>
                    {panel.contact && (
                        <span className="panel-contact">
                            <PhoneIcon />
                            {panel.contact}
                        </span>
                    )}
                </div>
                <ChevronRight />
            </div>
            <div className="panel-card-stats">
                <div className="panel-stat">
                    <span className="stat-value">{panelPatientCount}</span>
                    <span className="stat-label">Total</span>
                </div>
                <div className="panel-stat admitted">
                    <span className="stat-value">{admittedInPanel}</span>
                    <span className="stat-label">Admitted</span>
                </div>
                {panel.drive_folder_id && (
                    <a
                        href={`https://drive.google.com/drive/folders/${panel.drive_folder_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="panel-drive-link"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <FolderIcon />
                        Drive
                    </a>
                )}
            </div>
        </div>
    );
};

export default PanelCard;
