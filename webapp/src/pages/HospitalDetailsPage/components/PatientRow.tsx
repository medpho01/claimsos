import React, { useState } from "react";
import apiService from "../../../services/api";
import { Patient } from "../../../types";
import { getInitials, formatDate } from "../utils/formatters";

interface PatientRowProps {
    patient: Patient;
    onClick: () => void;
    onDischarge?: (e: React.MouseEvent) => void;
    canDischarge?: boolean;
    isDischarging?: boolean;
    onToggleActive?: (e: React.MouseEvent) => void;
    canToggleActive?: boolean;
    isTogglingActive?: boolean;
}

/**
 * Patient table row component
 */
const PatientRow: React.FC<PatientRowProps> = ({
    patient,
    onClick,
    onDischarge,
    canDischarge = false,
    isDischarging = false,
    onToggleActive,
    canToggleActive = false,
    isTogglingActive = false
}) => {
    const isAdmitted = !patient.discharged_at;
    const [isGenerating,setIsGenerating] = useState(false);
    return (
        <tr className="clickable-row" onClick={onClick}>
            <td>
                <div className="user-cell">
                    <div className="patient-avatar">
                        {getInitials(patient.first_name, patient.last_name)}
                    </div>
                    <div className="user-details">
                        <span className="user-name-cell">
                            {patient.first_name} {patient.last_name}
                        </span>
                    </div>
                </div>
            </td>
            <td>
                <span className="phone-number">{patient.phone}</span>
            </td>
            <td>
                <span className="date-text">{formatDate(patient.admitted_at)}</span>
            </td>
            <td>
                <span className={`type-badge ${patient.admission_type || ""}`}>
                    {patient.admission_type || "—"}
                </span>
            </td>
            <td>
                {patient.discharged_at ? (
                    <span className="status-badge discharged">Discharged</span>
                ) : (
                    <span className="status-badge admitted">Admitted</span>
                )}
            </td>
            <td>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    {canDischarge && isAdmitted && onDischarge && (
                        <button
                            className="discharge-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                onDischarge(e);
                            }}
                            disabled={isDischarging}
                            style={{
                                padding: '0.5rem 1rem',
                                background: isDischarging ? '#94a3b8' : '#ef4444',
                                color: 'white',
                                border: 'none',
                                borderRadius: '6px',
                                fontSize: '0.8125rem',
                                fontWeight: 500,
                                cursor: isDischarging ? 'not-allowed' : 'pointer',
                                transition: 'all 0.2s ease',
                            }}
                        >
                            {isDischarging ? 'Discharging...' : 'Discharge'}
                        </button>
                    )}
                    {canToggleActive && onToggleActive && (
                        <button
                            className="toggle-active-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleActive(e);
                            }}
                            disabled={isTogglingActive}
                            style={{
                                padding: '0.5rem 1rem',
                                background: isTogglingActive ? '#94a3b8' : (patient.is_active !== false ? '#f59e0b' : '#10b981'),
                                color: 'white',
                                border: 'none',
                                borderRadius: '6px',
                                fontSize: '0.8125rem',
                                fontWeight: 500,
                                cursor: isTogglingActive ? 'not-allowed' : 'pointer',
                                transition: 'all 0.2s ease',
                            }}
                        >
                            {isTogglingActive ? 'Updating...' : (patient.is_active !== false ? 'Deactivate' : 'Activate')}
                        </button>
                    )}
                </div>
            </td>
            <td>
                <button
                    className="edit-btn"
                    disabled = {isGenerating}
                    onClick={async(e) => {
                        e.stopPropagation();
                        setIsGenerating(true);
                        await apiService.generatePDF(patient.id);
                        setIsGenerating(false);
                    }}
                >
                    {isGenerating?"Generating...":"Generate PDF"}
                </button>
            </td>
        </tr>
    );
};

export default PatientRow;
